import { docxToPdf } from "../../convert";
import {
  applyTrackedEdits,
  extractDocxBodyText,
  finalizeTrackedEdits,
  type EditMode,
  type EditInput,
} from "../../docxTrackedChanges";
import { type EditAnnotation } from "../types";
import {
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
} from "../../documentTypes";
import { extractPresentationText } from "../../officeText";
import { spreadsheetToLLMText } from "../../spreadsheet";
import { isPlainTextDocumentType } from "../../documentTypes";
import { extractEmailText } from "../../emailText";
import { cachedParse } from "../../parseCache";
import { docxPathologyReportFor } from "./docxPathologyNotes";
import {
  normalizeDocxControlTag,
  renderDocxMarkdown,
  type RenderDocxMarkdownOptions,
} from "./docxMarkdown";
import { extractLegalPdfText } from "../../legalPdfSourceDoc";
import type {
  AssistantEdit,
  DocumentScope,
  DocumentStore,
} from "../../documentStore";

export function citationReminder(docLabel: string, filename: string): string {
  return [
    `[Citation requirement for ${docLabel} ("${filename}")]:`,
    "Use the returned Citation evidence_id in submit_grounded_answer for any factual claim from this document.",
    "Do not write citation markers, citation JSON, URLs, or pinpoints in prose.",
  ].join("\n");
}

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  try {
    return await extractLegalPdfText(Buffer.from(buf));
  } catch {
    return "";
  }
}

const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const mammothRawText = async (bytes: Buffer) =>
  (await (await import("mammoth")).extractRawText({ buffer: bytes })).value;

/**
 * Per-format text parser identity for the content-addressed parse cache.
 * Bump a parser's version whenever its output for the same bytes changes.
 */
export function textParserFor(fileType: string): {
  parser: string;
  version: number;
  run: (bytes: Buffer) => Promise<string>;
} | null {
  if (fileType === "pdf")
    return {
      parser: "legalpdf-text",
      version: 2,
      run: (b) => extractPdfText(toArrayBuffer(b)),
    };
  if (fileType === "docx")
    return {
      parser: "docx-body-text",
      version: 2,
      /**
       * Same flattening as the edit_document matcher, so the model sees
       * exactly the characters it can anchor against — and NO fallback.
       *
       * A second extractor here was silently load-bearing in the worst way:
       * `applyTextOpsToDocx` resolves its scopes against `extractDocxBodyText`
       * alone, so any document that fell through to mammoth was read on one
       * character plane and edited on another, and every offset the reader
       * handed back pointed somewhere else in the writer. Nothing reported
       * it, because falling back looked like success.
       *
       * Measured before removing it: 400 documents sampled at stride 28
       * across the 11,293-file corpus, zero empty and zero throwing. The
       * fallback was not carrying anything. If this does fail on a real
       * document, that is an instrument defect to fix in the extractor, and
       * a typed refusal naming the file is what makes it findable.
       */
      run: async (b) => {
        const text = await extractDocxBodyText(b);
        if (!text) {
          throw new Error(
            "DOCX body text could not be extracted. The document reads as empty, which is an extraction defect rather than an empty document; report the file rather than working from partial text.",
          );
        }
        return text;
      },
    };
  if (isPlainTextDocumentType(fileType))
    return {
      parser: "plain-text",
      version: 1,
      /**
       * Decode and nothing else. A BOM is a byte-order mark, not content, so
       * it goes; line endings STAY exactly as the file has them.
       *
       * Normalising CRLF here would be the same defect that silently
       * corrupted a quarter of a benchmark for five stages: every offset a
       * reader hands back has to index the stored bytes, and rewriting line
       * endings moves all of them. The structural grammars already tolerate
       * a trailing carriage return.
       */
      run: async (b) => {
        const text = b.toString("utf8");
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      },
    };
  if (fileType === "eml")
    return {
      parser: "eml-text",
      version: 1,
      // Headers + decoded MIME body. Transfer decoding is the whole point:
      // undecoded quoted-printable splits numbers mid-digit.
      run: async (b) => extractEmailText(b),
    };
  if (isSpreadsheetDocumentType(fileType))
    return {
      parser: "spreadsheet-llm-text",
      version: 2,
      // SheetJS reads .xlsx/.xlsm/.xls directly (no PDF detour), emitting a
      // cell-addressed markdown view with Excel-formatted values.
      run: (b) => spreadsheetToLLMText(b),
    };
  if (fileType === "pptx")
    return {
      parser: "pptx-text",
      version: 1,
      run: (b) => extractPresentationText(b),
    };
  if (isPresentationDocumentType(fileType) || isWordDocumentType(fileType))
    return {
      parser: "office-pdf-text",
      version: 2,
      // Legacy Office formats go through a PDF detour for text extraction.
      run: async (b) => extractPdfText(toArrayBuffer(await docxToPdf(b))),
    };
  return null;
}

async function generatedDocxResult(title: string, bytes: Buffer) {
  const zip = await import("jszip");
  const packageZip = await zip.default.loadAsync(bytes);
  for (const requiredPath of [
    "[Content_Types].xml",
    "word/document.xml",
    "word/_rels/document.xml.rels",
  ]) {
    if (!packageZip.file(requiredPath)) {
      throw new Error(
        `Generated DOCX is missing required package part: ${requiredPath}`,
      );
    }
  }
  return {
    filename: safeGeneratedFilename(title, "docx"),
    bytes,
  };
}

function docxFieldValues(raw: unknown) {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error("DOCX fields must be an array of at most 100 values.");
  }
  // Report every bad field in one error so the model can fix the whole call
  // in a single retry instead of discovering problems one round-trip at a time.
  const values: Record<string, string> = {};
  const problems: string[] = [];
  let totalLength = 0;
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`fields[${index}] must be an object with id and value.`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === "string"
        ? normalizeDocxControlTag(record.id)
        : null;
    if (!id) {
      problems.push(
        `fields[${index}].id must normalize to an identifier beginning with a letter.`,
      );
      continue;
    }
    if (Object.hasOwn(values, id)) {
      problems.push(`field "${id}" is duplicated.`);
      continue;
    }
    if (typeof record.value !== "string" || record.value.length > 20_000) {
      problems.push(
        `field "${id}" value must be a string of at most 20,000 characters.`,
      );
      continue;
    }
    totalLength += record.value.length;
    values[id] = record.value;
  }
  if (totalLength > 200_000) {
    problems.push("field values exceed 200,000 characters in total.");
  }
  if (problems.length) {
    throw new Error(
      `DOCX fields rejected: ${problems.join(" ")} Fix every listed field and retry the same call.`,
    );
  }
  return values;
}

export async function renderMarkdownDocx(
  title: string,
  markdown: string,
  fields?: unknown,
  options?: Omit<RenderDocxMarkdownOptions, "title" | "values">,
) {
  try {
    const bytes = await renderDocxMarkdown(markdown, {
      title,
      landscape: options?.landscape,
      values: docxFieldValues(fields),
      citations: options?.citations,
      citationPlacement: options?.citationPlacement,
      citationHyperlinks: options?.citationHyperlinks,
      numberHeadings: options?.numberHeadings,
      memoHeader: options?.memoHeader,
      generatedAt: options?.generatedAt,
      timeZone: options?.timeZone,
    });
    return await generatedDocxResult(title, bytes);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "DOCX creation failed.",
    };
  }
}

export function safeGeneratedFilename(title: string, extension: string) {
  const rawTitle = typeof title === "string" ? title : "document";
  const suffix = `.${extension}`;
  const titleWithoutExtension = rawTitle.toLowerCase().endsWith(suffix.toLowerCase())
    ? rawTitle.slice(0, -suffix.length)
    : rawTitle;
  const safeTitle =
    titleWithoutExtension
      .replace(/[^a-zA-Z0-9 -]/g, "")
      .trim()
      .slice(0, 64) || "document";
  return `${safeTitle}.${extension}`;
}

function xmlEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeSheetName(value: unknown, fallback: string) {
  const raw =
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  return (
    raw
      .replace(/[:\\/?*[\]]/g, " ")
      .trim()
      .slice(0, 31) || fallback
  );
}

function normalizeRows(rows: unknown, colCount: number) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      Array.from({ length: colCount }, (_, i) =>
        row[i] == null ? "" : String(row[i]),
      ),
    );
}

export async function renderXlsxWorkbook(
  title: string,
  sheetsInput: unknown[],
) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: title, Author: "Beaver" };
  const sheets = sheetsInput.length
    ? sheetsInput
    : [{ name: title, columns: [], rows: [] }];
  sheets.forEach((sheet, index) => {
    const raw = (sheet && typeof sheet === "object" ? sheet : {}) as {
      name?: unknown;
      columns?: unknown;
      rows?: unknown;
    };
    const columns = Array.isArray(raw.columns)
      ? raw.columns.map((col) => String(col ?? "")).filter((col) => col.trim())
      : [];
    const header = columns.length ? columns : ["Value"];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        header,
        ...normalizeRows(raw.rows, header.length),
      ]),
      normalizeSheetName(raw.name, `Sheet ${index + 1}`),
      true,
    );
  });
  return Buffer.from(
    XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    }),
  );
}

function pptTextParagraphs(lines: string[], opts: { title?: boolean } = {}) {
  const titleAttrs = opts.title ? ' sz="3200" b="1"' : ' sz="2000"';
  const bullet = opts.title
    ? ""
    : '<a:pPr marL="342900" indent="-171450"><a:buChar char="&#8226;"/></a:pPr>';
  return lines
    .map(
      (line) =>
        `<a:p>${bullet}<a:r><a:rPr lang="en-US"${titleAttrs}/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`,
    )
    .join("");
}

function pptShape(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  body: string,
) {
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
  <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody>
</p:sp>`;
}

export async function buildPptxPresentation(title: string, slidesInput: unknown[]) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const rawSlides = slidesInput.length
    ? slidesInput
    : [{ title, bullets: ["Generated by Beaver"] }];
  const slides = rawSlides.map((slide, index) => {
    const raw = (slide && typeof slide === "object" ? slide : {}) as {
      title?: unknown;
      bullets?: unknown;
    };
    return {
      title:
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : index === 0
            ? title
            : `Slide ${index + 1}`,
      bullets: Array.isArray(raw.bullets)
        ? raw.bullets.map((bullet) => String(bullet ?? "")).filter(Boolean)
        : [],
    };
  });

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${slides
  .map(
    (_, i) =>
      `  <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  )
  .join("\n")}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Beaver</dc:creator>
  <cp:lastModifiedBy>Beaver</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Beaver</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>${slides.length}</Slides>
</Properties>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${slides.length + 1}"/></p:sldMasterIdLst>
  <p:sldIdLst>
${slides.map((_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("\n")}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides
  .map(
    (_, i) =>
      `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  )
  .join("\n")}
  <Relationship Id="rId${slides.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
</p:sldLayout>`,
  );
  zip.file(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Beaver">
  <a:themeElements>
    <a:clrScheme name="Office"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="059669"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`,
  );

  for (const [index, slide] of slides.entries()) {
    const bullets = slide.bullets.length ? slide.bullets : [""];
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${pptShape(2, "Title", 685800, 457200, 10820400, 914400, pptTextParagraphs([slide.title], { title: true }))}
      ${pptShape(3, "Content", 914400, 1600200, 10363200, 4343400, pptTextParagraphs(bullets))}
    </p:spTree>
  </p:cSld>
</p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    );
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

export async function runEditDocument(params: {
  documents: DocumentStore;
  scope: DocumentScope;
  documentId: string;
  edits: EditInput[];
  editMode?: EditMode;
  annotate?: boolean;
  /**
   * If provided, append these edits to the existing turn-scoped version
   * (overwrites the file at storagePath and reuses the document_versions
   * row) instead of creating a new version. Used to collapse multiple
   * edit_document tool calls within a single assistant turn into one
   * version.
   */
  reuseVersion?: {
    versionId: string;
    versionNumber?: number;
    storagePath?: string;
    parentVersionId: string;
  };
}): Promise<
  | {
      ok: true;
      version_id: string;
      version_number: number;
      storage_path: string;
      download_url: string;
      edit_mode: EditMode;
      annotations: EditAnnotation[];
      errors: { index: number; reason: string }[];
      comment_count: number;
    }
  | { ok: false; error: string }
> {
  const {
    documents,
    scope,
    documentId,
    edits,
    reuseVersion,
    editMode = "manual",
    annotate = false,
  } = params;
  const current = await documents.read(
    scope,
    documentId,
    reuseVersion?.versionId ?? null,
    false,
  );
  if (!current) return { ok: false, error: "Could not load document bytes." };
  if (current.fileType !== "docx") {
    return { ok: false, error: "Edit only supports .docx files." };
  }

  const applied = await applyTrackedEdits(current.bytes, edits, {
    author: "Beaver",
    annotate,
  });
  const { changes, errors } = applied;

  if (changes.length === 0) {
    // Every diagnosis, not just the first: the matcher explains each miss in
    // the document's own words, so one round trip can fix the whole call.
    return {
      ok: false,
      error: errors.length
        ? errors.map((e) => `edit ${e.index + 1}: ${e.reason}`).join("\n\n")
        : "No edits could be applied. Refine context_before/context_after and retry.",
    };
  }

  const finalized = await finalizeTrackedEdits(
    applied.bytes,
    changes.flatMap((change) =>
      [change.delId, change.insId].filter((id): id is string => !!id),
    ),
    editMode,
  );
  {
    // Inherit the filename from the most recent prior version so
    // user-applied renames carry forward through further edits. Malformed
    // legacy rows without a filename get a neutral placeholder, not the
    // parent document filename. We intentionally do NOT append "[Edited Vn]"
    // — the version number is surfaced separately as a tag in the UI.
  }

  const stored = await documents.commitAssistantVersion(scope, documentId, {
    sourceVersionId: current.version.id,
    ...(reuseVersion ? { turnVersionId: reuseVersion.versionId } : {}),
    parentVersionId: reuseVersion?.parentVersionId ?? current.version.id,
    filename: current.version.filename ?? current.filename,
    bytes: finalized.bytes,
    edits: changes.map((change): AssistantEdit => ({
      changeId: change.id,
      delWId: change.delId,
      insWId: change.insId,
      deletedText: change.deletedText,
      insertedText: change.insertedText,
      contextBefore: change.contextBefore ?? "",
      contextAfter: change.contextAfter ?? "",
      reason: change.reason,
      diff: change.diff,
    })),
    status: finalized.status,
  });
  if (stored.status !== "committed") {
    return {
      ok: false,
      error: stored.status === "missing"
        ? "Document not found."
        : "The active document version changed.",
    };
  }
  const version = stored.version;
  const versionNumber = version.version_number ?? reuseVersion?.versionNumber;
  if (!versionNumber) {
    return { ok: false, error: "The saved version has no version number." };
  }
  const annotations: EditAnnotation[] = stored.edits.map((edit) => ({
    kind: "edit",
    edit_id: edit.id,
    document_id: documentId,
    version_id: version.id,
    version_number: versionNumber,
    change_id: edit.changeId,
    del_w_id: edit.delWId,
    ins_w_id: edit.insWId,
    deleted_text: edit.deletedText,
    inserted_text: edit.insertedText,
    context_before: edit.contextBefore,
    context_after: edit.contextAfter,
    reason: edit.reason,
    diff: edit.diff,
    status: edit.status,
  }));

  return {
    ok: true,
    version_id: version.id,
    version_number: versionNumber,
    storage_path: version.storage_path ?? reuseVersion?.storagePath ?? "",
    download_url:
      `/single-documents/${encodeURIComponent(documentId)}/file` +
      `?version_id=${encodeURIComponent(version.id)}`,
    edit_mode: editMode,
    annotations,
    errors,
    comment_count: applied.comments,
  };
}

/**
 * Build a whitespace-collapsed, lowercased copy of `text`, plus a map from
 * each character index in the normalized form back to the corresponding
 * index in the original text, keeping tolerant matches anchored to the
 * exact original excerpt.
 */
function normalizeWithMap(text: string): { norm: string; origIdx: number[] } {
  const norm: string[] = [];
  const origIdx: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        norm.push(" ");
        origIdx.push(i);
        prevSpace = true;
      }
    } else {
      norm.push(ch.toLowerCase());
      origIdx.push(i);
      prevSpace = false;
    }
  }
  return { norm: norm.join(""), origIdx };
}

function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export type TextMatch = {
  index: number;
  excerpt: string;
  context: string;
  /** Original-text character offset of the match start (composable with
   *  windowed reads and structural lookup, like grep's file:line). */
  at: number;
};

export function findTextMatches(params: {
  text: string;
  query: string;
  maxResults: number;
  contextChars: number;
  startIndex?: number;
}): { hits: TextMatch[]; totalMatches: number } {
  const { text, query, maxResults, contextChars, startIndex = 0 } = params;
  const { norm, origIdx } = normalizeWithMap(text);
  const needle = normalizeQuery(query);
  const hits: TextMatch[] = [];
  let totalMatches = 0;
  if (!needle) return { hits, totalMatches };

  let from = 0;
  while (from <= norm.length - needle.length) {
    const pos = norm.indexOf(needle, from);
    if (pos < 0) break;
    const endNormPos = pos + needle.length;
    const origStart = origIdx[pos] ?? 0;
    const origEnd =
      endNormPos - 1 < origIdx.length
        ? origIdx[endNormPos - 1] + 1
        : text.length;
    if (hits.length < maxResults) {
      const ctxStart = Math.max(0, origStart - contextChars);
      const ctxEnd = Math.min(text.length, origEnd + contextChars);
      hits.push({
        index: startIndex + hits.length,
        excerpt: text.slice(origStart, origEnd),
        context:
          (ctxStart > 0 ? "…" : "") +
          text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
          (ctxEnd < text.length ? "…" : ""),
        at: origStart,
      });
    }
    totalMatches++;
    from = pos + Math.max(1, needle.length);
  }

  return { hits, totalMatches };
}

/** Extend only a nearby clipped paragraph tail; never guess a legal section. */
export function boundedParagraphTail(
  text: string,
  end: number,
  maxChars = 1_500,
) {
  if (end <= 0 || end >= text.length || maxChars <= 0) return null;
  const newline = text.indexOf("\n", end);
  const tailEnd = newline < 0 ? text.length : newline;
  const tail = text.slice(end, tailEnd);
  return tail.length <= maxChars && /\S/u.test(tail)
    ? { text: tail, start: end, end: tailEnd }
    : null;
}
