import { sha256 } from "./hash";
import { assertBoundedZip } from "./zip";
import {
  lookupPdfStructure,
  readPdfEvidenceReceipt,
  rehydratePdfEvidence,
  rehydratePdfLinkEvidence,
  verifyPdfLinkEvidence,
  type PdfLocatorKind,
  type PdfLookupInput,
} from "./documentProjectionPdf";
import { projectionDirectory } from "./documentProjection";
import {
  spreadsheetToLLMStructure,
  type SpreadsheetLlmStructure,
} from "./spreadsheet";
import {
  configuredLegalPdfProfile,
  deriveDocumentNative,
  deriveDocxNative,
  derivePdfNative,
  documentTextBytesNative,
  pdfDocumentSummaryNative,
  restorePdfNative,
  type LegalPdfOcrProvider,
  type NativeDocument,
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
};

export type PdfPreparationProgress = {
  phase: "inspecting" | "extracting" | "ocr";
  pages: number[];
};

type PdfPreparationSummary = {
  sha256: string;
  parserVersion: string;
  cacheKey?: unknown;
  pageCount: number;
  projectionPageCount: number;
  status: string;
};

function preparedSummary(native: NativeDocument, expectedSha256?: string) {
  const result = pdfDocumentSummaryNative<PdfPreparationSummary>(native);
  if (!/^[a-f0-9]{64}$/u.test(result.sha256) ||
      (expectedSha256 && result.sha256 !== expectedSha256))
    throw new Error("PDF source changed after preparation began");
  if (typeof result.cacheKey !== "string" || !result.cacheKey)
    throw new Error("Legal PDF preparation returned no cache key");
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
  const profile = configuredLegalPdfProfile({ env });
  if (layout === null) delete profile.layout;
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
    ...(pages ? { pages } : {}),
    ...profile,
    id: `${input.documentId}:${input.versionId}`,
  };
}

async function openPdf(input: {
  documentId: string;
  versionId: string;
  bytes: Buffer;
  sourceSha256?: string;
  pages?: number[];
  ocrProvider?: PdfOcrProvider | null;
  layout?: boolean | null;
  signal?: AbortSignal;
  progress?: (value: PdfPreparationProgress) => void | Promise<void>;
}) {
  input.signal?.throwIfAborted();
  if (!validProjectionId(input.documentId) || !validProjectionId(input.versionId))
    throw new Error("PDF preparation requires valid document and version IDs");
  const profile = profileFor(input.ocrProvider, input.layout);
  const pages = input.pages?.length
    ? [...new Set(input.pages)].sort((left, right) => left - right)
    : undefined;
  try {
    await input.progress?.({ phase: "inspecting", pages: pages ?? [] });
    await input.progress?.({
      phase: profile.ocr ? "ocr" : "extracting",
      pages: pages ?? [],
    });
    const native = await pdfLifecyclePhase("prepare.native", input.documentId, () => derivePdfNative(
      input.bytes,
      pdfRequest(input, profile, pages)));
    const summary = pdfLifecyclePhase("prepare.summary", input.documentId, () =>
      preparedSummary(native, input.sourceSha256));
    input.signal?.throwIfAborted();
    const projection: Extract<DocumentReadProjection, { kind: "pdf" }> = {
      kind: "pdf",
      document: native,
      pageCount: summary.projectionPageCount,
    };
    if (!pages) {
      rememberProjection({ documentId: input.documentId, versionId: input.versionId,
        sourceSha256: summary.sourceSha256 }, projection);
    }
    return { summary, projection };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new Error(safeParserError(error), { cause: error });
  }
}

async function preparePdf(input: Parameters<typeof openPdf>[0]) {
  const { summary } = await openPdf(input);
  return { status: summary.status, pageCount: summary.pageCount };
}

const MAX_DOCUMENT_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSED_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 10_000;
const MAX_PROJECTION_OUTPUT_BYTES = 64 * 1024 * 1024;
const projectionMemory = new Map<string, Promise<DocumentReadProjection>>();
const projectionKey = (input: ProjectionReference) =>
  `${input.documentId}\0${input.versionId}\0${input.sourceSha256}`;

type DocumentProjectionInput = Readonly<{
  documentId: string;
  versionId: string;
  fileType: string;
  filename?: string;
  sourceSha256?: string | null;
  readBytes: () => Buffer | Promise<Buffer>;
}>;

type DocumentReadProjection =
  | {
      kind: "document";
      document: NativeDocument;
    }
  | {
      kind: "pdf";
      document: NativeDocument;
      pageCount: number;
    }
  | {
      kind: "docx";
      document: NativeDocument;
    }
  | {
      kind: "spreadsheet-grid";
      document: NativeDocument;
      tableCells: SpreadsheetLlmStructure["tableCells"];
    };

async function boundedSource(input: DocumentProjectionInput) {
  const fileType = input.fileType.trim().toLowerCase();
  const bytes = await input.readBytes();
  if (!bytes.length || bytes.length > MAX_DOCUMENT_INPUT_BYTES)
    throw new Error("Document projection input exceeds the read limit");
  if (["docx", "xlsx", "xlsm", "pptx"].includes(fileType) &&
      bytes.length > MAX_COMPRESSED_PACKAGE_BYTES)
    throw new Error("Compressed document exceeds the read limit");
  const sourceSha256 = fileType === "pdf" && input.sourceSha256
    ? input.sourceSha256 : sha256(bytes);
  if (fileType !== "pdf" && input.sourceSha256 && input.sourceSha256 !== sourceSha256)
    throw new Error("Document source bytes no longer match their version");
  return { bytes, fileType, sourceSha256 };
}

async function assertBoundedSpreadsheetPackage(bytes: Buffer, fileType: string) {
  if (!["xlsx", "xlsm"].includes(fileType)) return;
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  assertBoundedZip(zip, "Spreadsheet", {
    maxEntries: MAX_PACKAGE_ENTRIES, maxExpandedBytes: MAX_EXPANDED_PACKAGE_BYTES,
  });
}

function rememberProjection(
  reference: ProjectionReference,
  projection: DocumentReadProjection,
) {
  cacheProjection(projectionKey(reference), Promise.resolve(projection));
}

function cacheProjection(key: string, pending: Promise<DocumentReadProjection>) {
  if (projectionMemory.size >= 8 && !projectionMemory.has(key))
    projectionMemory.delete(projectionMemory.keys().next().value!);
  projectionMemory.set(key, pending);
  return pending;
}

function projectionFor(key: string, load: () => Promise<DocumentReadProjection>) {
  return projectionMemory.get(key) ?? cacheProjection(key, load().catch((error) => {
    projectionMemory.delete(key);
    throw error;
  }));
}

async function compileReadProjection(
  input: DocumentProjectionInput,
  source: Awaited<ReturnType<typeof boundedSource>>,
  signal?: AbortSignal,
): Promise<DocumentReadProjection> {
  const { bytes, fileType, sourceSha256 } = source;
  signal?.throwIfAborted();
  if (fileType === "docx") {
    const document = await deriveDocxNative(
      bytes,
      `${input.documentId}:${input.versionId}`,
    );
    return {
      kind: "docx",
      document,
    };
  }
  if (isSpreadsheetDocumentType(fileType)) {
    await assertBoundedSpreadsheetPackage(bytes, fileType);
    const grid = await spreadsheetToLLMStructure(bytes);
    if (Buffer.byteLength(grid.text) > MAX_PROJECTION_OUTPUT_BYTES)
      throw new Error("Spreadsheet projection output exceeds the read limit");
    const document = await deriveDocumentNative({
      kind: "instrument",
      id: `${input.documentId}:${input.versionId}`,
      text: grid.text,
      table_cells: grid.tableCells,
      reconstruct_lineation: false,
    });
    return {
      kind: "spreadsheet-grid",
      document,
      tableCells: grid.tableCells,
    };
  }
  if (fileType === "pdf") {
    return (await openPdf({
      documentId: input.documentId,
      versionId: input.versionId,
      bytes,
      sourceSha256,
      signal,
    })).projection;
  }
  let text = "";
  if (isPlainTextDocumentType(fileType)) {
    text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  } else if (fileType === "eml") {
    text = await extractEmailText(bytes);
  } else if (fileType === "pptx") {
    text = await extractPresentationText(bytes);
  } else if (isPresentationDocumentType(fileType) || isWordDocumentType(fileType)) {
    const pdf = await docxToPdf(bytes);
    const sourceSha256 = sha256(pdf);
    const prepared = await openPdf({
      documentId: input.documentId,
      versionId: input.versionId,
      bytes: pdf,
      sourceSha256,
      signal,
    });
    return { kind: "document", document: prepared.projection.document };
  }
  const document = await deriveDocumentNative({
    kind: "instrument",
    id: `${input.documentId}:${input.versionId}`,
    text,
    reconstruct_lineation: true,
  });
  return { kind: "document", document };
}

function assertProjectionOutput(projection: DocumentReadProjection) {
  const value = projection.kind === "pdf"
    ? { kind: projection.kind, pageCount: projection.pageCount }
    : projection.kind === "spreadsheet-grid"
      ? { kind: projection.kind, tableCells: projection.tableCells }
      : { kind: projection.kind };
  if (documentTextBytesNative(projection.document) +
      Buffer.byteLength(JSON.stringify(value)) > MAX_PROJECTION_OUTPUT_BYTES)
    throw new Error("Document projection output exceeds the read limit");
}

async function read(input: DocumentProjectionInput, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  if (!validProjectionId(input.documentId) || !validProjectionId(input.versionId))
    throw new Error("Document projection requires valid document and version IDs");
  const reference = input.sourceSha256 && {
    documentId: input.documentId,
    versionId: input.versionId,
    sourceSha256: input.sourceSha256,
  };
  const cached = reference && projectionMemory.get(projectionKey(reference));
  if (cached) return cached.then((result) => {
    options.signal?.throwIfAborted(); return result;
  });
  if (reference && input.fileType.trim().toLowerCase() === "pdf") {
    const pending = projectionFor(projectionKey(reference), async () => {
      const native = await pdfLifecyclePhase("open.native_cache", input.documentId, () =>
        restorePdfNative(pdfRequest(reference, profileFor(undefined, undefined))));
      const projection: DocumentReadProjection = native
        ? { kind: "pdf", document: native,
            pageCount: preparedSummary(native, reference.sourceSha256).projectionPageCount }
        : await compileReadProjection(input, await boundedSource(input), options.signal);
      assertProjectionOutput(projection);
      options.signal?.throwIfAborted();
      return projection;
    });
    const result = await pending;
    options.signal?.throwIfAborted();
    return result;
  }
  const source = await boundedSource(input);
  const key = projectionKey({
    documentId: input.documentId,
    versionId: input.versionId,
    sourceSha256: source.sourceSha256,
  });
  const pending = projectionFor(key, () =>
    compileReadProjection(input, source, options.signal).then((projection) => {
      assertProjectionOutput(projection);
      options.signal?.throwIfAborted();
      return projection;
    }));
  const result = await pending;
  options.signal?.throwIfAborted();
  return result;
}

async function preparedForSource(
  bytes: Buffer,
  reference: ProjectionReference,
  options: {
    pages?: number[];
    signal?: AbortSignal;
    progress?: (value: PdfPreparationProgress) => void | Promise<void>;
  } = {},
) {
  const pages = options.pages?.length
    ? [...new Set(options.pages)].sort((left, right) => left - right)
    : undefined;
  const key = pages
    ? `${projectionKey(reference)}\0pages:${pages.join(",")}`
    : projectionKey(reference);
  const pending = projectionFor(key, () =>
    openPdf({
      ...reference,
      bytes,
      ...(pages ? { pages } : {}),
      signal: options.signal,
      progress: options.progress,
    }).then(({ projection }) => projection));
  const projection = await pending;
  if (projection.kind !== "pdf")
    throw new Error("PDF canonical result is unavailable");
  return { projection, summary: preparedSummary(projection.document, reference.sourceSha256) };
}

async function lookupPdf(
  bytes: Buffer,
  input: PdfLookupInput,
  options: {
    persistEvidence?: boolean;
    capturePages?: (pages: { number: number; text: string }[]) => void;
    documentId: string;
    versionId: string;
    sourceSha256: string;
    pages?: number[];
    signal?: AbortSignal;
    progress?: (value: PdfPreparationProgress) => void | Promise<void>;
  },
) {
  const prepared = await preparedForSource(bytes, {
    documentId: options.documentId,
    versionId: options.versionId,
    sourceSha256: options.sourceSha256,
  }, options);
  return lookupPdfStructure(prepared.projection.document, input, {
    persistEvidence: options.persistEvidence,
    capturePages: options.capturePages,
    cacheKey: prepared.summary.cacheKey,
    documentId: options.documentId,
    versionId: options.versionId,
    sourceSha256: prepared.summary.sourceSha256,
    parserVersion: prepared.summary.parserVersion,
  });
}

async function preparedForEvidence(bytes: Buffer, handle: string) {
  const receipt = await readPdfEvidenceReceipt(handle);
  return preparedForSource(bytes, {
    documentId: receipt.source.document_id,
    versionId: receipt.source.version_id,
    sourceSha256: receipt.source.source_sha256,
  });
}

async function rehydrateEvidence(bytes: Buffer, handle: string) {
  const prepared = await preparedForEvidence(bytes, handle);
  return rehydratePdfEvidence(prepared.projection.document, handle);
}

async function verifyEvidence(bytes: Buffer, handle: string) {
  const prepared = await preparedForEvidence(bytes, handle);
  return verifyPdfLinkEvidence(prepared.projection.document, handle);
}

async function rehydrateLink(bytes: Buffer, handle: string) {
  const prepared = await preparedForEvidence(bytes, handle);
  return rehydratePdfLinkEvidence(prepared.projection.document, handle);
}

export const documentProjectionService = Object.freeze({
  read,
  preparePdf,
  lookupPdf,
  readPdfEvidence: readPdfEvidenceReceipt,
  rehydratePdfEvidence: rehydrateEvidence,
  verifyPdfEvidence: verifyEvidence,
  rehydratePdfLink: rehydrateLink,
});
