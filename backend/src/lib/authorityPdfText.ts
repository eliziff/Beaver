import { documentProjectionService } from "./documentProjectionService";
import type { PdfProfileSelection } from "./documentStore";
import { sha256 } from "./hash";
import type { NativePdfPassageGeometry, NativePdfPassageTarget } from "./structureNative";
import type { AuthoritiesBuildSettings } from "./authoritiesDomain";

type Projection = Pick<typeof documentProjectionService, "preparePdf" | "lookupPdf"> &
  Partial<Pick<typeof documentProjectionService, "pdfPassageGeometry">>;

export async function authorityPdfText(input: {
  bytes: Buffer;
  maxPages?: number;
  documentId?: string;
  versionId?: string;
  sourceSha256?: string;
  pdfProfile?: PdfProfileSelection;
  passageTargets?: NativePdfPassageTarget[];
  ocrTargets?: NativePdfPassageTarget[];
  scannedPdfPolicy?: AuthoritiesBuildSettings["scannedPdfPolicy"];
  signal?: AbortSignal;
}, projection: Projection = documentProjectionService) {
  const sourceSha256 = input.sourceSha256 ?? sha256(input.bytes);
  const documentId = input.documentId ?? `standalone-authority:${sourceSha256}`;
  const versionId = input.versionId ?? sourceSha256;
  const policy = input.scannedPdfPolicy ?? "page-margin";
  const reference = { documentId, versionId, sourceSha256 };
  const options = { ...reference, bytes: input.bytes, signal: input.signal };
  const selectedProfile = (prepared: Awaited<ReturnType<Projection["preparePdf"]>>) => ({
    cacheKey: prepared.cacheKey, profile: prepared.profile, status: prepared.status,
  });
  // Inspection never opts a newly uploaded source into recognition. Existing OCR
  // artifacts may be reused for an explicit full-recognition choice only.
  const retained = input.pdfProfile && (policy === "full"
    ? !!input.pdfProfile.profile.ocr : !input.pdfProfile.profile.ocr) ? input.pdfProfile : undefined;
  const native = await projection.preparePdf({ ...options, ...(retained ? { pdfProfile: retained }
    : { ocrProvider: policy === "full" ? "kraken-lite" as const : null }) });
  if (retained && native.cacheKey !== retained.cacheKey) throw new Error("Prepared authority PDF profile changed.");
  if (!native.pageCount) return { pageTextByPage: [], ocrTextByPage: [] };
  let recognized = native;
  let recognizedPages: Set<number> | undefined;
  const geometry = async (targets: NativePdfPassageTarget[], prepared = recognized) => {
    if (!projection.pdfPassageGeometry) throw new Error("PDF passage geometry is unavailable.");
    let result: NativePdfPassageGeometry | undefined;
    for (let offset = 0; offset < targets.length; offset += 100) {
      input.signal?.throwIfAborted();
      const next = await projection.pdfPassageGeometry(() => input.bytes, targets.slice(offset, offset + 100),
        { ...reference, cacheKey: prepared.cacheKey },
        { signal: input.signal, pdfProfile: selectedProfile(prepared) });
      result = result ? { ...result, targets: [...result.targets, ...next.targets] } : next;
    }
    return result;
  };
  if (policy === "cited-pages") {
    const targets = input.ocrTargets ?? input.passageTargets ?? [];
    if (targets.length && targets.every(({ locatorKind }) => locatorKind === "page")) {
      const located = await geometry(targets, native);
      if (located?.targets.some(({ status }) => status !== "found"))
        throw new Error("The cited PDF pages could not be identified. Check the page pinpoints or choose whole-PDF recognition.");
      recognizedPages = new Set(located?.targets.flatMap(({ pages }) => pages.map(({ pageNumber }) => pageNumber - 1)) ?? []);
    } else if (!targets.length) recognizedPages = new Set();
    // A paragraph or section on a scan cannot be located until the scan is read.
    // This fallback is disclosed beside the cited-pages option in the UI.
    if (!recognizedPages || recognizedPages.size) recognized = await projection.preparePdf({ ...options,
      // Recognized pages are held zero-based for indexing; the engine numbers them from one.
      ocrProvider: "kraken-lite", ...(recognizedPages
        ? { pages: [...recognizedPages].map((index) => index + 1).sort((a, b) => a - b) } : {}) });
  }
  const routed = new Set(policy === "page-margin" ? [] : recognized.ocrRoutedPages);
  const pageTextByPage: string[] = [], pageCount = Math.min(native.pageCount, input.maxPages ?? native.pageCount);
  // Bound concurrent page requests rather than opening hundreds of page lookups at once.
  for (let offset = 0; offset < pageCount; offset += 8) {
    input.signal?.throwIfAborted();
    const lookups = await Promise.all(Array.from({ length: Math.min(8, pageCount - offset) }, async (_, at) => {
      const index = offset + at;
      const prepared = recognizedPages && !recognizedPages.has(index) ? native : recognized;
      const lookup = await projection.lookupPdf(() => input.bytes, { locatorKind: "page", locator: String(index + 1),
        contextBlocks: 0 }, { persistEvidence: false, ...reference,
        signal: input.signal, pdfProfile: selectedProfile(prepared) });
      if (lookup.status !== "found" && lookup.status !== "unavailable")
        throw new Error("Prepared authority PDF text is unavailable.");
      return lookup.status === "found" ? lookup.pages.find(({ page_number }) => page_number === index + 1)?.text ?? "" : "";
    }));
    pageTextByPage.push(...lookups);
  }
  const passageGeometry = input.passageTargets?.length ? await geometry(input.passageTargets) : undefined;
  return { pageTextByPage,
    ocrTextByPage: pageTextByPage.map((value, index) => routed.has(index) ? value : ""),
    ...(passageGeometry ? { passageGeometry } : {}) };
}
