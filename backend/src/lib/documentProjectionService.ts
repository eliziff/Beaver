import path from "node:path";
import { access, mkdir, readFile, rm } from "node:fs/promises";

import { sha256 } from "./hash";
import { assertBoundedZip } from "./zip";
import {
  lookupPdfStructure,
  readPdfEvidenceReceipt,
  rehydratePdfEvidence,
  rehydratePdfLinkEvidence,
  verifyPdfLinkEvidence,
  type PdfEvidenceReceipt,
  type PdfLinkEvidence,
  type PdfLocatorKind,
  type PdfLookupInput,
} from "./documentProjectionPdf";
import {
  atomicWriteProjection,
  inspectPdf,
  projectionDirectory,
  publishPdfBytes,
} from "./documentProjection";
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
  pdfPageCountNative,
  pdfDocumentSummaryNative,
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

const STATE_SCHEMA = "beaver.pdf-preparation.v1";
const CACHE_DIRECTORY = projectionDirectory("legalpdf-cache", sha256("legalpdf-cache-v1"));

export type PdfParseStatus = "parsing" | "ready" | "degraded" | "failed";
export type PdfOcrProvider = LegalPdfOcrProvider;
export type {
  PdfEvidenceReceipt,
  PdfLinkEvidence,
  PdfLocatorKind,
  PdfLookupInput,
};

export type PdfParseState = {
  schema_version: typeof STATE_SCHEMA;
  document_id: string;
  version_id: string;
  status: PdfParseStatus;
  source_sha256: string;
  parser_version: string;
  parser_config: {
    ocr_provider: PdfOcrProvider | null;
    layout_provider: "ppdoc" | null;
    selected_pages?: number[];
    profile_sha256: string;
  };
  cache_key: string;
  attempts: number;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  engine_status?: string;
  page_count?: number;
  counts?: Record<string, number>;
  pages_needing_ocr?: number[];
  ocr_routed_pages?: number[];
  error?: string;
};

type PdfStateReference = {
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
  pagesNeedingOcr?: unknown;
  ocrRoutedPages?: unknown;
  counts: Record<string, number>;
};

const exists = (filename: string) => access(filename).then(() => true, () => false);
const statePath = (reference: PdfStateReference) => path.join(
  projectionDirectory("pdf-state", sha256(JSON.stringify({
    documentId: reference.documentId,
    versionId: reference.versionId,
    sourceSha256: reference.sourceSha256,
  }))),
  "state.json",
);

function validProjectionId(value: string) {
  return value === value.trim() && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeParserError(error: unknown) {
  const stderr = isJsonRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
  const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
  if (/invalid file trailer|couldn't parse input|PDF parsing failed/iu.test(message))
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

function parseState(value: unknown): PdfParseState {
  if (!isJsonRecord(value))
    throw new Error("Invalid PDF preparation state");
  const state = value as Partial<PdfParseState>;
  if (state.schema_version !== STATE_SCHEMA ||
      !validProjectionId(String(state.document_id || "")) ||
      !validProjectionId(String(state.version_id || "")) ||
      !/^[a-f0-9]{64}$/u.test(String(state.source_sha256 || "")) ||
      !["parsing", "ready", "degraded", "failed"].includes(String(state.status))) {
    throw new Error("Invalid PDF preparation state");
  }
  return state as PdfParseState;
}

async function readState(reference: PdfStateReference) {
  try {
    return parseState(JSON.parse(await readFile(statePath(reference), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(sourcePath: string, state: PdfParseState) {
  if (!(await exists(sourcePath))) return false;
  const filename = statePath({
    documentId: state.document_id,
    versionId: state.version_id,
    sourceSha256: state.source_sha256,
  });
  await mkdir(path.dirname(filename), { recursive: true });
  await atomicWriteProjection(filename, `${JSON.stringify(state, null, 2)}\n`);
  return true;
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

function physicalArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item) && Number(item) >= 0)
    ? value.map((item) => Number(item) + 1)
    : [];
}

async function preparePdf(input: {
  documentId: string;
  versionId: string;
  sourcePath: string;
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
  const sourceSha256 = input.sourceSha256 ?? (await inspectPdf(input.sourcePath, {
    signal: input.signal,
  })).sourceSha256;
  const reference = { documentId: input.documentId, versionId: input.versionId, sourceSha256 };
  const previous = await readState(reference);
  const profile = profileFor(input.ocrProvider, input.layout);
  const pages = input.pages?.length
    ? [...new Set(input.pages)].sort((left, right) => left - right)
    : undefined;
  const started = new Date().toISOString();
  const parsing: PdfParseState = {
    schema_version: STATE_SCHEMA,
    document_id: input.documentId,
    version_id: input.versionId,
    status: "parsing",
    source_sha256: sourceSha256,
    parser_version: previous?.parser_version ?? "pending",
    parser_config: {
      ocr_provider: profile.ocr?.provider ?? null,
      layout_provider: profile.layout?.provider ?? null,
      ...(pages ? { selected_pages: pages } : {}),
      profile_sha256: sha256(JSON.stringify(profile)),
    },
    cache_key: previous?.cache_key ?? "pending",
    attempts: (previous?.attempts ?? 0) + 1,
    started_at: started,
    updated_at: started,
  };
  await writeState(input.sourcePath, parsing);
  try {
    await input.progress?.({ phase: "inspecting", pages: pages ?? [] });
    await input.progress?.({
      phase: profile.ocr ? "ocr" : "extracting",
      pages: pages ?? [],
    });
    const native = await derivePdfNative({
      kind: "pdf",
      source_pdf: input.sourcePath,
      verified_source_sha256: sourceSha256,
      cache_dir: CACHE_DIRECTORY,
      ...(pages ? { pages } : {}),
      ...profile,
      id: `${input.documentId}:${input.versionId}`,
    });
    const result = pdfDocumentSummaryNative<PdfPreparationSummary>(native);
    input.signal?.throwIfAborted();
    if (result.sha256 !== sourceSha256)
      throw new Error("PDF source changed after preparation began");
    const cacheKey = result.cacheKey;
    if (typeof cacheKey !== "string" || !cacheKey)
      throw new Error("Legal PDF preparation returned no cache key");
    const engineStatus = String(result.status || "degraded");
    if (!["ready", "degraded", "ocr_required"].includes(engineStatus))
      throw new Error("Legal PDF engine returned an invalid preparation status");
    const completed = new Date().toISOString();
    const state: PdfParseState = {
      ...parsing,
      status: engineStatus === "ready" ? "ready" : "degraded",
      parser_version: result.parserVersion,
      cache_key: cacheKey,
      engine_status: engineStatus,
      page_count: result.pageCount,
      counts: result.counts,
      pages_needing_ocr: physicalArray(result.pagesNeedingOcr),
      ocr_routed_pages: physicalArray(result.ocrRoutedPages),
      completed_at: completed,
      updated_at: completed,
    };
    await writeState(input.sourcePath, state);
    const projection: Extract<DocumentReadProjection, { kind: "pdf" }> = {
      kind: "pdf",
      document: native,
      pageCount: result.projectionPageCount,
    };
    rememberProjection(reference, projection);
    return { state, projection };
  } catch (error) {
    if (input.signal?.aborted) {
      await rm(path.dirname(statePath(reference)), { recursive: true, force: true });
      throw error;
    }
    const completed = new Date().toISOString();
    const failed: PdfParseState = {
      ...parsing,
      status: "failed",
      error: safeParserError(error),
      completed_at: completed,
      updated_at: completed,
    };
    await writeState(input.sourcePath, failed);
    throw new Error(failed.error, { cause: error });
  }
}

async function parsePdf(input: Omit<Parameters<typeof preparePdf>[0], "pages">) {
  return (await preparePdf(input)).state;
}

async function parsePdfPages(input: Omit<Parameters<typeof preparePdf>[0], "pages"> & {
  pages: number[];
}) {
  return (await preparePdf(input)).state;
}

const pdfState = readState;

async function removePdf(input: PdfStateReference & { sourcePath: string }) {
  projectionMemory.delete(projectionKey(input));
  await rm(path.dirname(statePath(input)), { recursive: true, force: true });
}

const MAX_DOCUMENT_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSED_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 10_000;
const MAX_PROJECTION_OUTPUT_BYTES = 64 * 1024 * 1024;
const projectionMemory = new Map<string, Promise<DocumentReadProjection>>();
const projectionKey = (input: PdfStateReference) =>
  `${input.documentId}\0${input.versionId}\0${input.sourceSha256}`;

export type DocumentProjectionInput = Readonly<{
  documentId: string;
  versionId: string;
  fileType: string;
  filename?: string;
  sourceSha256?: string | null;
  bytes: Buffer;
}>;

export type DocumentReadProjection =
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

async function boundedSource(input: DocumentProjectionInput, signal?: AbortSignal) {
  if (!validProjectionId(input.documentId) || !validProjectionId(input.versionId))
    throw new Error("Document projection requires valid document and version IDs");
  signal?.throwIfAborted();
  const fileType = input.fileType.trim().toLowerCase();
  const bytes = input.bytes;
  if (!bytes.length || bytes.length > MAX_DOCUMENT_INPUT_BYTES)
    throw new Error("Document projection input exceeds the read limit");
  if (["docx", "xlsx", "xlsm", "pptx"].includes(fileType) &&
      bytes.length > MAX_COMPRESSED_PACKAGE_BYTES)
    throw new Error("Compressed document exceeds the read limit");
  const sourceSha256 = sha256(bytes);
  if (input.sourceSha256 && input.sourceSha256 !== sourceSha256)
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
  reference: PdfStateReference,
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
    const sourcePath = await publishPdfBytes(bytes, sourceSha256, signal);
    return (await preparePdf({
      documentId: input.documentId,
      versionId: input.versionId,
      sourcePath,
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
    const sourcePath = await publishPdfBytes(pdf, sourceSha256, signal);
    const prepared = await preparePdf({
      documentId: input.documentId,
      versionId: input.versionId,
      sourcePath,
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
  const source = await boundedSource(input, options.signal);
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
  sourcePath: string,
  reference: PdfStateReference,
  pages?: number[],
) {
  const key = projectionKey(reference);
  const pending = projectionFor(key, () =>
    preparePdf({
      ...reference,
      sourcePath,
      ...(pages?.length ? { pages } : {}),
    }).then(({ projection }) => projection));
  const [projection, state] = await Promise.all([pending, readState(reference)]);
  if (projection.kind !== "pdf" || !state || !["ready", "degraded"].includes(state.status))
    throw new Error("PDF canonical result is unavailable");
  return { projection, state };
}

async function lookupPdf(
  sourcePath: string,
  input: PdfLookupInput,
  options: {
    persistEvidence?: boolean;
    capturePages?: (pages: { number: number; text: string }[]) => void;
    cacheKey: string;
    documentId: string;
    versionId: string;
    sourceSha256: string;
    pages?: number[];
  },
) {
  const prepared = await preparedForSource(sourcePath, {
    documentId: options.documentId,
    versionId: options.versionId,
    sourceSha256: options.sourceSha256,
  }, options.pages);
  return lookupPdfStructure(prepared.projection.document, input, {
    ...options,
    sourceSha256: prepared.state.source_sha256,
    parserVersion: prepared.state.parser_version,
  });
}

async function preparedForEvidence(sourcePath: string, handle: string) {
  const receipt = await readPdfEvidenceReceipt(handle);
  return preparedForSource(sourcePath, {
    documentId: receipt.source.document_id,
    versionId: receipt.source.version_id,
    sourceSha256: receipt.source.source_sha256,
  });
}

async function rehydrateEvidence(sourcePath: string, handle: string) {
  const prepared = await preparedForEvidence(sourcePath, handle);
  return rehydratePdfEvidence(prepared.projection.document, handle);
}

async function verifyEvidence(sourcePath: string, handle: string) {
  const prepared = await preparedForEvidence(sourcePath, handle);
  return verifyPdfLinkEvidence(prepared.projection.document, handle);
}

async function rehydrateLink(sourcePath: string, handle: string) {
  const prepared = await preparedForEvidence(sourcePath, handle);
  return rehydratePdfLinkEvidence(prepared.projection.document, handle);
}

export const documentProjectionService = Object.freeze({
  read,
  pdfPageCount: pdfPageCountNative,
  parsePdf,
  parsePdfPages,
  publishPdf: (bytes: Buffer, expected?: string, signal?: AbortSignal) => {
    const actual = sha256(bytes);
    if (expected && expected !== actual)
      throw new Error("PDF source bytes no longer match their version");
    return publishPdfBytes(bytes, actual, signal);
  },
  pdfState,
  removePdf,
  lookupPdf,
  readPdfEvidence: readPdfEvidenceReceipt,
  rehydratePdfEvidence: rehydrateEvidence,
  verifyPdfEvidence: verifyEvidence,
  rehydratePdfLink: rehydrateLink,
});
