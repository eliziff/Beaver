import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  access,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { parseLegalPdfSourceDoc } from "./legalPdfSourceDoc";
import {
  configuredLegalPdfLayout,
  configuredLegalPdfOcrProvider,
  LEGAL_PDF_DOCUMENT_SCHEMA,
  LEGAL_PDF_PARSER_VERSION,
  legalPdfLayoutArguments,
  legalPdfOcrArguments,
  runLegalPdf,
  type LegalPdfLayoutConfig,
  type LegalPdfOcrProvider,
} from "./legalPdfProcess";
import { sha256 } from "./hash";
import type { UserApiKeys } from "./llm";
import {
  PDF_VISION_LAYOUT_IDENTITY,
  runPdfVisionLayout,
} from "./pdfVisionLayout";
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
  openPdfProjection,
  pdfProjectionDirectory,
  pdfProjectionIdentity,
  pdfProjectionKey,
  projectionDirectory,
  publishPdfBytes,
  publishPdfProjection,
  relativeLocalDataPath,
  removePdfProjection,
  resolveLocalDataPath,
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

const STATE_SUFFIX = ".legalpdf-state.json";
const STATE_SCHEMA = "mike.pdf_parse.v1";
const statuses = new Set(["queued", "parsing", "ready", "degraded", "failed"]);

export type PdfParseStatus =
  | "queued"
  | "parsing"
  | "ready"
  | "degraded"
  | "failed";

export type PdfOcrProvider = LegalPdfOcrProvider;

export type {
  PdfEvidenceReceipt,
  PdfLinkEvidence,
  PdfLocatorKind,
  PdfLookupInput,
  PdfLookupUnit,
};

export type PdfRepairConfig = {
  model: string;
  effort: string;
};

type PdfRepairIdentity = {
  schema_version: "legalpdf.codex.repair-identity.v1";
  prompt_version: string;
  response_schema_sha256: string;
  repairable_diagnostics_sha256: string;
  context_radius: number;
  max_attempts: number;
  max_live_calls: number;
  max_scope_pages: number;
  repairable_diagnostics: string[];
};

export type PdfParseState = {
  schema_version: typeof STATE_SCHEMA;
  job_id: string;
  document_id: string;
  version_id: string;
  status: PdfParseStatus;
  source_sha256: string;
  parser_version: string;
  parser_config: {
    mode: "local" | "codex";
    ocr_provider: PdfOcrProvider | null;
    ocr_identity?: string;
    ocr_language?: string;
    ocr_dpi?: number;
    ocr_psm?: number;
    layout_provider: "local" | "mllm" | null;
    layout_model: string | null;
    layout_identity?: string;
    model: string | null;
    effort?: string | null;
    prompt_version: string | null;
    response_schema_sha256?: string | null;
    repairable_diagnostics_sha256?: string | null;
    repairable_diagnostics?: string[];
    context_radius?: number | null;
    max_attempts?: number | null;
    max_live_calls?: number | null;
    max_scope_pages?: number | null;
  };
  repair_contract?: PdfRepairIdentity;
  cache_key: string;
  artifact_manifest: string;
  attempts: number;
  queued_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  interrupted_at?: string;
  engine_status?: string;
  page_count?: number;
  counts?: Record<string, number>;
  diagnostic_count?: number;
  diagnostic_summary?: {
    by_severity: Record<string, number>;
    by_code: Record<string, number>;
  };
  structural_repair_available?: boolean;
  error?: string;
};

type JsonObject = Record<string, unknown>;

const jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
const layoutIdentityPromises = new Map<string, Promise<string>>();
const layoutApiKeys = new Map<string, UserApiKeys>();
// ponytail: one parser at a time protects weak local machines; use a bounded
// worker pool only if measured queue latency justifies the extra machinery.
let workTail: Promise<unknown> = Promise.resolve();

function parserConfig(
  ocrProvider: PdfOcrProvider | null,
  ocrIdentity?: string,
  layout?: LegalPdfLayoutConfig | null,
  layoutIdentity?: string,
  repairIdentity?: PdfRepairIdentity | null,
  repair?: PdfRepairConfig | null,
): PdfParseState["parser_config"] {
  const config: PdfParseState["parser_config"] = {
    mode: repair ? "codex" : "local",
    ocr_provider: ocrProvider,
    layout_provider: layout?.provider ?? null,
    layout_model: layout?.provider === "mllm" ? layout.model : null,
    ...(layoutIdentity ? { layout_identity: layoutIdentity } : {}),
    model: repair?.model ?? null,
    prompt_version:
      repair && repairIdentity ? repairIdentity.prompt_version : null,
  };
  if (repair && repairIdentity) {
    Object.assign(config, {
      response_schema_sha256: repairIdentity.response_schema_sha256,
      repairable_diagnostics_sha256:
        repairIdentity.repairable_diagnostics_sha256,
      repairable_diagnostics: repairIdentity.repairable_diagnostics,
      context_radius: repairIdentity.context_radius,
      max_attempts: repairIdentity.max_attempts,
      max_live_calls: repairIdentity.max_live_calls,
      max_scope_pages: repairIdentity.max_scope_pages,
    });
  }
  if (repair) config.effort = repair.effort;
  if (!ocrProvider) return config;
  const dpi = Number(process.env.MIKE_PDF_OCR_DPI);
  const common = {
    ...config,
    ...(ocrIdentity ? { ocr_identity: ocrIdentity } : {}),
    ocr_dpi: Number.isInteger(dpi) && dpi >= 72 && dpi <= 600 ? dpi : 180,
  };
  if (ocrProvider === "kraken-lite") return common;
  const language = process.env.MIKE_PDF_OCR_LANGUAGE?.trim() || "eng";
  const psm = Number(process.env.MIKE_PDF_OCR_PSM);
  return {
    ...common,
    ocr_language: /^[A-Za-z0-9_+-]+$/u.test(language) ? language : "eng",
    ocr_psm: Number.isInteger(psm) && psm >= 0 && psm <= 13 ? psm : 3,
  };
}

function validRepairRequest(value: PdfRepairConfig) {
  return (
    typeof value.model === "string" &&
    value.model === value.model.trim() &&
    value.model.length > 0 &&
    value.model.length <= 160 &&
    !/[\u0000-\u001f\u007f]/u.test(value.model) &&
    typeof value.effort === "string" &&
    /^[A-Za-z0-9_-]{1,32}$/u.test(value.effort)
  );
}

function preservedRepair(
  state: PdfParseState | null,
): PdfRepairConfig | null {
  const config = state?.parser_config;
  if (config?.mode !== "codex") return null;
  const repair = { model: config.model, effort: config.effort };
  return typeof repair.model === "string" &&
    typeof repair.effort === "string" &&
    validRepairRequest(repair as PdfRepairConfig)
    ? (repair as PdfRepairConfig)
    : null;
}

function safeParserError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Tesseract was not found/iu.test(message)) {
    return "Tesseract was not found. Install it or configure its executable.";
  }
  if (/timed out|ETIMEDOUT/iu.test(message)) {
    return "PDF structural parsing timed out";
  }
  if (/Tesseract identity changed/iu.test(message)) {
    return "Tesseract changed before OCR began; retry the parse";
  }
  if (/Tesseract OCR failed/iu.test(message)) return "Tesseract OCR failed";
  if (/layout|PPdoc|OpenVINO/iu.test(message)) {
    return "PDF layout analysis could not start; check its model or provider settings";
  }
  if (/Kraken|LEGALPDF_KRAKEN|ONNX/iu.test(message)) {
    return "Kraken-lite OCR could not start; check its local runtime assets";
  }
  if (/Codex structural repair could not start/iu.test(message)) {
    return "Codex structural repair could not start";
  }
  if (/source changed after its parse job was queued/iu.test(message)) {
    return "PDF source changed after its parse job was queued";
  }
  return "PDF structural parser failed";
}

async function detectedOcrIdentity(
  provider: PdfOcrProvider,
  config: PdfParseState["parser_config"],
  signal?: AbortSignal,
) {
  try {
    const arguments_ = legalPdfOcrArguments(provider, {
      language: config.ocr_language,
      dpi: config.ocr_dpi,
      psm: config.ocr_psm,
    });
    arguments_[0] = "--provider";
    const result = await runLegalPdf(
      ["ocr-identity", ...arguments_],
      { timeoutMs: 15_000, signal },
    );
    const payload = JSON.parse(String(result.stdout)) as {
      provider?: unknown;
      identity?: unknown;
    };
    if (
      payload.provider !== provider ||
      typeof payload.identity !== "string" ||
      !payload.identity ||
      payload.identity.length > 1_024 ||
      /[\r\n\u0000]/u.test(payload.identity)
    ) {
      throw new Error(`Invalid ${provider} identity`);
    }
    return payload.identity;
  } catch (error) {
    throw new Error(safeParserError(error));
  }
}

async function detectedRepairIdentity(
  signal?: AbortSignal,
): Promise<PdfRepairIdentity> {
  try {
    const result = await runLegalPdf(["repair-identity"], {
      timeoutMs: 3_000,
      signal,
    });
    const payload = JSON.parse(String(result.stdout)) as {
      schema_version?: unknown;
      prompt_version?: unknown;
      response_schema_sha256?: unknown;
      repairable_diagnostics_sha256?: unknown;
      context_radius?: unknown;
      max_attempts?: unknown;
      max_live_calls?: unknown;
      max_scope_pages?: unknown;
      repairable_diagnostics?: unknown;
    };
    const codes = payload.repairable_diagnostics;
    if (
      payload.schema_version !== "legalpdf.codex.repair-identity.v1" ||
      typeof payload.prompt_version !== "string" ||
      !payload.prompt_version ||
      payload.prompt_version.length > 160 ||
      /[\r\n\u0000]/u.test(payload.prompt_version) ||
      typeof payload.response_schema_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(payload.response_schema_sha256) ||
      typeof payload.repairable_diagnostics_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(payload.repairable_diagnostics_sha256) ||
      payload.context_radius !== 1 ||
      !Number.isInteger(payload.max_attempts) ||
      Number(payload.max_attempts) < 1 ||
      Number(payload.max_attempts) > 3 ||
      !Number.isInteger(payload.max_live_calls) ||
      Number(payload.max_live_calls) < 1 ||
      Number(payload.max_live_calls) > 6 ||
      payload.max_scope_pages !== 2 ||
      !Array.isArray(codes) ||
      codes.length === 0 ||
      codes.some(
        (code) =>
          typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(code),
      ) ||
      payload.repairable_diagnostics_sha256 !==
        sha256(JSON.stringify([...codes].sort()))
    ) {
      throw new Error("Invalid Codex repair identity");
    }
    return {
      schema_version: payload.schema_version,
      prompt_version: payload.prompt_version,
      response_schema_sha256: payload.response_schema_sha256,
      repairable_diagnostics_sha256: payload.repairable_diagnostics_sha256,
      context_radius: payload.context_radius,
      max_attempts: Number(payload.max_attempts),
      max_live_calls: Number(payload.max_live_calls),
      max_scope_pages: payload.max_scope_pages,
      repairable_diagnostics: [...codes].sort(),
    };
  } catch (error) {
    throw new Error("Codex structural repair could not start", {
      cause: error,
    });
  }
}

const statePath = (sourcePath: string) => `${sourcePath}${STATE_SUFFIX}`;
const jobKey = (sourcePath: string) => path.resolve(statePath(sourcePath));
const artifactDirectory = (cacheKey: string) => projectionDirectory("pdf", cacheKey);

async function detectedLayoutIdentity(
  layout: LegalPdfLayoutConfig,
  signal?: AbortSignal,
) {
  if (layout.provider === "mllm") {
    return PDF_VISION_LAYOUT_IDENTITY(layout.model);
  }
  const arguments_ = legalPdfLayoutArguments(layout).map((value) =>
    value.startsWith("--ppdoc-")
      ? `--${value.slice("--ppdoc-".length)}`
      : value,
  );
  const key = JSON.stringify(arguments_);
  let pending = layoutIdentityPromises.get(key);
  if (!pending) {
    pending = runLegalPdf(["ppdoc-identity", ...arguments_], {
      timeoutMs: 120_000,
      signal,
    })
      .then((result) => {
        const payload = JSON.parse(String(result.stdout)) as {
          provider?: unknown;
          identity?: unknown;
        };
        if (
          payload.provider !== "local-layout" ||
          typeof payload.identity !== "string" ||
          !payload.identity ||
          payload.identity.length > 1_024 ||
          /[\r\n\u0000]/u.test(payload.identity)
        ) {
          throw new Error("Invalid local layout identity");
        }
        return payload.identity;
      })
      .catch((error) => {
        layoutIdentityPromises.delete(key);
        throw error;
      });
    layoutIdentityPromises.set(key, pending);
  }
  return pending;
}

const exists = (filePath: string) => access(filePath).then(() => true, () => false);

function parseState(value: unknown): PdfParseState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid PDF parse state");
  }
  const state = value as Partial<PdfParseState>;
  if (
    state.schema_version !== STATE_SCHEMA ||
    typeof state.job_id !== "string" ||
    typeof state.source_sha256 !== "string" ||
    typeof state.cache_key !== "string" ||
    !statuses.has(String(state.status))
  ) {
    throw new Error("Invalid PDF parse state");
  }
  return state as PdfParseState;
}

async function readState(sourcePath: string) {
  const filePath = statePath(sourcePath);
  try {
    return parseState(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(sourcePath: string, state: PdfParseState) {
  if (!(await exists(sourcePath))) return false;
  await atomicWriteProjection(
    statePath(sourcePath),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return true;
}

function projectionIdentity(
  documentId: string,
  versionId: string,
  sourceSha256: string,
  config: object,
  parserVersion = LEGAL_PDF_PARSER_VERSION,
) {
  return pdfProjectionIdentity({
    documentId,
    versionId,
    sourceSha256,
    compiler: { name: "legalpdf", version: parserVersion },
    options: { parser_config: config },
  });
}

function stateProjectionIdentity(state: PdfParseState) {
  return projectionIdentity(state.document_id, state.version_id, state.source_sha256,
    state.parser_config, state.parser_version);
}

function newQueuedState(params: {
  documentId: string;
  versionId: string;
  sourcePath: string;
  sourceSha256: string;
  ocrProvider: PdfOcrProvider | null;
  ocrIdentity?: string;
  layout: LegalPdfLayoutConfig | null;
  layoutIdentity?: string;
  repairIdentity: PdfRepairIdentity | null;
  repair?: PdfRepairConfig | null;
  previous?: PdfParseState | null;
}) {
  const now = new Date().toISOString();
  const config = parserConfig(
    params.ocrProvider,
    params.ocrIdentity,
    params.layout,
    params.layoutIdentity,
    params.repairIdentity,
    params.repair,
  );
  const key = pdfProjectionKey(projectionIdentity(
    params.documentId,
    params.versionId,
    params.sourceSha256,
    config,
  ));
  return {
    schema_version: STATE_SCHEMA,
    job_id: crypto.randomUUID(),
    document_id: params.documentId,
    version_id: params.versionId,
    status: "queued",
    source_sha256: params.sourceSha256,
    parser_version: LEGAL_PDF_PARSER_VERSION,
    parser_config: config,
    ...(params.repairIdentity
      ? { repair_contract: params.repairIdentity }
      : {}),
    cache_key: key,
    artifact_manifest: relativeLocalDataPath(
      path.join(artifactDirectory(key), "document.json"),
    ),
    attempts: params.previous?.attempts ?? 0,
    queued_at: now,
    updated_at: now,
    interrupted_at: params.previous?.interrupted_at,
  } satisfies PdfParseState;
}

async function requeueInvalidPublication(
  sourcePath: string,
  state: PdfParseState,
) {
  const now = new Date().toISOString();
  const queued = {
    ...state,
    job_id: crypto.randomUUID(),
    status: "queued",
    queued_at: now,
    updated_at: now,
    started_at: undefined,
    completed_at: undefined,
    engine_status: undefined,
    page_count: undefined,
    counts: undefined,
    diagnostic_count: undefined,
    diagnostic_summary: undefined,
    structural_repair_available: undefined,
    error: undefined,
  } satisfies PdfParseState;
  await writeState(sourcePath, queued);
  schedule(sourcePath);
  return queued;
}

const jsonLines = (raw: string) => raw.split(/\r?\n/u).filter(Boolean)
  .map((line) => JSON.parse(line) as JsonObject);

function objectValue(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as JsonObject;
}

async function validatePublishedArtifacts(
  state: PdfParseState,
) {
  try {
    const identity = stateProjectionIdentity(state);
    if (state.cache_key !== pdfProjectionKey(identity) ||
        resolveLocalDataPath(state.artifact_manifest) !==
          path.join(pdfProjectionDirectory(identity), "document.json")) return false;
    const { manifest } = await openPdfProjection(identity);
    const engineStatus = String(manifest.status || "");
    return ["ready", "degraded", "ocr_required"].includes(engineStatus) &&
      (!state.engine_status || state.engine_status === engineStatus) &&
      (state.status !== "ready" || engineStatus === "ready") &&
      (state.status !== "degraded" || engineStatus !== "ready");
  } catch {
    return false;
  }
}

async function publishCompactArtifacts(
  state: PdfParseState,
) {
  const output = artifactDirectory(state.cache_key);
  const manifestPath = path.join(output, "document.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as JsonObject;
  if (
    manifest.schema_version !== LEGAL_PDF_DOCUMENT_SCHEMA ||
    manifest.artifact_profile !== "compact-source" ||
    manifest.source_sha256 !== state.source_sha256 ||
    manifest.parser_version !== state.parser_version
  ) {
    throw new Error(
      "PDF parser returned artifacts for a different source or version",
    );
  }
  if (state.parser_config.mode === "codex") {
    const provenance = objectValue(
      manifest.provenance,
      "PDF parser provenance",
    );
    const codex = objectValue(provenance.codex, "PDF Codex repair provenance");
    if (
      codex.model !== state.parser_config.model ||
      codex.effort !== state.parser_config.effort ||
      codex.prompt_version !== state.parser_config.prompt_version ||
      codex.response_schema_sha256 !==
        state.parser_config.response_schema_sha256 ||
      codex.repairable_diagnostics_sha256 !==
        state.parser_config.repairable_diagnostics_sha256 ||
      !isDeepStrictEqual(
        codex.repairable_diagnostics,
        state.parser_config.repairable_diagnostics,
      ) ||
      codex.context_radius !== state.parser_config.context_radius ||
      codex.max_attempts !== state.parser_config.max_attempts ||
      codex.max_live_calls !== state.parser_config.max_live_calls ||
      codex.max_scope_pages !== state.parser_config.max_scope_pages
    ) {
      throw new Error("PDF Codex repair provenance does not match its job");
    }
  }
  const identity = stateProjectionIdentity(state);
  await publishPdfProjection(identity);
  return manifest;
}

async function diagnosticSummary(
  output: string,
  repairableDiagnostics?: string[],
) {
  const diagnostics = jsonLines(
    await readFile(path.join(output, "diagnostics.jsonl"), "utf8"),
  );
  const bySeverity: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const severity = String(diagnostic.severity || "unknown");
    const code = String(diagnostic.code || "UNKNOWN");
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  return {
    count: diagnostics.length,
    summary: { by_severity: bySeverity, by_code: byCode },
    structuralRepairAvailable: structuralRepairAvailable(
      diagnostics,
      repairableDiagnostics,
    ),
  };
}

function structuralRepairAvailable(
  diagnostics: JsonObject[],
  repairableDiagnostics?: string[],
) {
  if (
    !Array.isArray(repairableDiagnostics) ||
    !repairableDiagnostics.every((code) => typeof code === "string")
  ) {
    return false;
  }
  return diagnostics.some((diagnostic) => {
    const details =
      diagnostic.details &&
      typeof diagnostic.details === "object" &&
      !Array.isArray(diagnostic.details)
        ? (diagnostic.details as JsonObject)
        : {};
    return (
      repairableDiagnostics.includes(String(diagnostic.code || "")) &&
      String(diagnostic.severity || "") !== "info" &&
      details.codex_repair_applied !== true
    );
  });
}

async function processJob(sourcePath: string, controller: AbortController) {
  const key = jobKey(sourcePath);
  if (controller.signal.aborted) return;
  let parsing: PdfParseState | null = null;
  try {
    const queued = await readState(sourcePath);
    if (!queued || queued.status !== "queued" || controller.signal.aborted) return;
    if (queued.parser_config.ocr_provider) {
      const identity = await detectedOcrIdentity(
        queued.parser_config.ocr_provider,
        queued.parser_config,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (queued.parser_config.ocr_identity !== identity)
        throw new Error("OCR runtime changed after the parse was queued");
    }
    const started = new Date().toISOString();
    parsing = {
      ...queued,
      status: "parsing",
      attempts: queued.attempts + 1,
      started_at: started,
      updated_at: started,
      error: undefined,
    };
    const output = artifactDirectory(parsing.cache_key);
    await inspectPdf(sourcePath, { expectedSha256: queued.source_sha256,
      signal: controller.signal });
    if (controller.signal.aborted) return;
    if (!(await writeState(sourcePath, parsing))) return;
    await rm(output, { recursive: true, force: true });
    const configuredTimeout = Number(process.env.MIKE_PDF_PARSE_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 30 * 60 * 1000;
    const ocrArguments = parsing.parser_config.ocr_provider
      ? legalPdfOcrArguments(parsing.parser_config.ocr_provider, {
          language: parsing.parser_config.ocr_language,
          dpi: parsing.parser_config.ocr_dpi,
          psm: parsing.parser_config.ocr_psm,
          expectedIdentity: String(parsing.parser_config.ocr_identity),
        })
      : [];
    if (parsing.parser_config.layout_provider === "mllm") {
      const model = String(parsing.parser_config.layout_model);
      if (PDF_VISION_LAYOUT_IDENTITY(model) !== parsing.parser_config.layout_identity) {
        throw new Error("PDF vision layout identity changed before parsing");
      }
      const work = `${output}.layout-work`;
      const input = path.join(work, "input.json");
      const images = path.join(work, "pages");
      const assignments = path.join(work, "assignments.json");
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });
      try {
        await runLegalPdf(
          [
            "layout-input",
            sourcePath,
            "--output",
            input,
            "--images",
            images,
            "--image-dpi",
            process.env.MIKE_PDF_LAYOUT_DPI?.trim() || "120",
            ...ocrArguments,
          ],
          { timeoutMs, signal: controller.signal },
        );
        await runPdfVisionLayout({
          inputPath: input,
          imagesDir: images,
          outputPath: assignments,
          model,
          abortSignal: controller.signal,
          apiKeys: layoutApiKeys.get(key),
        });
        const applyArguments = [
          "apply-layout",
          input,
          "--assignments",
          assignments,
          "--output",
          output,
          "--compact-pages",
        ];
        if (parsing.parser_config.mode === "codex") {
          applyArguments.push(
            "--pdf",
            sourcePath,
            "--model",
            String(parsing.parser_config.model),
            "--effort",
            String(parsing.parser_config.effort),
          );
        }
        await runLegalPdf(applyArguments, {
          timeoutMs,
          signal: controller.signal,
        });
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    } else {
      const arguments_ = [
        "parse",
        sourcePath,
        "--output",
        output,
        "--mode",
        parsing.parser_config.mode,
        "--no-cache",
        "--compact-pages",
      ];
      if (parsing.parser_config.mode === "codex") {
        arguments_.push(
          "--model",
          String(parsing.parser_config.model),
          "--effort",
          String(parsing.parser_config.effort),
        );
      }
      arguments_.push(...ocrArguments);
      if (parsing.parser_config.layout_provider === "local") {
        arguments_.push(
          ...legalPdfLayoutArguments(
            { provider: "local" },
            parsing.parser_config.layout_identity,
          ),
        );
      }
      await runLegalPdf(arguments_, {
        timeoutMs,
        signal: controller.signal,
      });
    }
    if (controller.signal.aborted) return;
    if (!(await exists(sourcePath)) || !(await inspectPdf(sourcePath,
      { expectedSha256: parsing.source_sha256 }).then(() => true, () => false))) {
      await Promise.all([
        rm(statePath(sourcePath), { force: true }),
        removePdfProjection(stateProjectionIdentity(parsing)),
      ]);
      return;
    }
    const manifest = await publishCompactArtifacts(parsing);
    if (controller.signal.aborted) return;
    const diagnostics = await diagnosticSummary(
      output,
      parsing.repair_contract?.repairable_diagnostics,
    );
    const completed = new Date().toISOString();
    const engineStatus = String(manifest.status || "degraded");
    const counts =
      manifest.counts && typeof manifest.counts === "object"
        ? Object.fromEntries(
            Object.entries(manifest.counts as JsonObject).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number",
            ),
          )
        : {};
    if (controller.signal.aborted) return;
    const completedState = {
      ...parsing,
      status: engineStatus === "ready" ? "ready" : "degraded",
      engine_status: engineStatus,
      page_count:
        typeof manifest.page_count === "number"
          ? manifest.page_count
          : undefined,
      counts,
      diagnostic_count: diagnostics.count,
      diagnostic_summary: diagnostics.summary,
      structural_repair_available: diagnostics.structuralRepairAvailable,
      completed_at: completed,
      updated_at: completed,
    } satisfies PdfParseState;
    if (!(await validatePublishedArtifacts(completedState))) {
      await rm(path.join(output, "document.json"), { force: true });
      throw new Error("PDF parser published incomplete or corrupt artifacts");
    }
    await writeState(sourcePath, completedState);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (!parsing) {
      const queued = await readState(sourcePath);
      if (!queued) return;
      const started = new Date().toISOString();
      parsing = {
        ...queued,
        status: "parsing",
        attempts: queued.attempts + 1,
        started_at: started,
        updated_at: started,
        error: undefined,
      };
    }
    await rm(artifactDirectory(parsing.cache_key), {
      recursive: true,
      force: true,
    });
    const failed = new Date().toISOString();
    if (!(await exists(sourcePath))) {
      if (await exists(statePath(sourcePath))) {
        await atomicWriteProjection(
          statePath(sourcePath),
          `${JSON.stringify(
            {
              ...parsing,
              status: "failed",
              error: "PDF source is missing",
              completed_at: failed,
              updated_at: failed,
            },
            null,
            2,
          )}\n`,
        );
      }
      return;
    }
    await writeState(sourcePath, {
      ...parsing,
      status: "failed",
      error: safeParserError(error),
      completed_at: failed,
      updated_at: failed,
    });
  } finally {
    layoutApiKeys.delete(key);
  }
}

function schedule(sourcePath: string) {
  const key = jobKey(sourcePath);
  if (jobs.has(key)) return;
  const controller = new AbortController();
  const promise = workTail
    .catch(() => undefined)
    .then(() => processJob(sourcePath, controller))
    .catch((error) => {
      console.error("[pdf-projection] PDF parse worker failed", {
        error: safeParserError(error),
      });
    })
    .finally(() => {
      jobs.delete(key);
    });
  jobs.set(key, { promise, controller });
  workTail = promise;
}

async function queuePdf(params: {
  documentId: string;
  versionId: string;
  sourcePath: string;
  sourceSha256?: string;
  force?: boolean;
  ocrProvider?: PdfOcrProvider | null;
  layout?: LegalPdfLayoutConfig | null;
  apiKeys?: UserApiKeys;
  repair?: PdfRepairConfig | null;
  signal?: AbortSignal;
}) {
  throwIfAborted(params.signal);
  if (!validProjectionId(params.documentId) || !validProjectionId(params.versionId)) {
    throw new Error("PDF projection requires valid document and version IDs");
  }
  relativeLocalDataPath(params.sourcePath);
  const sourceSha256 = (await inspectPdf(params.sourcePath, {
    expectedSha256: params.sourceSha256,
    signal: params.signal,
    maximumBytes: MAX_DOCUMENT_INPUT_BYTES,
  })).sourceSha256;
  let current = await readState(params.sourcePath);
  const key = jobKey(params.sourcePath);
  const active = current?.status === "queued" || current?.status === "parsing";
  if (current && active && jobs.has(key)) {
    if (params.apiKeys) layoutApiKeys.set(key, params.apiKeys);
    return current;
  }
  let repair = params.repair === undefined ? preservedRepair(current) : null;
  if (params.repair) {
    if (!validRepairRequest(params.repair)) {
      throw new Error("Invalid Codex structural repair settings");
    }
    repair = params.repair;
  }
  const ocrProvider =
    params.ocrProvider === undefined
      ? (current?.parser_config.ocr_provider ?? configuredLegalPdfOcrProvider())
      : params.ocrProvider;
  const layout =
    params.layout === undefined ? configuredLegalPdfLayout() : params.layout;
  let repairIdentity: PdfRepairIdentity | null;
  let ocrIdentity: string | undefined;
  let layoutIdentity: string | undefined;
  try {
    repairIdentity = repair
      ? await detectedRepairIdentity(params.signal)
      : await detectedRepairIdentity(params.signal).catch(() => null);
    ocrIdentity = ocrProvider
      ? await detectedOcrIdentity(
          ocrProvider,
          parserConfig(ocrProvider, undefined, layout),
          params.signal,
        )
      : undefined;
    layoutIdentity = layout
      ? await detectedLayoutIdentity(layout, params.signal)
      : undefined;
  } catch (error) {
    if (current && active && jobs.has(key)) return current;
    if (current && active) {
      const failed = new Date().toISOString();
      current = {
        ...current,
        status: "failed",
        error: safeParserError(error),
        completed_at: failed,
        updated_at: failed,
        ...(current.status === "parsing" ? { interrupted_at: failed } : {}),
      };
      await writeState(params.sourcePath, current);
    }
    throw error;
  }
  if (current && active && jobs.has(key)) {
    if (params.apiKeys) layoutApiKeys.set(key, params.apiKeys);
    return current;
  }
  const candidate = newQueuedState({
    ...params,
    sourceSha256,
    ocrProvider,
    ocrIdentity,
    layout,
    layoutIdentity,
    repairIdentity,
    repair,
    previous: current,
  });
  if (
    current &&
    current.cache_key === candidate.cache_key &&
    current.source_sha256 === sourceSha256
  ) {
    if (
      !params.force &&
      (current.status === "ready" || current.status === "degraded") &&
      (await validatePublishedArtifacts(current))
    ) {
      return current;
    }
    if (!params.force && current.status === "failed") return current;
  }
  if (params.apiKeys) layoutApiKeys.set(key, params.apiKeys);
  await writeState(params.sourcePath, candidate);
  schedule(params.sourcePath);
  return candidate;
}

async function parsePdf(
  params: Omit<Parameters<typeof queuePdf>[0], "force">,
) {
  throwIfAborted(params.signal);
  const sourceSha256 = (await inspectPdf(params.sourcePath, {
    signal: params.signal,
  })).sourceSha256;
  let current = await pdfState(params.sourcePath, {
    validatePublication: false,
  });
  if (params.sourceSha256 && params.sourceSha256 !== sourceSha256) {
    await removePdf(params.sourcePath);
    throw new Error("PDF source bytes no longer match their version");
  }
  if (current && current.source_sha256 !== sourceSha256) {
    await removePdf(params.sourcePath);
    current = null;
  }
  if (
    current &&
    params.layout === undefined &&
    (current.status === "ready" || current.status === "degraded") &&
    (await validatePublishedArtifacts(current))
  ) {
    return current;
  }
  const queued = await queuePdf({
    ...params,
    sourceSha256,
    force: current?.status === "failed",
  });
  if (queued.status === "ready" || queued.status === "degraded") return queued;
  const job = jobs.get(jobKey(params.sourcePath))?.promise;
  if (job) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(abortError());
      params.signal?.addEventListener("abort", abort, { once: true });
      job.then(resolve, resolve).finally(() =>
        params.signal?.removeEventListener("abort", abort)
      );
    });
  }
  throwIfAborted(params.signal);
  return (await pdfState(params.sourcePath)) ?? queued;
}

async function pdfState(
  sourcePath: string,
  options?: { validatePublication?: boolean },
) {
  let state = await readState(sourcePath);
  if (!state) return null;
  if (["queued", "parsing"].includes(state.status) &&
      !jobs.has(jobKey(sourcePath))) {
    void queuePdf({
      documentId: state.document_id,
      versionId: state.version_id,
      sourcePath,
      sourceSha256: state.source_sha256,
    }).catch(() => undefined);
  }
  let diagnostics: JsonObject[] = [];
  let diagnosticsLoaded = false;
  if (
    options?.validatePublication !== false &&
    (state.status === "ready" || state.status === "degraded")
  ) {
    if (!(await validatePublishedArtifacts(state))) {
      state = await requeueInvalidPublication(sourcePath, state);
      return {
        ...state,
        structural_repair_available: false,
        diagnostics,
      };
    }
    try {
      diagnostics = jsonLines(
        await readFile(
          path.join(
            artifactDirectory(state.cache_key),
            "diagnostics.jsonl",
          ),
          "utf8",
        ),
      );
      diagnosticsLoaded = true;
    } catch {
      diagnostics = [];
    }
  }
  return {
    ...state,
    structural_repair_available: diagnosticsLoaded
      ? structuralRepairAvailable(
          diagnostics,
          state.repair_contract?.repairable_diagnostics,
        )
      : state.structural_repair_available ?? false,
    diagnostics,
  };
}

async function removePdf(sourcePath: string) {
  const key = jobKey(sourcePath);
  const job = jobs.get(key);
  job?.controller.abort();
  await job?.promise.catch(() => undefined);
  const state = await readState(sourcePath);
  await rm(statePath(sourcePath), { force: true });
  if (state) await removePdfProjection(stateProjectionIdentity(state));
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
      kind: "source-doc" | "pdf-artifact";
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

function abortError() {
  return new DOMException("Document projection aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function validProjectionId(value: string) {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

async function boundedSource(
  input: DocumentProjectionInput,
  signal?: AbortSignal,
) {
  if (!validProjectionId(input.documentId) || !validProjectionId(input.versionId)) {
    throw new Error("Document projection requires valid document and version IDs");
  }
  throwIfAborted(signal);
  const fileType = input.fileType.trim().toLowerCase();
  const bytes = input.bytes;
  if (!bytes.length || bytes.length > MAX_DOCUMENT_INPUT_BYTES) {
    throw new Error("Document projection input exceeds the read limit");
  }
  if (
    ["docx", "xlsx", "xlsm"].includes(fileType) &&
    bytes.length > MAX_COMPRESSED_PACKAGE_BYTES
  ) {
    throw new Error("Compressed document exceeds the read limit");
  }
  const sourceSha256 = sha256(bytes);
  if (input.sourceSha256 && input.sourceSha256 !== sourceSha256) {
    throw new Error("Document source bytes no longer match their version");
  }
  throwIfAborted(signal);
  return { bytes, fileType, sourceSha256 };
}

async function assertBoundedSpreadsheetPackage(bytes: Buffer, fileType: string) {
  if (!["xlsx", "xlsm"].includes(fileType)) return;
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_PACKAGE_ENTRIES) {
    throw new Error("Spreadsheet contains too many package entries");
  }
  let expanded = 0;
  for (const entry of entries) {
    const size = (entry as { _data?: { uncompressedSize?: unknown } })._data
      ?.uncompressedSize;
    if (!Number.isSafeInteger(size) || Number(size) < 0) {
      throw new Error("Spreadsheet has invalid ZIP size metadata");
    }
    expanded += Number(size);
    if (expanded > MAX_EXPANDED_PACKAGE_BYTES) {
      throw new Error("Spreadsheet expands beyond the read limit");
    }
  }
}

function sourceDocProjection(
  kind: "source-doc" | "pdf-artifact",
  doc: SourceDoc,
): DocumentReadProjection {
  if (Buffer.byteLength(doc.text) > MAX_PROJECTION_OUTPUT_BYTES) {
    throw new Error("Document projection output exceeds the read limit");
  }
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
      paragraph.acceptedText
        ? [{
            kind: "paragraph" as const,
            label: `par${index + 1}`,
            start: paragraph.globalStart,
            end: paragraph.globalStart + paragraph.acceptedText.length,
            origin: "native" as const,
          }]
        : [],
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
    if (Buffer.byteLength(grid.text) > MAX_PROJECTION_OUTPUT_BYTES) {
      throw new Error("Spreadsheet projection output exceeds the read limit");
    }
    return { kind: "spreadsheet-grid", text: grid.text, grid,
      tableCells: grid.tableCells };
  }
  let doc: SourceDoc;
  if (fileType === "pdf") {
    const sourcePath = await publishPdfBytes(bytes, sourceSha256, signal);
    await parsePdf({
      documentId: input.documentId,
      versionId: input.versionId,
      sourcePath,
      sourceSha256,
      signal,
    });
    doc = (await readPdfSourceDoc(sourcePath)) ??
      await parseLegalPdfSourceDoc(bytes, signal);
    return sourceDocProjection("pdf-artifact", doc);
  }
  let text = "";
  if (isPlainTextDocumentType(fileType)) {
    text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  } else if (fileType === "eml") {
    text = await extractEmailText(bytes);
  } else if (fileType === "pptx") {
    text = await extractPresentationText(bytes);
  } else if (isPresentationDocumentType(fileType) || isWordDocumentType(fileType)) {
    text = (
      await parseLegalPdfSourceDoc(await docxToPdf(bytes), signal)
    ).text;
  }
  doc = createSourceDoc({ provider: null,
    id: `${input.documentId}:${input.versionId}`, text, blocks: [] });
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

async function read(
  input: DocumentProjectionInput,
  options: { signal?: AbortSignal } = {},
) {
  const source = await boundedSource(input, options.signal);
  const key = `${input.documentId}\0${input.versionId}\0${source.sourceSha256}`;
  let pending = projectionMemory.get(key);
  if (!pending) {
    pending = (async () => {
      const projection = await compileReadProjection(input, source, options.signal);
      assertProjectionOutput(projection);
      throwIfAborted(options.signal);
      return projection;
    })().catch((error) => {
      projectionMemory.delete(key);
      throw error;
    });
    if (projectionMemory.size >= 32) {
      projectionMemory.delete(projectionMemory.keys().next().value!);
    }
    projectionMemory.set(key, pending);
  }
  const result = await pending;
  throwIfAborted(options.signal);
  return result;
}

/**
 * Beaver's only document-projection entrypoint.
 *
 * Keep format knowledge in the existing compilers (`legal-pdf-parser`,
 * `SourceDoc`, `DocxSession`, and the spreadsheet grid renderer). Routes,
 * assistant tools, Library code, citation linking, and provider bridges call
 * this service; they must not grow their own hashes, artifact discovery,
 * extraction, rehydration, or projection caches.
 */
export const documentProjectionService = Object.freeze({
  read,
  queuePdf,
  parsePdf,
  publishPdf: (bytes: Buffer, expected?: string, signal?: AbortSignal) =>
    publishPdfBytes(bytes, expected ?? sha256(bytes), signal),
  pdfState,
  removePdf,
  lookupPdf: lookupPdfStructure,
  readPdfEvidence: readPdfEvidenceReceipt,
  rehydratePdfEvidence: rehydratePdfEvidence,
  verifyPdfEvidence: verifyPdfLinkEvidence,
  rehydratePdfLink: rehydratePdfLinkEvidence,
});
