import { readFile } from "node:fs/promises";
import { ApplicationError } from "./applicationError";
import { validateDocumentFile } from "./documentTypes";
import { preparePdf } from "./sourceDocument";
import type { DocumentFile } from "./documentStore";
import { sha256 } from "./hash";
import { pdfFailureKind, structureNative, type NativeDocument } from "./structureNative";

export async function prepareCourtRecordPdf(file: DocumentFile, requestedPages: unknown) {
  const pages = selectedOcrPages(requestedPages);
  const bytes = "bytes" in file ? file.bytes : await readFile(file.path);
  if ("sizeBytes" in file && bytes.byteLength !== file.sizeBytes) {
    throw new Error("Uploaded file size changed while reading");
  }
  const validated = validateDocumentFile(file.filename, bytes);
  if (!validated.ok || validated.fileType !== "pdf" || file.fileType !== "pdf") {
    throw new ApplicationError(400,
      validated.ok ? "A PDF is required" : validated.error);
  }
  const digest = sha256(bytes), documentId = `court-record:${digest}`,
    versionId = `source:${digest}`;
  try {
    const prepared = await preparePdf({ documentId, versionId, bytes,
      sourceSha256: digest, pages, ocrProvider: "indra" });
    if (prepared.pageCount > 2_000) {
      throw new ApplicationError(409, "This PDF has an unsupported page count");
    }
    const pageText = courtRecordPageText(prepared.document);
    return { source_sha256: digest, page_count: prepared.pageCount,
      parser_status: prepared.status,
      ocr_pages: prepared.ocrRoutedPages.map((page) => page + 1),
      pages: pageText };
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    const kind = pdfFailureKind(error);
    if (kind === "encrypted") throw new ApplicationError(409, (error as Error).message);
    if (kind === "corrupt" || kind === "parser") throw new ApplicationError(400, (error as Error).message);
    throw error;
  }
}

/** Each page's text of a prepared PDF, a scanned page's empty where nothing was recognized on it. */
export function courtRecordPageText(document: NativeDocument) {
  return structureNative().pdfPageTexts(document)
    .map((text, index) => ({ page_number: index + 1, text }));
}

function selectedOcrPages(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 2_000 ||
      !value.every((page) => typeof page === "number" && Number.isSafeInteger(page) &&
        page > 0 && page <= 2_000)) {
    throw new ApplicationError(400, "OCR pages must be one-based page numbers");
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

