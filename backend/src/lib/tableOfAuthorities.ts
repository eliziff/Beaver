import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { appUrl } from "./appRoutes";
import { isLocalRuntime } from "./localMode";

const DOCX_LIMIT = 64 * 1024 * 1024;
const PDF_LIMIT = 256 * 1024 * 1024;
const JOB_ID = /^[0-9a-f]{32}$/;

let child: ChildProcess | null = null;

export type TableOfAuthoritiesJob = {
  id: string;
  state: string;
  operation: string;
  progress: number;
  message: string;
  error: string;
  has_review: boolean;
  split_fallback: "off" | "auto";
  files: Array<{ name: string; size: number; url: string }>;
  project_id: string;
  app_url: string;
};

function port() {
  const parsed = Number.parseInt(process.env.TOA_WEB_PORT ?? "8765", 10);
  return Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65_535
    ? parsed
    : 8765;
}

export function tableOfAuthoritiesUrl() {
  return `http://127.0.0.1:${port()}`;
}

export function tableOfAuthoritiesProjectDirectory() {
  const configured = process.env.TOA_MAKER_DIR?.trim();
  if (configured) return path.resolve(configured);
  const fromBackend = path.resolve(
    process.cwd(),
    "..",
    "TableOfAuthoritiesMaker",
  );
  if (existsSync(path.join(fromBackend, "toa_web.py"))) return fromBackend;
  return path.resolve(process.cwd(), "TableOfAuthoritiesMaker");
}

export function tableOfAuthoritiesLocalFeatureAvailable() {
  return isLocalRuntime() && process.env.NODE_ENV !== "production";
}

export async function tableOfAuthoritiesStatus() {
  try {
    const response = await fetch(`${tableOfAuthoritiesUrl()}/api/status`, {
      signal: AbortSignal.timeout(1_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as {
      ok?: unknown;
      service?: unknown;
    };
    return payload.ok === true && payload.service === "table-of-authorities";
  } catch {
    return false;
  }
}

async function waitUntilReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await tableOfAuthoritiesStatus()) return true;
    if (child?.exitCode !== null && child?.exitCode !== undefined) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function ensureTableOfAuthoritiesRunning() {
  if (!tableOfAuthoritiesLocalFeatureAvailable()) {
    throw new Error(
      "Table of Authorities is available only in local mode.",
    );
  }
  if (await tableOfAuthoritiesStatus()) {
    return { url: tableOfAuthoritiesUrl(), reused: true };
  }

  const directory = tableOfAuthoritiesProjectDirectory();
  const script = path.join(directory, "toa_web.py");
  const bootstrap = path.join(directory, "bootstrap.py");
  if (!existsSync(script)) {
    throw new Error(`Table of Authorities web host was not found at ${script}`);
  }

  if (!child || child.exitCode !== null) {
    const args = existsSync(bootstrap)
      ? [bootstrap, "--web", "--port", String(port()), "--no-browser"]
      : [script, "--port", String(port()), "--no-browser"];
    child = spawn(process.env.TOA_PYTHON?.trim() || "python", args, {
      cwd: directory,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {
      child = null;
    });
  }

  if (!(await waitUntilReady())) {
    throw new Error(
      "Table of Authorities did not become ready. Run `python bootstrap.py --web` in TableOfAuthoritiesMaker to see its startup error.",
    );
  }
  return { url: tableOfAuthoritiesUrl(), reused: false };
}

function boundedText(value: unknown, maximum = 500) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function normalizeJob(payload: unknown): TableOfAuthoritiesJob {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Table of Authorities returned an invalid job.");
  }
  const row = payload as Record<string, unknown>;
  const id = boundedText(row.id, 32);
  if (!JOB_ID.test(id)) {
    throw new Error("Table of Authorities returned an invalid job id.");
  }
  const files = Array.isArray(row.files)
    ? row.files.slice(0, 50).flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }
        const file = value as Record<string, unknown>;
        const relativeUrl = boundedText(file.url, 2_000);
        if (!relativeUrl.startsWith(`/api/jobs/${id}/files/`)) return [];
        return [
          {
            name: boundedText(file.name, 200),
            size:
              typeof file.size === "number" && Number.isFinite(file.size)
                ? Math.max(0, Math.trunc(file.size))
                : 0,
            url: new URL(relativeUrl, tableOfAuthoritiesUrl()).toString(),
          },
        ];
      })
    : [];
  const projectId = boundedText(row.project_id, 80);
  return {
    id,
    state: boundedText(row.state, 40),
    operation: boundedText(row.operation, 80),
    progress:
      typeof row.progress === "number" && Number.isFinite(row.progress)
        ? Math.min(100, Math.max(0, Math.trunc(row.progress)))
        : 0,
    message: boundedText(row.message),
    error: boundedText(row.error, 1_000),
    has_review: row.has_review === true,
    split_fallback: row.split_fallback === "auto" ? "auto" : "off",
    files,
    project_id: projectId,
    app_url: appUrl({
      kind: "authorities",
      jobId: id,
      projectId: projectId || null,
    }),
  };
}

async function responseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") return payload.error.slice(0, 500);
  } catch {
    // Fall through to a bounded status message.
  }
  return `Table of Authorities request failed (${response.status}).`;
}

export async function submitTableOfAuthoritiesDocument(params: {
  bytes: Buffer;
  filename: string;
  splitFallback?: "off" | "auto";
  projectId?: string | null;
}) {
  const filename = path.basename(params.filename).slice(0, 180);
  const lower = filename.toLowerCase();
  const pdf = lower.endsWith(".pdf");
  const docx = lower.endsWith(".docx");
  if (!docx && !pdf) {
    throw new Error(
      "Table of Authorities requires a Word or PDF Library version.",
    );
  }
  const limit = pdf ? PDF_LIMIT : DOCX_LIMIT;
  if (params.bytes.byteLength === 0 || params.bytes.byteLength > limit) {
    throw new Error(
      `Table of Authorities accepts ${pdf ? "PDF files up to 256 MB" : "Word files up to 64 MB"}.`,
    );
  }
  await ensureTableOfAuthoritiesRunning();
  const query = new URLSearchParams({
    filename,
    split_fallback: params.splitFallback === "auto" ? "auto" : "off",
  });
  if (params.projectId?.trim()) {
    query.set("project", params.projectId.trim());
  }
  const response = await fetch(
    `${tableOfAuthoritiesUrl()}/api/jobs?${query.toString()}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": pdf
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      body: new Uint8Array(params.bytes),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(await responseError(response));
  return normalizeJob(await response.json());
}

export async function getTableOfAuthoritiesJob(jobId: string) {
  if (!JOB_ID.test(jobId)) {
    throw new Error("A valid Table of Authorities job_id is required.");
  }
  await ensureTableOfAuthoritiesRunning();
  const response = await fetch(
    `${tableOfAuthoritiesUrl()}/api/jobs/${jobId}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(await responseError(response));
  return normalizeJob(await response.json());
}
