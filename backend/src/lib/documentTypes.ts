import { imageValidationError } from "./llm/images";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", eml: "message/rfc822",
  md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
  mdown: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
  text: "text/plain; charset=utf-8", rst: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8", doc: "application/msword",
};
const ALLOWED_DOCUMENT_TYPES = new Set(Object.keys(CONTENT_TYPES));

const ALLOWED_DOCUMENT_TYPES_LABEL =
  "pdf, docx, doc, xlsx, xlsm, xls, pptx, ppt, jpg, jpeg, png, gif, webp, eml, txt, md";

export function documentFileType(filename: string) {
  const fileType = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_DOCUMENT_TYPES.has(fileType)) {
    return { ok: false,
      error: `Unsupported file type: ${fileType}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
    } as const;
  }
  return { ok: true, fileType } as const;
}

export function validateDocumentFile(filename: string, bytes: Buffer,
  sizeBytes = bytes.byteLength) {
  const type = documentFileType(filename);
  if (!type.ok) return type;
  const { fileType } = type;
  const error = containerValidationError(fileType, bytes) ??
    imageValidationError(filename, bytes, sizeBytes);
  return error ? { ok: false, error } as const : { ok: true, fileType } as const;
}

const types = (value: string) => new Set(value.split(" "));
const ZIP_TYPES = types("docx xlsx xlsm pptx");
const OLE_TYPES = types("doc xls ppt");
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
function containerValidationError(fileType: string, bytes: Buffer) {
  if (!bytes.length) return "Document is empty.";
  const matches = fileType === "pdf"
    ? bytes.subarray(0, 1_024).includes(Buffer.from("%PDF-"))
    : ZIP_TYPES.has(fileType)
      ? bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      : OLE_TYPES.has(fileType)
        ? bytes.subarray(0, 8).equals(OLE_SIGNATURE) ||
          fileType === "doc" && bytes.subarray(0, 5).toString() === "{\\rtf"
        : true;
  return matches ? null : "Document content does not match its file type.";
}

const WORD_TYPES = types("docx doc");
const SPREADSHEET_TYPES = types("xlsx xlsm xls");
const PRESENTATION_TYPES = types("pptx ppt");
const PLAIN_TEXT_TYPES = types("txt text md markdown mdown rst log");

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
  return isWordDocumentType(normalized) || isPresentationDocumentType(normalized);
}

export function contentTypeForDocumentType(fileType: string | null | undefined) {
  return CONTENT_TYPES[(fileType ?? "").toLowerCase()] ?? "application/octet-stream";
}
