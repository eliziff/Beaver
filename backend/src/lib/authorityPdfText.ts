import { preparePdf, type PdfPreparationProgress } from "./sourceDocument";
import type { PdfProfileSelection } from "./documentStore";
import { sha256 } from "./hash";
import { structureNative, type NativeDocument } from "./structureNative";
import type { PassageTarget } from "mike/shared/engine-types/PassageTarget";
import type { AuthoritiesBuildSettings } from "./authoritiesDomain";

type Prepared = Awaited<ReturnType<typeof preparePdf>>;

/** Whether an authority's PDF is read as an instrument: a legislation authority's is, so the parser reads its numbered
 *  provisions as its sections. Every reader of an authority's PDF asks this, and so asks for one reading of it. */
export const instrumentReading = (authority?: { kind: string }) => authority?.kind === "legislation";

/** The authority's own headings, read from the PDF it is reproduced from. */
export async function authorityPdfOutline(input: {
  bytes: Buffer; documentId?: string; versionId?: string; sourceSha256?: string;
  pdfProfile?: PdfProfileSelection; instrument?: boolean; signal?: AbortSignal;
}) {
  const sourceSha256 = input.sourceSha256 ?? sha256(input.bytes);
  const reference = { documentId: input.documentId ?? `standalone-authority:${sourceSha256}`,
    versionId: input.versionId ?? sourceSha256, sourceSha256 };
  // Recognized text already retained for the source is read too; nothing new is recognized.
  const prepared = await preparePdf({ ...reference, bytes: input.bytes, signal: input.signal, instrument: input.instrument,
    ...(input.pdfProfile ? { pdfProfile: input.pdfProfile } : { ocrProvider: null, layout: false }) });
  return structureNative().documentOutline(prepared.document)
    .flatMap(({ title, ...entry }) => entry.kind === "heading" && title ? [{ ...entry, title }] : []);
}

/** A source PDF as a build reads it: the document its text and passages are read from, recognized as the scan setting
 *  asks; where only some of its pages were recognized, those pages and the unrecognized reading of the rest. Null for
 *  a PDF without pages. */
export type AuthorityPdfReading = { document: NativeDocument; native?: NativeDocument; recognizedPages?: number[] };

export async function authorityPdfReading(input: {
  bytes: Buffer;
  citations?: string[];
  documentId?: string;
  versionId?: string;
  sourceSha256?: string;
  pdfProfile?: PdfProfileSelection;
  /** The PDF is an instrument (`instrumentReading`). */
  instrument?: boolean;
  /** The passages a cited-pages scan setting recognizes the pages of. */
  ocrTargets?: PassageTarget[];
  scannedPdfPolicy?: AuthoritiesBuildSettings["scannedPdfPolicy"];
  /** Pages recognized so far, of those this pass reads. */
  progress?: (recognized: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<AuthorityPdfReading | null> {
  const sourceSha256 = input.sourceSha256 ?? sha256(input.bytes);
  const reference = { documentId: input.documentId ?? `standalone-authority:${sourceSha256}`,
    versionId: input.versionId ?? sourceSha256, sourceSha256 };
  const policy = input.scannedPdfPolicy ?? "page-margin";
  const targets = input.ocrTargets ?? [];
  const pageOnly = targets.length > 0 && targets.every(target => target.locatorKind === "page" && !target.exactQuotes?.length);
  const options = { ...reference, bytes: input.bytes, instrument: input.instrument, signal: input.signal };
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
  // A retained preparation of another kind of reading (one not read as an instrument) names none of this one's.
  if (retained && retained.profile.profile === native.profile.profile && native.cacheKey !== retained.cacheKey)
    throw new Error("Prepared authority PDF profile changed.");
  if (!native.pageCount) return null;
  const citations = input.citations ?? [];
  let recognized = native;
  let recognizedPages: Set<number> | undefined;
  if (policy === "full" && native.pagesNeedingOcr.length) {
    recognized = await preparePdf({ ...recognition, ocrProvider: "indra" });
  } else if (policy === "cited-pages") {
    if (targets.length && targets.every(({ locatorKind }) => locatorKind === "page")) {
      // Each pinpoint's PDF pages, zero-based, by the page map of the PDF as `prepared` reads it.
      const locate = (prepared: Prepared) => structureNative().pdfPrintedPages(prepared.document,
        citations, targets.map(target => target.locator)).map(pages => pages.map(page => page - 1));
      let located = locate(native);
      // Cited-page OCR is explicitly requested: establish the reporter offset
      // before resolving its pinpoints, retaining the anchor in the partial pass.
      const openingPages: number[] = [];
      if (structureNative().reporterStartPages(citations).length) {
        for (let page = 1; located.some(pages => !pages.length) &&
            page <= Math.min(3, native.pageCount); page++) {
          if (!recognized.pagesNeedingOcr.includes(page - 1)) continue;
          openingPages.push(page);
          recognized = await preparePdf({ ...recognition, ocrProvider: "indra", pages: [...openingPages] });
          located = locate(recognized);
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
  input.signal?.throwIfAborted();
  return { document: recognized.document, ...(recognizedPages && recognized !== native
    ? { native: native.document, recognizedPages: [...recognizedPages] } : {}) };
}
