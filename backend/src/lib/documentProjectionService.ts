import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { mikeLocalDataHome } from "./legalDataPath";
import {
  LOCAL_PDF_SOURCE_SCHEMA,
  parseLegalPdfSourceDoc,
} from "./legalPdfSourceDoc";
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
  lookupLocalPdfStructure,
  readLocalPdfEvidenceReceipt,
  readLocalPdfSourceDoc,
  rehydrateLocalPdfEvidence,
  rehydrateLocalPdfLinkEvidence,
  verifyLocalPdfLinkEvidence,
  type LocalPdfEvidenceReceipt,
  type LocalPdfLinkEvidence,
  type LocalPdfLocatorKind,
  type LocalPdfLookupInput,
  type LocalPdfLookupUnit,
} from "./documentProjectionPdf";
import {
  atomicWriteProjection,
  canonicalProjectionOptions,
  inspectPdf,
  openPdfProjection,
  pdfProjectionDirectory,
  pdfProjectionIdentity,
  pdfProjectionKey,
  projectionDirectory,
  projectionFormatRoot,
  projectionKey,
  publishPdfBytes,
  publishPdfProjection,
  relativeLocalDataPath,
  removePdfProjection,
  resolveLocalDataPath,
  type PdfProjectionIdentity,
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

export type LocalPdfParseStatus =
  | "queued"
  | "parsing"
  | "ready"
  | "degraded"
  | "failed";

export type LocalPdfOcrProvider = LegalPdfOcrProvider;

export type {
  LocalPdfEvidenceReceipt,
  LocalPdfLinkEvidence,
  LocalPdfLocatorKind,
  LocalPdfLookupInput,
  LocalPdfLookupUnit,
};

export type LocalPdfRepairConfig = {
  model: string;
  effort: string;
};

type LocalPdfRepairIdentity = {
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

export type LocalPdfParseState = {
  schema_version: typeof STATE_SCHEMA;
  job_id: string;
  document_id: string;
  version_id: string;
  status: LocalPdfParseStatus;
  source_path: string;
  source_sha256: string;
  parser_version: string;
  parser_config_version: string;
  parser_config: {
    mode: "local" | "codex";
    ocr_provider: LocalPdfOcrProvider | null;
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
  repair_contract?: LocalPdfRepairIdentity;
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
  error_detail?: string;
};

type JsonObject = Record<string, unknown>;

const dataRoot = mikeLocalDataHome();
const scheduled = new Set<string>();
const cancelled = new Set<string>();
const activeControllers = new Map<string, AbortController>();
const jobs = new Map<string, Promise<void>>();
const jobSignals = new Map<string, AbortSignal>();
let repairIdentityPromise: Promise<LocalPdfRepairIdentity> | null = null;
const layoutIdentityPromises = new Map<string, Promise<string>>();
const layoutApiKeys = new Map<string, UserApiKeys>();
// ponytail: one parser at a time protects weak local machines; use a bounded
// worker pool only if measured queue latency justifies the extra machinery.
let workTail: Promise<unknown> = Promise.resolve();

function configVersion() {
  return process.env.MIKE_PDF_PARSE_CONFIG_VERSION?.trim() || "mike-local-v1";
}

function parserConfig(
  ocrProvider: LocalPdfOcrProvider | null,
  ocrIdentity?: string,
  layout?: LegalPdfLayoutConfig | null,
  layoutIdentity?: string,
  repairIdentity?: LocalPdfRepairIdentity | null,
  repair?: LocalPdfRepairConfig | null,
): LocalPdfParseState["parser_config"] {
  const config: LocalPdfParseState["parser_config"] = {
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

function validRepairRequest(value: LocalPdfRepairConfig) {
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
  state: LocalPdfParseState | null,
): LocalPdfRepairConfig | null {
  const config = state?.parser_config;
  if (config?.mode !== "codex") return null;
  const repair = { model: config.model, effort: config.effort };
  return typeof repair.model === "string" &&
    typeof repair.effort === "string" &&
    validRepairRequest(repair as LocalPdfRepairConfig)
    ? (repair as LocalPdfRepairConfig)
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

function parserErrorDetail(error: unknown) {
  if (!(error instanceof Error)) return String(error).slice(0, 4_000);
  const processError = error as Error & {
    code?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  return [
    error.message,
    processError.code === undefined ? "" : `exit: ${String(processError.code)}`,
    typeof processError.stderr === "string" ? processError.stderr : "",
    typeof processError.stdout === "string" ? processError.stdout : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4_000);
}

async function detectedOcrIdentity(
  provider: LocalPdfOcrProvider,
  config: LocalPdfParseState["parser_config"],
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
): Promise<LocalPdfRepairIdentity> {
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

function cachedRepairIdentity() {
  repairIdentityPromise ??= detectedRepairIdentity().catch((error) => {
    repairIdentityPromise = null;
    throw error;
  });
  return repairIdentityPromise;
}

function statePath(sourcePath: string) {
  return `${sourcePath}${STATE_SUFFIX}`;
}

function jobKey(sourcePath: string) {
  return path.resolve(statePath(sourcePath));
}

function artifactDirectory(_sourcePath: string, cacheKey: string) {
  return projectionDirectory("pdf", cacheKey);
}

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

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseState(value: unknown): LocalPdfParseState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid PDF parse state");
  }
  const state = value as Partial<LocalPdfParseState>;
  if (
    state.schema_version !== STATE_SCHEMA ||
    typeof state.job_id !== "string" ||
    typeof state.source_sha256 !== "string" ||
    typeof state.cache_key !== "string" ||
    !statuses.has(String(state.status))
  ) {
    throw new Error("Invalid PDF parse state");
  }
  return state as LocalPdfParseState;
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

async function writeState(sourcePath: string, state: LocalPdfParseState) {
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
  version: string,
  config: object,
  parserVersion = LEGAL_PDF_PARSER_VERSION,
) {
  return pdfProjectionIdentity({
    documentId,
    versionId,
    sourceSha256,
    compiler: { name: "legalpdf", version: parserVersion },
    options: { parser_config_version: version, parser_config: config },
  });
}

function stateProjectionIdentity(state: LocalPdfParseState) {
  return projectionIdentity(state.document_id, state.version_id, state.source_sha256,
    state.parser_config_version, state.parser_config, state.parser_version);
}

function newQueuedState(params: {
  documentId: string;
  versionId: string;
  sourcePath: string;
  sourceSha256: string;
  ocrProvider: LocalPdfOcrProvider | null;
  ocrIdentity?: string;
  layout: LegalPdfLayoutConfig | null;
  layoutIdentity?: string;
  repairIdentity: LocalPdfRepairIdentity | null;
  repair?: LocalPdfRepairConfig | null;
  previous?: LocalPdfParseState | null;
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
  const version = configVersion();
  const key = pdfProjectionKey(projectionIdentity(
    params.documentId,
    params.versionId,
    params.sourceSha256,
    version,
    config,
  ));
  return {
    schema_version: STATE_SCHEMA,
    job_id: crypto.randomUUID(),
    document_id: params.documentId,
    version_id: params.versionId,
    status: "queued",
    source_path: relativeLocalDataPath(params.sourcePath),
    source_sha256: params.sourceSha256,
    parser_version: LEGAL_PDF_PARSER_VERSION,
    parser_config_version: version,
    parser_config: config,
    ...(params.repairIdentity
      ? { repair_contract: params.repairIdentity }
      : {}),
    cache_key: key,
    artifact_manifest: relativeLocalDataPath(
      path.join(artifactDirectory(params.sourcePath, key), "document.json"),
    ),
    attempts: params.previous?.attempts ?? 0,
    queued_at: now,
    updated_at: now,
    interrupted_at: params.previous?.interrupted_at,
  } satisfies LocalPdfParseState;
}

function rekeyOcrState(
  sourcePath: string,
  state: LocalPdfParseState,
  identity: string,
) {
  if (state.parser_config.ocr_identity === identity) return state;
  const now = new Date().toISOString();
  const config = { ...state.parser_config, ocr_identity: identity };
  const key = pdfProjectionKey(projectionIdentity(
    state.document_id,
    state.version_id,
    state.source_sha256,
    state.parser_config_version,
    config,
    state.parser_version,
  ));
  return {
    ...state,
    job_id: crypto.randomUUID(),
    status: "queued",
    parser_config: config,
    cache_key: key,
    artifact_manifest: relativeLocalDataPath(
      path.join(artifactDirectory(sourcePath, key), "document.json"),
    ),
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
  } satisfies LocalPdfParseState;
}

async function requeueInvalidPublication(
  sourcePath: string,
  state: LocalPdfParseState,
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
  } satisfies LocalPdfParseState;
  await writeState(sourcePath, queued);
  schedule(sourcePath);
  return queued;
}

function jsonLines(raw: string) {
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

function publishedArtifactPath(output: string, value: unknown, name: string) {
  if (typeof value !== "string" || !value) {
    throw new Error(`PDF parser did not publish ${name} artifacts`);
  }
  const resolved = path.resolve(output, value);
  const relative = path.relative(output, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`PDF parser published an unsafe ${name} artifact path`);
  }
  return resolved;
}

function objectValue(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as JsonObject;
}

function jsonObject(raw: string, label: string) {
  return objectValue(JSON.parse(raw) as unknown, label);
}

function compactPage(row: JsonObject) {
  const lines = Array.isArray(row.lines)
    ? row.lines.map((value) => {
        const line = objectValue(value, "PDF page line");
        return {
          reading_order: line.reading_order,
          text: line.text,
        };
      })
    : [];
  return {
    id: row.id,
    index: row.index,
    number: row.number,
    printed_label: row.printed_label,
    printed_label_source: row.printed_label_source,
    source: row.source,
    text_quality: row.text_quality,
    lines,
  };
}

async function validatePublishedArtifacts(
  sourcePath: string,
  state: LocalPdfParseState,
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
  sourcePath: string,
  state: LocalPdfParseState,
) {
  const output = artifactDirectory(sourcePath, state.cache_key);
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
  const artifacts =
    manifest.artifacts && typeof manifest.artifacts === "object"
      ? (manifest.artifacts as JsonObject)
      : {};
  const pagesPath = publishedArtifactPath(
    output,
    artifacts.pages,
    "page",
  );
  const pages = jsonLines(await readFile(pagesPath, "utf8")).map(compactPage);
  await atomicWriteProjection(
    pagesPath,
    pages.map((row) => JSON.stringify(row)).join("\n") +
      (pages.length ? "\n" : ""),
  );
  const identity = stateProjectionIdentity(state);
  await atomicWriteProjection(
    path.join(output, "parser-config.json"),
    `${JSON.stringify(
      {
        parser_version: state.parser_version,
        parser_config_version: state.parser_config_version,
        parser_config: state.parser_config,
        cache_key: state.cache_key,
        source_sha256: state.source_sha256,
        projection_options: identity.options,
      },
      null,
      2,
    )}\n`,
  );
  manifest.artifacts = {
    ...artifacts,
    parser_config: "parser-config.json",
  };
  if (
    manifest.metadata &&
    typeof manifest.metadata === "object" &&
    !Array.isArray(manifest.metadata)
  ) {
    const pairing = (manifest.metadata as JsonObject).pairing;
    if (pairing && typeof pairing === "object" && !Array.isArray(pairing)) {
      delete (pairing as JsonObject).created_at;
      delete (pairing as JsonObject).elapsed_seconds;
    }
  }
  delete manifest.artifact_profile;
  manifest.engine_schema_version = LEGAL_PDF_DOCUMENT_SCHEMA;
  manifest.schema_version = LOCAL_PDF_SOURCE_SCHEMA;
  manifest.artifact_profile = "compact-source";
  await atomicWriteProjection(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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

async function processJob(sourcePath: string) {
  const key = jobKey(sourcePath);
  if (cancelled.has(key)) return;
  const controller = new AbortController();
  const callerSignal = jobSignals.get(key);
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  activeControllers.set(key, controller);
  let parsing: LocalPdfParseState | null = null;
  try {
    let queued = await readState(sourcePath);
    if (!queued || queued.status !== "queued" || cancelled.has(key)) return;
    if (queued.parser_config.ocr_provider) {
      const identity = await detectedOcrIdentity(
        queued.parser_config.ocr_provider,
        queued.parser_config,
        controller.signal,
      );
      if (cancelled.has(key)) return;
      const rekeyed = rekeyOcrState(sourcePath, queued, identity);
      if (rekeyed !== queued) {
        queued = rekeyed;
        if (!(await writeState(sourcePath, queued))) return;
      }
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
    const output = artifactDirectory(sourcePath, parsing.cache_key);
    await inspectPdf(sourcePath, { expectedSha256: queued.source_sha256,
      signal: controller.signal });
    if (cancelled.has(key)) return;
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
    if (cancelled.has(key)) return;
    if (!(await exists(sourcePath)) || !(await inspectPdf(sourcePath,
      { expectedSha256: parsing.source_sha256 }).then(() => true, () => false))) {
      await Promise.all([
        rm(statePath(sourcePath), { force: true }),
        removePdfProjection(stateProjectionIdentity(parsing)),
      ]);
      return;
    }
    const manifest = await publishCompactArtifacts(sourcePath, parsing);
    if (cancelled.has(key)) return;
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
    if (cancelled.has(key)) return;
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
    } satisfies LocalPdfParseState;
    if (!(await validatePublishedArtifacts(sourcePath, completedState))) {
      await rm(path.join(output, "document.json"), { force: true });
      throw new Error("PDF parser published incomplete or corrupt artifacts");
    }
    await writeState(sourcePath, completedState);
  } catch (error) {
    if (cancelled.has(key) || controller.signal.aborted) return;
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
    await rm(artifactDirectory(sourcePath, parsing.cache_key), {
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
      error_detail: parserErrorDetail(error),
      completed_at: failed,
      updated_at: failed,
    });
  } finally {
    callerSignal?.removeEventListener("abort", abortFromCaller);
    layoutApiKeys.delete(key);
    if (activeControllers.get(key) === controller) {
      activeControllers.delete(key);
    }
  }
}

function schedule(sourcePath: string) {
  const key = jobKey(sourcePath);
  if (scheduled.has(key)) return;
  scheduled.add(key);
  const job = workTail
    .catch(() => undefined)
    .then(() => processJob(sourcePath))
    .catch((error) => {
      console.error("[local-library] PDF parse worker failed", {
        error: safeParserError(error),
      });
    })
    .finally(() => {
      scheduled.delete(key);
      jobs.delete(key);
      jobSignals.delete(key);
      cancelled.delete(key);
    });
  jobs.set(key, job);
  workTail = job;
}

async function queuePdf(params: {
  documentId: string;
  versionId: string;
  sourcePath: string;
  sourceSha256?: string;
  force?: boolean;
  ocrProvider?: LocalPdfOcrProvider | null;
  layout?: LegalPdfLayoutConfig | null;
  apiKeys?: UserApiKeys;
  repair?: LocalPdfRepairConfig | null;
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
  const activeStatus =
    current?.status === "queued" || current?.status === "parsing";
  const hasOwner =
    scheduled.has(key) || jobs.has(key) || activeControllers.has(key);
  if (current && activeStatus && hasOwner) {
    if (params.apiKeys) layoutApiKeys.set(key, params.apiKeys);
    return current;
  }
  const unownedActive = Boolean(current && activeStatus);
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
  let repairIdentity: LocalPdfRepairIdentity | null;
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
    if (
      current &&
      unownedActive &&
      (scheduled.has(key) || jobs.has(key) || activeControllers.has(key))
    ) {
      return current;
    }
    if (current && unownedActive) {
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
  const ownerAfterProbes =
    scheduled.has(key) || jobs.has(key) || activeControllers.has(key);
  if (current && activeStatus && ownerAfterProbes) {
    if (params.apiKeys) layoutApiKeys.set(key, params.apiKeys);
    return current;
  }
  const hasNoOwner = !ownerAfterProbes;
  const recoverOrphan = Boolean(
    current?.status === "parsing" && unownedActive && hasNoOwner,
  );
  const refreshRepairContract = Boolean(
    repairIdentity &&
    current &&
    hasNoOwner &&
    !isDeepStrictEqual(current.repair_contract, repairIdentity),
  );
  if (current && (recoverOrphan || refreshRepairContract)) {
    const updated = new Date().toISOString();
    current = {
      ...current,
      ...(recoverOrphan
        ? {
            status: "queued" as const,
            queued_at: updated,
            interrupted_at: updated,
            error: undefined,
          }
        : {}),
      ...(refreshRepairContract && repairIdentity
        ? { repair_contract: repairIdentity }
        : {}),
      updated_at: updated,
    };
    await writeState(params.sourcePath, current);
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
    if (current.status === "queued" || current.status === "parsing") {
      schedule(params.sourcePath);
      return current;
    }
    if (
      !params.force &&
      (current.status === "ready" || current.status === "degraded") &&
      (await validatePublishedArtifacts(params.sourcePath, current))
    ) {
      return current;
    }
    if (!params.force && current.status === "failed") return current;
  }
  cancelled.delete(jobKey(params.sourcePath));
  if (params.apiKeys) layoutApiKeys.set(key, params.apiKeys);
  if (params.signal) jobSignals.set(key, params.signal);
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
    (await validatePublishedArtifacts(params.sourcePath, current))
  ) {
    return current;
  }
  const queued = await queuePdf({
    ...params,
    sourceSha256,
    force: current?.status === "failed",
  });
  if (queued.status === "ready" || queued.status === "degraded") return queued;
  const job = jobs.get(jobKey(params.sourcePath));
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

/**
 * Light parse-state summary for library listings: reads the state file
 * only — no artifact validation, no diagnostics load, no writes — so a
 * list of N documents costs N stat-reads, not N artifact walks. The full
 * `pdfState` stays the source of truth for the per-document
 * inspector.
 */
async function peekPdfState(sourcePath: string) {
  const state = await readState(sourcePath);
  if (!state) return null;
  return {
    status: state.status,
    error: state.error ?? null,
    attempts: state.attempts,
    queued_at: state.queued_at,
    updated_at: state.updated_at,
    completed_at: state.completed_at ?? null,
    engine_status: state.engine_status ?? null,
    page_count: state.page_count ?? null,
    diagnostic_count: state.diagnostic_count ?? null,
    structural_repair_available: state.structural_repair_available ?? false,
  };
}

async function pdfState(
  sourcePath: string,
  options?: { validatePublication?: boolean },
) {
  let state = await readState(sourcePath);
  if (!state) return null;
  const storedRepairContract = state.repair_contract;
  let repairContract = state.repair_contract;
  let diagnostics: JsonObject[] = [];
  let diagnosticsLoaded = false;
  if (state.status === "ready" || state.status === "degraded") {
    try {
      const latest = await cachedRepairIdentity();
      repairContract = latest;
      if (!isDeepStrictEqual(state.repair_contract, latest)) {
        state = {
          ...state,
          repair_contract: latest,
          updated_at: new Date().toISOString(),
        };
        await writeState(sourcePath, state);
      }
    } catch {
      repairContract = undefined;
    }
  }
  if (
    options?.validatePublication !== false &&
    (state.status === "ready" || state.status === "degraded")
  ) {
    if (!(await validatePublishedArtifacts(sourcePath, state))) {
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
            artifactDirectory(sourcePath, state.cache_key),
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
          repairContract?.repairable_diagnostics,
        )
      : repairContract &&
          isDeepStrictEqual(storedRepairContract, repairContract)
        ? state.structural_repair_available
        : false,
    diagnostics,
  };
}

async function removePdf(sourcePath: string) {
  const key = jobKey(sourcePath);
  const wasScheduled = scheduled.has(key);
  const active = activeControllers.get(key);
  const job = jobs.get(key);
  cancelled.add(key);
  active?.abort();
  await job?.catch(() => undefined);
  const state = await readState(sourcePath);
  await rm(statePath(sourcePath), { force: true });
  if (state) await removePdfProjection(stateProjectionIdentity(state));
  if (!wasScheduled) cancelled.delete(key);
}

async function stateFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? stateFiles(entryPath)
        : Promise.resolve(entry.name.endsWith(STATE_SUFFIX) ? [entryPath] : []);
    }),
  );
  return nested.flat();
}

async function resume() {
  for (const filePath of await stateFiles(path.join(dataRoot, "files"))) {
    try {
      const sourcePath = filePath.slice(0, -STATE_SUFFIX.length);
      const state = await readState(sourcePath);
      if (!state) continue;
      if (!(await exists(sourcePath))) {
        const now = new Date().toISOString();
        await atomicWriteProjection(
          filePath,
          `${JSON.stringify(
            {
              ...state,
              status: "failed",
              error: "PDF source is missing",
              completed_at: now,
              updated_at: now,
            },
            null,
            2,
          )}\n`,
        );
        continue;
      }
      if (!["queued", "parsing"].includes(state.status)) continue;
      await queuePdf({
        documentId: state.document_id,
        versionId: state.version_id,
        sourcePath,
        sourceSha256: state.source_sha256,
      });
    } catch (error) {
      console.error("[local-library] Could not resume PDF parse state", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const PROJECTION_SCHEMA = "beaver.document-projection.v1";
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
  bytes?: Buffer;
  localPath?: string;
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

type ProjectionIdentity = {
  schema: typeof PROJECTION_SCHEMA;
  document_id: string;
  version_id: string;
  source_sha256: string;
  compiler_version: string;
  material_options: unknown;
};

type CachedReadProjection =
  | {
      kind: "source-doc" | "pdf-artifact";
      sourceDoc: Pick<
        SourceDoc,
        "provider" | "id" | "url" | "docType" | "text" | "blocks"
      >;
    }
  | { kind: "spreadsheet-grid"; grid: SpreadsheetLlmStructure };

function abortError() {
  return new DOMException("Document projection aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function compilerVersion(fileType: string) {
  if (fileType === "pdf") {
    return `legal-pdf-parser@${LEGAL_PDF_PARSER_VERSION}+beaver-pdf-source@1`;
  }
  if (fileType === "docx") return "beaver-docx-session@1";
  if (isSpreadsheetDocumentType(fileType)) return "beaver-spreadsheet-grid@2";
  if (isPlainTextDocumentType(fileType)) return "beaver-plain-text@1";
  if (fileType === "eml") return "beaver-email-text@1";
  if (fileType === "pptx") return "beaver-presentation-text@1";
  return "beaver-office-pdf-text@2";
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
  if (input.localPath) relativeLocalDataPath(input.localPath);
  const fileType = input.fileType.trim().toLowerCase();
  const bytes = input.bytes ?? await (async () => {
    if (!input.localPath) throw new Error("Document projection source is missing");
    const filename = path.resolve(input.localPath);
    relativeLocalDataPath(filename);
    const info = await stat(filename);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_DOCUMENT_INPUT_BYTES) {
      throw new Error("Document projection input exceeds the read limit");
    }
    return readFile(filename);
  })();
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

function projectionCacheFile(key: string) {
  return path.join(projectionDirectory("read", key), "projection.json");
}

async function cachedPdfSource(
  input: DocumentProjectionInput,
  bytes: Buffer,
  sourceSha256: string,
  signal?: AbortSignal,
) {
  if (input.localPath) return input.localPath;
  return publishPdfBytes(bytes, sourceSha256, signal);
}

async function readProjectionCache(
  key: string,
  identity: ProjectionIdentity,
): Promise<CachedReadProjection | null> {
  const filename = projectionCacheFile(key);
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > MAX_PROJECTION_OUTPUT_BYTES) return null;
    const parsed = JSON.parse(await readFile(filename, "utf8")) as {
      identity?: unknown;
      projection?: CachedReadProjection;
      projection_sha256?: string;
    };
    return isDeepStrictEqual(parsed.identity, identity) && parsed.projection &&
      parsed.projection_sha256 === sha256(JSON.stringify(parsed.projection))
      ? parsed.projection
      : null;
  } catch {
    return null;
  }
}

async function writeProjectionCache(
  key: string,
  identity: ProjectionIdentity,
  projection: CachedReadProjection,
) {
  const serialized = `${JSON.stringify({ identity, projection,
    projection_sha256: sha256(JSON.stringify(projection)) })}\n`;
  if (Buffer.byteLength(serialized) > MAX_PROJECTION_OUTPUT_BYTES) {
    throw new Error("Document projection output exceeds the cache limit");
  }
  await atomicWriteProjection(projectionCacheFile(key), serialized);
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

function restoreProjection(value: CachedReadProjection): DocumentReadProjection {
  if (value.kind === "spreadsheet-grid") {
    return {
      kind: value.kind,
      text: value.grid.text,
      grid: value.grid,
      tableCells: value.grid.tableCells,
    };
  }
  return sourceDocProjection(
    value.kind,
    createSourceDoc(value.sourceDoc),
  );
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
    const sourcePath = await cachedPdfSource(input, bytes, sourceSha256, signal);
    await parsePdf({
      documentId: input.documentId,
      versionId: input.versionId,
      sourcePath,
      sourceSha256,
      signal,
    });
    doc = (await readLocalPdfSourceDoc(sourcePath)) ??
      await parseLegalPdfSourceDoc(bytes, signal);
    return sourceDocProjection("pdf-artifact", doc);
  }
  let text = "";
  if (isPlainTextDocumentType(fileType)) {
    text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  } else if (fileType === "eml") {
    text = extractEmailText(bytes);
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

function cacheableProjection(
  projection: DocumentReadProjection,
): CachedReadProjection | null {
  if (projection.kind === "docx-session") return null;
  if (projection.kind === "spreadsheet-grid") {
    return { kind: projection.kind, grid: projection.grid };
  }
  const { provider, id, url, docType, text, blocks } = projection.sourceDoc;
  return {
    kind: projection.kind,
    sourceDoc: { provider, id, url, docType, text, blocks },
  };
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
  options: { signal?: AbortSignal; material?: Record<string, unknown> } = {},
) {
  const source = await boundedSource(input, options.signal);
  const identity: ProjectionIdentity = {
    schema: PROJECTION_SCHEMA,
    document_id: input.documentId,
    version_id: input.versionId,
    source_sha256: source.sourceSha256,
    compiler_version: compilerVersion(source.fileType),
    material_options: canonicalProjectionOptions(options.material ?? {}),
  };
  const key = projectionKey("read", identity);
  let pending = projectionMemory.get(key);
  if (!pending) {
    pending = (async () => {
      const cached = await readProjectionCache(key, identity);
      if (cached) return restoreProjection(cached);
      const projection = await compileReadProjection(input, source, options.signal);
      assertProjectionOutput(projection);
      throwIfAborted(options.signal);
      const serializable = cacheableProjection(projection);
      if (serializable) await writeProjectionCache(key, identity, serializable);
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

async function clear(input?: Pick<DocumentProjectionInput, "documentId" | "versionId">) {
  projectionMemory.clear();
  if (!input) {
    await rm(projectionFormatRoot("read"), {
      recursive: true,
      force: true,
    });
  }
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
  clear,
  queuePdf,
  parsePdf,
  peekPdfState,
  pdfState,
  removePdf,
  resume,
  readPdfSourceDoc: readLocalPdfSourceDoc,
  lookupPdf: lookupLocalPdfStructure,
  readPdfEvidence: readLocalPdfEvidenceReceipt,
  rehydratePdfEvidence: rehydrateLocalPdfEvidence,
  verifyPdfEvidence: verifyLocalPdfLinkEvidence,
  rehydratePdfLink: rehydrateLocalPdfLinkEvidence,
});
