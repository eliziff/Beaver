import { profileFor } from "./pdfProfile";
import { ApplicationError } from "./applicationError";
import type { NativePdfTextPage } from "./structureNative";
import { sha256 } from "./hash";
import {
  lookupPdfStructure,
  readPdfEvidenceReceipt,
  rehydratePdfEvidence,
  verifyPdfEvidence,
  type PdfLocatorKind,
  type PdfLookupInput,
} from "./documentProjectionPdf";
import { projectionDirectory, textProjectionKey } from "./documentProjection";
import { spreadsheetToLLMStructure, spreadsheetToLLMText } from "./spreadsheet";
import {
  pdfPassageGeometry as nativePdfPassageGeometry,
  structureNative,
  type NativeDocument,
  type NativePdfPassageTarget,
  type PdfPreparationSummary,
} from "./structureNative";
import {
  isPlainTextDocumentType,
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
} from "./documentTypes";
import { extractEmailText } from "./emailText";
import { extractPresentationText } from "./officeText";
import { projectDocxRedline } from "./docx/redline";
import { docxToPdf } from "./convert";
import { isJsonRecord } from "./value";
import { pdfLifecyclePhase } from "./pdfLifecycleDiagnostics";
import { utf16PrefixCeil } from "./text";
import type {
  DocumentProjectionSource,
  LegalPdfOcrProvider,
  LegalPdfProfile,
  PdfProfileSelection,
} from "./documentStore";

const CACHE_DIRECTORY = projectionDirectory("legalpdf-cache", sha256("legalpdf-cache-v1"));

export type PdfParseStatus = "ready" | "degraded";
export type PdfOcrProvider = LegalPdfOcrProvider;
export type {
  PdfLocatorKind,
  PdfLookupInput,
};

type ProjectionReference = {
  documentId: string;
  versionId: string;
  sourceSha256: string;
  cacheKey?: string;
};

export type PdfPreparationProgress = {
  phase: "extracting";
  pages: number[];
};

function preparedSummary(result: PdfPreparationSummary, expectedSha256?: string,
  expectedCacheKey?: string) {
  if (!/^[a-f0-9]{64}$/u.test(result.sha256) ||
      (expectedSha256 && result.sha256 !== expectedSha256))
    throw new Error("PDF source changed after preparation began");
  if (typeof result.cacheKey !== "string" || !/^[a-f0-9]{64}$/u.test(result.cacheKey))
    throw new Error("Legal PDF preparation returned no cache key");
  if (expectedCacheKey && result.cacheKey !== expectedCacheKey)
    throw new Error("Legal PDF preparation profile changed");
  const engineStatus = String(result.status || "degraded");
  if (!["ready", "degraded", "ocr_required"].includes(engineStatus))
    throw new Error("Legal PDF engine returned an invalid preparation status");
  return {
    status: (engineStatus === "ready" ? "ready" : "degraded") as PdfParseStatus,
    sourceSha256: result.sha256,
    parserVersion: result.parserVersion,
    cacheKey: result.cacheKey,
    pageCount: result.pageCount,
    projectionPageCount: result.projectionPageCount,
    pagesNeedingOcr: result.pagesNeedingOcr,
    ocrRoutedPages: result.ocrRoutedPages,
  };
}

function validProjectionId(value: string) {
  return value === value.trim() && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeParserError(error: unknown) {
  const stderr = isJsonRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
  const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
  const safe = (detail: string, name = "Error") =>
    Object.assign(new Error(detail, { cause: error }), { name });
  if (/PDF is encrypted|password (?:is )?required|incorrect password/iu.test(message))
    return safe("PDF is password-protected. Remove its password, then upload it again.",
      "PdfEncrypted");
  if (/invalid file trailer|couldn't parse input|PDF parsing failed|source bytes are invalid/iu.test(message))
    return safe("PDF is invalid or corrupt");
  if (/timed out|ETIMEDOUT/iu.test(message)) return safe("PDF structural parsing timed out");
  if (/Tesseract/iu.test(message)) return safe("Tesseract OCR could not start");
  if (/Kraken|LEGALPDF_KRAKEN|ONNX/iu.test(message))
    return safe("Kraken-lite OCR could not start; check its local runtime assets");
  if (/layout|PPdoc|OpenVINO/iu.test(message))
    return safe("PDF layout analysis could not start; check its local runtime assets");
  if (/source changed/iu.test(message))
    return safe("PDF source changed after preparation began");
  return safe("PDF structural parser failed");
}

function pdfRequest(
  input: { documentId: string; versionId: string; sourceSha256?: string },
  profile: LegalPdfProfile,
  pages?: number[],
) {
  return {
    kind: "pdf",
    ...(input.sourceSha256 ? { expected_source_sha256: input.sourceSha256 } : {}),
    cache_dir: CACHE_DIRECTORY,
    max_output_bytes: MAX_PROJECTION_OUTPUT_BYTES,
    ...(pages ? { pages } : {}),
    ...profile,
    id: `${input.documentId}:${input.versionId}`,
  };
}

function pdfCacheRequest(input: ProjectionReference, cacheKey: string) {
  return {
    kind: "pdf",
    expected_source_sha256: input.sourceSha256,
    cache_dir: CACHE_DIRECTORY,
    max_output_bytes: MAX_PROJECTION_OUTPUT_BYTES,
    cache_key: cacheKey,
    id: `${input.documentId}:${input.versionId}`,
  };
}

type PdfOpenInput = {
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

async function withPdfRequest<T>(
  input: PdfOpenInput,
  action: (request: ReturnType<typeof pdfRequest>,
    profile: LegalPdfProfile) => Promise<T>,
) {
  input.signal?.throwIfAborted();
  if (!validProjectionId(input.documentId) || !validProjectionId(input.versionId))
    throw new Error("PDF preparation requires valid document and version IDs");
  if (input.pdfProfile && (input.ocrProvider !== undefined || input.layout !== undefined))
    throw new Error("PDF preparation cannot combine a stored profile with overrides");
  const profile: LegalPdfProfile = input.pdfProfile?.profile ??
    profileFor(input.ocrProvider, input.layout);
  const pages = input.pages?.length ? input.pages : undefined;
  try {
    await input.progress?.({
      phase: "extracting",
      pages: pages ?? [],
    });
    const result = await action(pdfRequest(input, profile, pages), profile);
    input.signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw safeParserError(error);
  }
}

async function openPdf(input: PdfOpenInput) {
  return withPdfRequest(input, (request) =>
    pdfLifecyclePhase("prepare.native", input.documentId, () =>
      structureNative().derivePdfDocument(input.bytes, request, input.signal)));
}

async function preparePdf(input: PdfOpenInput) {
  const prepared = await withPdfRequest(input, async (request, profile) => ({
    summary: preparedSummary(
      await pdfLifecyclePhase("prepare.native", input.documentId, () =>
        structureNative().preparePdfDocument(input.bytes, request, input.signal)),
      input.sourceSha256,
    ),
    profile,
  }));
  return { ...prepared.summary, profile: prepared.profile };
}

const MAX_DOCUMENT_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSED_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_PROJECTION_OUTPUT_BYTES = 64 * 1024 * 1024;
type ProjectionValue = NativeDocument | string;
const MAX_RETAINED_TEXT_BYTES = 8 * 1024 * 1024;
const projectionLoads = new Map<string, Promise<ProjectionValue>>();
// Share the existing eight-entry working set; native documents stay weakly held.
const projectionMemory = new Map<string, WeakRef<NativeDocument> | string>();
const projectionKey = (input: ProjectionReference) =>
  `${input.documentId}\0${input.versionId}\0${input.sourceSha256}\0${input.cacheKey ?? ""}`;

async function boundedSource(input: DocumentProjectionSource, nativeDocxView = false) {
  const fileType = input.fileType.trim().toLowerCase();
  const bytes = await input.readBytes();
  if (!bytes.length || bytes.length > MAX_DOCUMENT_INPUT_BYTES)
    throw new Error("Document projection input exceeds the read limit");
  if (!nativeDocxView && ["docx", "xlsx", "xlsm", "pptx"].includes(fileType) &&
      bytes.length > MAX_COMPRESSED_PACKAGE_BYTES)
    throw new Error("Compressed document exceeds the read limit");
  const sourceSha256 = sha256(bytes);
  if (input.sourceSha256 !== sourceSha256)
    throw new Error("Document source bytes no longer match their version");
  return { bytes, fileType, sourceSha256 };
}

function assertProjectionSource(input: DocumentProjectionSource) {
  if (!validProjectionId(input.documentId) || !validProjectionId(input.versionId))
    throw new Error("Document projection requires valid document and version IDs");
  if (!/^[a-f0-9]{64}$/u.test(input.sourceSha256))
    throw new Error("Document projection requires a source SHA-256");
}

async function extractedText(source: Awaited<ReturnType<typeof boundedSource>>) {
  if (isPlainTextDocumentType(source.fileType))
    return source.bytes.toString("utf8").replace(/^\uFEFF/u, "");
  if (source.fileType === "eml") return extractEmailText(source.bytes);
  if (source.fileType === "pptx") return extractPresentationText(source.bytes);
  return null;
}

function existingProjection<T extends ProjectionValue = NativeDocument>(key: string): Promise<T> | undefined {
  const entry = projectionMemory.get(key);
  const projection = typeof entry === "string" ? entry : entry?.deref();
  projectionMemory.delete(key);
  if (projection !== undefined) {
    projectionMemory.set(key, entry!);
    return Promise.resolve(projection as T);
  }
  return projectionLoads.get(key) as Promise<T> | undefined;
}

function projectionFor<T extends ProjectionValue>(key: string, load: () => Promise<T>,
  retain = () => true): Promise<T> {
  const existing = existingProjection<T>(key);
  if (existing) return existing;
  const pending = load().then((projection) => {
    if (!retain() || typeof projection === "string" && projection.length * 2 > MAX_RETAINED_TEXT_BYTES)
      return projection;
    for (const [cachedKey, cached] of projectionMemory)
      if (typeof cached !== "string" && !cached.deref()) projectionMemory.delete(cachedKey);
    projectionMemory.set(key, typeof projection === "string" ? projection : new WeakRef(projection as NativeDocument));
    const textBytes = () => [...projectionMemory.values()].reduce((bytes, value) =>
      bytes + (typeof value === "string" ? value.length * 2 : 0), 0);
    while (projectionMemory.size > 8 || textBytes() > MAX_RETAINED_TEXT_BYTES)
      projectionMemory.delete(projectionMemory.keys().next().value!);
    return projection;
  }).finally(() => {
    projectionLoads.delete(key);
  });
  projectionLoads.set(key, pending);
  return pending;
}

// An abandoned reader must neither wait for shared extraction nor cancel it for
// another reader. Both settlement handlers stay attached after cancellation.
function waitForProjection<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
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

async function compileReadProjection(
  input: DocumentProjectionSource,
  source: Awaited<ReturnType<typeof boundedSource>>,
  mode: "text" | "drafting" | "redline" = "text",
): Promise<NativeDocument> {
  const { bytes, fileType } = source;
  if (fileType === "docx") {
    if (mode === "redline") return structureNative().deriveDocumentStructure({
      kind: "instrument", id: input.documentId,
      text: (await projectDocxRedline(bytes)).text, reconstruct_lineation: true,
    });
    return structureNative().deriveDocxDocument(bytes,
      mode === "drafting" ? input.documentId : `${input.documentId}:${input.versionId}`,
      mode === "drafting");
  }
  if (isSpreadsheetDocumentType(fileType)) {
    const grid = await spreadsheetToLLMStructure(bytes, fileType);
    const document = await structureNative().deriveDocumentStructure({
      kind: "instrument",
      id: `${input.documentId}:${input.versionId}`,
      text: grid.text,
      table_cells: grid.tableCells,
      reconstruct_lineation: false,
    });
    return document;
  }
  const text = await extractedText(source);
  if (text === null && (isPresentationDocumentType(fileType) ||
      isWordDocumentType(fileType))) {
    const pdf = await docxToPdf(bytes);
    const sourceSha256 = sha256(pdf);
    return openPdf({
      documentId: input.documentId,
      versionId: input.versionId,
      bytes: pdf,
      sourceSha256,
    });
  }
  if (text === null) {
    throw new Error(`Document type ${fileType} has no text projection`);
  }
  if (Buffer.byteLength(text) > MAX_PROJECTION_OUTPUT_BYTES)
    throw new Error("Document projection output exceeds the read limit");
  const document = await structureNative().deriveDocumentStructure({
    kind: "instrument",
    id: `${input.documentId}:${input.versionId}`,
    text,
    reconstruct_lineation: true,
  });
  return document;
}

function assertProjectionOutput(document: NativeDocument) {
  if (structureNative().documentTextBytes(document) > MAX_PROJECTION_OUTPUT_BYTES)
    throw new Error("Document projection output exceeds the read limit");
}

async function read(input: DocumentProjectionSource, options: {
  mode?: "text" | "drafting" | "redline"; signal?: AbortSignal;
} = {}) {
  options.signal?.throwIfAborted();
  assertProjectionSource(input);
  const reference = {
    documentId: input.documentId,
    versionId: input.versionId,
    sourceSha256: input.sourceSha256,
    ...(input.pdfProfile ? { cacheKey: input.pdfProfile.cacheKey } : {}),
  };
  const pending = (async () => {
    if (input.assertAvailable) await input.assertAvailable();
    let reusable = true;
    const mode = input.fileType.toLowerCase() === "docx" ? options.mode ?? "text" : "text";
    if (options.mode === "redline" && mode !== "redline")
      throw new Error("Redline requires a DOCX document");
    const result = input.fileType.trim().toLowerCase() === "pdf"
      ? await pdfDocumentForSource(input.readBytes, reference, { pdfProfile: input.pdfProfile })
      : await projectionFor(`${projectionKey(reference)}\0${mode}`, async () => {
        const source = await boundedSource(input, mode !== "text");
        let document: NativeDocument;
        try { document = await compileReadProjection(input, source, mode); }
        catch (error) {
          if (mode !== "drafting") throw error;
          reusable = false;
          document = await compileReadProjection(input, await boundedSource(input));
        }
        if (mode === "text" || !reusable) assertProjectionOutput(document);
        return document;
      }, () => reusable);
    if (input.assertAvailable) await input.assertAvailable();
    return result;
  })();
  return waitForProjection(pending, options.signal);
}

async function text(input: DocumentProjectionSource, options: {
  drafting?: boolean; limit?: number; signal?: AbortSignal;
} = {}) {
  options.signal?.throwIfAborted();
  assertProjectionSource(input);
  const fileType = input.fileType.trim().toLowerCase();
  const requiresPdf = fileType === "pdf" ||
    (fileType !== "docx" && isWordDocumentType(fileType)) ||
    (fileType !== "pptx" && isPresentationDocumentType(fileType));
  if (requiresPdf) {
    const document = await read(input, { signal: options.signal });
    options.signal?.throwIfAborted();
    return structureNative().documentText(document, options.limit);
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0))
    throw new RangeError("Document text limit must be a nonnegative safe integer");
  const sourceInput = { ...input, fileType }, settings = { ...options };
  const pending = (async () => {
    // Each reader checks its own authority, including hits and shared loads. A
    // raw caller has no repository validator, so must still supply verified bytes.
    await sourceInput.assertAvailable?.();
    const supplied = sourceInput.assertAvailable ? undefined : await boundedSource(sourceInput);
    settings.signal?.throwIfAborted();
    let reusable = true;
    const result = await projectionFor(textProjectionKey(sourceInput, settings), async () => {
      const source = supplied ?? await boundedSource(sourceInput);
      let result: string | null;
      if (fileType === "docx") {
        try {
          result = await structureNative().docxText(source.bytes, settings.drafting, settings.limit);
        } catch (error) {
          if (!settings.drafting) throw error;
          // Preserve fallback behavior, but retry drafting next time rather than
          // freezing a transient plain-text fallback under the drafting identity.
          reusable = false;
          result = await structureNative().docxText(source.bytes, false, settings.limit);
        }
      } else if (isSpreadsheetDocumentType(fileType)) {
        result = await spreadsheetToLLMText(source.bytes, fileType);
      } else {
        result = await extractedText(source);
      }
      if (result === null)
        throw new Error(`Document type ${fileType} has no text projection`);
      if (Buffer.byteLength(result) > MAX_PROJECTION_OUTPUT_BYTES)
        throw new Error("Document projection output exceeds the read limit");
      return result;
    }, () => reusable);
    settings.signal?.throwIfAborted();
    await sourceInput.assertAvailable?.();
    settings.signal?.throwIfAborted();
    return settings.limit === undefined || fileType === "docx"
      ? result : utf16PrefixCeil(result, settings.limit);
  })();
  return waitForProjection(pending, settings.signal);
}

type PdfSourceOptions = {
  pages?: number[];
  pdfProfile?: PdfProfileSelection;
  signal?: AbortSignal;
  progress?: (value: PdfPreparationProgress) => void | Promise<void>;
};

async function pdfDocumentForSource(
  readBytes: () => Buffer | Promise<Buffer>,
  reference: ProjectionReference,
  options: PdfSourceOptions = {},
) {
  options.signal?.throwIfAborted();
  const pages = !reference.cacheKey && options.pages?.length
    ? [...new Set(options.pages)].sort((left, right) => left - right)
    : undefined;
  const baseKey = projectionKey(reference);
  const live = pages && existingProjection(baseKey);
  if (live) {
    const document = await live;
    options.signal?.throwIfAborted();
    return document;
  }
  const key = pages ? `${baseKey}\0pages:${pages.join(",")}` : baseKey;
  const pending = projectionFor(key, async () => {
    if (reference.cacheKey) {
      const restored = await structureNative().restorePdfDocument(
        pdfCacheRequest(reference, reference.cacheKey));
      if (restored) {
        return restored;
      }
    }
    const bytes = await readBytes();
    const document = await openPdf({
      ...reference,
      bytes,
      ...(pages ? { pages } : {}),
      pdfProfile: options.pdfProfile,
      signal: options.signal,
      progress: options.progress,
    });
    return document;
  });
  const document = await pending;
  options.signal?.throwIfAborted();
  return document;
}

async function preparedForSource(
  readBytes: () => Buffer | Promise<Buffer>,
  reference: ProjectionReference,
  options: PdfSourceOptions = {},
) {
  const document = await pdfDocumentForSource(readBytes, reference, options);
  return { document, summary: preparedSummary(
    structureNative().pdfDocumentSummary(document),
    reference.sourceSha256,
    reference.cacheKey,
  ) };
}

async function lookupPdf(
  readBytes: () => Buffer | Promise<Buffer>,
  input: PdfLookupInput,
  options: {
    persistEvidence?: boolean;
    documentId: string;
    versionId: string;
    sourceSha256: string;
    pdfProfile?: PdfProfileSelection;
    pages?: number[];
    signal?: AbortSignal;
    progress?: (value: PdfPreparationProgress) => void | Promise<void>;
  },
) {
  const prepared = await preparedForSource(readBytes, {
    documentId: options.documentId,
    versionId: options.versionId,
    sourceSha256: options.sourceSha256,
    ...(options.pdfProfile ? { cacheKey: options.pdfProfile.cacheKey } : {}),
  }, options);
  return lookupPdfStructure(prepared.document, input, {
    persistEvidence: options.persistEvidence,
    cacheKey: prepared.summary.cacheKey,
    documentId: options.documentId,
    versionId: options.versionId,
    sourceSha256: prepared.summary.sourceSha256,
    parserVersion: prepared.summary.parserVersion,
  });
}

async function pdfPassageGeometry(
  readBytes: () => Buffer | Promise<Buffer>,
  targets: NativePdfPassageTarget[],
  reference: ProjectionReference,
  options: PdfSourceOptions = {},
) {
  const bytes = await readBytes();
  const prepared = await preparedForSource(() => bytes, reference, options);
  return nativePdfPassageGeometry(prepared.document, bytes, targets);
}

async function pdfTextLayer(
  _readBytes: () => Buffer | Promise<Buffer>,
  reference: ProjectionReference,
  options: PdfSourceOptions = {},
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
  const unavailable = () => new ApplicationError(409,
    "Recognized text is no longer cached. Run Recognize text again for this PDF.");
  for (const key of keys) {
    options.signal?.throwIfAborted();
    // Reuse the existing weak working set and single-flight restore, not a second OCR cache.
    const document = await waitForProjection(projectionFor(projectionKey({ ...reference, cacheKey: key }), async () => {
      const document = await native.restorePdfDocument(pdfCacheRequest(reference, key));
      if (!document) throw unavailable();
      return document;
    }), options.signal);
    options.signal?.throwIfAborted();
    const geometry = native.pdfRecognizedText(document, requested?.filter(page => owner(page) === key));
    if (geometry === null) throw unavailable();
    for (const page of geometry) if (owner(page.pageNumber) === key) result.set(page.pageNumber, page);
  }
  // Unfiltered reads are for automatic marking; the viewport only restores/copies its requested pages.
  return [...result.values()].sort((a, b) => a.pageNumber - b.pageNumber);
}

async function preparedForEvidence(
  handle: string,
  expected: ProjectionReference,
) {
  const receipt = await readPdfEvidenceReceipt(handle);
  if (receipt.source.document_id !== expected.documentId ||
      receipt.source.version_id !== expected.versionId ||
      receipt.source.source_sha256 !== expected.sourceSha256)
    throw new Error("PDF evidence source mismatch");
  const reference = { ...expected, cacheKey: receipt.source.cache_key };
  const document = await projectionFor(projectionKey(reference), async () => {
    const document = await structureNative().restorePdfDocument(
      pdfCacheRequest(reference, reference.cacheKey));
    if (!document) throw new Error("PDF evidence artifact is no longer available");
    return document;
  });
  return { document, receipt };
}

export const documentProjectionService = Object.freeze({
  read,
  text,
  preparePdf,
  lookupPdf,
  pdfPassageGeometry,
  pdfTextLayer,
  async rehydratePdfEvidence(handle: string, expected: ProjectionReference) {
    const { document, receipt } = await preparedForEvidence(handle, expected);
    return rehydratePdfEvidence(document, receipt);
  },
  async verifyPdfEvidence(bytes: Buffer, handle: string, expected: ProjectionReference) {
    if (sha256(bytes) !== expected.sourceSha256)
      throw new Error("PDF evidence source bytes no longer match their version");
    const { document, receipt } = await preparedForEvidence(handle, expected);
    return verifyPdfEvidence(document, receipt);
  },
});
