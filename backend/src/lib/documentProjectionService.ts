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
import type { lintDocxStructure } from "./docxStructuralLint";
import type { SourceDoc } from "./sourceDoc";
import {
  analyzeDocumentNative,
  analyzePdfNative,
  configuredLegalPdfProfile,
  type LegalPdfOcrProvider,
  type NativePdfDocument,
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
import { decodeXmlText } from "./text";
import { isJsonRecord } from "./value";
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
  structure: { text: string; nodes: { kind: string }[]; notes?: unknown[] };
  pdf_source_map: {
    pages: unknown[];
    table_ids: string[];
    image_ids: string[];
  };
  pairing_audit?: unknown;
  source_doc?: SourceDoc;
  source: {
    sha256: string;
    parser_version: string;
    page_count: number;
    status: string;
    cache_key?: unknown;
    pages_needing_ocr?: unknown;
    ocr_routed_pages?: unknown;
  };
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
    await input.progress?.({
      phase: profile.ocr ? "ocr" : "extracting",
      pages: pages ?? [],
    });
    const prepared = await analyzePdfNative<PrepareResult>({
      kind: "pdf",
      source_pdf: input.sourcePath,
      cache_dir: CACHE_DIRECTORY,
      ...(pages ? { pages } : {}),
      ...profile,
      id: `${input.documentId}:${input.versionId}`,
      source_doc: true,
      pairing_audit: true,
    });
    input.signal?.throwIfAborted();
    const source = prepared.result.source;
    if (source.sha256 !== sourceSha256)
      throw new Error("PDF source changed after preparation began");
    const cacheKey = source.cache_key;
    if (typeof cacheKey !== "string" || !cacheKey)
      throw new Error("Legal PDF preparation returned no cache key");
    if (!prepared.result.source_doc)
      throw new Error("Legal PDF preparation omitted SourceDoc");
    const engineStatus = String(source.status || "degraded");
    if (!["ready", "degraded", "ocr_required"].includes(engineStatus))
      throw new Error("Legal PDF engine returned an invalid preparation status");
    const completed = new Date().toISOString();
    const state: PdfParseState = {
      ...parsing,
      status: engineStatus === "ready" ? "ready" : "degraded",
      parser_version: source.parser_version,
      cache_key: cacheKey,
      engine_status: engineStatus,
      page_count: source.page_count,
      counts: {
        paragraphs: prepared.result.structure.nodes.filter(({ kind }) => kind === "paragraph").length,
        sections: prepared.result.structure.nodes.filter(({ kind }) => kind === "section").length,
        footnotes: prepared.result.structure.notes?.length ?? 0,
        tables: prepared.result.pdf_source_map.table_ids.length,
        images: prepared.result.pdf_source_map.image_ids.length,
      },
      pages_needing_ocr: physicalArray(source.pages_needing_ocr),
      ocr_routed_pages: physicalArray(source.ocr_routed_pages),
      completed_at: completed,
      updated_at: completed,
    };
    await writeState(input.sourcePath, state);
    const projection = pdfProjection(prepared.result, prepared.native);
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
      kind: "source-doc";
      sourceDoc: SourceDoc;
      structure: unknown;
      tableCells: [];
    }
  | {
      kind: "pdf";
      sourceDoc: SourceDoc;
      structure: PrepareResult["structure"];
      pdfSourceMap: PrepareResult["pdf_source_map"];
      pairingAudit: PrepareResult["pairing_audit"];
      native: NativePdfDocument;
      tableCells: [];
    }
  | {
      kind: "docx-session";
      sourceDoc: SourceDoc;
      structure: Parameters<typeof lintDocxStructure>[0];
      session: DocxSession;
      pathology: DocxPathologyReport;
      tableCells: Awaited<ReturnType<DocxSession["document"]>>["tableCells"];
    }
  | {
      kind: "spreadsheet-grid";
      sourceDoc: SourceDoc;
      structure: { text: string };
      grid: SpreadsheetLlmStructure;
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

function sourceDocProjection(
  analysis: { structure: unknown; source_doc: SourceDoc },
): DocumentReadProjection {
  if (Buffer.byteLength(analysis.source_doc.text) > MAX_PROJECTION_OUTPUT_BYTES)
    throw new Error("Document projection output exceeds the read limit");
  return {
    kind: "source-doc",
    sourceDoc: analysis.source_doc,
    structure: analysis.structure,
    tableCells: [],
  };
}

function pdfProjection(
  result: PrepareResult,
  native: NativePdfDocument,
): Extract<DocumentReadProjection, { kind: "pdf" }> {
  if (!result.source_doc) throw new Error("Legal PDF preparation omitted SourceDoc");
  return {
    kind: "pdf",
    sourceDoc: result.source_doc,
    structure: result.structure,
    pdfSourceMap: result.pdf_source_map,
    pairingAudit: result.pairing_audit,
    native,
    tableCells: [],
  };
}

function rememberProjection(
  reference: PdfStateReference,
  projection: DocumentReadProjection,
) {
  if (projectionMemory.size >= 8 && !projectionMemory.has(projectionKey(reference)))
    projectionMemory.delete(projectionMemory.keys().next().value!);
  projectionMemory.set(projectionKey(reference), Promise.resolve(projection));
}

function docxParagraphs(documentXml: string) {
  return [...documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gu)].map(([paragraph]) => {
    const accepted = paragraph.replace(/<w:del\b[\s\S]*?<\/w:del>/gu, "");
    return [...accepted.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)]
      .map((match) => decodeXmlText(match[1] ?? ""))
      .join("")
      .replace(/[“”]/gu, '"')
      .replace(/[‘’]/gu, "'")
      .replace(/[\u00a0\u2007\u202f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  });
}

function docxAnalysisInput(
  body: Awaited<ReturnType<DocxSession["document"]>>,
  paragraphs: string[],
) {
  if (!body.tableCells.length) return { paragraphs, tableCells: [] };
  const indexed = body.paragraphs.map(({ events }) => events
    .flatMap((event) => event.kind === "run" && !event.run.del ? [event.run.text] : [])
    .join("")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/[\u00a0\u2007\u202f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim());
  const starts: number[] = [];
  let textLength = 0;
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index) textLength += 1;
    starts.push(textLength);
    textLength += paragraph.length;
  }
  const boundaries = new Map<number, number>();
  let canonical = 0;
  body.paragraphs.forEach((paragraph, index) => {
    const matched = indexed[index] === paragraphs[canonical];
    const start = starts[canonical] ?? textLength;
    const end = matched ? start + paragraphs[canonical].length : start;
    boundaries.set(paragraph.globalStart, start);
    boundaries.set(paragraph.globalStart + paragraph.acceptedText.length, end);
    if (matched) canonical += 1;
  });
  if (canonical !== paragraphs.length) {
    throw new Error("DOCX table paragraphs do not align with structural text");
  }
  const tableCells = body.tableCells.map((cell) => {
    const start = boundaries.get(cell.start);
    const end = boundaries.get(cell.end);
    if (start == null || end == null) {
      throw new Error("DOCX table cell does not align with accepted paragraphs");
    }
    return { ...cell, start, end };
  });
  return { paragraphs, tableCells };
}

async function compileReadProjection(
  input: DocumentProjectionInput,
  source: Awaited<ReturnType<typeof boundedSource>>,
  signal?: AbortSignal,
): Promise<DocumentReadProjection> {
  const { bytes, fileType, sourceSha256 } = source;
  signal?.throwIfAborted();
  if (fileType === "docx") {
    const session = await openDocxSession(bytes);
    const body = await session.document(input.filename ?? "document.docx");
    const documentXml = await session.readText("word/document.xml");
    if (documentXml == null) throw new Error("Structural lint requires a valid DOCX");
    const { paragraphs, tableCells } = docxAnalysisInput(
      body,
      docxParagraphs(documentXml),
    );
    const [analyzed, pathology] = await Promise.all([
      analyzeDocumentNative<Parameters<typeof lintDocxStructure>[0]>({
        kind: "docx",
        id: `${input.documentId}:${input.versionId}`,
        paragraphs,
        table_cells: tableCells,
        source_doc: true,
      }),
      scanDocxPathology(session),
    ]);
    if (!analyzed.source_doc) {
      throw new Error("Legal structure native module omitted DOCX SourceDoc");
    }
    return {
      kind: "docx-session",
      sourceDoc: analyzed.source_doc,
      structure: analyzed.structure,
      session,
      pathology,
      tableCells,
    };
  }
  if (isSpreadsheetDocumentType(fileType)) {
    await assertBoundedSpreadsheetPackage(bytes, fileType);
    const grid = await spreadsheetToLLMStructure(bytes);
    if (Buffer.byteLength(grid.text) > MAX_PROJECTION_OUTPUT_BYTES)
      throw new Error("Spreadsheet projection output exceeds the read limit");
    const analyzed = await analyzeDocumentNative<{ text: string }>({
      kind: "instrument",
      id: `${input.documentId}:${input.versionId}`,
      text: grid.text,
      table_cells: grid.tableCells,
      reconstruct_lineation: false,
      source_doc: true,
    });
    if (!analyzed.source_doc) {
      throw new Error("Legal structure native module omitted spreadsheet SourceDoc");
    }
    return {
      kind: "spreadsheet-grid",
      sourceDoc: analyzed.source_doc,
      structure: analyzed.structure,
      grid,
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
    return sourceDocProjection({
      structure: prepared.projection.structure,
      source_doc: prepared.projection.sourceDoc,
    });
  }
  const analyzed = await analyzeDocumentNative({
    kind: "instrument",
    id: `${input.documentId}:${input.versionId}`,
    text,
    table_cells: [],
    reconstruct_lineation: true,
    source_doc: true,
  });
  if (!analyzed.source_doc) {
    throw new Error("Legal structure native module omitted SourceDoc");
  }
  return sourceDocProjection({ ...analyzed, source_doc: analyzed.source_doc });
}

function assertProjectionOutput(projection: DocumentReadProjection) {
  const value = projection.kind === "docx-session"
    ? { kind: projection.kind, sourceDoc: projection.sourceDoc,
        structure: projection.structure, pathology: projection.pathology,
        tableCells: projection.tableCells }
    : projection.kind === "pdf"
      ? { kind: projection.kind, sourceDoc: projection.sourceDoc,
          structure: projection.structure, pdfSourceMap: projection.pdfSourceMap,
          pairingAudit: projection.pairingAudit }
      : projection;
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PROJECTION_OUTPUT_BYTES)
    throw new Error("Document projection output exceeds the read limit");
}

async function read(input: DocumentProjectionInput, options: { signal?: AbortSignal } = {}) {
  const source = await boundedSource(input, options.signal);
  const key = projectionKey({
    documentId: input.documentId,
    versionId: input.versionId,
    sourceSha256: source.sourceSha256,
  });
  let pending = projectionMemory.get(key);
  if (!pending) {
    pending = compileReadProjection(input, source, options.signal).then((projection) => {
      assertProjectionOutput(projection);
      options.signal?.throwIfAborted();
      return projection;
    }).catch((error) => {
      projectionMemory.delete(key);
      throw error;
    });
    if (projectionMemory.size >= 8)
      projectionMemory.delete(projectionMemory.keys().next().value!);
    projectionMemory.set(key, pending);
  }
  const result = await pending;
  options.signal?.throwIfAborted();
  return result;
}

async function preparedForSource(
  sourcePath: string,
  reference: PdfStateReference,
  pages?: number[],
) {
  await inspectPdf(sourcePath, { expectedSha256: reference.sourceSha256 });
  const key = projectionKey(reference);
  let pending = projectionMemory.get(key);
  if (!pending) {
    pending = preparePdf({
      ...reference,
      sourcePath,
      ...(pages?.length ? { pages } : {}),
    }).then(({ projection }) => projection).catch((error) => {
      projectionMemory.delete(key);
      throw error;
    });
    if (projectionMemory.size >= 8)
      projectionMemory.delete(projectionMemory.keys().next().value!);
    projectionMemory.set(key, pending);
  }
  const [projection, state] = await Promise.all([pending, readState(reference)]);
  if (projection.kind !== "pdf" || !state || !["ready", "degraded"].includes(state.status))
    throw new Error("PDF canonical result is unavailable");
  return { projection, state };
}

async function lookupPdf(
  sourcePath: string,
  input: PdfLookupInput,
  options?: {
    persistEvidence?: boolean;
    capturePages?: (pages: { number: number; text: string }[]) => void;
    cacheKey?: string;
    documentId?: string;
    versionId?: string;
    pages?: number[];
  },
) {
  if (!options?.documentId || !options.versionId)
    return lookupPdfStructure(null, input, options);
  const inspected = await inspectPdf(sourcePath);
  const prepared = await preparedForSource(sourcePath, {
    documentId: options.documentId,
    versionId: options.versionId,
    sourceSha256: inspected.sourceSha256,
  }, options.pages);
  return lookupPdfStructure(prepared.projection.native, input, {
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
  return rehydratePdfEvidence(prepared.projection.native, handle);
}

async function verifyEvidence(sourcePath: string, handle: string) {
  const prepared = await preparedForEvidence(sourcePath, handle);
  return verifyPdfLinkEvidence(prepared.projection.native, handle);
}

async function rehydrateLink(sourcePath: string, handle: string) {
  const prepared = await preparedForEvidence(sourcePath, handle);
  return rehydratePdfLinkEvidence(prepared.projection.native, handle);
}

export const documentProjectionService = Object.freeze({
  read,
  parsePdf,
  parsePdfPages,
  publishPdf: (bytes: Buffer, expected?: string, signal?: AbortSignal) =>
    publishPdfBytes(bytes, expected ?? sha256(bytes), signal),
  pdfState,
  removePdf,
  lookupPdf,
  readPdfEvidence: readPdfEvidenceReceipt,
  rehydratePdfEvidence: rehydrateEvidence,
  verifyPdfEvidence: verifyEvidence,
  rehydratePdfLink: rehydrateLink,
});
