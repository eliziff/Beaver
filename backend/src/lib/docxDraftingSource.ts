import { sha256 } from "./hash";
import {
  type XNode,
  elAttrs,
  elChildren,
  elName,
  getTextContent,
  MAX_DRAFTING_DOCX_BYTES,
} from "./docx/core";
import { openDocxSession } from "./docx/session";
import { normalizeDocxControlTag } from "./chat/tools/docxMarkdown";
import { spawn } from "child_process";
import { isolatedProcessEnv } from "./subprocessEnv";

export const DOCX_DRAFTING_SOURCE_FORMAT = "pandoc-markdown-v1";
const MAX_DRAFTING_WARNINGS = 20;

export type DocxDraftingSource = {
  format: typeof DOCX_DRAFTING_SOURCE_FORMAT;
  source_sha256: string;
  markdown: string;
  warnings: string[];
  requires_review: boolean;
};

function cleanWarning(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function boundedWarnings(warnings: string[]) {
  const unique = [...new Set(warnings)];
  if (unique.length <= MAX_DRAFTING_WARNINGS) return unique;
  return [
    ...unique.slice(0, MAX_DRAFTING_WARNINGS),
    `${unique.length - MAX_DRAFTING_WARNINGS} additional conversion warnings omitted.`,
  ];
}

/** Make heading-styled paragraphs structurally recognizable to Pandoc. */
const HEADING_OUTLINE_MAP: Record<string, string> = {
  Heading1: "0",
  Heading2: "1",
  Heading3: "2",
  Heading4: "3",
  Heading5: "4",
  Heading6: "5",
};

function stripHeadingNumbering(documentXml: string): string {
  return documentXml.replace(
    /<w:pPr>((?:(?!<\/w:pPr>)[\s\S])*?<w:pStyle\b[^>]*w:val="(Heading\d+)"(?:(?!<\/w:pPr>)[\s\S])*?)<\/w:pPr>/g,
    (_match: string, inner: string, styleVal: string) => {
      let cleaned = inner.replace(/<w:numPr\b[\s\S]*?<\/w:numPr>/g, "");
      const level = HEADING_OUTLINE_MAP[styleVal];
      // Add outline level if missing — Pandoc needs it on the paragraph w:pPr
      if (level && !/<w:outlineLvl\b/.test(cleaned)) {
        cleaned = `<w:outlineLvl w:val="${level}"/>${cleaned}`;
      }
      return `<w:pPr>${cleaned}</w:pPr>`;
    },
  );
}

/** Patch DOCX-generated heading styles into Pandoc's expected shape. */
function normalizeStylesForPandoc(stylesXml: string): string {
  // Ensure a default Normal style exists — Pandoc's style resolution chain
  // requires it. Without `w:default="1"` on Normal, heading styles that
  // reference `w:basedOn w:val="Normal"` do not resolve and Pandoc emits
  // every heading as a plain paragraph.
  let result = stylesXml;
  if (!/<w:style\b[^>]*\bw:default="1"/.test(result)) {
    result = result.replace(
      "</w:styles>",
      '<w:style w:default="1" w:styleId="Normal" w:type="paragraph"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>',
    );
  }
  // Lowercase heading style names — Pandoc matches case-sensitively against
  // "heading" (lowercase). The docx npm package writes "Heading 1" (capital H).
  // Also add w:outlineLvl to each heading style's paragraph properties as a
  // belt-and-suspenders measure.
  return result.replace(
    /<w:style\b[^>]*\bw:styleId="(Heading\d+)"[\s\S]*?<\/w:style>/g,
    (match: string, styleId: string) => {
      let patched = match;
      patched = patched.replace(
        /(<w:name\b[^>]*w:val=")Heading (\d)(")/gi,
        (_m: string, before: string, num: string, after: string) =>
          `${before}heading ${num}${after}`,
      );
      const level = HEADING_OUTLINE_MAP[styleId];
      if (level && !/<w:outlineLvl\b/.test(patched)) {
        patched = patched.replace(
          /(<w:pPr[\s>][^<]*)/,
          `$1<w:outlineLvl w:val="${level}"/>`,
        );
      }
      return patched;
    },
  );
}

/**
 * Run Pandoc on (potentially modified) .docx bytes, returning markdown.
 * Pipes the bytes to Pandoc via stdin — no temp files.
 */
function pandocMd(bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pandoc", [
      "-f", "docx",
      "-t", "gfm",
      "--sandbox",
      "--wrap=none",
      "-o", "-",
    ], {
      env: isolatedProcessEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2 * 60 * 1000,
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_DRAFTING_DOCX_BYTES) child.kill();
      else stdout.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = `${stderr}${data.toString("utf8")}`.slice(-8_192);
    });

    child.on("close", (code: number | null) => {
      if (stdoutBytes > MAX_DRAFTING_DOCX_BYTES) {
        reject(new Error("Pandoc conversion output exceeded 25 MiB"));
      } else if (code !== 0) {
        reject(new Error(
          `Pandoc conversion failed (exit ${code}): ${cleanWarning(stderr)}`,
        ));
      } else {
        resolve(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
      }
    });

    child.on("error", (err: Error) => {
      // Pandoc not installed or not on PATH
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("Pandoc is required for drafting mode but was not found on PATH"));
      } else {
        reject(new Error(`Pandoc conversion failed: ${cleanWarning(err)}`));
      }
    });

    child.stdin.write(bytes);
    child.stdin.end();
  });
}

/**
 * Post-process Pandoc markdown output:
 * - Normalise CRLF → LF (Pandoc on Windows emits \r\n).
 * - Replace image references with `[Image omitted]`.
 * - Strip data:/javascript: unsafe scheme links.
 */
function postProcessMarkdown(md: string): string {
  let out = md
    // Pandoc on Windows emits CRLF; normalise to LF for platform-independent
    // output that matches the write-side markdown grammar.
    .replace(/\r\n?/gu, "\n")
    // Image references (both gfm inline HTML <img> and markdown ![alt](path)).
    .replace(/<img\b[^>]*\/?>/giu, "[Image omitted]")
    .replace(/!\[[^\]]*\]\([^)]*\)(?:\{[^}]*\})?/gu, "[Image omitted]")
    // Bare media references: Pandoc may leave `[](media/...)` references
    .replace(/^\[\]\([^)]*\)\s*$/gmu, "")
    // Unsafe inline links (data: and javascript: URIs)
    .replace(/\[[^\]]*\]\((?:data|javascript):[^)]*\)/giu, "")
    // Pandoc escapes literal [...] that look like link references (e.g.
    // content-control placeholders like [Party name]). It may escape either
    // or both brackets. Restore literal brackets not part of real links.
    .replace(/\\(\[)/gu, "$1")
    .replace(/\\(\])/gu, "$1");

  return out.trim();
}

/**
 * Check raw document.xml for merged or nested tables that Pandoc may normalise
 * but the model should still know about.
 */
function hasMergedOrNestedTables(documentXml: string): boolean {
  // w:gridSpan (colspan), w:vMerge (rowspan), or nested w:tbl
  return /<w:gridSpan\b/iu.test(documentXml) ||
    /<w:vMerge\b/iu.test(documentXml) ||
    /<w:tbl\b[\s\S]*?<w:tbl\b/iu.test(documentXml);
}

/**
 * Accepted-view text of a content-control body, mirroring the tracked-changes
 * flattener: w:del is invisible, w:t / w:tab / w:br carry their rendered text.
 */
function acceptedSdtText(node: XNode): string {
  const name = elName(node);
  if (!name || name === "w:del") return "";
  if (name === "w:t") return getTextContent(node);
  if (name === "w:tab") return "\t";
  if (name === "w:br") return "\n";
  return elChildren(node).map(acceptedSdtText).join("");
}

/**
 * Beaver-rendered content controls land in the DOCX as w:sdt with a w:tag and
 * a bracketed placeholder in the body ({{party_name}} renders as "[Party name]").
 * Re-ingesting through Pandoc reads that placeholder as literal text, so the
 * marker is lost. This pass recovers which tags were flattened so the drafting
 * view can warn instead of silently dropping them. Only controls whose body is
 * exactly one bracketed placeholder are flagged — a filled control (real value)
 * is left alone.
 */
function flattenedControlTags(
  tree: XNode[],
): { tag: string; placeholder: string }[] {
  const byTag = new Map<string, string>();
  const visit = (n: unknown) => {
    const name = elName(n);
    if (!name) return;
    if (name === "w:sdt") {
      const children = elChildren(n);
      const sdtPr = children.find((child) => elName(child) === "w:sdtPr");
      const sdtContent = children.find(
        (child) => elName(child) === "w:sdtContent",
      );
      if (sdtPr && sdtContent) {
        const tagEl = elChildren(sdtPr).find(
          (child) => elName(child) === "w:tag",
        );
        const tag = tagEl ? elAttrs(tagEl)["@_w:val"] : undefined;
        const placeholder = acceptedSdtText(sdtContent).trim();
        const normalized = tag ? normalizeDocxControlTag(tag) : null;
        if (
          normalized &&
          /^\[[^\]\r\n]+\]$/u.test(placeholder) &&
          !byTag.has(normalized)
        ) {
          byTag.set(normalized, placeholder);
        }
      }
    }
    for (const child of elChildren(n)) visit(child);
  };
  for (const top of tree) visit(top);
  return [...byTag].map(([tag, placeholder]) => ({ tag, placeholder }));
}

/** True when any w:txbxContent in the XML carries non-whitespace text. */
function hasTextBoxLiteralText(xml: string) {
  for (const region of xml.matchAll(
    /<w:txbxContent[^>]*>([\s\S]*?)<\/w:txbxContent>/giu,
  )) {
    for (const match of region[1].matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/giu)) {
      if (match[1].trim()) return true;
    }
  }
  return false;
}

export async function extractDocxDraftingSource(
  bytes: Buffer,
): Promise<DocxDraftingSource> {
  if (!bytes.length || bytes.length > MAX_DRAFTING_DOCX_BYTES) {
    throw new Error("Precedent DOCX exceeds the drafting read limit");
  }

  const session = await openDocxSession(bytes).catch((error: unknown) => {
    throw new Error(cleanWarning(error).replace(/^DOCX\b/u, "Precedent DOCX"));
  });
  if (!session.has("word/document.xml")) {
    throw new Error("Drafting mode requires a valid DOCX");
  }

  const paths = session.paths;
  const warnings: string[] = [];

  // Detect literal text in headers/footers — presence alone is not content
  // loss because the renderer always emits a page-number-only footer.
  const partHasLiteralText = async (pattern: RegExp) => {
    for (const path of paths) {
      if (!pattern.test(path)) continue;
      const xml = await session.readText(path);
      for (const match of xml?.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/giu) ??
        []) {
        if (match[1].trim()) return true;
      }
    }
    return false;
  };
  if (await partHasLiteralText(/^word\/header\d*\.xml$/i)) {
    warnings.push("Headers are not included in the drafting source.");
  }
  if (await partHasLiteralText(/^word\/footer\d*\.xml$/i)) {
    warnings.push("Footers are not included in the drafting source.");
  }
  const endnotes = await session.readText("word/endnotes.xml");
  if (
    endnotes &&
    /<w:endnote\b(?![^>]*\bw:type="(?:separator|continuationSeparator|continuationNotice)")/iu.test(
      endnotes,
    )
  ) {
    warnings.push("Endnotes may require manual review.");
  }
  const comments = await session.readText("word/comments.xml");
  if (
    comments &&
    /<w:comment(?:\s|>)/iu.test(comments)
  ) {
    warnings.push("Word comments are not included in the drafting source.");
  }
  if (paths.some((entry) => /^word\/embeddings\//i.test(entry))) {
    warnings.push("Embedded objects are not included in the drafting source.");
  }
  const documentXml = await session.readText("word/document.xml").catch((error: unknown) => {
    throw new Error(
      `Precedent DOCX is corrupted (word/document.xml cannot be read): ${cleanWarning(error)}`,
    );
  });
  if (documentXml == null) throw new Error("Drafting mode requires a valid DOCX");
  if (
    /<w:br\b[^>]*w:type="page"/iu.test(documentXml) ||
    /<w:lastRenderedPageBreak\b/iu.test(documentXml)
  ) {
    warnings.push(
      "Source page breaks are not included in the drafting source.",
    );
  }
  if (
    /<w:ins(?=[\s/>])/u.test(documentXml) ||
    /<w:del(?=[\s/>])/u.test(documentXml)
  ) {
    warnings.push(
      "Tracked changes are shown accepted in the drafting view; use the redline view to review the original revisions.",
    );
  }
  if (hasTextBoxLiteralText(documentXml)) {
    warnings.push(
      "Text-box content is not included in the drafting source.",
    );
  }

  const mediaCount = paths.filter((path) =>
    /^word\/media\//i.test(path),
  ).length;

  // Prepare the ZIP for Pandoc. Two patches may be needed:
  // 1. Strip <w:numPr> from heading paragraphs so Pandoc outputs `# Heading`
  //    instead of `N. **Heading**` (numbered list with bold text).
  // 2. Add <w:outlineLvl> to heading style definitions — Pandoc uses outline
  //    level (not style name) to determine heading rank.
  const hasNumberedHeadings = /<w:pStyle\b[^>]*w:val="Heading\d+"[\s\S]*?<w:numPr\b/iu.test(documentXml);
  const stylesXml = await session.readText("word/styles.xml").catch(() => "") ?? "";
  // Always patch styles if they contain heading definitions — we need to
  // (a) ensure Normal has w:default="1", (b) lowercase heading names,
  // and (c) add w:outlineLvl for Pandoc to recognise heading levels.
  const needsStylesPatch = stylesXml &&
    /<w:style\b[^>]*\bw:styleId="Heading\d+"/.test(stylesXml);

  let pandocInput: Buffer;
  if (hasNumberedHeadings || needsStylesPatch) {
    if (hasNumberedHeadings) {
      session.write("word/document.xml", stripHeadingNumbering(documentXml));
    }
    if (needsStylesPatch) {
      session.write("word/styles.xml", normalizeStylesForPandoc(stylesXml));
    }
    pandocInput = await session.save();
  } else {
    pandocInput = bytes;
  }

  // Convert via Pandoc (markdown, not HTML).
  const mdRaw = await pandocMd(pandocInput).catch((error: unknown) => {
    const message = cleanWarning(error);
    // A missing converter is an environment fault, not a document defect:
    // wrapping ENOENT as "malformed XML" sent operators hunting a healthy
    // file. Conversion failures on real bytes keep naming the part.
    if (/not found on PATH/u.test(message)) throw new Error(message);
    throw new Error(
      `Precedent DOCX contains malformed XML in word/document.xml: ${message}`,
    );
  });

  let markdown = postProcessMarkdown(mdRaw);

  // Safety net for documents where Pandoc produces nothing (e.g., text-box-only
  // docs): fall back to mammoth's raw text extraction, exactly like upstream.
  if (!markdown) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: pandocInput });
    markdown = result.value;
    if (markdown) {
      warnings.push("Pandoc returned no content; fell back to raw text extraction.");
    }
  }

  // No markdown-size refusal: memory is bounded by the package guards above
  // (input bytes, entry count, inflated XML bounds), and token exposure is a
  // SERVING policy — scoped windows, whole-read gates — not an extraction
  // concern. The old 300k cap's throw was swallowed by a catch(()=>null)
  // upstream and silently swapped the document onto the plaintext whole-read
  // plane, costing MORE tokens than the markdown it refused (the antitrust
  // market-data report whole-read ~84k tokens on the fallback plane).
  if (!markdown) {
    throw new Error("Precedent DOCX has no readable drafting structure");
  }

  // Structural warnings based on raw OOXML (format-agnostic).
  if (/w:val="Heading[7-9]"/iu.test(documentXml)) {
    warnings.push(
      "Heading levels 7–9 must be normalized into the six-level drafting schema.",
    );
  }
  if (hasMergedOrNestedTables(documentXml)) {
    warnings.push(
      "Merged or nested tables must be normalized without dropping their text.",
    );
  }
  if (mediaCount) {
    warnings.push(
      `${mediaCount} embedded image${mediaCount === 1 ? " was" : "s were"} replaced with [Image omitted].`,
    );
  }

  // Content-control detection (reads raw XML, format-agnostic).
  let flattenedControls: { tag: string; placeholder: string }[];
  try {
    flattenedControls = flattenedControlTags(
      (await session.readXml("word/document.xml")) ?? [],
    );
  } catch (error) {
    throw new Error(
      `Precedent DOCX contains malformed XML in word/document.xml: ${cleanWarning(error)}`,
    );
  }
  if (
    flattenedControls.length &&
    flattenedControls.some((entry) => markdown.includes(entry.placeholder))
  ) {
    const first = flattenedControls[0];
    warnings.push(
      `Content controls are flattened to placeholder text in the drafting view (${flattenedControls.length} total, e.g. ${first.placeholder} = {{${first.tag}}}); re-render them as {{tag}} markers to keep the controls.`,
    );
  }

  const requiresReview = warnings.length > 0;
  const finalWarnings = boundedWarnings(warnings);

  return {
    format: DOCX_DRAFTING_SOURCE_FORMAT,
    source_sha256: sha256(bytes),
    markdown,
    warnings: finalWarnings,
    requires_review: requiresReview,
  };
}
