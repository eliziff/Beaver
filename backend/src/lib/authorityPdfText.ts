import { openDocument, PLAIN_PDF, preparePdf, type PdfPreparationProgress } from "./sourceDocument";
import type { PdfProfileSelection } from "./documentStore";
import { sha256 } from "./hash";
import { structureNative, type NativePdfPassageTarget } from "./structureNative";
import type { AuthoritiesBuildSettings } from "./authoritiesDomain";

type Prepared = Awaited<ReturnType<typeof preparePdf>>;

/** The authority's own headings, read from the PDF it is reproduced from. */
export async function authorityPdfOutline(input: {
  bytes: Buffer; documentId?: string; versionId?: string; sourceSha256?: string;
  pdfProfile?: PdfProfileSelection; signal?: AbortSignal;
}) {
  const sourceSha256 = input.sourceSha256 ?? sha256(input.bytes);
  const reference = { documentId: input.documentId ?? `standalone-authority:${sourceSha256}`,
    versionId: input.versionId ?? sourceSha256, sourceSha256 };
  // Recognized text already retained for the source is read too; nothing new is recognized.
  const prepared = await preparePdf({ ...reference, bytes: input.bytes, signal: input.signal,
    ...(input.pdfProfile ? { pdfProfile: input.pdfProfile } : { ocrProvider: null, layout: false }) });
  return structureNative().documentOutline(await openDocument({ ...reference, readBytes: () => input.bytes,
    pdfProfile: prepared }, { signal: input.signal }))
    .flatMap(({ title, ...entry }) => entry.kind === "heading" && title ? [{ ...entry, title }] : []);
}

export async function authorityPdfText(input: {
  bytes: Buffer;
  citations?: string[];
  maxPages?: number;
  documentId?: string;
  versionId?: string;
  sourceSha256?: string;
  pdfProfile?: PdfProfileSelection;
  /** Targets, or a function of the page text when the text says where they are. */
  passageTargets?: NativePdfPassageTarget[] | ((pageTextByPage: string[]) => NativePdfPassageTarget[]);
  ocrTargets?: NativePdfPassageTarget[];
  scannedPdfPolicy?: AuthoritiesBuildSettings["scannedPdfPolicy"];
  /** Pages recognized so far, of those this pass reads. */
  progress?: (recognized: number, total: number) => void;
  signal?: AbortSignal;
}) {
  const sourceSha256 = input.sourceSha256 ?? sha256(input.bytes);
  const documentId = input.documentId ?? `standalone-authority:${sourceSha256}`;
  const versionId = input.versionId ?? sourceSha256;
  const policy = input.scannedPdfPolicy ?? "page-margin";
  const listed = Array.isArray(input.passageTargets) ? input.passageTargets : [];
  const targets = input.ocrTargets ?? listed;
  const pageOnly = targets.length > 0 && [...targets, ...listed]
    .every(target => target.locatorKind === "page" && !target.exactQuotes?.length);
  const reference = { documentId, versionId, sourceSha256 };
  const options = { ...reference, bytes: input.bytes, signal: input.signal };
  // Physical page selection needs folios, not a whole-document layout model.
  const recognition = { ...options, ...(pageOnly ? { layout: false } : {}),
    ...(input.progress && { progress: (step: PdfPreparationProgress) => {
      if (step.phase === "recognizing") input.progress!(step.recognized, step.total);
    } }) };
  // Inspection never opts a newly uploaded source into recognition. Existing OCR
  // artifacts, including partial OCR, remain usable without expanding coverage.
  const retained = input.pdfProfile;
  const native = await preparePdf({ ...options, ...(retained ? { pdfProfile: retained }
    : { ocrProvider: null, ...(pageOnly ? { layout: false } : {}) }) });
  if (retained && native.cacheKey !== retained.cacheKey) throw new Error("Prepared authority PDF profile changed.");
  if (!native.pageCount) return { pageTextByPage: [], ocrTextByPage: [] };
  const document = (prepared: Prepared, plain = false) => openDocument({ ...reference,
    readBytes: () => input.bytes, pdfProfile: prepared }, { signal: input.signal,
    ...(plain ? PLAIN_PDF : {}) });
  const citations = input.citations ?? [];
  let recognized = native;
  let recognizedPages: Set<number> | undefined;
  if (policy === "full" && native.pagesNeedingOcr.length) {
    recognized = await preparePdf({ ...recognition, ocrProvider: "indra" });
  } else if (policy === "cited-pages") {
    if (targets.length && targets.every(({ locatorKind }) => locatorKind === "page")) {
      // Each pinpoint's PDF pages, zero-based, by the page map of the PDF as `prepared` reads it.
      const locate = async (prepared: Prepared) => structureNative().pdfPrintedPages(await document(prepared, true),
        citations, targets.map(target => target.locator)).map(pages => pages.map(page => page - 1));
      let located = await locate(native);
      // Cited-page OCR is explicitly requested: establish the reporter offset
      // before resolving its pinpoints, retaining the anchor in the partial pass.
      const openingPages: number[] = [];
      if (structureNative().reporterStartPages(citations).length) {
        for (let page = 1; located.some(pages => !pages.length) &&
            page <= Math.min(3, native.pageCount); page++) {
          if (!recognized.pagesNeedingOcr.includes(page - 1)) continue;
          openingPages.push(page);
          recognized = await preparePdf({ ...recognition, ocrProvider: "indra", pages: [...openingPages] });
          located = await locate(recognized);
        }
      }
      // A pinpoint no known printed page answers to is read from the whole scan, as a
      // paragraph is below; a PDF with no scanned pages needs no recognition either way.
      if (located.every(pages => pages.length)) {
        recognizedPages = new Set([...located.flat(), ...(retained?.profile.ocr ? native.ocrRoutedPages : [])]);
        openingPages.forEach(page => recognizedPages!.add(page - 1));
      }
    } else if (!targets.length) recognizedPages = new Set();
    // A paragraph or section on a scan cannot be located until the scan is read.
    // This fallback is disclosed beside the cited-pages option in the UI.
    if (recognized.pagesNeedingOcr.some(index => !recognizedPages || recognizedPages.has(index)))
      recognized = await preparePdf({ ...recognition,
      // Recognized pages are held zero-based for indexing; the engine numbers them from one.
      ocrProvider: "indra", ...(recognizedPages
        ? { pages: [...recognizedPages].map((index) => index + 1).sort((a, b) => a - b) } : {}) });
  }
  const routed = new Set(policy === "page-margin" ? [] : recognized.ocrRoutedPages);
  const pageCount = Math.min(native.pageCount, input.maxPages ?? native.pageCount);
  // One read of every page's text per prepared profile, not one lookup per page.
  const texts = async (prepared: Prepared) => structureNative().pdfPageTexts(await document(prepared));
  const nativeTexts = await texts(native);
  const recognizedTexts = recognized === native ? nativeTexts : await texts(recognized);
  input.signal?.throwIfAborted();
  const pageTextByPage = Array.from({ length: pageCount }, (_, index) =>
    (recognizedPages && !recognizedPages.has(index) ? nativeTexts : recognizedTexts)[index] ?? "");
  const passageTargets = typeof input.passageTargets === "function"
    ? input.passageTargets(pageTextByPage) : input.passageTargets;
  const passageGeometry = passageTargets?.length
    ? await structureNative().pdfPassageGeometry(await document(recognized), passageTargets, citations) : undefined;
  return { pageTextByPage,
    ocrTextByPage: pageTextByPage.map((value, index) => routed.has(index) ? value : ""),
    ...(passageGeometry ? { passageGeometry } : {}) };
}
