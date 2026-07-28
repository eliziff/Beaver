import { createHash } from "node:crypto";
import type JSZip from "jszip";
import { loadZip } from "./zip";

export const DOCX_DRAFTING_SOURCE_FORMAT = "beaver-precedent-html-v1";
export const MAX_DRAFTING_DOCX_BYTES = 25 * 1024 * 1024;
const MAX_DRAFTING_HTML_CHARS = 300_000;
const MAX_DRAFTING_ZIP_ENTRIES = 2_048;
const MAX_DRAFTING_EXPANDED_BYTES = 96 * 1024 * 1024;
export const MAX_DRAFTING_XML_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_DRAFTING_XML_BYTES = 32 * 1024 * 1024;
const MAX_DRAFTING_WARNINGS = 20;

export type DocxDraftingSource = {
  format: typeof DOCX_DRAFTING_SOURCE_FORMAT;
  source_sha256: string;
  html: string;
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

function containsNestedTable(html: string) {
  let depth = 0;
  for (const match of html.matchAll(/<\/?table\b[^>]*>/giu)) {
    if (match[0].startsWith("</")) depth -= 1;
    else {
      depth += 1;
      if (depth > 1) return true;
    }
  }
  return false;
}

function hasMultipleParagraphs(html: string, container: "td" | "th" | "li") {
  const pattern = new RegExp(
    `<${container}\\b[^>]*>([\\s\\S]*?)<\\/${container}>`,
    "giu",
  );
  for (const match of html.matchAll(pattern)) {
    if ((match[1]?.match(/<p\b/giu)?.length ?? 0) > 1) return true;
  }
  return false;
}

function boundedWarnings(warnings: string[]) {
  const unique = [...new Set(warnings)];
  if (unique.length <= MAX_DRAFTING_WARNINGS) return unique;
  return [
    ...unique.slice(0, MAX_DRAFTING_WARNINGS),
    `${unique.length - MAX_DRAFTING_WARNINGS} additional conversion warnings omitted.`,
  ];
}

export async function extractDocxDraftingSource(
  bytes: Buffer,
): Promise<DocxDraftingSource> {
  if (!bytes.length || bytes.length > MAX_DRAFTING_DOCX_BYTES) {
    throw new Error("Precedent DOCX exceeds the drafting read limit");
  }

  const zip = await loadZip(bytes);
  assertBoundedPackage(zip);
  if (!zip.file("word/document.xml")) {
    throw new Error("Drafting mode requires a valid DOCX");
  }

  const paths = Object.keys(zip.files);
  const warnings: string[] = [];
  // Presence alone is not content loss: Beaver's own renderer always emits a
  // page-number-only footer (field codes, no literal text). Only headers and
  // footers carrying literal text are worth a review flag.
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
  const documentXml = await zip.file("word/document.xml")!.async("text");
  if (
    /<w:br\b[^>]*w:type="page"/iu.test(documentXml) ||
    /<w:lastRenderedPageBreak\b/iu.test(documentXml)
  ) {
    warnings.push(
      "Source page breaks are not included in the drafting source.",
    );
  }

  const mediaCount = paths.filter((path) =>
    /^word\/media\//i.test(path),
  ).length;
  const mammoth = await import("mammoth");
  const imageMarker = "beaver:image-omitted";
  const converted = await mammoth.convertToHtml(
    { buffer: bytes },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async () => ({
        src: imageMarker,
      })),
    },
  );
  const html = converted.value
    .replace(
      new RegExp(`<img\\b[^>]*src="${imageMarker}"[^>]*\\/?>`, "giu"),
      "<span>[Image omitted]</span>",
    )
    .replace(/\shref="(?:data|javascript):[^"]*"/giu, "")
    .trim();

  if (!html || html.length > MAX_DRAFTING_HTML_CHARS) {
    throw new Error(
      html
        ? "Precedent structure exceeds the drafting read limit"
        : "Precedent DOCX has no readable drafting structure",
    );
  }
  if (/data:[^"'>\s]+/iu.test(html)) {
    throw new Error("Precedent conversion produced unsafe embedded data");
  }
  if (/<h[4-6]\b/iu.test(html)) {
    warnings.push(
      "Heading levels 4–6 must be normalized into the three-level drafting schema.",
    );
  }
  if (/\b(?:rowspan|colspan)=/iu.test(html) || containsNestedTable(html)) {
    warnings.push(
      "Merged or nested tables must be normalized without dropping their text.",
    );
  }
  if (
    hasMultipleParagraphs(html, "td") ||
    hasMultipleParagraphs(html, "th")
  ) {
    warnings.push(
      "Multi-paragraph table cells must be normalized without dropping their text.",
    );
  }
  if (hasMultipleParagraphs(html, "li") && /id="footnote-/iu.test(html)) {
    warnings.push(
      "Multi-paragraph footnotes must be normalized into one native note without dropping their text.",
    );
  }
  if (mediaCount) {
    warnings.push(
      `${mediaCount} embedded image${mediaCount === 1 ? " was" : "s were"} replaced with [Image omitted].`,
    );
  }
  const requiresReview = warnings.length > 0;
  for (const message of converted.messages) {
    const warning = cleanWarning(message.message);
    if (warning) warnings.push(warning);
  }
  const finalWarnings = boundedWarnings(warnings);

  return {
    format: DOCX_DRAFTING_SOURCE_FORMAT,
    source_sha256: createHash("sha256").update(bytes).digest("hex"),
    html,
    warnings: finalWarnings,
    requires_review: requiresReview,
  };
}
