import { readFile } from "node:fs/promises";
import { ApplicationError } from "./applicationError";
import { validateDocumentFile } from "./documentTypes";
import { documentProjectionService } from "./documentProjectionService";
import type { DocumentFile } from "./documentStore";
import { sha256 } from "./hash";

export async function prepareCourtRecordPdf(file: DocumentFile, requestedPages: unknown,
  projection: Pick<typeof documentProjectionService, "preparePdf" | "lookupPdf"> = documentProjectionService) {
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
    const prepared = await projection.preparePdf({ documentId, versionId, bytes,
      sourceSha256: digest, pages, ocrProvider: "kraken-lite" });
    if (!Number.isSafeInteger(prepared.pageCount) || prepared.pageCount < 1 ||
        prepared.pageCount > 2_000) {
      throw new ApplicationError(409, "This PDF has an unsupported page count");
    }
    const pageText = await courtRecordPageText(() => bytes, prepared.pageCount, projection, {
      persistEvidence: false, documentId, versionId, sourceSha256: digest,
      pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile,
        status: prepared.status },
    });
    return { source_sha256: digest, page_count: prepared.pageCount,
      parser_status: prepared.status,
      ocr_pages: prepared.ocrRoutedPages.map((page) => page + 1),
      pages: pageText };
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    if (error instanceof Error && error.name === "PdfEncrypted") {
      throw new ApplicationError(409, error.message);
    }
    if (error instanceof Error && ["PDF is invalid or corrupt",
      "PDF structural parser failed"].includes(error.message)) {
      throw new ApplicationError(400, error.message);
    }
    throw error;
  }
}

export async function courtRecordPageText(readBytes: () => Buffer | Promise<Buffer>, pageCount: number,
  projection: Pick<typeof documentProjectionService, "lookupPdf">,
  options: Parameters<typeof documentProjectionService.lookupPdf>[2]) {
  const pages = [];
  for (let page = 1; page <= pageCount; page++) {
    const lookup = await projection.lookupPdf(readBytes, {
      locatorKind: "page", locator: String(page), contextBlocks: 0,
    }, options);
    if (lookup.status !== "found" && lookup.status !== "unavailable") {
      throw new ApplicationError(409, "The prepared PDF page text is unavailable");
    }
    pages.push({ page_number: page, text: lookup.status === "found"
      ? lookup.pages.find(({ page_number }) => page_number === page)?.text ?? "" : "" });
  }
  return pages;
}

function selectedOcrPages(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 2_000 ||
      !value.every((page) => typeof page === "number" && Number.isSafeInteger(page) &&
        page > 0 && page <= 2_000)) {
    throw new ApplicationError(400, "OCR pages must be one-based page numbers");
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

