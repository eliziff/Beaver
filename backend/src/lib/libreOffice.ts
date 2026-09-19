import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { isolatedProcessEnv } from "./subprocessEnv";
import { resolveUnoRuntime, UNO_BOOTSTRAP } from "./libreOfficeRuntime";

const exec = promisify(execFile);
const MAX_BYTES = 100 * 1024 * 1024;
const worker = path.resolve(__dirname, "../../scripts/word_uno.py");
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export type UnoResult = { report: Record<string, unknown>; candidate?: Buffer };

/** Same native gateway on Windows/macOS/Linux; optional OCI isolation for cloud.
 * A draft is never published here. The application owns exact-byte publication.
 */
export async function runLibreOffice(bytes: Buffer, request: Record<string, unknown>,
  signal: AbortSignal): Promise<UnoResult> {
  signal.throwIfAborted();
  const scripted = typeof request.program === "string" || request.action === "preview";
  const program = typeof request.program === "string" ? request.program :
    `return word.batch(${JSON.stringify(request.operations)});`;
  const wire: Record<string, unknown> = { ...request, ...(scripted ? { action: "console", read_only: request.action !== "preview" } : {}) };
  delete wire.program;
  const input = JSON.stringify(wire);
  if (!bytes.length || bytes.length > MAX_BYTES || Buffer.byteLength(input) > 262144)
    throw new Error("Word input exceeds the worker limit");
  const directory = await mkdtemp(path.join(os.tmpdir(), "beaver-word-"));
  const source = path.join(directory, "source.docx"), output = path.join(directory, "candidate.docx");
  const image = process.env.WORD_UNO_CONTAINER_IMAGE;
  const container = "beaver-word-" + randomUUID();
  const containerRuntime = process.env.WORD_UNO_CONTAINER_RUNTIME || "docker";
  let cleanupContainer = false;
  try {
    await writeFile(source, bytes, { mode: 0o600, flag: "wx" });
    const runtime = image ? undefined : await resolveUnoRuntime();
    signal.throwIfAborted();
    const command = image ? containerRuntime : runtime!.python;
    const args = image ? ["run", "--rm", "-i", "--name", container, "--network=none", "--read-only",
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=2g", "--cpus=1",
      "--user", `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--mount", `type=bind,src=${directory},dst=/work`,
      image, "/usr/bin/python3", "-I", "-c", UNO_BOOTSTRAP, JSON.stringify(["/app"]),
      "/app/word_uno.py", "/work/source.docx", "--output", "/work/candidate.docx"] :
      ["-I", "-c", UNO_BOOTSTRAP, JSON.stringify([path.dirname(worker), ...runtime!.modulePaths]),
        worker, source, "--output", output, "--soffice", runtime!.soffice];
    cleanupContainer = !!image;
    const report = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(command, args, { cwd: directory, windowsHide: true, detached: process.platform !== "win32",
        env: image ? isolatedProcessEnv(["DOCKER_HOST", "CONTAINER_HOST"]) : {
          ...runtime!.env, HOME: directory, XDG_CACHE_HOME: directory, XDG_CONFIG_HOME: directory,
          BEAVER_UNO_OWNED_GROUP: "1" }, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "", final: Record<string, unknown> | undefined, failure: Error | undefined;
      const programStop = new AbortController();
      const programSignal = AbortSignal.any([signal, programStop.signal]);
      let consoleValue: unknown, running: Promise<void> | undefined, sequence = 0;
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killTree = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          void exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }).catch(() => {});
        } else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
      };
      const stop = (error: Error) => {
        if (failure) return;
        failure = error; programStop.abort();
        for (const promise of pending.values()) promise.reject(error);
        pending.clear();
        child.kill("SIGTERM");
        killTimer = setTimeout(killTree, 3000); killTimer.unref();
      };
      const abort = () => stop(new Error("Word operation cancelled"));
      const timer = setTimeout(() => stop(new Error("Word operation timed out")), 120000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const rpc = (value: Record<string, unknown>) => new Promise<unknown>((res, rej) => {
        if (failure) return rej(failure);
        const id = ++sequence;
        pending.set(id, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify({ ...value, id }) + "\n");
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) => { stderr = (stderr + text).slice(-4000); });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      // readline alone does not cap an unterminated line. Bound all worker output too.
      let received = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > 32 * 1024 * 1024) stop(new Error("Word session output budget exceeded"));
      });
      lines.on("line", (text) => {
        try {
          if (Buffer.byteLength(text) > 262144) throw new Error("Word result exceeds limit");
          const value = JSON.parse(text) as Record<string, unknown>;
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Word result");
          if (value.rpc === "ready") {
            if (!scripted || running) throw new Error("Unexpected console handshake");
            if (value.snapshot !== hash(bytes)) throw new Error("Console opened a different source");
            running = (async () => {
              const { executeWordProgram } = await import("./libreOfficeConsole");
              consoleValue = await executeWordProgram(program, rpc, programSignal);
              if (!failure) child.stdin.end('{"op":"finish"}\n');
            })().catch(error => stop(error instanceof Error ? error : new Error("Word program failed")));
          } else if (value.rpc === "result") {
            const promise = pending.get(Number(value.id));
            if (!promise) throw new Error("Unknown console response");
            pending.delete(Number(value.id));
            if (typeof value.error === "string") promise.reject(new Error(value.error));
            else promise.resolve(value.value);
          } else {
            if (final) throw new Error("Duplicate final receipt");
            final = value;
          }
        } catch (error) { stop(error instanceof Error ? error : new Error("Invalid Word result")); }
      });
      child.stdin.on("error", () => {});
      child.on("error", () => stop(new Error("The Word runtime could not start")));
      child.on("close", async code => {
        clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", abort); lines.close();
        for (const promise of pending.values()) promise.reject(new Error("Word runtime disconnected"));
        pending.clear();
        if (!final || code !== 0) programStop.abort();
        await running;
        if (failure) { killTree(); return reject(failure); }
        if (code !== 0 || !final || final.ok !== true) return reject(new Error(
          typeof final?.error === "string" ? final.error.slice(0, 1000) :
            stderr.includes("No module named") ? "LibreOffice Python components are unavailable" : "Word worker did not complete"));
        resolve({ ...final, ...(scripted ? { result: consoleValue } : {}),
          isolation: image ? "oci-networkless" : "document-capabilities", platform: process.platform });
      });
      if (scripted) child.stdin.write(input + "\n");
      else child.stdin.end(input + "\n");
    });
    signal.throwIfAborted();
    if (report.snapshot !== hash(bytes)) throw new Error("Word receipt does not match the source");
    if (request.action !== "preview") return { report };
    const stat = await lstat(output);
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error("Invalid Word candidate size/type");
    const candidate = await readFile(output);
    if (report.candidate_sha256 !== hash(candidate) || report.reopened !== true)
      throw new Error("Word candidate did not pass export/reopen checks");
    return { report, candidate };
  } finally {
    if (cleanupContainer) await exec(containerRuntime, ["rm", "-f", container],
      { timeout: 10000, windowsHide: true, env: isolatedProcessEnv(["DOCKER_HOST", "CONTAINER_HOST"]) }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
