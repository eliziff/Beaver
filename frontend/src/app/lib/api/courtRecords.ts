import { multipartRequest, apiRequest, pagePath, segment } from "@/app/lib/api/client";
import type { Document } from "@/app/lib/api/documents";
import type { WorkProductBuildReceipt, WorkProduct } from "@/app/lib/workProducts";

export const uploadCourtRecordDocument = (file: File, workProductId?: string) =>
  multipartRequest<Document>("/court-records/documents", file,
    workProductId ? { fields: { work_product_id: workProductId } } : undefined);
export const saveCourtRecordBuild = <State>(artifacts: Array<{
  file: File; receipt: WorkProductBuildReceipt;
}>) => {
  const body = new FormData();
  for (const { file, receipt } of artifacts) {
    body.append("files", file);
    body.append("receipts", JSON.stringify(receipt));
  }
  return apiRequest<WorkProduct<State>>("/court-records/builds", { method: "POST", body });
};
/** A PDF as the engine reads it, without recognizing any page: its page count, the pages (from 1) needing
 *  recognition, its page labels and each page's text; encrypted where it could not be opened. */
export type CourtRecordPdfInspection = {
  page_count: number; encrypted: boolean; textless_pages: number[]; page_labels: string[] | null;
  pages: Array<{ page_number: number; text: string }>;
};
export const inspectCourtRecordPdf = (file: File) => {
  const body = new FormData();
  body.append("file", file, file.name);
  return apiRequest<CourtRecordPdfInspection>("/court-records/pdf-preparation", { method: "POST", body });
};
export type CourtRecordPreparation = {
  document_id: string;
  version_id: string;
  source_sha256: string;
  page_count: number;
  parser_status: "ready" | "degraded";
  pages: Array<{ page_number: number; text: string }>;
};
export const getCourtRecordPreparation = (
  documentId: string,
  versionId?: string | null,
) => apiRequest<CourtRecordPreparation>(
  pagePath(`/court-records/documents/${segment(documentId)}/preparation`, {
    version_id: versionId,
  }),
);
