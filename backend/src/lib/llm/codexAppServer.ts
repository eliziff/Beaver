import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { isolatedProcessEnv } from "../subprocessEnv";

type JsonObject = Record<string, unknown>;
export type CodexAppServerNotification = {
  method: string;
  params: JsonObject;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 20_000;
export const CODEX_APP_SERVER_CLOSED = "$closed";

export type CodexAppServer = {
  bridgeToken: string;
  codexHome: string;
  request<T>(method: string, params?: unknown): Promise<T>;
  subscribe(listener: (event: CodexAppServerNotification) => void): () => void;
  alive(): boolean;
  stop(): void;
};

export function beaverCodexHome() {
  return (
    process.env.BEAVER_CODEX_HOME?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    path.join(os.homedir(), ".codex")
  );
}

function terminate(child: ChildProcessWithoutNullStreams) {
  if (process.platform !== "win32" || !child.pid) {
    child.kill();
    return;
  }
  const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", () => child.kill());
  killer.unref();
}

async function launch(apiKey: string): Promise<CodexAppServer> {
  const codexHome = path.resolve(beaverCodexHome());
  await mkdir(codexHome, { recursive: true });
  const bridgeToken = randomBytes(32).toString("hex");
  const child = spawn(
    process.env.CODEX_COMMAND?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex"),
    [
      "-c",
      "features.code_mode=false",
      "app-server",
      "--stdio",
      "--strict-config",
    ], {
    cwd: os.tmpdir(),
    env: {
      ...isolatedProcessEnv([
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS", "OPENAI_BASE_URL",
      ]),
      CODEX_HOME: codexHome,
      MIKE_CODEX_BRIDGE_TOKEN: bridgeToken,
      ...(apiKey ? { CODEX_API_KEY: apiKey } : {}),
    },
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  let nextId = 1;
  let closed = false;
  let stderr = "";
  const pending = new Map<number, PendingRequest>();
  const listeners = new Set<(event: CodexAppServerNotification) => void>();
  const write = (message: unknown) => {
    if (closed) throw new Error("Codex app-server is not running.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    const detail = stderr.trim().slice(-1_000);
    const error = new Error(
      `Codex app-server ${reason}${detail ? `: ${detail}` : ""}`,
    );
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const listener of listeners) {
      listener({ method: CODEX_APP_SERVER_CLOSED, params: { message: error.message } });
    }
    listeners.clear();
  };

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  child.once("error", (error) => close(`failed to start: ${error.message}`));
  child.once("close", (code) => close(`exited${code === null ? "" : ` (${code})`}`));

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      close("sent invalid JSON");
      terminate(child);
      return;
    }
    const id = message.id;
    if (typeof id === "number" && ("result" in message || "error" in message)) {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      const failure = message.error as { message?: unknown } | undefined;
      if (failure) {
        request.reject(
          new Error(
            typeof failure.message === "string"
              ? failure.message
              : "Codex app-server request failed.",
          ),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (id !== undefined) {
      // Beaver turns cannot execute Codex shell/file tools and never delegate
      // approval or credential decisions to this headless transport.
      write({
        id,
        error: {
          code: -32601,
          message: "This Codex app-server request is not available in Beaver.",
        },
      });
      return;
    }
    const event = {
      method: message.method,
      params:
        message.params && typeof message.params === "object"
          ? (message.params as JsonObject)
          : {},
    };
    for (const listener of listeners) listener(event);
  });

  const request = <T,>(method: string, params?: unknown) =>
    new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new Error("Codex app-server is not running."));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        const error = new Error(`Codex app-server ${method} request timed out.`);
        reject(error);
        close(`${method} request timed out`);
        terminate(child);
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      write({ id, method, params: params ?? {} });
    });

  const initialized = await request<{ userAgent?: unknown; codexHome?: unknown }>(
    "initialize",
    {
      clientInfo: { name: "beaver", title: "Beaver", version: "1.0.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    },
  ).catch((error) => {
    terminate(child);
    throw error;
  });
  if (
    typeof initialized.userAgent !== "string" ||
    path.resolve(String(initialized.codexHome)) !== codexHome
  ) {
    terminate(child);
    throw new Error("Codex app-server returned an incompatible initialize response.");
  }
  write({ method: "initialized", params: {} });

  return {
    bridgeToken,
    codexHome,
    request,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    alive: () => !closed,
    stop: () => terminate(child),
  };
}

const servers = new Map<string, Promise<CodexAppServer>>();

export async function acquireCodexAppServer(apiKey = "") {
  const key = apiKey
    ? createHash("sha256").update(apiKey).digest("hex")
    : "subscription";
  const existing = servers.get(key);
  if (existing) {
    const server = await existing.catch(() => null);
    if (server?.alive()) return server;
    if (servers.get(key) === existing) servers.delete(key);
    return acquireCodexAppServer(apiKey);
  }
  const started = launch(apiKey);
  servers.set(key, started);
  started.catch(() => {
    if (servers.get(key) === started) servers.delete(key);
  });
  return started;
}

export async function shutdownCodexAppServers() {
  const active = [...servers.values()];
  servers.clear();
  await Promise.all(active.map((server) => server.then((value) => value.stop(), () => undefined)));
}
