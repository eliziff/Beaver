import { documentProjectionService } from "./documentProjectionService";
import type { PdfProfileSelection } from "./documentStore";
import { sha256 } from "./hash";
import type { NativePdfPassageGeometry, NativePdfPassageTarget } from "./structureNative";

type Projection = Pick<typeof documentProjectionService, "preparePdf" | "lookupPdf"> &
  Partial<Pick<typeof documentProjectionService, "pdfPassageGeometry">>;

export async function authorityPdfText(input: {
  bytes: Buffer;
  documentId?: string;
  versionId?: string;
  sourceSha256?: string;
  pdfProfile?: PdfProfileSelection;
  passageTargets?: NativePdfPassageTarget[];
  nativeOnly?: boolean;
  signal?: AbortSignal;
}, projection: Projection = documentProjectionService) {
  const sourceSha256 = input.sourceSha256 ?? sha256(input.bytes);
  const documentId = input.documentId ?? `standalone-authority:${sourceSha256}`;
  const versionId = input.versionId ?? sourceSha256;
  const prepared = await projection.preparePdf({ documentId, versionId,
    bytes: input.bytes, sourceSha256, signal: input.signal, ...(input.pdfProfile
      ? { pdfProfile: input.pdfProfile }
      : { ocrProvider: input.nativeOnly ? null : "kraken-lite" as const }) });
  if (input.pdfProfile && prepared.cacheKey !== input.pdfProfile.cacheKey) {
    throw new Error("Prepared authority PDF profile changed.");
  }
  const routed = new Set(prepared.ocrRoutedPages);
  if (!prepared.pageCount) return { pageTextByPage: [], ocrTextByPage: [] };
  const lookups = await Promise.all(Array.from({ length: prepared.pageCount }, (_, index) =>
    projection.lookupPdf(() => input.bytes, { locatorKind: "page", locator: String(index + 1),
      contextBlocks: 0 }, { persistEvidence: false, documentId, versionId, sourceSha256,
      signal: input.signal, pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile,
        status: prepared.status } })));
  if (lookups.some(({ status }) => status !== "found" && status !== "unavailable"))
    throw new Error("Prepared authority PDF text is unavailable.");
  const text = new Map(lookups.flatMap((lookup) =>
    lookup.status === "found" ? lookup.pages.map((page) => [page.page_number, page.text] as const) : []));
  const pageTextByPage = Array.from({ length: prepared.pageCount }, (_, index) =>
    text.get(index + 1) ?? "");
  let passageGeometry: NativePdfPassageGeometry | undefined;
  if (input.passageTargets?.length) {
    if (!projection.pdfPassageGeometry) throw new Error("PDF passage geometry is unavailable.");
    for (let offset = 0; offset < input.passageTargets.length; offset += 100) {
      const geometry = await projection.pdfPassageGeometry(() => input.bytes,
        input.passageTargets.slice(offset, offset + 100),
        { documentId, versionId, sourceSha256, cacheKey: prepared.cacheKey },
        { signal: input.signal, pdfProfile: { cacheKey: prepared.cacheKey,
          profile: prepared.profile, status: prepared.status } });
      passageGeometry = passageGeometry
        ? { ...passageGeometry, targets: [...passageGeometry.targets, ...geometry.targets] }
        : geometry;
    }
  }
  return { pageTextByPage,
    ocrTextByPage: pageTextByPage.map((value, index) => routed.has(index) ? value : ""),
    ...(passageGeometry ? { passageGeometry } : {}) };
}
