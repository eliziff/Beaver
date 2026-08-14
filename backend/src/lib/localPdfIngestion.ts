import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { mikeLocalDataHome } from "./legalDataPath";
import { LOCAL_PDF_SOURCE_SCHEMA } from "./legalPdfSourceDoc";
import {
  configuredLegalPdfOcrProvider,
  LEGAL_PDF_DOCUMENT_SCHEMA,
  LEGAL_PDF_PARSER_VERSION,
  legalPdfOcrArguments,
  runLegalPdf,
  type LegalPdfOcrProvider,
} from "./legalPdfProcess";
import { sha256 } from "./hash";

const STATE_SUFFIX = ".legalpdf-state.json";
const ARTIFACT_SUFFIX = ".legalpdf";
const STATE_SCHEMA = "mike.pdf_parse.v1";
const statuses = new Set(["queued", "parsing", "ready", "degraded", "failed"]);
const publicationArtifacts = [
  "pages",
  "paragraphs",
  "sections",
  "footnotes",
  "diagnostics",
  "repairs",
  "parser_config",
] as const;

export type LocalPdfParseStatus =
  | "queued"
  | "parsing"
  | "ready"
  | "degraded"
  | "failed";

export type LocalPdfOcrProvider = LegalPdfOcrProvider;

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
const atomicWriteTails = new Map<string, Promise<void>>();
const validatedPublications = new Map<string, string>();
let repairIdentityPromise: Promise<LocalPdfRepairIdentity> | null = null;
// ponytail: one parser at a time protects weak local machines; use a bounded
// worker pool only if measured queue latency justifies the extra machinery.
let workTail: Promise<unknown> = Promise.resolve();

function configVersion() {
  return process.env.MIKE_PDF_PARSE_CONFIG_VERSION?.trim() || "mike-local-v1";
}

function parserConfig(
  ocrProvider: LocalPdfOcrProvider | null,
  ocrIdentity?: string,
  repairIdentity?: LocalPdfRepairIdentity | null,
  repair?: LocalPdfRepairConfig | null,
): LocalPdfParseState["parser_config"] {
  const config: LocalPdfParseState["parser_config"] = {
    mode: repair ? "codex" : "local",
    ocr_provider: ocrProvider,
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

function relativeDataPath(absolutePath: string) {
  const resolved = path.resolve(absolutePath);
  const relative = path.relative(dataRoot, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("PDF parse path is outside Beaver's local data directory");
  }
  return relative;
}

function statePath(sourcePath: string) {
  return `${sourcePath}${STATE_SUFFIX}`;
}

function jobKey(sourcePath: string) {
  return path.resolve(statePath(sourcePath));
}

function artifactRoot(sourcePath: string) {
  return `${sourcePath}${ARTIFACT_SUFFIX}`;
}

function artifactDirectory(sourcePath: string, cacheKey: string) {
  return path.join(artifactRoot(sourcePath), cacheKey);
}

async function removeOutmodedArtifacts(sourcePath: string, keepCacheKey: string) {
  const root = artifactRoot(sourcePath);
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of entries) {
    if (name !== keepCacheKey) {
      validatedPublications.delete(publicationKey(sourcePath, name));
    }
  }
  await Promise.all(
    entries
      .filter((name) => name !== keepCacheKey)
      .map((name) => rm(path.join(root, name), { recursive: true, force: true })),
  );
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteNow(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    const deadline = Date.now() + 5_000;
    let retryDelay = 10;
    for (;;) {
      try {
        await rename(temporary, filePath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== "win32" ||
          !["EACCES", "EBUSY", "EPERM"].includes(String(code)) ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 100);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicWrite(filePath: string, content: string) {
  const key = path.resolve(filePath);
  const previous = atomicWriteTails.get(key);
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  atomicWriteTails.set(key, turn);
  if (previous) await previous;
  try {
    await atomicWriteNow(filePath, content);
  } finally {
    release();
    if (atomicWriteTails.get(key) === turn) atomicWriteTails.delete(key);
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
  await atomicWriteTails.get(path.resolve(filePath));
  try {
    return parseState(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(sourcePath: string, state: LocalPdfParseState) {
  if (!(await exists(sourcePath))) return false;
  await atomicWrite(
    statePath(sourcePath),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return true;
}

async function hashFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

function cacheKey(
  sourceSha256: string,
  version: string,
  config: object,
  parserVersion = LEGAL_PDF_PARSER_VERSION,
) {
  return sha256(
    JSON.stringify({
      source_sha256: sourceSha256,
      parser_version: parserVersion,
      parser_config_version: version,
      parser_config: config,
    }),
  );
}

function newQueuedState(params: {
  documentId: string;
  versionId: string;
  sourcePath: string;
  sourceSha256: string;
  ocrProvider: LocalPdfOcrProvider | null;
  ocrIdentity?: string;
  repairIdentity: LocalPdfRepairIdentity | null;
  repair?: LocalPdfRepairConfig | null;
  previous?: LocalPdfParseState | null;
}) {
  const now = new Date().toISOString();
  const config = parserConfig(
    params.ocrProvider,
    params.ocrIdentity,
    params.repairIdentity,
    params.repair,
  );
  const version = configVersion();
  const key = cacheKey(params.sourceSha256, version, config);
  return {
    schema_version: STATE_SCHEMA,
    job_id: crypto.randomUUID(),
    document_id: params.documentId,
    version_id: params.versionId,
    status: "queued",
    source_path: relativeDataPath(params.sourcePath),
    source_sha256: params.sourceSha256,
    parser_version: LEGAL_PDF_PARSER_VERSION,
    parser_config_version: version,
    parser_config: config,
    ...(params.repairIdentity
      ? { repair_contract: params.repairIdentity }
      : {}),
    cache_key: key,
    artifact_manifest: relativeDataPath(
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
  const key = cacheKey(
    state.source_sha256,
    state.parser_config_version,
    config,
    state.parser_version,
  );
  return {
    ...state,
    job_id: crypto.randomUUID(),
    status: "queued",
    parser_config: config,
    cache_key: key,
    artifact_manifest: relativeDataPath(
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
  validatedPublications.delete(publicationKey(sourcePath, state.cache_key));
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

function publicationKey(sourcePath: string, cacheKey_: string) {
  return `${path.resolve(sourcePath)}\u0000${cacheKey_}`;
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

async function validateJsonLines(filePath: string) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    jsonObject(line, path.basename(filePath));
    count += 1;
  }
  return count;
}

async function validatePublishedArtifacts(
  sourcePath: string,
  state: LocalPdfParseState,
) {
  const key = publicationKey(sourcePath, state.cache_key);
  try {
    const output = artifactDirectory(sourcePath, state.cache_key);
    const manifestPath = path.join(output, "document.json");
    if (
      typeof state.artifact_manifest !== "string" ||
      path.resolve(dataRoot, state.artifact_manifest) !== manifestPath
    ) {
      throw new Error("PDF parse state points to a different publication");
    }
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = jsonObject(manifestRaw, "PDF artifact manifest");
    const engineStatus = String(manifest.status || "");
    if (
      manifest.schema_version !== LOCAL_PDF_SOURCE_SCHEMA ||
      manifest.engine_schema_version !== LEGAL_PDF_DOCUMENT_SCHEMA ||
      manifest.artifact_profile !== "compact-source" ||
      manifest.source_sha256 !== state.source_sha256 ||
      manifest.parser_version !== state.parser_version ||
      !["ready", "degraded", "ocr_required"].includes(engineStatus) ||
      (state.engine_status !== undefined &&
        state.engine_status !== engineStatus) ||
      (state.status === "ready" && engineStatus !== "ready") ||
      (state.status === "degraded" && engineStatus === "ready")
    ) {
      throw new Error("PDF artifact manifest does not match its parse state");
    }
    const artifacts = objectValue(manifest.artifacts, "PDF artifact map");
    const paths = Object.fromEntries(
      publicationArtifacts.map((name) => [
        name,
        publishedArtifactPath(output, artifacts[name], name),
      ]),
    ) as Record<(typeof publicationArtifacts)[number], string>;
    const parserConfigRaw = await readFile(paths.parser_config, "utf8");
    const persistedConfig = jsonObject(
      parserConfigRaw,
      "PDF parser configuration",
    );
    if (
      persistedConfig.parser_version !== state.parser_version ||
      persistedConfig.parser_config_version !== state.parser_config_version ||
      persistedConfig.cache_key !== state.cache_key ||
      persistedConfig.source_sha256 !== state.source_sha256 ||
      !isDeepStrictEqual(persistedConfig.parser_config, state.parser_config)
    ) {
      throw new Error(
        "PDF parser configuration does not match its parse state",
      );
    }
    const metadata = await Promise.all(
      publicationArtifacts.map(async (name) => {
        const details = await stat(paths[name]);
        if (!details.isFile()) {
          throw new Error(`PDF ${name} artifact is not a file`);
        }
        return `${name}:${details.size}:${details.mtimeMs}`;
      }),
    );
    const signature = sha256(
      [manifestRaw, parserConfigRaw, ...metadata].join("\u001e"),
    );
    if (validatedPublications.get(key) === signature) return true;

    const names = publicationArtifacts.filter(
      (name) => name !== "parser_config",
    );
    const rowCounts = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [name, await validateJsonLines(paths[name])]),
      ),
    ) as Record<(typeof names)[number], number>;
    const expectedCounts = objectValue(manifest.counts, "PDF artifact counts");
    for (const name of [
      "pages",
      "paragraphs",
      "sections",
      "footnotes",
      "diagnostics",
      "repairs",
    ] as const) {
      if (expectedCounts[name] !== rowCounts[name]) {
        throw new Error(
          `PDF ${name} artifact count does not match its manifest`,
        );
      }
    }
    if (
      manifest.page_count !== rowCounts.pages ||
      (state.page_count !== undefined &&
        state.page_count !== rowCounts.pages) ||
      (state.diagnostic_count !== undefined &&
        state.diagnostic_count !== rowCounts.diagnostics) ||
      (state.counts !== undefined &&
        !isDeepStrictEqual(state.counts, expectedCounts))
    ) {
      throw new Error("PDF artifact publication is internally inconsistent");
    }
    validatedPublications.set(key, signature);
    return true;
  } catch {
    validatedPublications.delete(key);
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
  await atomicWrite(
    pagesPath,
    pages.map((row) => JSON.stringify(row)).join("\n") +
      (pages.length ? "\n" : ""),
  );
  await atomicWrite(
    path.join(output, "parser-config.json"),
    `${JSON.stringify(
      {
        parser_version: state.parser_version,
        parser_config_version: state.parser_config_version,
        parser_config: state.parser_config,
        cache_key: state.cache_key,
        source_sha256: state.source_sha256,
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
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
    const actualHash = await hashFile(sourcePath);
    if (actualHash !== queued.source_sha256) {
      throw new Error("PDF source changed after its parse job was queued");
    }
    if (cancelled.has(key)) return;
    if (!(await writeState(sourcePath, parsing))) return;
    validatedPublications.delete(publicationKey(sourcePath, parsing.cache_key));
    await rm(output, { recursive: true, force: true });
    const configuredTimeout = Number(process.env.MIKE_PDF_PARSE_TIMEOUT_MS);
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
    if (parsing.parser_config.ocr_provider) {
      arguments_.push(
        ...legalPdfOcrArguments(parsing.parser_config.ocr_provider, {
          language: parsing.parser_config.ocr_language,
          dpi: parsing.parser_config.ocr_dpi,
          psm: parsing.parser_config.ocr_psm,
          expectedIdentity: String(parsing.parser_config.ocr_identity),
        }),
      );
    }
    await runLegalPdf(arguments_, {
      timeoutMs:
        Number.isFinite(configuredTimeout) && configuredTimeout > 0
          ? configuredTimeout
          : 30 * 60 * 1000,
      signal: controller.signal,
    });
    if (cancelled.has(key)) return;
    if (
      !(await exists(sourcePath)) ||
      (await hashFile(sourcePath)) !== parsing.source_sha256
    ) {
      await Promise.all([
        rm(statePath(sourcePath), { force: true }),
        rm(artifactRoot(sourcePath), { recursive: true, force: true }),
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
        await atomicWrite(
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
      cancelled.delete(key);
    });
  jobs.set(key, job);
  workTail = job;
}

export async function queueLocalPdfParse(params: {
  documentId: string;
  versionId: string;
  sourcePath: string;
  sourceSha256?: string;
  force?: boolean;
  ocrProvider?: LocalPdfOcrProvider | null;
  repair?: LocalPdfRepairConfig | null;
}) {
  const sourceSha256 =
    params.sourceSha256 || (await hashFile(params.sourcePath));
  let current = await readState(params.sourcePath);
  const key = jobKey(params.sourcePath);
  const activeStatus =
    current?.status === "queued" || current?.status === "parsing";
  const hasOwner =
    scheduled.has(key) || jobs.has(key) || activeControllers.has(key);
  if (current && activeStatus && hasOwner) return current;
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
  let repairIdentity: LocalPdfRepairIdentity | null;
  let ocrIdentity: string | undefined;
  try {
    repairIdentity = repair
      ? await cachedRepairIdentity()
      : await cachedRepairIdentity().catch(() => null);
    ocrIdentity = ocrProvider
      ? await detectedOcrIdentity(ocrProvider, parserConfig(ocrProvider))
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
  if (current && activeStatus && ownerAfterProbes) return current;
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
      await removeOutmodedArtifacts(params.sourcePath, current.cache_key);
      return current;
    }
    if (!params.force && current.status === "failed") return current;
  }
  cancelled.delete(jobKey(params.sourcePath));
  await removeOutmodedArtifacts(params.sourcePath, candidate.cache_key);
  await writeState(params.sourcePath, candidate);
  schedule(params.sourcePath);
  return candidate;
}

export async function parseLocalPdfOnDemand(
  params: Omit<Parameters<typeof queueLocalPdfParse>[0], "force">,
) {
  const sourceSha256 = await hashFile(params.sourcePath);
  let current = await readLocalPdfParseState(params.sourcePath, {
    validatePublication: false,
  });
  if (params.sourceSha256 && params.sourceSha256 !== sourceSha256) {
    await removeLocalPdfParseArtifacts(params.sourcePath);
    throw new Error("PDF source bytes no longer match their version");
  }
  if (current && current.source_sha256 !== sourceSha256) {
    await removeLocalPdfParseArtifacts(params.sourcePath);
    current = null;
  }
  if (
    current &&
    (current.status === "ready" || current.status === "degraded") &&
    (await validatePublishedArtifacts(params.sourcePath, current))
  ) {
    await removeOutmodedArtifacts(params.sourcePath, current.cache_key);
    return current;
  }
  const queued = await queueLocalPdfParse({
    ...params,
    sourceSha256,
    force: current?.status === "failed",
  });
  if (queued.status === "ready" || queued.status === "degraded") return queued;
  await jobs.get(jobKey(params.sourcePath))?.catch(() => undefined);
  return (await readLocalPdfParseState(params.sourcePath)) ?? queued;
}

/**
 * Light parse-state summary for library listings: reads the state file
 * only — no artifact validation, no diagnostics load, no writes — so a
 * list of N documents costs N stat-reads, not N artifact walks. The full
 * readLocalPdfParseState stays the source of truth for the per-document
 * inspector.
 */
export async function peekLocalPdfParseState(sourcePath: string) {
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

export async function readLocalPdfParseState(
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

export async function removeLocalPdfParseArtifacts(sourcePath: string) {
  const key = jobKey(sourcePath);
  const wasScheduled = scheduled.has(key);
  const active = activeControllers.get(key);
  const job = jobs.get(key);
  cancelled.add(key);
  active?.abort();
  await job?.catch(() => undefined);
  const publicationPrefix = `${path.resolve(sourcePath)}\u0000`;
  for (const publication of validatedPublications.keys()) {
    if (publication.startsWith(publicationPrefix)) {
      validatedPublications.delete(publication);
    }
  }
  await Promise.all([
    rm(statePath(sourcePath), { force: true }),
    rm(artifactRoot(sourcePath), { recursive: true, force: true }),
  ]);
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

export async function resumeLocalPdfParses() {
  for (const filePath of await stateFiles(path.join(dataRoot, "files"))) {
    try {
      const sourcePath = filePath.slice(0, -STATE_SUFFIX.length);
      const state = await readState(sourcePath);
      if (!state) continue;
      if (!(await exists(sourcePath))) {
        const now = new Date().toISOString();
        await atomicWrite(
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
      await queueLocalPdfParse({
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
