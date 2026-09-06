import type { CourtSourceFormat, DocumentKind } from "./types";

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export function sourceFormat(file: Pick<File, "name" | "type">): CourtSourceFormat | undefined {
  if (file.type === "application/pdf" || /\.pdf$/iu.test(file.name)) return "pdf";
  if (file.type === DOCX_MIME || /\.docx$/iu.test(file.name)) return "docx";
  return undefined;
}

export function acceptedSourceFormats(kind: DocumentKind): CourtSourceFormat[] {
  return kind.acceptedFormats ?? ["pdf", "docx"];
}

export function needsPdfRendition(kind?: DocumentKind): boolean {
  return !(kind?.acceptedFormats?.length === 1 && kind.acceptedFormats[0] === "docx");
}

export function sourceAccept(kind: DocumentKind) {
  return acceptedSourceFormats(kind).flatMap((format) => format === "pdf"
    ? ["application/pdf", ".pdf"]
    : [DOCX_MIME, ".docx"]).join(",");
}

export function sourceFormatLabel(kind: DocumentKind) {
  const formats = acceptedSourceFormats(kind);
  if (formats.length === 2) return "PDF or Word";
  return formats[0] === "docx" ? "Word" : "PDF";
}
