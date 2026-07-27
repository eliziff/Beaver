import crypto from "node:crypto";
import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { mikeLocalDataHome } from "./legalDataPath";
import { runLegalPdf } from "./legalPdfProcess";

export const LOCAL_PDF_PARSER_VERSION = "0.1.0";
const STATE_SUFFIX = ".legalpdf-state.json";
const ARTIFACT_SUFFIX = ".legalpdf";
const STATE_SCHEMA = "mike.pdf_parse.v1";
const statuses = new Set(["queued", "parsing", "ready", "degraded", "failed"]);

export type LocalPdfParseStatus =
  | "queued"
  | "parsing"
  | "ready"
  | "degraded"
  | "failed";

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
    ocr_provider: null;
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
// ponytail: one parser at a time protects weak local machines; use a bounded
// worker pool only if measured queue latency justifies the extra machinery.
let workTail: Promise<unknown> = Promise.resolve();

function configVersion() {
  return process.env.MIKE_PDF_PARSE_CONFIG_VERSION?.trim() || "mike-local-v1";
}

function parserConfig(): LocalPdfParseState["parser_config"] {
  return {
    mode: "local",
    ocr_provider: null,
    model: null,
    prompt_version: null,
    text_fidelity_root: process.env.LEGALPDF_TEXT_FIDELITY_ROOT?.trim() || null,
    text_fidelity_native: false,
  };
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

async function atomicWrite(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, filePath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== "win32" ||
          !["EACCES", "EBUSY", "EPERM"].includes(String(code)) ||
          attempt >= 20
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    await rm(temporary, { force: true });
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
  try {
    return parseState(
      JSON.parse(await readFile(statePath(sourcePath), "utf8")),
    );
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
  return sha256(await readFile(filePath));
}

function cacheKey(sourceSha256: string, version: string, config: object) {
  return sha256(
    JSON.stringify({
      source_sha256: sourceSha256,
      parser_version: LOCAL_PDF_PARSER_VERSION,
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
  previous?: LocalPdfParseState | null;
}) {
  const now = new Date().toISOString();
  const config = parserConfig();
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

function jsonLines(raw: string) {
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
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
    await readFile(path.join(output, String(artifacts.footnotes)), "utf8"),
  );
  if (typeof artifacts.sections !== "string") {
    throw new Error("PDF parser did not publish section artifacts");
  }
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
  const queued = await readState(sourcePath);
  if (!queued || queued.status !== "queued") return;
  const started = new Date().toISOString();
  const parsing: LocalPdfParseState = {
    ...queued,
    status: "parsing",
    attempts: queued.attempts + 1,
    started_at: started,
    updated_at: started,
    error: undefined,
  };
  const output = artifactDirectory(sourcePath, parsing.cache_key);
  try {
    const actualHash = await hashFile(sourcePath);
    if (actualHash !== queued.source_sha256) {
      throw new Error("PDF source changed after its parse job was queued");
    }
    if (!(await writeState(sourcePath, parsing))) return;
    const configuredTimeout = Number(process.env.MIKE_PDF_PARSE_TIMEOUT_MS);
    await runLegalPdf(
      [
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
      ],
      {
        timeoutMs:
          Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout
            : 30 * 60 * 1000,
      },
    );
    if (
      !(await exists(sourcePath)) ||
      (await hashFile(sourcePath)) !== parsing.source_sha256
    ) {
      await rm(artifactRoot(sourcePath), { recursive: true, force: true });
      return;
    }
    const manifest = await publishBridgeArtifacts(sourcePath, parsing);
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
    await writeState(sourcePath, {
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
    });
  } catch (error) {
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
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        2000,
      ),
      completed_at: failed,
      updated_at: failed,
    });
  }
}

function schedule(sourcePath: string) {
  const key = statePath(sourcePath);
  if (scheduled.has(key)) return;
  scheduled.add(key);
  const job = workTail
    .catch(() => undefined)
    .then(() => processJob(sourcePath))
    .catch((error) => {
      console.error("[local-library] PDF parse worker failed", {
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => scheduled.delete(key));
  workTail = job;
}

export async function queueLocalPdfParse(params: {
  documentId: string;
  versionId: string;
  sourcePath: string;
  sourceSha256?: string;
  force?: boolean;
}) {
  const sourceSha256 =
    params.sourceSha256 || (await hashFile(params.sourcePath));
  const current = await readState(params.sourcePath);
  const candidate = newQueuedState({
    ...params,
    sourceSha256,
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
      (await exists(
        path.join(
          artifactDirectory(params.sourcePath, current.cache_key),
          "document.json",
        ),
      ))
    ) {
      return current;
    }
    if (!params.force && current.status === "failed") return current;
  }
  await writeState(params.sourcePath, candidate);
  schedule(params.sourcePath);
  return candidate;
}

export async function readLocalPdfParseState(sourcePath: string) {
  const state = await readState(sourcePath);
  if (!state) return null;
  let diagnostics: JsonObject[] = [];
  if (state.status === "ready" || state.status === "degraded") {
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
  await Promise.all([
    rm(statePath(sourcePath), { force: true }),
    rm(artifactRoot(sourcePath), { recursive: true, force: true }),
  ]);
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
      if (!state || !["queued", "parsing"].includes(state.status)) continue;
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
