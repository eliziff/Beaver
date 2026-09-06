import { inspectPdf } from "@/app/lib/inspectPdf";
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
      sourceBookmarks: [],
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
      sourceBookmarks: [],
      origin: { kind: "device" },
      inspectionError: "Use a PDF or Word (.docx) file allowed by this document slot.",
    };
  }
  try {
    const inspection = await inspectPdf(file);
    return {
      file,
      pageCount: inspection.pageCount,
      searchable: inspection.searchable,
      encrypted: inspection.encrypted,
      textlessPageCount: inspection.textlessPageCount,
      textlessPages: inspection.textlessPages,
      sourceBookmarks: inspection.sourceBookmarks,
      pageLabels: inspection.pageLabels,
      sourceFields: sourceDocumentFields(inspection.pageTexts),
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
      sourceBookmarks: [],
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
