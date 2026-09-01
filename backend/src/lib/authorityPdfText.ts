import { documentProjectionService } from "./documentProjectionService";
import type { PdfProfileSelection } from "./documentStore";
import { sha256 } from "./hash";

type Projection = Pick<typeof documentProjectionService, "preparePdf" | "lookupPdf">;

export async function authorityPdfOcrText(input: {
  bytes: Buffer;
  documentId?: string;
  versionId?: string;
  sourceSha256?: string;
  pdfProfile?: PdfProfileSelection;
}, projection: Projection = documentProjectionService) {
  const sourceSha256 = input.sourceSha256 ?? sha256(input.bytes);
  const documentId = input.documentId ?? `standalone-authority:${sourceSha256}`;
  const versionId = input.versionId ?? sourceSha256;
  const prepared = await projection.preparePdf({ documentId, versionId,
    bytes: input.bytes, sourceSha256, ...(input.pdfProfile
      ? { pdfProfile: input.pdfProfile }
      : { ocrProvider: "kraken-lite" as const }) });
  if (input.pdfProfile && prepared.cacheKey !== input.pdfProfile.cacheKey) {
    throw new Error("Prepared authority PDF profile changed.");
  }
  const routed = new Set(prepared.ocrRoutedPages);
  if (!routed.size) return [];
  const lookup = await projection.lookupPdf(() => input.bytes, {
    locatorKind: "page", locator: prepared.pageCount === 1 ? "1" : `1-${prepared.pageCount}`,
    contextBlocks: 0,
  }, { persistEvidence: false, documentId, versionId, sourceSha256,
    pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile,
      status: prepared.status } });
  if (lookup.status !== "found") throw new Error("Prepared authority PDF text is unavailable.");
  const text = new Map(lookup.pages.map((page) => [page.page_number, page.text]));
  return Array.from({ length: prepared.pageCount }, (_, index) =>
    routed.has(index) ? text.get(index + 1) ?? "" : "");
}
