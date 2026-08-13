export const ALLOWED_DOCUMENT_TYPES = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xlsm",
  "xls",
  "pptx",
  "ppt",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "eml",
  // Files that ARE their text. Legal work arrives as exported agreements,
  // transcripts and markdown memos constantly; until now every one of them
  // was rejected at upload and produced nothing.
  "txt",
  "text",
  "md",
  "markdown",
  "mdown",
  "rst",
  "log",
]);

export const ALLOWED_DOCUMENT_TYPES_LABEL =
  "pdf, docx, doc, xlsx, xlsm, xls, pptx, ppt, jpg, jpeg, png, gif, webp, eml, txt, md";

export function validateDocumentFile(filename: string, bytes: Buffer) {
  const fileType = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_DOCUMENT_TYPES.has(fileType)) {
    return { ok: false,
      error: `Unsupported file type: ${fileType}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
    } as const;
  }
  const error = imageValidationError(filename, bytes);
  return error ? { ok: false, error } as const : { ok: true, fileType } as const;
}

const WORD_TYPES = new Set(["docx", "doc"]);
const SPREADSHEET_TYPES = new Set(["xlsx", "xlsm", "xls"]);
const PRESENTATION_TYPES = new Set(["pptx", "ppt"]);
/**
 * Files that ARE their text. No extraction step, no format to lose: the
 * bytes decode to the characters every downstream layer already works on.
 * Legal work arrives in these constantly -- exported agreements, transcripts,
 * markdown memos, corpus files -- and until now they produced nothing.
 */
const PLAIN_TEXT_TYPES = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "mdown",
  "rst",
  "log",
]);

export function isWordDocumentType(fileType: string | null | undefined) {
  return WORD_TYPES.has((fileType ?? "").toLowerCase());
}

export function isSpreadsheetDocumentType(fileType: string | null | undefined) {
  return SPREADSHEET_TYPES.has((fileType ?? "").toLowerCase());
}

export function isPresentationDocumentType(fileType: string | null | undefined) {
  return PRESENTATION_TYPES.has((fileType ?? "").toLowerCase());
}

export function isPlainTextDocumentType(fileType: string | null | undefined) {
  return PLAIN_TEXT_TYPES.has((fileType ?? "").toLowerCase());
}

export function shouldConvertToPdf(fileType: string | null | undefined) {
  const normalized = (fileType ?? "").toLowerCase();
  // Spreadsheets are intentionally excluded: they are rendered natively as a
  // grid in the frontend (Fortune-sheet) from the raw file bytes rather than a
  // PDF rendition, which clipped wide/large sheets.
  return (
    isWordDocumentType(normalized) || isPresentationDocumentType(normalized)
  );
}

export function contentTypeForDocumentType(fileType: string | null | undefined) {
  switch ((fileType ?? "").toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xlsm":
      return "application/vnd.ms-excel.sheet.macroEnabled.12";
    case "xls":
      return "application/vnd.ms-excel";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "eml":
      return "message/rfc822";
    case "md":
    case "markdown":
    case "mdown":
      return "text/markdown; charset=utf-8";
    case "txt":
    case "text":
    case "rst":
    case "log":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
import { imageValidationError } from "./llm/images";
