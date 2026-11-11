import { inspectCourtRecordPdf } from "@/app/lib/api/courtRecords";
import { sourceFormat } from "./formats";
import type { PreparedFile, PreparationProgress } from "./host";
import { sourceDocumentFields } from "./sourceFields";

export async function prepareDeviceFile(
  file: File,
  _progress?: PreparationProgress,
): Promise<PreparedFile> {
  const format = sourceFormat(file);
  if (format === "docx") {
    return {
      file,
      pageCount: null,
      searchable: null,
      encrypted: null,
      textlessPageCount: 0,
      textlessPages: [],
      origin: { kind: "device" },
    };
  }
  if (format !== "pdf") {
    return {
      file,
      pageCount: null,
      searchable: null,
      encrypted: null,
      textlessPageCount: 0,
      textlessPages: [],
      origin: { kind: "device" },
      inspectionError: "Use a PDF or Word (.docx) file allowed by this document slot.",
    };
  }
  try {
    // The engine reads the PDF; the browser does not parse it.
    const inspection = await inspectCourtRecordPdf(file), texts = inspection.pages.map(({ text }) => text);
    return {
      file,
      pageCount: inspection.page_count,
      searchable: texts.some((text) => text.trim()),
      encrypted: inspection.encrypted,
      textlessPageCount: inspection.textless_pages.length,
      textlessPages: inspection.textless_pages,
      pageLabels: inspection.page_labels,
      sourceFields: sourceDocumentFields(texts),
      origin: { kind: "device" },
    };
  } catch (error) {
    return {
      file,
      pageCount: null,
      searchable: null,
      encrypted: null,
      textlessPageCount: 0,
      textlessPages: [],
      origin: { kind: "device" },
      inspectionError: error instanceof Error ? error.message : "The PDF could not be inspected.",
    };
  }
}

export async function prepareDocxRendition(
  file: File,
  pdf: Blob,
  progress?: PreparationProgress,
): Promise<PreparedFile> {
  const pdfFile = new File([pdf], file.name.replace(/\.docx$/iu, ".pdf"), {
    type: "application/pdf",
  });
  return { ...await prepareDeviceFile(pdfFile, progress), file, pdfRendition: pdfFile };
}
