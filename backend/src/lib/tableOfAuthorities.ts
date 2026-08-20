import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { appUrl } from "./appRoutes";
import { sha256 } from "./hash";
import { isolatedProcessEnv } from "./subprocessEnv";
import { isJsonRecord } from "./value";

const DOCX_LIMIT = 64 * 1024 * 1024;
const PDF_LIMIT = 256 * 1024 * 1024;
const JOB_ID = /^[0-9a-f]{32}$/;
const REQUEST_TIMEOUT_MS = 30_000;

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

export type AuthoritiesResponse = {
  status: number;
  body?: unknown;
  file?: string;
  name?: string;
  contentType?: string;
};

type Pending = {
  resolve: (value: AuthoritiesResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<ChildProcessWithoutNullStreams> | null = null;
let inbox = "";
let nextRequestId = 1;
const pending = new Map<number, Pending>();

function tableOfAuthoritiesProjectDirectory() {
  const configured = process.env.TOA_MAKER_DIR?.trim();
  if (configured) return path.resolve(configured);
  const fromBackend = path.resolve(process.cwd(), "..", "AuthoritiesHelper");
  if (existsSync(path.join(fromBackend, "toa_web.py"))) return fromBackend;
  return path.resolve(process.cwd(), "AuthoritiesHelper");
}

function stopWorker(reason: string) {
  const current = worker;
  worker = null;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
  pending.clear();
  if (current && current.exitCode === null) current.kill();
  const oldInbox = inbox;
  inbox = "";
  if (oldInbox) void rm(oldInbox, { recursive: true, force: true });
}

export function shutdownTableOfAuthorities() {
  stopWorker("Beaver is shutting down.");
}

async function startWorker() {
  if (worker?.exitCode === null) return worker;
  if (starting) return starting;
  starting = createWorker();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function createWorker() {
  const directory = tableOfAuthoritiesProjectDirectory();
  const script = path.join(directory, "toa_web.py");
  const bootstrap = path.join(directory, "bootstrap.py");
  if (!existsSync(script)) throw new Error(`Authorities Helper was not found at ${script}`);
  inbox = await mkdtemp(path.join(tmpdir(), "beaver-authorities-"));
  const args = existsSync(bootstrap)
    ? [bootstrap, "--stdio", "--inbox", inbox]
    : ["-X", "utf8", script, "--stdio", "--inbox", inbox];
  const child = spawn(process.env.TOA_PYTHON?.trim() || "python", args, {
    cwd: directory,
    env: isolatedProcessEnv([
      "TOA_*", "LEGALPDF_*", "MIKE_DOCX_*", "OPEN_LEGAL_DATA_HOME",
      "CODEX_HOME", "TESSDATA_PREFIX", "PYTHONPATH", "VIRTUAL_ENV",
    ]),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  worker = child;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!isJsonRecord(value) || typeof value.id !== "number") return;
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (typeof value.status !== "number") {
        request.reject(new Error("Authorities Helper returned an invalid response."));
        return;
      }
      request.resolve({
        status: value.status,
        body: value.body,
        file: typeof value.file === "string" ? value.file : undefined,
        name: typeof value.name === "string" ? value.name : undefined,
        contentType: typeof value.content_type === "string" ? value.content_type : undefined,
      });
    } catch {
      stopWorker("Authorities Helper returned an invalid response.");
    }
  });
  child.once("error", () => stopWorker("Authorities Helper could not be started."));
  child.once("exit", () => stopWorker("Authorities Helper stopped unexpectedly."));
  child.stderr.resume();
  return child;
}

export async function requestTableOfAuthorities(
  userId: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  requestPath: string,
  options: { body?: unknown; upload?: Buffer | Readable } = {},
) {
  const child = await startWorker();
  const workerInbox = inbox;
  if (!workerInbox || worker !== child) throw new Error("Authorities Helper is unavailable.");
  const id = nextRequestId++;
  let upload = "";
  if (options.upload) {
    upload = path.join(workerInbox, `${id}-${crypto.randomUUID()}.upload`);
    try {
      if (Buffer.isBuffer(options.upload)) {
        await writeFile(upload, options.upload, { flag: "wx", mode: 0o600 });
      } else {
        await pipeline(options.upload, createWriteStream(upload, { flags: "wx", mode: 0o600 }));
      }
    } catch (error) {
      await rm(upload, { force: true });
      throw error;
    }
  }
  const response = new Promise<AuthoritiesResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Authorities Helper request timed out."));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
  });
  const message: Record<string, unknown> = {
    id, method, path: requestPath, scope: sha256(userId),
  };
  if ("body" in options) message.body = options.body;
  if (upload) message.upload = upload;
  child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
    if (!error) return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    request.reject(error);
  });
  return response;
}

function boundedText(value: unknown, maximum = 500) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function normalizeJob(payload: unknown): TableOfAuthoritiesJob {
  if (!isJsonRecord(payload)) throw new Error("Authorities Helper returned an invalid job.");
  const id = boundedText(payload.id, 32);
  if (!JOB_ID.test(id)) throw new Error("Authorities Helper returned an invalid job id.");
  const files = Array.isArray(payload.files) ? payload.files.slice(0, 50).flatMap((value) => {
    if (!isJsonRecord(value)) return [];
    const relativeUrl = boundedText(value.url, 2_000);
    if (!relativeUrl.startsWith(`/api/jobs/${id}/files/`)) return [];
    return [{
      name: boundedText(value.name, 200),
      size: typeof value.size === "number" && Number.isFinite(value.size)
        ? Math.max(0, Math.trunc(value.size)) : 0,
      url: `/api/table-of-authorities/workspace${relativeUrl.slice(4)}`,
    }];
  }) : [];
  const projectId = boundedText(payload.project_id, 80);
  return {
    id,
    state: boundedText(payload.state, 40),
    operation: boundedText(payload.operation, 80),
    progress: typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.min(100, Math.max(0, Math.trunc(payload.progress))) : 0,
    message: boundedText(payload.message),
    error: boundedText(payload.error, 1_000),
    has_review: payload.has_review === true,
    split_fallback: payload.split_fallback === "auto" ? "auto" : "off",
    files,
    project_id: projectId,
    app_url: appUrl({ kind: "authorities", jobId: id, projectId: projectId || null }),
  };
}

function responseError(response: AuthoritiesResponse) {
  if (isJsonRecord(response.body) && typeof response.body.error === "string") {
    return response.body.error.slice(0, 500);
  }
  return `Authorities Helper request failed (${response.status}).`;
}

export async function submitTableOfAuthoritiesDocument(params: {
  userId: string;
  bytes: Buffer;
  filename: string;
  splitFallback?: "off" | "auto";
  projectId?: string | null;
}) {
  const filename = path.basename(params.filename).slice(0, 180);
  const pdf = filename.toLowerCase().endsWith(".pdf");
  if (!pdf && !filename.toLowerCase().endsWith(".docx")) {
    throw new Error("Authorities Helper requires a Word or PDF Library version.");
  }
  const limit = pdf ? PDF_LIMIT : DOCX_LIMIT;
  if (!params.bytes.byteLength || params.bytes.byteLength > limit) {
    throw new Error(`Authorities Helper accepts ${pdf ? "PDF files up to 256 MB" : "Word files up to 64 MB"}.`);
  }
  const query = new URLSearchParams({
    filename,
    split_fallback: params.splitFallback === "auto" ? "auto" : "off",
  });
  if (params.projectId?.trim()) query.set("project", params.projectId.trim());
  const response = await requestTableOfAuthorities(params.userId, "POST", `/api/jobs?${query}`, {
    upload: params.bytes,
  });
  if (response.status < 200 || response.status >= 300) throw new Error(responseError(response));
  return normalizeJob(response.body);
}

export async function getTableOfAuthoritiesJob(userId: string, jobId: string) {
  if (!JOB_ID.test(jobId)) throw new Error("A valid Authorities Helper job ID is required.");
  const response = await requestTableOfAuthorities(userId, "GET", `/api/jobs/${jobId}`);
  if (response.status < 200 || response.status >= 300) throw new Error(responseError(response));
  return normalizeJob(response.body);
}
