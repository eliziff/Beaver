import { sha256 } from "./hash";
import type JSZip from "jszip";
import { loadZip } from "./zip";
import {
  type XNode,
  createParser,
  elAttrs,
  elChildren,
  elName,
  getTextContent,
  getZipEntry,
  MAX_DRAFTING_DOCX_BYTES,
  MAX_DRAFTING_XML_ENTRY_BYTES,
} from "./docx/core";
import { normalizeDocxControlTag } from "./chat/tools/docxMarkdown";
import { spawn } from "child_process";

// Bounds now live in the docx kernel; re-exported so existing callers keep
// importing them from here.
export { MAX_DRAFTING_DOCX_BYTES, MAX_DRAFTING_XML_ENTRY_BYTES };

export const DOCX_DRAFTING_SOURCE_FORMAT = "pandoc-markdown-v1";
const MAX_DRAFTING_MD_CHARS = 300_000;
const MAX_DRAFTING_ZIP_ENTRIES = 2_048;
const MAX_DRAFTING_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_DRAFTING_XML_BYTES = 32 * 1024 * 1024;
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

function hasPart(paths: string[], pattern: RegExp) {
  return paths.some((path) => pattern.test(path));
}

function expandedSize(entry: unknown) {
  const size = (
    entry as {
      _data?: { uncompressedSize?: unknown };
    }
  )?._data?.uncompressedSize;
  if (!Number.isSafeInteger(size) || Number(size) < 0) {
    throw new Error("Precedent DOCX has invalid ZIP size metadata");
  }
  return Number(size);
}

function assertBoundedPackage(zip: JSZip) {
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length > MAX_DRAFTING_ZIP_ENTRIES) {
    throw new Error("Precedent DOCX contains too many package entries");
  }
  let expandedBytes = 0;
  let xmlBytes = 0;
  for (const entry of files) {
    const size = expandedSize(entry);
    expandedBytes += size;
    if (/\.xml(?:\.rels)?$/iu.test(entry.name)) {
      if (size > MAX_DRAFTING_XML_ENTRY_BYTES) {
        throw new Error("Precedent DOCX contains an oversized XML part");
      }
      xmlBytes += size;
    }
  }
  if (
    expandedBytes > MAX_DRAFTING_EXPANDED_BYTES ||
    xmlBytes > MAX_DRAFTING_XML_BYTES
  ) {
    throw new Error("Precedent DOCX expands beyond the drafting read limit");
  }
}

function boundedWarnings(warnings: string[]) {
  const unique = [...new Set(warnings)];
  if (unique.length <= MAX_DRAFTING_WARNINGS) return unique;
  return [
    ...unique.slice(0, MAX_DRAFTING_WARNINGS),
    `${unique.length - MAX_DRAFTING_WARNINGS} additional conversion warnings omitted.`,
  ];
}

/**
 * Strip `<w:numPr>` from heading-styled paragraphs AND add `<w:outlineLvl>`
 * so Pandoc outputs `# Heading` instead of `N. **Heading**`. Pandoc requires
 * `w:outlineLvl` on the paragraph itself (not just the style definition) to
 * recognise heading rank. Without this patch, the combination of
 * `w:numPr` (list numbering) and missing paragraph-level outline level
 * causes Pandoc to flatten every heading into bold body text.
 */
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

/**
 * Patch heading styles in styles.xml so Pandoc recognises them as headings.
 * The `docx` npm package emits `w:pStyle w:val="Heading1"` on paragraphs but
 * does not add `<w:outlineLvl>` to the style definition. Pandoc uses the
 * outline level (not the style name) to determine heading rank, so without
 * this patch every heading becomes bold body text.
 */
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
      "--wrap=none",
      "-o", "-",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(
          `Pandoc conversion failed (exit ${code}): ${cleanWarning(stderr)}`,
        ));
      } else {
        resolve(stdout);
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
 * Check raw document.xml for heading levels 7–9 that exceed our six-level
 * drafting schema.
 */
function hasDeepHeadings(documentXml: string): boolean {
  return /w:val="Heading[7-9]"/iu.test(documentXml);
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
  documentXml: string,
): { tag: string; placeholder: string }[] {
  const parser = createParser();
  const tree = parser.parse(documentXml) as XNode[];
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

  const zip = await loadZip(bytes).catch((error: unknown) => {
    throw new Error(
      `Precedent DOCX is corrupted or truncated (not a readable ZIP archive): ${cleanWarning(error)}`,
    );
  });
  assertBoundedPackage(zip);
  const documentEntry = getZipEntry(zip, "word/document.xml");
  if (!documentEntry) {
    throw new Error("Drafting mode requires a valid DOCX");
  }

  const paths = Object.keys(zip.files);
  const warnings: string[] = [];

  // Detect literal text in headers/footers — presence alone is not content
  // loss because the renderer always emits a page-number-only footer.
  const partHasLiteralText = async (pattern: RegExp) => {
    for (const path of paths) {
      if (!pattern.test(path)) continue;
      const xml = await zip.file(path)?.async("text");
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
  const endnotes = zip.file("word/endnotes.xml");
  if (
    endnotes &&
    /<w:endnote\b(?![^>]*\bw:type="(?:separator|continuationSeparator|continuationNotice)")/iu.test(
      await endnotes.async("text"),
    )
  ) {
    warnings.push("Endnotes may require manual review.");
  }
  const comments = zip.file("word/comments.xml");
  if (
    comments &&
    /<w:comment(?:\s|>)/iu.test(await comments.async("text"))
  ) {
    warnings.push("Word comments are not included in the drafting source.");
  }
  if (hasPart(paths, /^word\/embeddings\//i)) {
    warnings.push("Embedded objects are not included in the drafting source.");
  }
  const documentXml = await documentEntry.async("text").catch((error: unknown) => {
    throw new Error(
      `Precedent DOCX is corrupted (word/document.xml cannot be read): ${cleanWarning(error)}`,
    );
  });
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
  const stylesEntry = getZipEntry(zip, "word/styles.xml");
  const stylesXml = stylesEntry ? await stylesEntry.async("text").catch(() => "") : "";
  // Always patch styles if they contain heading definitions — we need to
  // (a) ensure Normal has w:default="1", (b) lowercase heading names,
  // and (c) add w:outlineLvl for Pandoc to recognise heading levels.
  const needsStylesPatch = stylesXml &&
    /<w:style\b[^>]*\bw:styleId="Heading\d+"/.test(stylesXml);

  let pandocInput: Buffer;
  if (hasNumberedHeadings || needsStylesPatch) {
    if (hasNumberedHeadings) {
      zip.file("word/document.xml", stripHeadingNumbering(documentXml));
    }
    if (needsStylesPatch) {
      zip.file("word/styles.xml", normalizeStylesForPandoc(stylesXml));
    }
    pandocInput = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
  } else {
    pandocInput = bytes;
  }

  // Convert via Pandoc (markdown, not HTML).
  const mdRaw = await pandocMd(pandocInput).catch((error: unknown) => {
    throw new Error(
      `Precedent DOCX contains malformed XML in word/document.xml: ${cleanWarning(error)}`,
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

  if (!markdown || markdown.length > MAX_DRAFTING_MD_CHARS) {
    throw new Error(
      markdown
        ? "Precedent structure exceeds the drafting read limit"
        : "Precedent DOCX has no readable drafting structure",
    );
  }

  // Structural warnings based on raw OOXML (format-agnostic).
  if (hasDeepHeadings(documentXml)) {
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
    flattenedControls = flattenedControlTags(documentXml);
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
