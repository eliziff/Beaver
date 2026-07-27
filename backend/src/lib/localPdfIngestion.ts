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
import { runLegalPdf } from "./legalPdfProcess";

export const LOCAL_PDF_PARSER_VERSION = "0.1.0";
const STATE_SUFFIX = ".legalpdf-state.json";
const ARTIFACT_SUFFIX = ".legalpdf";
const STATE_SCHEMA = "mike.pdf_parse.v1";
const DOCUMENT_SCHEMA = "legalpdf.document.v1";
const statuses = new Set(["queued", "parsing", "ready", "degraded", "failed"]);
const publicationArtifacts = [
  "pages",
  "paragraphs",
  "sections",
  "footnotes",
  "diagnostics",
  "repairs",
  "propositions",
  "parser_config",
] as const;

export type LocalPdfParseStatus =
  | "queued"
  | "parsing"
  | "ready"
  | "degraded"
  | "failed";

export type LocalPdfOcrProvider = "tesseract";

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
    mode: "local";
    ocr_provider: LocalPdfOcrProvider | null;
    ocr_identity?: string;
    ocr_language?: string;
    ocr_dpi?: number;
    ocr_psm?: number;
    model: null;
    prompt_version: null;
    text_fidelity_root: string | null;
    text_fidelity_native: false;
  };
  cache_key: string;
  artifact_manifest: string;
  attempts: number;
  queued_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  interrupted_at?: string;
  engine_status?: string;
  cache_hit?: boolean;
  page_count?: number;
  counts?: Record<string, number>;
  diagnostic_count?: number;
  diagnostic_summary?: {
    by_severity: Record<string, number>;
    by_code: Record<string, number>;
  };
  error?: string;
  flat_text_fallback_available: true;
};

type JsonObject = Record<string, unknown>;

const dataRoot = mikeLocalDataHome();
const scheduled = new Set<string>();
const cancelled = new Set<string>();
const activeControllers = new Map<string, AbortController>();
const jobs = new Map<string, Promise<void>>();
const atomicWriteTails = new Map<string, Promise<void>>();
const validatedPublications = new Map<string, string>();
// ponytail: one parser at a time protects weak local machines; use a bounded
// worker pool only if measured queue latency justifies the extra machinery.
let workTail: Promise<unknown> = Promise.resolve();

function configVersion() {
  return process.env.MIKE_PDF_PARSE_CONFIG_VERSION?.trim() || "mike-local-v1";
}

function parserConfig(
  ocrProvider: LocalPdfOcrProvider | null,
  ocrIdentity?: string,
): LocalPdfParseState["parser_config"] {
  const config: LocalPdfParseState["parser_config"] = {
    mode: "local",
    ocr_provider: ocrProvider,
    model: null,
    prompt_version: null,
    text_fidelity_root: process.env.LEGALPDF_TEXT_FIDELITY_ROOT?.trim() || null,
    text_fidelity_native: false,
  };
  if (!ocrProvider) return config;
  const language = process.env.MIKE_PDF_OCR_LANGUAGE?.trim() || "eng";
  const dpi = Number(process.env.MIKE_PDF_OCR_DPI);
  const psm = Number(process.env.MIKE_PDF_OCR_PSM);
  return {
    ...config,
    ...(ocrIdentity ? { ocr_identity: ocrIdentity } : {}),
    ocr_language: /^[A-Za-z0-9_+-]+$/u.test(language) ? language : "eng",
    ocr_dpi: Number.isInteger(dpi) && dpi >= 72 && dpi <= 600 ? dpi : 180,
    ocr_psm: Number.isInteger(psm) && psm >= 0 && psm <= 13 ? psm : 3,
  };
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
  if (/source changed after its parse job was queued/iu.test(message)) {
    return "PDF source changed after its parse job was queued";
  }
  return "PDF structural parser failed";
}

async function detectedTesseractIdentity(
  config: LocalPdfParseState["parser_config"],
  signal?: AbortSignal,
) {
  try {
    const result = await runLegalPdf(
      [
        "ocr-identity",
        "--provider",
        "tesseract",
        "--ocr-language",
        config.ocr_language || "eng",
        "--ocr-dpi",
        String(config.ocr_dpi ?? 180),
        "--ocr-psm",
        String(config.ocr_psm ?? 3),
      ],
      { timeoutMs: 15_000, signal },
    );
    const payload = JSON.parse(String(result.stdout)) as {
      provider?: unknown;
      identity?: unknown;
    };
    if (
      payload.provider !== "tesseract" ||
      typeof payload.identity !== "string" ||
      !payload.identity ||
      payload.identity.length > 256 ||
      /[\r\n\u0000]/u.test(payload.identity)
    ) {
      throw new Error("Invalid Tesseract identity");
    }
    return payload.identity;
  } catch (error) {
    throw new Error(safeParserError(error));
  }
}

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
    throw new Error("PDF parse path is outside Mike's local data directory");
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
  parserVersion = LOCAL_PDF_PARSER_VERSION,
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
  previous?: LocalPdfParseState | null;
}) {
  const now = new Date().toISOString();
  const config = parserConfig(params.ocrProvider, params.ocrIdentity);
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
    parser_version: LOCAL_PDF_PARSER_VERSION,
    parser_config_version: version,
    parser_config: config,
    cache_key: key,
    artifact_manifest: relativeDataPath(
      path.join(artifactDirectory(params.sourcePath, key), "document.json"),
    ),
    attempts: params.previous?.attempts ?? 0,
    queued_at: now,
    updated_at: now,
    interrupted_at: params.previous?.interrupted_at,
    flat_text_fallback_available: true,
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
    cache_hit: undefined,
    page_count: undefined,
    counts: undefined,
    diagnostic_count: undefined,
    diagnostic_summary: undefined,
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
    cache_hit: undefined,
    page_count: undefined,
    counts: undefined,
    diagnostic_count: undefined,
    diagnostic_summary: undefined,
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
      manifest.schema_version !== DOCUMENT_SCHEMA ||
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
      rowCounts.propositions !== rowCounts.footnotes ||
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

async function publishBridgeArtifacts(
  sourcePath: string,
  state: LocalPdfParseState,
) {
  const output = artifactDirectory(sourcePath, state.cache_key);
  const manifestPath = path.join(output, "document.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as JsonObject;
  if (
    manifest.source_sha256 !== state.source_sha256 ||
    manifest.parser_version !== state.parser_version
  ) {
    throw new Error(
      "PDF parser returned artifacts for a different source or version",
    );
  }
  const artifacts =
    manifest.artifacts && typeof manifest.artifacts === "object"
      ? (manifest.artifacts as JsonObject)
      : {};
  const footnotes = jsonLines(
    await readFile(
      publishedArtifactPath(output, artifacts.footnotes, "footnote"),
      "utf8",
    ),
  );
  publishedArtifactPath(output, artifacts.sections, "section");
  const propositions = footnotes.map((footnote) => ({
    pair_id: footnote.pair_id,
    label: footnote.label,
    reference_page: footnote.reference_page,
    sentence: footnote.sentence_proposition,
    passage_since_prior_note: footnote.passage_since_prior_note,
  }));
  await Promise.all([
    atomicWrite(
      path.join(output, "propositions.jsonl"),
      propositions.map((row) => JSON.stringify(row)).join("\n") +
        (propositions.length ? "\n" : ""),
    ),
    atomicWrite(
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
    ),
  ]);
  manifest.artifacts = {
    ...artifacts,
    propositions: "propositions.jsonl",
    parser_config: "parser-config.json",
  };
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function diagnosticSummary(output: string) {
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
  };
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
    if (queued.parser_config.ocr_provider === "tesseract") {
      const identity = await detectedTesseractIdentity(
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
    await rm(path.join(output, "document.json"), { force: true });
    const configuredTimeout = Number(process.env.MIKE_PDF_PARSE_TIMEOUT_MS);
    const arguments_ = [
      "parse",
      sourcePath,
      "--output",
      output,
      "--mode",
      "local",
      "--cache-dir",
      path.join(
        dataRoot,
        "cache",
        "legalpdf",
        parsing.parser_version,
        parsing.parser_config_version,
      ),
    ];
    if (parsing.parser_config.ocr_provider === "tesseract") {
      arguments_.push(
        "--ocr-provider",
        "tesseract",
        "--ocr-language",
        parsing.parser_config.ocr_language || "eng",
        "--ocr-dpi",
        String(parsing.parser_config.ocr_dpi ?? 180),
        "--ocr-psm",
        String(parsing.parser_config.ocr_psm ?? 3),
        "--expected-ocr-identity",
        String(parsing.parser_config.ocr_identity),
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
      await rm(artifactRoot(sourcePath), { recursive: true, force: true });
      return;
    }
    const manifest = await publishBridgeArtifacts(sourcePath, parsing);
    if (cancelled.has(key)) return;
    const diagnostics = await diagnosticSummary(output);
    const completed = new Date().toISOString();
    const engineStatus = String(manifest.status || "degraded");
    const provenance =
      manifest.provenance && typeof manifest.provenance === "object"
        ? (manifest.provenance as JsonObject)
        : {};
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
      cache_hit: provenance.cache_hit === true,
      page_count:
        typeof manifest.page_count === "number"
          ? manifest.page_count
          : undefined,
      counts,
      diagnostic_count: diagnostics.count,
      diagnostic_summary: diagnostics.summary,
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
}) {
  const sourceSha256 =
    params.sourceSha256 || (await hashFile(params.sourcePath));
  const current = await readState(params.sourcePath);
  const ocrProvider =
    params.ocrProvider === undefined
      ? (current?.parser_config.ocr_provider ?? null)
      : params.ocrProvider;
  const ocrIdentity =
    ocrProvider === "tesseract"
      ? await detectedTesseractIdentity(parserConfig(ocrProvider))
      : undefined;
  const candidate = newQueuedState({
    ...params,
    sourceSha256,
    ocrProvider,
    ocrIdentity,
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
  await writeState(params.sourcePath, candidate);
  schedule(params.sourcePath);
  return candidate;
}

export async function readLocalPdfParseState(
  sourcePath: string,
  options?: { validatePublication?: boolean },
) {
  let state = await readState(sourcePath);
  if (!state) return null;
  let diagnostics: JsonObject[] = [];
  if (
    options?.validatePublication !== false &&
    (state.status === "ready" || state.status === "degraded")
  ) {
    if (!(await validatePublishedArtifacts(sourcePath, state))) {
      state = await requeueInvalidPublication(sourcePath, state);
      return { ...state, diagnostics };
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
    } catch {
      diagnostics = [];
    }
  }
  return { ...state, diagnostics };
}

export async function removeLocalPdfParseArtifacts(sourcePath: string) {
  const key = jobKey(sourcePath);
  const wasScheduled = scheduled.has(key);
  const active = activeControllers.get(key);
  const job = jobs.get(key);
  cancelled.add(key);
  active?.abort();
  if (active) await job?.catch(() => undefined);
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
  try {
    const store = JSON.parse(
      await readFile(path.join(dataRoot, "library.json"), "utf8"),
    ) as {
      documents?: {
        id?: unknown;
        versions?: {
          id?: unknown;
          fileType?: unknown;
          storagePath?: unknown;
          sourceSha256?: unknown;
        }[];
      }[];
    };
    for (const document of store.documents ?? []) {
      for (const version of document.versions ?? []) {
        if (
          version.fileType !== "pdf" ||
          typeof document.id !== "string" ||
          typeof version.id !== "string" ||
          typeof version.storagePath !== "string"
        ) {
          continue;
        }
        const sourcePath = path.resolve(dataRoot, version.storagePath);
        relativeDataPath(sourcePath);
        if ((await exists(sourcePath)) && !(await readState(sourcePath))) {
          await queueLocalPdfParse({
            documentId: document.id,
            versionId: version.id,
            sourcePath,
            sourceSha256:
              typeof version.sourceSha256 === "string"
                ? version.sourceSha256
                : undefined,
          });
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[local-library] Could not recover unqueued PDF imports", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
      if (
        (state.status === "ready" || state.status === "degraded") &&
        !(await validatePublishedArtifacts(sourcePath, state))
      ) {
        await requeueInvalidPublication(sourcePath, state);
        continue;
      }
      if (!["queued", "parsing"].includes(state.status)) continue;
      if (state.status === "parsing") {
        const now = new Date().toISOString();
        await writeState(sourcePath, {
          ...state,
          status: "queued",
          queued_at: now,
          updated_at: now,
          interrupted_at: now,
          error: undefined,
        });
      }
      schedule(sourcePath);
    } catch (error) {
      console.error("[local-library] Could not resume PDF parse state", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
