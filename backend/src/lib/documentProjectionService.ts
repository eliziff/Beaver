import { existsSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./hash";
import {
  lookupPdfStructure,
  readPdfEvidenceReceipt,
  rehydratePdfEvidence,
  verifyPdfEvidence,
  type PdfLocatorKind,
  type PdfLookupInput,
} from "./documentProjectionPdf";
import { projectionDirectory } from "./documentProjection";
import { spreadsheetToLLMStructure, spreadsheetToLLMText } from "./spreadsheet";
import {
  structureNative,
  type NativeDocument,
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

function pdfEngineRoot(env: NodeJS.ProcessEnv) {
  return path.resolve(env.LEGALPDF_ENGINE_ROOT?.trim() ||
    path.join(__dirname, "../../../legal-pdf-parser"));
}

function nativeLibraryNames(platform: NodeJS.Platform) {
  if (platform === "win32") return ["onnxruntime.dll", "legalpdf_tesseract_layout.dll"];
  const extension = platform === "darwin" ? "dylib" : "so";
  return [`libonnxruntime.${extension}`, `liblegalpdf_tesseract_layout.${extension}`];
}

function openVinoLibraryName(platform: NodeJS.Platform) {
  if (platform === "win32") return "openvino_c.dll";
  return platform === "darwin" ? "libopenvino_c.dylib" : "libopenvino_c.so";
}

function configuredPath(env: NodeJS.ProcessEnv, root: string, name: string,
  fallback: string, requiredFile?: string) {
  const candidate = path.resolve(root, env[name]?.trim() || fallback);
  if (!existsSync(requiredFile ? path.join(candidate, requiredFile) : candidate))
    throw new Error(`${name} does not exist: ${candidate}`);
  return candidate;
}

function numericSetting(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function numericSettings(env: NodeJS.ProcessEnv, fields: ReadonlyArray<readonly [string, string]>) {
  return Object.fromEntries(fields.flatMap(([field, name]) => {
    const value = numericSetting(env, name);
    return value === undefined ? [] : [[field, value]];
  }));
}

function configuredLegalPdfOcrProvider(env: NodeJS.ProcessEnv, root: string) {
  const requested = env.MIKE_PDF_OCR_PROVIDER?.trim();
  if (requested) {
    if (requested === "none") return null;
    if (requested === "kraken-lite" || requested === "tesseract") return requested;
    throw new Error("MIKE_PDF_OCR_PROVIDER must be none, kraken-lite, or tesseract");
  }
  const [runtime, layout] = nativeLibraryNames(process.platform);
  return ["runtime/kraken/model.onnx", "runtime/kraken/codec.json",
    `runtime/${runtime}`, `runtime/${layout}`]
    .every((candidate) => existsSync(path.resolve(root, candidate))) ? "kraken-lite" : null;
}

function configuredLegalPdfProfile(env: NodeJS.ProcessEnv = process.env): LegalPdfProfile {
  const root = pdfEngineRoot(env), platform = process.platform;
  const profile: LegalPdfProfile = {};
  const ocr = configuredLegalPdfOcrProvider(env, root);
  if (ocr === "tesseract") {
    profile.ocr = { provider: ocr, settings: {
      language: env.LEGALPDF_OCR_LANGUAGE?.trim() || "eng",
      dpi: numericSetting(env, "LEGALPDF_OCR_DPI") ?? 180,
      psm: numericSetting(env, "LEGALPDF_OCR_PSM") ?? 3,
    } };
  } else if (ocr === "kraken-lite") {
    const layout = env.LEGALPDF_KRAKEN_LAYOUT?.trim() || "tesseract";
    if (layout !== "tesseract" && layout !== "blla")
      throw new Error("LEGALPDF_KRAKEN_LAYOUT must be tesseract or blla");
    const [runtime, tesseractLibrary] = nativeLibraryNames(platform);
    profile.ocr = { provider: ocr, settings: {
      dpi: numericSetting(env, "LEGALPDF_OCR_DPI") ?? 180,
      layout,
      backend: env.LEGALPDF_KRAKEN_BACKEND?.trim() || "cpu",
      tier: env.LEGALPDF_KRAKEN_TIER?.trim() || "quality",
      ...(layout === "tesseract" ? {
        model: configuredPath(env, root, "LEGALPDF_KRAKEN_MODEL", "runtime/kraken/model.onnx"),
        codec: configuredPath(env, root, "LEGALPDF_KRAKEN_CODEC", "runtime/kraken/codec.json"),
        runtime: configuredPath(env, root, "LEGALPDF_ONNX_RUNTIME", `runtime/${runtime}`),
        tesseract_library: configuredPath(env, root, "LEGALPDF_KRAKEN_TESSERACT_LIBRARY",
          `runtime/${tesseractLibrary}`),
      } : {
        runtime_wheel: configuredPath(env, root, "LEGALPDF_KRAKEN_RUNTIME_WHEEL",
          "runtime/kraken/runtime.whl"),
        blla_pack: configuredPath(env, root, "LEGALPDF_KRAKEN_BLLA_PACK", "runtime/kraken/blla"),
        recognizer_pack: configuredPath(env, root, "LEGALPDF_KRAKEN_RECOGNIZER_PACK",
          "runtime/kraken/recognizer"),
        ...(env.LEGALPDF_KRAKEN_PYTHON?.trim()
          ? { python: env.LEGALPDF_KRAKEN_PYTHON.trim() } : {}),
      }),
      ...numericSettings(env, [
        ["threads", "LEGALPDF_KRAKEN_THREADS"], ["workers", "LEGALPDF_KRAKEN_WORKERS"],
        ["layout_workers", "LEGALPDF_KRAKEN_LAYOUT_WORKERS"],
        ["batch_size", "LEGALPDF_KRAKEN_BATCH_SIZE"],
        ["width_bucket", "LEGALPDF_KRAKEN_WIDTH_BUCKET"],
        ["width_scale", "LEGALPDF_KRAKEN_WIDTH_SCALE"],
      ]),
      ...(env.LEGALPDF_KRAKEN_DEVICE?.trim()
        ? { device: env.LEGALPDF_KRAKEN_DEVICE.trim() } : {}),
    } };
  }

  const requestedLayout = env.MIKE_PDF_LAYOUT_PROVIDER?.trim();
  if (requestedLayout && requestedLayout !== "none" && requestedLayout !== "ppdoc")
    throw new Error("MIKE_PDF_LAYOUT_PROVIDER must be none or ppdoc");
  const backend = env.LEGALPDF_PPDOC_BACKEND?.trim() || "openvino";
  const modelPack = path.resolve(root,
    env.LEGALPDF_PPDOC_MODEL_PACK?.trim() || "runtime/layout/heron-int8");
  const runtime = path.resolve(root, env.LEGALPDF_PPDOC_RUNTIME?.trim() ||
    `runtime/${backend === "openvino"
      ? openVinoLibraryName(platform) : nativeLibraryNames(platform)[0]}`);
  if (requestedLayout === "ppdoc" || (!requestedLayout &&
      existsSync(path.join(modelPack, "manifest.json")) && existsSync(runtime))) {
    profile.layout = { provider: "ppdoc", settings: {
      model_pack: configuredPath(env, root, "LEGALPDF_PPDOC_MODEL_PACK",
        "runtime/layout/heron-int8", "manifest.json"),
      runtime: configuredPath(env, root, "LEGALPDF_PPDOC_RUNTIME",
        `runtime/${backend === "openvino"
          ? openVinoLibraryName(platform) : nativeLibraryNames(platform)[0]}`),
      backend,
      ...numericSettings(env, [
        ["threads", "LEGALPDF_PPDOC_THREADS"], ["threshold", "LEGALPDF_PPDOC_THRESHOLD"],
        ["render_dpi", "LEGALPDF_PPDOC_DPI"],
      ]),
      ...(env.LEGALPDF_PPDOC_DEVICE?.trim()
        ? { device: env.LEGALPDF_PPDOC_DEVICE.trim() } : {}),
      ...(env.LEGALPDF_PPDOC_CPU_FALLBACK === "1" ? { cpu_fallback: true } : {}),
    } };
  }
  return profile;
}

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
  };
}

function validProjectionId(value: string) {
  return value === value.trim() && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeParserError(error: unknown) {
  const stderr = isJsonRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
  const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
  if (/invalid file trailer|couldn't parse input|PDF parsing failed|source bytes are invalid/iu.test(message))
    return "PDF is invalid or corrupt";
  if (/timed out|ETIMEDOUT/iu.test(message)) return "PDF structural parsing timed out";
  if (/Tesseract/iu.test(message)) return "Tesseract OCR could not start";
  if (/Kraken|LEGALPDF_KRAKEN|ONNX/iu.test(message))
    return "Kraken-lite OCR could not start; check its local runtime assets";
  if (/layout|PPdoc|OpenVINO/iu.test(message))
    return "PDF layout analysis could not start; check its local runtime assets";
  if (/source changed/iu.test(message))
    return "PDF source changed after preparation began";
  return "PDF structural parser failed";
}

function profileFor(
  ocrProvider: PdfOcrProvider | null | undefined,
  layout: boolean | null | undefined,
) {
  const env = ocrProvider === undefined
    ? process.env
    : { ...process.env, MIKE_PDF_OCR_PROVIDER: ocrProvider ?? "none" };
  const profile = configuredLegalPdfProfile(env);
  if (layout === false || layout === null) delete profile.layout;
  if (layout === true && !profile.layout)
    throw new Error("Local PDF layout assets are unavailable");
  return profile;
}

function pdfRequest(
  input: { documentId: string; versionId: string; sourceSha256?: string },
  profile: ReturnType<typeof configuredLegalPdfProfile>,
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
    profile: ReturnType<typeof configuredLegalPdfProfile>) => Promise<T>,
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
    throw new Error(safeParserError(error), { cause: error });
  }
}

async function openPdf(input: PdfOpenInput) {
  return withPdfRequest(input, (request) =>
    pdfLifecyclePhase("prepare.native", input.documentId, () =>
      structureNative().derivePdfDocument(input.bytes, request)));
}

async function preparePdf(input: PdfOpenInput) {
  const prepared = await withPdfRequest(input, async (request, profile) => ({
    summary: preparedSummary(
      await pdfLifecyclePhase("prepare.native", input.documentId, () =>
        structureNative().preparePdfDocument(input.bytes, request)),
      input.sourceSha256,
    ),
    profile,
  }));
  return { ...prepared.summary, profile: prepared.profile };
}

const MAX_DOCUMENT_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSED_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_PROJECTION_OUTPUT_BYTES = 64 * 1024 * 1024;
const projectionLoads = new Map<string, Promise<NativeDocument>>();
const projectionMemory = new Map<string, WeakRef<NativeDocument>>();
const projectionKey = (input: ProjectionReference) =>
  `${input.documentId}\0${input.versionId}\0${input.sourceSha256}\0${input.cacheKey ?? ""}`;

async function boundedSource(input: DocumentProjectionSource) {
  const fileType = input.fileType.trim().toLowerCase();
  const bytes = await input.readBytes();
  if (!bytes.length || bytes.length > MAX_DOCUMENT_INPUT_BYTES)
    throw new Error("Document projection input exceeds the read limit");
  if (["docx", "xlsx", "xlsm", "pptx"].includes(fileType) &&
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

function existingProjection(key: string) {
  const projection = projectionMemory.get(key)?.deref();
  if (!projection) projectionMemory.delete(key);
  return projection ? Promise.resolve(projection) : projectionLoads.get(key);
}

function projectionFor(key: string, load: () => Promise<NativeDocument>) {
  const existing = existingProjection(key);
  if (existing) return existing;
  const pending = load().then((projection) => {
    for (const [cachedKey, cached] of projectionMemory)
      if (!cached.deref()) projectionMemory.delete(cachedKey);
    if (projectionMemory.size >= 8)
      projectionMemory.delete(projectionMemory.keys().next().value!);
    projectionMemory.set(key, new WeakRef(projection));
    return projection;
  }).finally(() => {
    projectionLoads.delete(key);
  });
  projectionLoads.set(key, pending);
  return pending;
}

async function compileReadProjection(
  input: DocumentProjectionSource,
  source: Awaited<ReturnType<typeof boundedSource>>,
  signal?: AbortSignal,
): Promise<NativeDocument> {
  const { bytes, fileType } = source;
  signal?.throwIfAborted();
  if (fileType === "docx") {
    const document = await structureNative().deriveDocxDocument(
      bytes,
      `${input.documentId}:${input.versionId}`,
    );
    return document;
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
      signal,
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

async function read(input: DocumentProjectionSource, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  assertProjectionSource(input);
  const reference = {
    documentId: input.documentId,
    versionId: input.versionId,
    sourceSha256: input.sourceSha256,
    ...(input.pdfProfile ? { cacheKey: input.pdfProfile.cacheKey } : {}),
  };
  const cached = existingProjection(projectionKey(reference));
  if (cached) return cached.then((result) => {
    options.signal?.throwIfAborted(); return result;
  });
  if (input.fileType.trim().toLowerCase() === "pdf") {
    return pdfDocumentForSource(input.readBytes, reference, {
      pdfProfile: input.pdfProfile,
      signal: options.signal,
    });
  }
  const source = await boundedSource(input);
  const key = projectionKey({
    documentId: input.documentId,
    versionId: input.versionId,
    sourceSha256: source.sourceSha256,
  });
  const pending = projectionFor(key, () =>
    compileReadProjection(input, source, options.signal).then((document) => {
      assertProjectionOutput(document);
      options.signal?.throwIfAborted();
      return document;
    }));
  const result = await pending;
  options.signal?.throwIfAborted();
  return result;
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
  const source = await boundedSource(input);
  options.signal?.throwIfAborted();
  let result: string | null;
  if (fileType === "docx") {
    try {
      result = await structureNative().docxText(source.bytes, options.drafting, options.limit);
    } catch (error) {
      if (!options.drafting) throw error;
      options.signal?.throwIfAborted();
      result = await structureNative().docxText(source.bytes, false, options.limit);
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
  options.signal?.throwIfAborted();
  return options.limit === undefined || fileType === "docx"
    ? result : utf16PrefixCeil(result, options.limit);
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

async function rehydrateEvidence(
  handle: string,
  expected: ProjectionReference,
) {
  const prepared = await preparedForEvidence(handle, expected);
  return rehydratePdfEvidence(prepared.document, prepared.receipt);
}

async function verifyEvidence(
  bytes: Buffer,
  handle: string,
  expected: ProjectionReference,
) {
  if (sha256(bytes) !== expected.sourceSha256)
    throw new Error("PDF evidence source bytes no longer match their version");
  const prepared = await preparedForEvidence(handle, expected);
  return verifyPdfEvidence(prepared.document, prepared.receipt);
}

export const documentProjectionService = Object.freeze({
  read,
  text,
  preparePdf,
  lookupPdf,
  rehydratePdfEvidence: rehydrateEvidence,
  verifyPdfEvidence: verifyEvidence,
});
