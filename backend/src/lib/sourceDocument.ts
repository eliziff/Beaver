import { profileFor } from "./pdfProfile";
import { ApplicationError } from "./applicationError";
import { sha256 } from "./hash";
import { storeDirectory } from "./contentStore";
import { structureNative, type NativeDocument, type NativePdfTextPage,
  type PdfPreparationSummary } from "./structureNative";
import { isPresentationDocumentType, isWordDocumentType } from "./documentTypes";
import { docxToPdf } from "./convert";
import { pdfLifecyclePhase } from "./pdfLifecycleDiagnostics";
import { oneAtATime } from "mike/shared/one-at-a-time.mjs";
import type { DocumentSource, LegalPdfOcrProvider, LegalPdfProfile,
  PdfProfileSelection } from "./documentStore";

/** A stored source read as the engine's document (structureNative's `openSource`): the engine routes each format to
 *  its reader and keeps the documents it read. A Word or PowerPoint binary is converted to PDF first, by LibreOffice,
 *  which no engine reads in its place. */

const CACHE_DIRECTORY = storeDirectory("legalpdf-cache", sha256("legalpdf-cache-v1"));
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export type PdfParseStatus = "ready" | "degraded";
export type PdfOcrProvider = LegalPdfOcrProvider;
export type PdfPreparationProgress = {
  phase: "extracting";
  pages: number[];
} | { phase: "recognizing"; recognized: number; total: number };

/** The reading a PDF's pages are numbered from: its own text layer, neither recognized nor laid out by a model. */
export const PLAIN_PDF = { ocrProvider: null, layout: false } as const;

/** A source as the engine reads it: whose version it is, the hash its bytes must have, its bytes, the PDF reading
 *  prepared of it, and, for a repository's source, how to recheck it is still the version asked for. */
type Source = Pick<DocumentSource, "documentId" | "versionId" | "sourceSha256" | "readBytes"> &
  Partial<Pick<DocumentSource, "fileType" | "pdfProfile" | "assertAvailable">>;

type OpenOptions = {
  mode?: "text" | "drafting" | "redline";
  /** A PDF read afresh: the pages it recognizes, and the profile it is read with in place of the prepared one. */
  pages?: number[];
  ocrProvider?: PdfOcrProvider | null;
  layout?: boolean | null;
  signal?: AbortSignal;
  progress?: (value: PdfPreparationProgress) => void | Promise<void>;
};

function validId(value: string) {
  return value === value.trim() && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertSource(source: Pick<Source, "documentId" | "versionId">) {
  if (!validId(source.documentId) || !validId(source.versionId))
    throw new Error("Reading a document requires valid document and version IDs");
}

const fileTypeOf = (source: Pick<Source, "fileType">) => (source.fileType ?? "pdf").trim().toLowerCase();
/** A Word or PowerPoint binary, which is read as the PDF converted from it. */
const converted = (fileType: string) => fileType !== "docx" && isWordDocumentType(fileType) ||
  fileType !== "pptx" && isPresentationDocumentType(fileType);

const pdfRequest = (profile: LegalPdfProfile, pages?: number[], cacheKey?: string) => ({
  cache_dir: CACHE_DIRECTORY, max_output_bytes: MAX_OUTPUT_BYTES, ...profile,
  ...(pages ? { pages } : {}), ...(cacheKey ? { cache_key: cacheKey } : {}),
});

const sourceRequest = (source: Pick<Source, "documentId" | "versionId" | "sourceSha256">, fileType: string,
  mode: OpenOptions["mode"], pdf?: ReturnType<typeof pdfRequest>) => ({
  document_id: source.documentId, version_id: source.versionId, file_type: fileType,
  source_sha256: source.sourceSha256, mode: mode ?? "text", ...(pdf ? { pdf } : {}),
});

// An abandoned reader must neither wait for a shared read nor cancel it for another reader.
function abandonable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void pending.then(value => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

// One recognition pass already schedules every core, and each pass loads its own model
// sessions: a second concurrent pass only multiplies memory, so passes wait their turn,
// unless the engine's host reads every pass's pages on one pool of its own (the browser page).
const oneRecognitionAtATime = oneAtATime();
const recognitionTurn = <T>(run: () => Promise<T>, signal?: AbortSignal) => {
  const engine = structureNative();
  return "schedulesRecognition" in engine && engine.schedulesRecognition === true
    ? run() : oneRecognitionAtATime(run, signal);
};

/** The engine's document of a source: the one it keeps, or, read from the source's bytes, a fresh one. A PDF is its
 *  prepared reading where it has one (its cache key), else read with the profile asked for. */
export async function openDocument(source: Source, options: OpenOptions = {}): Promise<NativeDocument> {
  options.signal?.throwIfAborted();
  assertSource(source);
  const fileType = fileTypeOf(source), native = structureNative();
  const pdf = fileType === "pdf" || converted(fileType);
  const overridden = options.ocrProvider !== undefined || options.layout !== undefined;
  const cacheKey = fileType === "pdf" ? source.pdfProfile?.cacheKey : undefined;
  const pages = !cacheKey && options.pages?.length
    ? [...new Set(options.pages)].sort((left, right) => left - right) : undefined;
  const request = sourceRequest(source, fileType, options.mode, pdf ? pdfRequest(overridden || !source.pdfProfile
    ? profileFor(options.ocrProvider, options.layout) : source.pdfProfile.profile, pages, cacheKey) : undefined);
  const pending = (async () => {
    await source.assertAvailable?.();
    let document = await native.openSource(undefined, request);
    if (!document) {
      const bytes = await source.readBytes();
      if (pdf) await options.progress?.({ phase: "extracting", pages: pages ?? [] });
      document = await pdfLifecyclePhase("prepare.native", source.documentId, async () =>
        native.openSource(converted(fileType) ? await docxToPdf(bytes) : bytes, request));
    }
    await source.assertAvailable?.();
    return document!;
  })();
  const document = await abandonable(pending, options.signal);
  options.signal?.throwIfAborted();
  return document;
}

/** The PDF reading its parser cached under `cacheKey`, or none: a reading no longer cached is not made again. */
export async function cachedPdf(source: Pick<Source, "documentId" | "versionId" | "sourceSha256">, cacheKey: string) {
  assertSource(source);
  return structureNative().openSource(undefined, sourceRequest(source, "pdf", "text", pdfRequest({}, undefined, cacheKey)));
}

/** A source's text: a PDF's (and a converted Word or PowerPoint binary's) its document's, any other the text its
 *  format's reader gives (a Word document's drafting text where asked), at most `limit` UTF-16 units. */
export async function sourceText(source: Source & { fileType: string }, options: {
  drafting?: boolean; limit?: number; signal?: AbortSignal;
} = {}) {
  options.signal?.throwIfAborted();
  assertSource(source);
  const fileType = fileTypeOf(source);
  if (fileType === "pdf" || converted(fileType)) {
    const document = await openDocument(source, { signal: options.signal });
    return structureNative().documentText(document, options.limit);
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0))
    throw new RangeError("Document text limit must be a nonnegative safe integer");
  const pending = (async () => {
    await source.assertAvailable?.();
    const text = await structureNative().sourceText(await source.readBytes(), {
      file_type: fileType, source_sha256: source.sourceSha256, drafting: !!options.drafting,
      limit: options.limit ?? null });
    await source.assertAvailable?.();
    return text;
  })();
  const text = await abandonable(pending, options.signal);
  options.signal?.throwIfAborted();
  return text;
}

/** A prepared PDF's summary as its readers take it: ready, or degraded where pages still need recognition. */
export function pdfSummary(result: PdfPreparationSummary) {
  return {
    status: (result.status === "ready" ? "ready" : "degraded") as PdfParseStatus,
    sourceSha256: result.sha256,
    parserVersion: result.parserVersion,
    cacheKey: result.cacheKey,
    pageCount: result.pageCount,
    pagesNeedingOcr: result.pagesNeedingOcr,
    ocrRoutedPages: result.ocrRoutedPages,
  };
}

type PdfPrepareInput = {
  documentId: string;
  versionId: string;
  bytes: Buffer;
  sourceSha256?: string;
  pages?: number[];
  ocrProvider?: PdfOcrProvider | null;
  layout?: boolean | null;
  pdfProfile?: PdfProfileSelection;
  signal?: AbortSignal;
  progress?: (value: PdfPreparationProgress) => void | Promise<void>;
};

/** Prepares a PDF's reading and caches it, recognizing its pages where its profile does; a prepared reading the
 *  engine still has is its summary. */
export async function preparePdf(input: PdfPrepareInput) {
  input.signal?.throwIfAborted();
  assertSource(input);
  if (input.pdfProfile && (input.ocrProvider !== undefined || input.layout !== undefined))
    throw new Error("PDF preparation cannot combine a stored profile with overrides");
  const profile: LegalPdfProfile = input.pdfProfile?.profile ?? profileFor(input.ocrProvider, input.layout);
  const pages = input.pages?.length ? input.pages : undefined;
  await input.progress?.({ phase: "extracting", pages: pages ?? [] });
  const native = structureNative();
  if (input.pdfProfile && !pages) {
    const sourceSha256 = input.sourceSha256 ?? sha256(input.bytes);
    const kept = await native.openSource(undefined, sourceRequest({ ...input, sourceSha256 }, "pdf", "text",
      pdfRequest(profile, undefined, input.pdfProfile.cacheKey)));
    // A reading no longer kept is made again below, as it was first made.
    if (kept) return { ...pdfSummary(native.pdfDocumentSummary(kept)), profile };
  }
  const request = { ...pdfRequest(profile, pages), id: `${input.documentId}:${input.versionId}`,
    ...(input.sourceSha256 ? { expected_source_sha256: input.sourceSha256 } : {}) };
  const prepare = () => pdfLifecyclePhase("prepare.native", input.documentId, () =>
    native.preparePdfDocument(input.bytes, request, input.signal, input.progress &&
      ((recognized, total) => void input.progress?.({ phase: "recognizing", recognized, total }))));
  const summary = await (profile.ocr ? recognitionTurn(prepare, input.signal) : prepare());
  input.signal?.throwIfAborted();
  return { ...pdfSummary(summary), profile };
}

/** The recognized text of a PDF's pages (at most 16), each page from the reading that recognized it: the reading its
 *  profile names, or the one that recognized it alone. */
export async function pdfTextLayer(
  readBytes: () => Buffer | Promise<Buffer>,
  reference: { documentId: string; versionId: string; sourceSha256: string },
  options: { pages?: number[]; pdfProfile?: PdfProfileSelection; signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const requested = options.pages;
  if (requested && (!requested.length || requested.length > 16 ||
      requested.some(page => !Number.isSafeInteger(page) || page < 1)))
    throw new ApplicationError(400, "Request between 1 and 16 PDF text pages");
  const profile = options.pdfProfile;
  if (!profile) return [];
  const owners = profile.textLayerPages ?? {};
  const owner = (page: number) => owners[page] ?? (profile.profile.ocr ? profile.cacheKey : undefined);
  const keys = new Set(requested ? requested.map(owner).filter((key): key is string => !!key)
    : [...(profile.profile.ocr ? [profile.cacheKey] : []), ...Object.values(owners)]);
  if (!keys.size) return [];
  const native = structureNative(), result = new Map<number, NativePdfTextPage>();
  const unavailable = () => new ApplicationError(409, "This PDF's recognized text could not be read.");
  for (const key of keys) {
    options.signal?.throwIfAborted();
    // A reading no longer kept is made again as it was first made (a page-bound one for its own pages): whoever
    // asks for its text never learns it was gone.
    const pages = key === profile.cacheKey ? undefined
      : Object.entries(owners).filter(([, owner]) => owner === key).map(([page]) => Number(page));
    const request = sourceRequest(reference, "pdf", "text", pdfRequest(profile.profile, pages, key));
    const document = await abandonable((async () => await native.openSource(undefined, request) ??
      await recognitionTurn(async () => native.openSource(await readBytes(), request), options.signal))(), options.signal);
    options.signal?.throwIfAborted();
    const geometry = document && native.pdfRecognizedText(document, requested?.filter(page => owner(page) === key));
    if (!geometry) throw unavailable();
    for (const page of geometry) if (owner(page.number) === key) result.set(page.number, page);
  }
  // Unfiltered reads are for automatic marking; the viewport only restores/copies its requested pages.
  return [...result.values()].sort((a, b) => a.number - b.number);
}
