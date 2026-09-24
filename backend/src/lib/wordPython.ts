import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSofficeBinary } from "./convert";
import { isolatedProcessEnv } from "./subprocessEnv";

type Report = Record<string, unknown>;
export type WordResult = { report: Report; candidate?: Buffer };

const SCRIPTS = path.resolve(__dirname, "../../scripts/word_python");
const MAX_BYTES = 100 * 1024 * 1024;
const windows = process.platform === "win32";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const image = () => process.env.WORD_PYTHON_CONTAINER_IMAGE?.trim();
const containerRuntime = () => process.env.WORD_PYTHON_CONTAINER_RUNTIME?.trim() || "docker";
const containerEnv = () => isolatedProcessEnv(["DOCKER_HOST", "CONTAINER_HOST"]);
export const wordPython = () => process.env.BEAVER_WORD_PYTHON?.trim() || process.env.BEAVER_PYTHON?.trim() ||
  (windows ? "python" : "python3");

let probed: { python: string; ready: Promise<void> } | undefined;
/** probe.py accepts only an interpreter with requirements.txt installed exactly; failures are retried. */
function checkPython(python: string): Promise<void> {
  if (probed?.python === python) return probed.ready;
  const ready = new Promise<void>((resolve, reject) => execFile(python, ["-I", "-B", path.join(SCRIPTS, "probe.py")],
    { env: isolatedProcessEnv(), windowsHide: true, timeout: 20_000 }, (_error, stdout) => {
      let probe: Report | undefined;
      try { probe = JSON.parse(String(stdout).trim().split(/\r?\n/u).pop() ?? ""); } catch { /* reported below */ }
      if (probe?.ok === true) return resolve();
      reject(new Error(`Word editing is unavailable: ${python} ${typeof probe?.error === "string" ? probe.error : "could not run"}. ` +
        `Install with "${python} -m pip install -r ${path.join(SCRIPTS, "requirements.txt")}" or set BEAVER_WORD_PYTHON.`));
    }));
  probed = { python, ready };
  ready.catch(() => { if (probed?.ready === ready) probed = undefined; });
  return ready;
}

/** One worker process. `dir` is the only host directory it sees: its cwd locally, mounted at /job in a
 * container. Arguments are relative to it. */
type Step = { command: "python" | "soffice"; args: string[]; dir: string; input?: string; sandbox?: boolean; timeoutMs: number };
const script = (name: string) => image() ? `/app/${name}` : path.join(SCRIPTS, name);

function run(step: Step, signal: AbortSignal): Promise<string> {
  const container = image(), name = "beaver-word-" + randomUUID();
  let command: string, args: string[], env: NodeJS.ProcessEnv;
  if (container) {
    command = containerRuntime(); env = containerEnv();
    args = ["run", "--rm", "-i", "--name", name, "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=2g", "--cpus=1",
      "--user", `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--mount", `type=bind,src=${step.dir},dst=/job`, "-w", "/job",
      container, ...(step.command === "python" ? ["python3", "-I", "-B", "-X", "utf8"] : ["soffice"]), ...step.args];
  } else if (step.command === "python") {
    command = wordPython(); args = ["-I", "-B", "-X", "utf8", ...step.args];
    // A model program sees only its directory: no inherited credentials, configuration or PATH.
    env = step.sandbox ? { SYSTEMROOT: process.env.SYSTEMROOT, TEMP: step.dir, TMP: step.dir, TMPDIR: step.dir,
      HOME: step.dir, PATH: "" } : isolatedProcessEnv();
  } else {
    const binary = resolveSofficeBinary();
    if (!binary) throw new Error("LibreOffice is not installed; it verifies that Word candidates open");
    const console = binary.replace(/soffice\.exe$/iu, "soffice.com");
    command = windows && existsSync(console) ? console : binary; args = step.args; env = isolatedProcessEnv(["SAL_*"]);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: step.dir, env, windowsHide: true, detached: !windows && !container,
      stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "", failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      if (container) execFile(containerRuntime(), ["rm", "-f", name], { env: containerEnv(), windowsHide: true, timeout: 10_000 }, () => {});
      if (windows && child.pid) execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else if (child.pid) try { process.kill(container ? child.pid : -child.pid, "SIGKILL"); } catch { /* exited */ }
    };
    const timer = setTimeout(() => stop(new Error("Word program timed out")), step.timeoutMs);
    const abort = () => stop(new Error("Word operation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdout += text;
      if (stdout.length > 4 * 1024 * 1024) stop(new Error("Word program output exceeds limit"));
    });
    child.stdin.on("error", () => {});
    child.on("error", () => stop(new Error(container ? `${containerRuntime()} could not start the Word container`
      : `${command} could not start`)));
    child.on("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (step.command === "soffice" && code !== 0) return reject(new Error("LibreOffice could not open the candidate"));
      resolve(stdout);
    });
    child.stdin.end(step.input ?? "");
  });
}

/** The last stdout line is the worker's JSON reply; program output travels inside it. */
function reply(stdout: string): Report {
  let value: unknown;
  try { value = JSON.parse(stdout.trim().split(/\r?\n/u).pop() ?? ""); } catch { throw new Error("Word worker did not complete"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Word worker reply");
  const report = value as Report;
  if (report.ok !== true) throw new Error(String(report.error ?? "Word worker failed").slice(0, 2000) +
    (typeof report.stdout === "string" && report.stdout ? "\nprogram output: " + report.stdout.slice(-1500) : ""));
  return report;
}

// A LibreOffice profile serves one process at a time; a container gets a fresh one in its /tmp.
let officeQueue: Promise<unknown> = Promise.resolve();
const officeProfile = path.join(os.tmpdir(), `beaver-word-python-office-${process.pid}`);

/** LibreOffice headless must open and lay out the candidate; the page count is its witness. */
function render(dir: string, file: string, signal: AbortSignal): Promise<number> {
  const convert = async () => {
    const profile = image() ? "file:///tmp/office" : pathToFileURL(officeProfile).href;
    await mkdir(path.join(dir, "pdf"));
    await run({ command: "soffice", dir, timeoutMs: 90_000, args: [`-env:UserInstallation=${profile}`, "--headless",
      "--norestore", "--nolockcheck", "--nodefault", "--convert-to", "pdf", "--outdir", "pdf", file] }, signal);
    const pdf = (await readdir(path.join(dir, "pdf"))).find(name => name.endsWith(".pdf"));
    if (!pdf) throw new Error("LibreOffice could not open the candidate");
    return ((await readFile(path.join(dir, "pdf", pdf))).toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/gu) ?? []).length;
  };
  if (image()) return convert();
  const result = officeQueue.then(convert, convert);
  officeQueue = result.catch(() => undefined);
  return result;
}

/** Runs one word_python request: inspect pages the document, a program runs in its own sandboxed process,
 * and a preview candidate is re-screened by a separate verifier and opened by LibreOffice. */
export async function runWordPython(bytes: Buffer, request: Record<string, unknown>, signal: AbortSignal): Promise<WordResult> {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Word input exceeds the worker limit");
  const snapshot = hash(bytes);
  const program = typeof request.program === "string" ? request.program : "";
  if (!image()) await checkPython(wordPython());
  const root = await mkdtemp(path.join(os.tmpdir(), "beaver-word-python-"));
  const work = path.join(root, "work");
  try {
    await writeFile(path.join(root, "source.docx"), bytes, { flag: "wx", mode: 0o600 });
    if (request.action === "inspect" && !program) {
      const view = { offset: request.offset, limit: request.limit, target: request.target };
      const report = reply(await run({ command: "python", args: [script("verify.py"), "inspect", "source.docx"], dir: root,
        input: JSON.stringify(view), timeoutMs: 60_000 }, signal));
      return { report: { ...report, snapshot, mode: "read-only" } };
    }
    const mode = request.action === "preview" ? String(request.mode) : "read-only";
    if (!["tracked", "direct", "read-only"].includes(mode)) throw new Error("Unknown review mode");
    await mkdir(work);
    await writeFile(path.join(work, "document.docx"), bytes, { flag: "wx", mode: 0o600 });
    const ran = reply(await run({ command: "python", args: [script("sandbox.py")], dir: work, sandbox: true,
      input: JSON.stringify({ program, mode }), timeoutMs: 60_000 }, signal));
    const output = { result: ran.result, ...(ran.stdout ? { stdout: ran.stdout } : {}),
      ...(Array.isArray(ran.warnings) && ran.warnings.length ? { warnings: ran.warnings } : {}) };
    if (mode === "read-only") return { report: { ok: true, snapshot, mode, ...output } };
    const produced = path.join(work, "candidate.docx");
    const stat = await lstat(produced).catch(() => null);
    if (!stat?.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error("The program did not produce a valid candidate");
    const candidate = await readFile(produced);
    await writeFile(path.join(root, "checked.docx"), candidate, { flag: "wx" });
    const verified = reply(await run({ command: "python", args: [script("verify.py"), "verify", "source.docx", "checked.docx", mode],
      dir: root, timeoutMs: 60_000 }, signal));
    if (verified.candidate_sha256 !== hash(candidate)) throw new Error("Verified bytes differ from the candidate");
    const pages = await render(root, "checked.docx", signal);
    signal.throwIfAborted();
    return { report: { ok: true, snapshot, ...verified, libreoffice_opened: true, pages, ...output }, candidate };
  } finally {
    // A killed Windows job releases file handles asynchronously.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
