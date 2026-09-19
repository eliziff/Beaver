import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedProcessEnv } from "./subprocessEnv";

const MAX_BYTES = 100 * 1024 * 1024;
const worker = path.resolve(__dirname, "../../scripts/word_uno.py");
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export type UnoResult = { report: Record<string, unknown>; candidate?: Buffer };

/** One owned batch, no shell, listener, credentials, executable model code or warm tenant state. */
export async function runLibreOffice(bytes: Buffer, request: Record<string, unknown>,
  signal: AbortSignal): Promise<UnoResult> {
  signal.throwIfAborted();
  if (process.platform !== "linux") throw new Error("The UNO worker is currently qualified on Linux only");
  const input = JSON.stringify(request);
  if (!bytes.length || bytes.length > MAX_BYTES || Buffer.byteLength(input) > 262144)
    throw new Error("Word input exceeds the worker limit");
  const directory = await mkdtemp(path.join(os.tmpdir(), "beaver-word-"));
  const source = path.join(directory, "source.docx"), output = path.join(directory, "candidate.docx");
  try {
    await writeFile(source, bytes, { mode: 0o600, flag: "wx" });
    const report = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const binary = process.env.WORD_UNO_PYTHON || "/usr/bin/python3";
      const args = ["-I", worker, source, "--output", output];
      const soffice = process.env.SOFFICE_BINARY_PATH || process.env.LIBREOFFICE_BINARY_PATH || process.env.LIBRE_OFFICE_EXE;
      if (soffice) args.push("--soffice", soffice);
      const child = spawn(binary, args, { cwd: directory, windowsHide: true, detached: true,
        env: { ...isolatedProcessEnv(["SAL_*", "URE_*"]), HOME: directory,
          XDG_CACHE_HOME: directory, XDG_CONFIG_HOME: directory, BEAVER_UNO_OWNED_GROUP: "1" },
        stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const killGroup = () => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      };
      const stop = (message: string) => {
        if (failure) return;
        failure = new Error(message);
        child.kill("SIGTERM"); // Python's finally closes its owned office process.
        killTimer = setTimeout(killGroup, 5000);
        killTimer.unref();
      };
      const abort = () => stop("Word operation cancelled");
      const timeout = setTimeout(() => stop("Word operation timed out"), 120000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        if (stdout.length + text.length > 262144) stop("Word result exceeds the worker limit");
        else stdout += text;
      });
      child.stderr.on("data", (text: string) => { stderr = (stderr + text).slice(0, 4000); });
      child.stdin.on("error", () => {}); // An early process exit is handled by close/error below.
      child.on("error", () => { failure ??= new Error("Python/UNO is unavailable; configure WORD_UNO_PYTHON"); });
      child.on("close", (code) => {
        clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        if (failure) { killGroup(); return reject(failure); }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          const value = parsed as Record<string, unknown>;
          if (code !== 0 || value.ok !== true) return reject(new Error(
            typeof value.error === "string" ? value.error.slice(0, 1000) : "Word worker failed"));
          resolve(value);
        } catch {
          reject(new Error(stderr.includes("No module named 'uno'")
            ? "Python cannot import UNO; install python3-uno or configure WORD_UNO_PYTHON"
            : "Word worker returned an invalid result"));
        }
      });
      child.stdin.end(input);
    });
    signal.throwIfAborted();
    if (report.snapshot !== hash(bytes)) throw new Error("Word receipt does not match the source");
    if (request.action !== "preview") return { report };
    const candidate = await readFile(output);
    if (!candidate.length || candidate.length > MAX_BYTES || report.candidate_sha256 !== hash(candidate)
      || report.reopened !== true) throw new Error("Word candidate did not pass export/reopen checks");
    return { report, candidate };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
