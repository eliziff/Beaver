import { profileFor } from "./pdfProfile";
import { ApplicationError } from "./applicationError";
import { sha256 } from "./hash";
import { storeDirectory } from "./contentStore";
import { structureNative, type NativeDocument } from "./structureNative";
import type { Page } from "mike/shared/engine-types/Page";
import { docxToPdf } from "./convert";
import { pdfLifecyclePhase } from "./pdfLifecycleDiagnostics";
import { oneAtATime } from "mike/shared/one-at-a-time.mjs";
import { abandonable } from "mike/shared/structure-engine.mjs";
import type { DocumentSource, LegalPdfOcrProvider, LegalPdfProfile,
  PdfProfileSelection } from "./documentStore";

/** A stored source read as the engine's document (structureNative's `openSource`): the engine routes each format to
 *  its reader and keeps the documents it read. A Word or PowerPoint binary is converted to PDF first, by LibreOffice,
 *  which no engine reads in its place. */

const CACHE_DIRECTORY = storeDirectory("legalpdf-cache", sha256("legalpdf-cache-v1"));
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export type PdfPreparationProgress = {
  phase: "extracting";
  pages: number[];
} | { phase: "recognizing"; recognized: number; total: number };

/** The reading a PDF's pages are numbered from: its own text layer, neither recognized nor laid out by a model, nor
 *  read by DOC. */
export const PLAIN_PDF = { ocrProvider: null, layout: false, doc: false } as const;

/** A source as the engine reads it: whose version it is, the hash its bytes must have, its bytes, the PDF reading
 *  prepared of it, and, for a repository's source, how to recheck it is still the version asked for. */
type Source = Pick<DocumentSource, "documentId" | "versionId" | "sourceSha256" | "readBytes"> &
  Partial<Pick<DocumentSource, "fileType" | "pdfProfile" | "assertAvailable">>;

type OpenOptions = {
  mode?: "text" | "drafting" | "redline";
  /** A PDF read afresh: the pages it recognizes, and the profile it is read with in place of the prepared one. */
  pages?: number[];
  ocrProvider?: LegalPdfOcrProvider | null;
  layout?: boolean | null;
  /** DOC (the structure stage's tier 1) asked for or not (`profileFor`); undefined, the server's own. */
  doc?: boolean | null;
  /** The PDF is an instrument (`asRead`). */
  instrument?: boolean;
  signal?: AbortSignal;
  progress?: (value: PdfPreparationProgress) => void | Promise<void>;
};

/** A PDF's profile as it is read: as an instrument where its reader knows it for one (a legislation authority's PDF,
 *  `instrumentReading`), whatever else the profile asks. A prepared reading's cache key names its own profile's reading
 *  only: it is asked for where the reading is of the same kind, and read afresh, recognition kept, where it is not. */
const asRead = (profile: LegalPdfProfile, instrument?: boolean): LegalPdfProfile =>
  instrument && profile.profile !== "instrument" ? { ...profile, profile: "instrument" } : profile;
const keyFor = (selection: PdfProfileSelection | undefined, profile: LegalPdfProfile) =>
  selection && selection.profile.profile === profile.profile ? selection.cacheKey : undefined;

/** A Word or PowerPoint binary, which the engine reads as the PDF converted from it. */
const converted = (fileType: string) => fileType === "doc" || fileType === "ppt";

const pdfRequest = (profile: LegalPdfProfile, pages?: number[], cacheKey?: string) => ({
  cacheDir: CACHE_DIRECTORY, maxOutputBytes: MAX_OUTPUT_BYTES, ...profile, ...(pages && { pages }), ...(cacheKey && { cacheKey }),
});

const sourceRequest = ({ documentId, versionId, sourceSha256 }: Pick<Source, "documentId" | "versionId" | "sourceSha256">,
  fileType: string, mode: OpenOptions["mode"], pdf?: ReturnType<typeof pdfRequest>) =>
  ({ documentId, versionId, sourceSha256, fileType, mode: mode ?? "text", ...(pdf && { pdf }) });

// One recognition pass already schedules every core, and each pass loads its own model
// sessions: a second concurrent pass only multiplies memory, so passes wait their turn,
// unless the engine's host reads every pass's pages on one pool of its own (the browser page).
const oneRecognitionAtATime = oneAtATime();
const recognitionTurn = <T>(run: () => Promise<T>, signal?: AbortSignal) => {
  const engine = structureNative();
  return "schedulesRecognition" in engine && engine.schedulesRecognition === true
    ? run() : oneRecognitionAtATime(run, signal);
};

/** The engine's document of `request`: the one it keeps or has cached, else read from the bytes, read only then
 *  (`convert`: a Word or PowerPoint binary to PDF first; recognizing, in its turn). A source is rechecked either side. */
function read(source: Pick<Source, "documentId" | "readBytes" | "assertAvailable">, request: ReturnType<typeof sourceRequest>,
  options: { convert?: boolean; recognize?: boolean; signal?: AbortSignal; extracting?: () => unknown;
    progress?: (recognized: number, total: number) => void } = {}) {
  const native = structureNative();
  return abandonable((async () => {
    await source.assertAvailable?.();
    const document = await native.openSource(undefined, request) ?? await (async () => {
      const bytes = await source.readBytes();
      await options.extracting?.();
      const open = () => pdfLifecyclePhase("prepare.native", source.documentId, async () =>
        native.openSource(options.convert ? await docxToPdf(bytes) : bytes, request, options.signal, options.progress));
      return options.recognize ? recognitionTurn(open, options.signal) : open();
    })();
    await source.assertAvailable?.();
    return document;
  })(), options.signal);
}

/** The engine's document of a source: the one it keeps, or, read from the source's bytes, a fresh one. A PDF is its
 *  prepared reading where it has one (its cache key), else read with the profile asked for. */
export async function openDocument(source: Source, options: OpenOptions = {}): Promise<NativeDocument> {
  options.signal?.throwIfAborted();
  const fileType = source.fileType ?? "pdf";
  const pdf = fileType === "pdf" || converted(fileType);
  const overridden = options.ocrProvider !== undefined || options.layout !== undefined || options.doc !== undefined;
  const profile = asRead(overridden || !source.pdfProfile ? profileFor(options.ocrProvider, options.layout, options.doc)
    : source.pdfProfile.profile, options.instrument);
  const cacheKey = fileType === "pdf" ? keyFor(source.pdfProfile, profile) : undefined;
  const pages = !cacheKey && options.pages?.length ? options.pages : undefined;
  const request = sourceRequest(source, fileType, options.mode, pdf ? pdfRequest(profile, pages, cacheKey) : undefined);
  return (await read(source, request, { convert: converted(fileType), signal: options.signal,
    extracting: () => pdf && options.progress?.({ phase: "extracting", pages: pages ?? [] }) }))!;
}

/** The PDF reading its parser cached under `cacheKey`, or none: a reading no longer cached is not made again. */
export async function cachedPdf(source: Pick<Source, "documentId" | "versionId" | "sourceSha256">, cacheKey: string) {
  return structureNative().openSource(undefined, sourceRequest(source, "pdf", "text", pdfRequest({}, undefined, cacheKey)));
}

/** A source's text: a PDF's (and a converted Word or PowerPoint binary's) its document's, any other the text its
 *  format's reader gives (a Word document's drafting text where asked), at most `limit` UTF-16 units. */
export async function sourceText(source: Source & { fileType: string }, options: {
  drafting?: boolean; limit?: number; signal?: AbortSignal;
} = {}) {
  options.signal?.throwIfAborted();
  const { fileType } = source;
  if (fileType === "pdf" || converted(fileType)) {
    const document = await openDocument(source, { signal: options.signal, doc: false });
    return structureNative().documentText(document, options.limit);
  }
  const pending = (async () => {
    await source.assertAvailable?.();
    const text = await structureNative().sourceText(await source.readBytes(), {
      fileType, sourceSha256: source.sourceSha256, drafting: !!options.drafting, limit: options.limit ?? null });
    await source.assertAvailable?.();
    return text;
  })();
  const text = await abandonable(pending, options.signal);
  options.signal?.throwIfAborted();
  return text;
}

type PdfPrepareInput = {
  documentId: string;
  versionId: string;
  bytes: Buffer;
  sourceSha256?: string;
  pages?: number[];
  ocrProvider?: LegalPdfOcrProvider | null;
  layout?: boolean | null;
  doc?: boolean | null;
  pdfProfile?: PdfProfileSelection;
  /** The PDF is an instrument (`asRead`). */
  instrument?: boolean;
  signal?: AbortSignal;
  progress?: (value: PdfPreparationProgress) => void | Promise<void>;
};

/** Reads a PDF and caches its reading, recognizing its pages where its profile does: the document, with its summary
 *  and the profile it was read with (which is also its profile selection). A reading the engine still has is that
 *  one. Whoever holds the result holds the document, so reopening it by its cache key reads it from memory. */
export async function preparePdf(input: PdfPrepareInput) {
  input.signal?.throwIfAborted();
  const profile = asRead(input.pdfProfile?.profile ?? profileFor(input.ocrProvider, input.layout, input.doc), input.instrument);
  const pages = input.pages?.length ? input.pages : undefined;
  await input.progress?.({ phase: "extracting", pages: pages ?? [] });
  const source = { ...input, sourceSha256: input.sourceSha256 ?? sha256(input.bytes), readBytes: () => input.bytes };
  // A prepared reading no longer kept is made again, as it was first made.
  const document = await read(source, sourceRequest(source, "pdf", "text",
    pdfRequest(profile, pages, !pages ? keyFor(input.pdfProfile, profile) : undefined)), { recognize: !!profile.ocr, signal: input.signal,
    progress: input.progress && ((recognized, total) => void input.progress?.({ phase: "recognizing", recognized, total })) });
  return { ...structureNative().pdfDocumentSummary(document!), profile, document: document! };
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
  const profile = options.pdfProfile;
  if (!profile) return [];
  const owners = profile.textLayerPages ?? {};
  const owner = (page: number) => owners[page] ?? (profile.profile.ocr ? profile.cacheKey : undefined);
  const keys = new Set(requested ? requested.map(owner).filter((key): key is string => !!key)
    : [...(profile.profile.ocr ? [profile.cacheKey] : []), ...Object.values(owners)]);
  if (!keys.size) return [];
  const native = structureNative(), result = new Map<number, Page>();
  const unavailable = () => new ApplicationError(409, "This PDF's recognized text could not be read.");
  for (const key of keys) {
    options.signal?.throwIfAborted();
    // A reading no longer kept is made again as it was first made (a page-bound one for its own pages): whoever
    // asks for its text never learns it was gone.
    const pages = key === profile.cacheKey ? undefined
      : Object.entries(owners).filter(([, owner]) => owner === key).map(([page]) => Number(page));
    const request = sourceRequest(reference, "pdf", "text", pdfRequest(profile.profile, pages, key));
    const document = await read({ ...reference, readBytes }, request, { recognize: true, signal: options.signal });
    options.signal?.throwIfAborted();
    const geometry = document && native.pdfRecognizedText(document, requested?.filter(page => owner(page) === key));
    if (!geometry) throw unavailable();
    for (const page of geometry) if (owner(page.number) === key) result.set(page.number, page);
  }
  // Unfiltered reads are for automatic marking; the viewport only restores/copies its requested pages.
  return [...result.values()].sort((a, b) => a.number - b.number);
}
