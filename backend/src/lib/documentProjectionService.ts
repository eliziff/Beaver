import path from "node:path";
import { access, mkdir, readFile, rm } from "node:fs/promises";

import { parseLegalPdfSourceDoc } from "./legalPdfSourceDoc";
import {
  configuredLegalPdfProfile,
  runLegalPdfDocument,
  type LegalPdfOcrProvider,
} from "./legalPdfProcess";
import { sha256 } from "./hash";
import {
  lookupPdfStructure,
  readPdfEvidenceReceipt,
  readPdfSourceDoc,
  rehydratePdfEvidence,
  rehydratePdfLinkEvidence,
  verifyPdfLinkEvidence,
  type PdfEvidenceReceipt,
  type PdfLinkEvidence,
  type PdfLocatorKind,
  type PdfLookupInput,
  type PdfLookupUnit,
} from "./documentProjectionPdf";
import {
  atomicWriteProjection,
  inspectPdf,
  projectionDirectory,
  publishPdfBytes,
} from "./documentProjection";
import { openDocxSession, type DocxSession } from "./docx/session";
import {
  spreadsheetToLLMStructure,
  type SpreadsheetLlmStructure,
} from "./spreadsheet";
import {
  createSourceDoc,
  type SourceDoc,
  type SourceDocBlock,
} from "./sourceDoc";
import {
  isPlainTextDocumentType,
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
} from "./documentTypes";
import { extractEmailText } from "./emailText";
import { extractPresentationText } from "./officeText";
import { docxToPdf } from "./convert";
import {
  scanDocxPathology,
  type DocxPathologyReport,
} from "./docx/pathology";

const STATE_SCHEMA = "beaver.pdf-preparation.v1";
const CACHE_DIRECTORY = projectionDirectory("legalpdf-cache", sha256("legalpdf-cache-v1"));

export type PdfParseStatus = "parsing" | "ready" | "degraded" | "failed";
export type PdfOcrProvider = LegalPdfOcrProvider;
export type {
  PdfEvidenceReceipt,
  PdfLinkEvidence,
  PdfLocatorKind,
  PdfLookupInput,
  PdfLookupUnit,
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

type PrepareResult = {
  status?: unknown;
  page_count?: unknown;
  pages_needing_ocr?: unknown;
  ocr_routed_pages?: unknown;
  counts?: unknown;
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

function abortError() {
  return new DOMException("Document projection aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function safeParserError(error: unknown) {
  const stderr = error && typeof error === "object" &&
    typeof (error as { stderr?: unknown }).stderr === "string"
    ? (error as { stderr: string }).stderr
    : "";
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
  if (!value || typeof value !== "object" || Array.isArray(value))
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

function integerArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item) && Number(item) > 0)
    ? value.map(Number)
    : [];
}

function numberRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  ));
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
  throwIfAborted(input.signal);
  if (!validProjectionId(input.documentId) || !validProjectionId(input.versionId))
    throw new Error("PDF preparation requires valid document and version IDs");
  const inspected = await inspectPdf(input.sourcePath, {
    expectedSha256: input.sourceSha256,
    signal: input.signal,
  });
  const sourceSha256 = inspected.sourceSha256;
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
    const inspection = await runLegalPdfDocument<{
      page_count: number;
      pages_needing_ocr: number[];
    }>({ operation: "inspect", source_pdf: input.sourcePath }, {
      signal: input.signal,
      timeoutMs: 60_000,
    });
    if (inspection.source.sha256 !== sourceSha256)
      throw new Error("PDF source changed after preparation began");
    const weak = integerArray(inspection.result.pages_needing_ocr);
    const routed = pages ? weak.filter((page) => pages.includes(page)) : weak;
    await input.progress?.({
      phase: routed.length && profile.ocr ? "ocr" : "extracting",
      pages: routed,
    });
    const prepared = await runLegalPdfDocument<PrepareResult>({
      operation: "prepare",
      source_pdf: input.sourcePath,
      cache_dir: CACHE_DIRECTORY,
      ...(pages ? { pages } : {}),
      ...profile,
    }, { signal: input.signal, timeoutMs: 30 * 60_000 });
    if (prepared.source.sha256 !== sourceSha256)
      throw new Error("PDF source changed after preparation began");
    if (!prepared.source.cache_key)
      throw new Error("Legal PDF preparation returned no cache key");
    const engineStatus = String(prepared.result.status || "degraded");
    if (!["ready", "degraded", "ocr_required"].includes(engineStatus))
      throw new Error("Legal PDF engine returned an invalid preparation status");
    const completed = new Date().toISOString();
    const state: PdfParseState = {
      ...parsing,
      status: engineStatus === "ready" ? "ready" : "degraded",
      parser_version: prepared.source.parser_version,
      cache_key: prepared.source.cache_key,
      engine_status: engineStatus,
      page_count: prepared.source.page_count,
      counts: numberRecord(prepared.result.counts),
      pages_needing_ocr: integerArray(prepared.result.pages_needing_ocr),
      ocr_routed_pages: integerArray(prepared.result.ocr_routed_pages),
      completed_at: completed,
      updated_at: completed,
    };
    await writeState(input.sourcePath, state);
    return state;
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
  return preparePdf(input);
}

async function parsePdfPages(input: Omit<Parameters<typeof preparePdf>[0], "pages"> & {
  pages: number[];
}) {
  return preparePdf(input);
}

async function pdfState(input: PdfStateReference & { sourcePath: string }) {
  const state = await readState(input);
  if (!state) return null;
  try {
    const inspected = await inspectPdf(input.sourcePath, {
      expectedSha256: input.sourceSha256,
    });
    return inspected.sourceSha256 === state.source_sha256 ? state : null;
  } catch {
    await rm(path.dirname(statePath(input)), { recursive: true, force: true });
    return null;
  }
}

async function removePdf(input: PdfStateReference & { sourcePath: string }) {
  await rm(path.dirname(statePath(input)), { recursive: true, force: true });
}

const MAX_DOCUMENT_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSED_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 10_000;
const MAX_PROJECTION_OUTPUT_BYTES = 64 * 1024 * 1024;
const projectionMemory = new Map<string, Promise<DocumentReadProjection>>();

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
      kind: "source-doc" | "pdf";
      text: string;
      sourceDoc: SourceDoc;
      tableCells: [];
    }
  | {
      kind: "docx-session";
      text: string;
      sourceDoc: SourceDoc;
      session: DocxSession;
      pathology: DocxPathologyReport;
      tableCells: Awaited<ReturnType<DocxSession["document"]>>["tableCells"];
    }
  | {
      kind: "spreadsheet-grid";
      text: string;
      grid: SpreadsheetLlmStructure;
      tableCells: SpreadsheetLlmStructure["tableCells"];
    };

async function boundedSource(input: DocumentProjectionInput, signal?: AbortSignal) {
  if (!validProjectionId(input.documentId) || !validProjectionId(input.versionId))
    throw new Error("Document projection requires valid document and version IDs");
  throwIfAborted(signal);
  const fileType = input.fileType.trim().toLowerCase();
  const bytes = input.bytes;
  if (!bytes.length || bytes.length > MAX_DOCUMENT_INPUT_BYTES)
    throw new Error("Document projection input exceeds the read limit");
  if (["docx", "xlsx", "xlsm"].includes(fileType) &&
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
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_PACKAGE_ENTRIES)
    throw new Error("Spreadsheet contains too many package entries");
  let expanded = 0;
  for (const entry of entries) {
    const size = (entry as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || Number(size) < 0)
      throw new Error("Spreadsheet has invalid ZIP size metadata");
    expanded += Number(size);
    if (expanded > MAX_EXPANDED_PACKAGE_BYTES)
      throw new Error("Spreadsheet expands beyond the read limit");
  }
}

function sourceDocProjection(kind: "source-doc" | "pdf", doc: SourceDoc): DocumentReadProjection {
  if (Buffer.byteLength(doc.text) > MAX_PROJECTION_OUTPUT_BYTES)
    throw new Error("Document projection output exceeds the read limit");
  return { kind, text: doc.text, sourceDoc: doc, tableCells: [] };
}

async function compileReadProjection(
  input: DocumentProjectionInput,
  source: Awaited<ReturnType<typeof boundedSource>>,
  signal?: AbortSignal,
): Promise<DocumentReadProjection> {
  const { bytes, fileType, sourceSha256 } = source;
  throwIfAborted(signal);
  if (fileType === "docx") {
    const session = await openDocxSession(bytes);
    const body = await session.document(input.filename ?? "document.docx");
    const blocks: SourceDocBlock[] = body.paragraphs.flatMap((paragraph, index) =>
      paragraph.acceptedText ? [{
        kind: "paragraph" as const,
        label: `par${index + 1}`,
        start: paragraph.globalStart,
        end: paragraph.globalStart + paragraph.acceptedText.length,
        origin: "native" as const,
      }] : [],
    );
    const sourceDoc = createSourceDoc({
      provider: null,
      id: `${input.documentId}:${input.versionId}`,
      text: body.text,
      blocks,
    });
    return {
      kind: "docx-session",
      text: body.text,
      sourceDoc,
      session,
      pathology: await scanDocxPathology(session),
      tableCells: body.tableCells,
    };
  }
  if (isSpreadsheetDocumentType(fileType)) {
    await assertBoundedSpreadsheetPackage(bytes, fileType);
    const grid = await spreadsheetToLLMStructure(bytes);
    if (Buffer.byteLength(grid.text) > MAX_PROJECTION_OUTPUT_BYTES)
      throw new Error("Spreadsheet projection output exceeds the read limit");
    return { kind: "spreadsheet-grid", text: grid.text, grid, tableCells: grid.tableCells };
  }
  if (fileType === "pdf") {
    const sourcePath = await publishPdfBytes(bytes, sourceSha256, signal);
    const state = await parsePdf({
      documentId: input.documentId,
      versionId: input.versionId,
      sourcePath,
      sourceSha256,
      signal,
    });
    const doc = await readPdfSourceDoc(sourcePath, state.cache_key);
    return sourceDocProjection("pdf", doc);
  }
  let text = "";
  if (isPlainTextDocumentType(fileType)) {
    text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  } else if (fileType === "eml") {
    text = await extractEmailText(bytes);
  } else if (fileType === "pptx") {
    text = await extractPresentationText(bytes);
  } else if (isPresentationDocumentType(fileType) || isWordDocumentType(fileType)) {
    text = (await parseLegalPdfSourceDoc(await docxToPdf(bytes), signal)).text;
  }
  const doc = createSourceDoc({
    provider: null,
    id: `${input.documentId}:${input.versionId}`,
    text,
    blocks: [],
  });
  return sourceDocProjection("source-doc", doc);
}

function assertProjectionOutput(projection: DocumentReadProjection) {
  const value = projection.kind === "docx-session"
    ? { kind: projection.kind, text: projection.text, sourceDoc: projection.sourceDoc,
        pathology: projection.pathology, tableCells: projection.tableCells }
    : projection;
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PROJECTION_OUTPUT_BYTES)
    throw new Error("Document projection output exceeds the read limit");
}

async function read(input: DocumentProjectionInput, options: { signal?: AbortSignal } = {}) {
  const source = await boundedSource(input, options.signal);
  const key = `${input.documentId}\0${input.versionId}\0${source.sourceSha256}`;
  let pending = projectionMemory.get(key);
  if (!pending) {
    pending = compileReadProjection(input, source, options.signal).then((projection) => {
      assertProjectionOutput(projection);
      throwIfAborted(options.signal);
      return projection;
    }).catch((error) => {
      projectionMemory.delete(key);
      throw error;
    });
    if (projectionMemory.size >= 32)
      projectionMemory.delete(projectionMemory.keys().next().value!);
    projectionMemory.set(key, pending);
  }
  const result = await pending;
  throwIfAborted(options.signal);
  return result;
}

export const documentProjectionService = Object.freeze({
  read,
  parsePdf,
  parsePdfPages,
  publishPdf: (bytes: Buffer, expected?: string, signal?: AbortSignal) =>
    publishPdfBytes(bytes, expected ?? sha256(bytes), signal),
  pdfState,
  removePdf,
  lookupPdf: lookupPdfStructure,
  readPdfEvidence: readPdfEvidenceReceipt,
  rehydratePdfEvidence,
  verifyPdfEvidence: verifyPdfLinkEvidence,
  rehydratePdfLink: rehydratePdfLinkEvidence,
});
