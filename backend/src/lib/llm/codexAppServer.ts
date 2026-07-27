import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { legalDataHome } from "../legalDataPath";
import {
  CODEX_THREAD_ID,
  CODEX_TIMEOUT_MS,
  buildCodexPrompt,
  codexAbortError,
  codexCommand,
  codexStreamCallbacks,
  normalizeCodexUsage,
  streamCodex,
  terminateProcessTree,
  withCodexImages,
} from "./codex";
import { startCodexToolBridge, type CodexToolBridge } from "./codexToolBridge";
import { codexModelSlug } from "./models";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";
import type {
  NormalizedLlmUsage,
  StreamChatParams,
  StreamChatResult,
} from "./types";

/**
 * `codex exec` re-spawns the CLI every turn (~320-930ms of process init) and
 * emits the assistant message only as one `item.completed` lump, so users wait
 * out the whole generation before seeing a character. `codex app-server` is a
 * persistent JSON-RPC process (newline-delimited JSON, no Content-Length
 * framing) that streams `item/agentMessage/delta` notifications. This adapter
 * keeps one server alive per auth identity and falls back to the exec path
 * whenever the protocol misbehaves, so a Codex CLI upgrade can degrade Beaver
 * chat but never break it. Verified against codex-cli 0.145.0.
 */

type JsonRecord = Record<string, unknown>;
type Notification = { method: string; params: JsonRecord };

/** Synthetic notification announcing that the child is gone. */
const CLOSED = "$closed";
/** Local-first Beaver realistically runs one auth identity; cap stray servers. */
const MAX_SERVERS = 2;
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** How long to let an interrupted turn wind down before abandoning it. */
const INTERRUPT_GRACE_MS = 2_000;

/** Turn-level failures (model errors, timeouts) must not be replayed on exec. */
class CodexTurnError extends Error {}

type AppServer = {
  child: ChildProcessWithoutNullStreams;
  request: <T>(method: string, params?: unknown) => Promise<T>;
  listeners: Set<(notification: Notification) => void>;
  /** Bridge bearer token baked into this child's env at spawn. */
  bridgeToken: string;
  alive: () => boolean;
};

const servers = new Map<string, Promise<AppServer>>();
let fallbackLogged = false;
let versionLogged = false;

function withTimeout<T>(work: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * `codex app-server` has no `--ignore-user-config`, so an isolated CODEX_HOME is
 * the only way to keep the operator's `config.toml` MCP servers, hooks, and
 * plugins out of Beaver turns (the exec path passes `--ignore-user-config`).
 * Auth still resolves from CODEX_HOME, so mirror the CLI login into it.
 */
async function isolatedCodexHome(): Promise<string> {
  const home =
    process.env.BEAVER_CODEX_HOME?.trim() ||
    path.join(legalDataHome(), "apps", "mike", "codex-home");
  await mkdir(home, { recursive: true });
  const source = path.join(
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
    "auth.json",
  );
  const target = path.join(home, "auth.json");
  if (path.resolve(source) !== path.resolve(target)) {
    await copyFile(source, target).catch(() => undefined);
  }
  return home;
}

async function startServer(apiKey: string): Promise<AppServer> {
  const bridgeToken = randomBytes(32).toString("hex");
  const child = spawn(codexCommand(), ["app-server"], {
    cwd: process.cwd(),
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: await isolatedCodexHome(),
      MIKE_CODEX_BRIDGE_TOKEN: bridgeToken,
      ...(apiKey ? { CODEX_API_KEY: apiKey } : {}),
    },
  }) as ChildProcessWithoutNullStreams;

  let nextId = 1;
  let stderr = "";
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >();
  const listeners = new Set<(notification: Notification) => void>();
  const write = (message: unknown) => {
    if (!closed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  // Dead servers stay pooled until `acquireServer` sees `alive() === false`
  // and replaces them, which keeps teardown free of map bookkeeping.
  const shutdown = (reason: string) => {
    if (closed) return;
    closed = true;
    const detail = stderr.trim().slice(-400);
    const error = new Error(
      `Codex app-server ${reason}${detail ? `: ${detail}` : ""}`,
    );
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const listener of [...listeners]) {
      listener({ method: CLOSED, params: { message: error.message } });
    }
    listeners.clear();
  };

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  child.once("error", (error) => shutdown(`failed to start: ${error.message}`));
  child.once("close", () => shutdown("exited"));

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: JsonRecord;
    try {
      message = JSON.parse(line) as JsonRecord;
    } catch {
      return;
    }
    const id = message.id;
    if (
      typeof id === "number" &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const request = pending.get(id);
      pending.delete(id);
      const failure = message.error as { message?: string } | undefined;
      if (!request) return;
      if (failure) {
        request.reject(new Error(failure.message || "Codex app-server error."));
      } else {
        request.resolve(message.result as never);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (id !== undefined) {
      // Approvals are disabled for Beaver turns; answer any unexpected
      // server-initiated request so a turn cannot stall waiting on us.
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: "Beaver does not service Codex app-server requests.",
        },
      });
      return;
    }
    const notification: Notification = {
      method: message.method,
      params: (message.params as JsonRecord) ?? {},
    };
    for (const listener of [...listeners]) listener(notification);
  });

  const request = <T,>(method: string, params?: unknown) =>
    new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new Error("Codex app-server is not running."));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });

  const server: AppServer = {
    child,
    request,
    listeners,
    bridgeToken,
    alive: () => !closed,
  };

  const handshake = await withTimeout(
    request<{ userAgent?: string }>("initialize", {
      clientInfo: { name: "beaver", title: "Beaver", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }),
    HANDSHAKE_TIMEOUT_MS,
    "Codex app-server handshake timed out.",
  ).catch((error: Error) => {
    terminateProcessTree(child);
    throw error;
  });
  if (typeof handshake?.userAgent !== "string") {
    terminateProcessTree(child);
    throw new Error("Codex app-server handshake returned an unexpected shape.");
  }
  if (!versionLogged) {
    versionLogged = true;
    console.info(`[codex-app-server] connected (${handshake.userAgent}).`);
  }
  write({ jsonrpc: "2.0", method: "initialized", params: {} });
  return server;
}

async function acquireServer(apiKey: string): Promise<AppServer> {
  const existing = servers.get(apiKey);
  if (existing) {
    const server = await existing.catch(() => null);
    if (server?.alive()) return server;
    if (servers.get(apiKey) === existing) servers.delete(apiKey);
  }
  for (const [key, pooled] of servers) {
    if (servers.size < MAX_SERVERS) break;
    servers.delete(key);
    void pooled.then(
      (server) => terminateProcessTree(server.child),
      () => undefined,
    );
  }
  const started = startServer(apiKey);
  servers.set(apiKey, started);
  started.catch(() => {
    if (servers.get(apiKey) === started) servers.delete(apiKey);
  });
  return started;
}

/** Releases every pooled app-server. Used by scripts, tests, and shutdown. */
export async function shutdownCodexAppServers(): Promise<void> {
  const pooled = [...servers.values()];
  servers.clear();
  await Promise.all(
    pooled.map((server) =>
      server.then(
        (running) => terminateProcessTree(running.child),
        () => undefined,
      ),
    ),
  );
}

function turnUsage(tokenUsage: unknown): NormalizedLlmUsage | undefined {
  const last = (tokenUsage as { last?: JsonRecord } | undefined)?.last;
  if (!last) return undefined;
  return normalizeCodexUsage({
    input_tokens: last.inputTokens,
    cached_input_tokens: last.cachedInputTokens,
    cache_write_input_tokens: last.cacheWriteInputTokens,
    output_tokens: last.outputTokens,
    reasoning_output_tokens: last.reasoningOutputTokens,
  });
}

async function runTurn(
  params: StreamChatParams,
  prompt: string,
  imagePaths: string[],
  progress: { streamed: boolean },
): Promise<StreamChatResult> {
  if (params.abortSignal?.aborted) throw codexAbortError();
  const continuationId = params.providerSession?.continuationId;
  if (continuationId && !CODEX_THREAD_ID.test(continuationId)) {
    throw new Error("Invalid Codex continuation ID.");
  }
  const persist = Boolean(params.providerSession?.persist);
  const modelSlug = codexModelSlug(params.model);
  const effort =
    params.reasoningEffort?.trim() ||
    (params.enableThinking ? "max" : undefined);
  const { callbacks, endReasoning } = codexStreamCallbacks(params);
  const recorder = createRawLlmStreamRecorder({
    provider: "codex-app-server",
    model: params.model,
  });
  const server = await acquireServer(params.apiKeys?.codex?.trim() || "");

  let bridge: CodexToolBridge | null = null;
  if (params.tools?.length && params.runTools) {
    bridge = await startCodexToolBridge({
      tools: params.tools,
      runTools: params.runTools,
      // A dispatched tool call is a side effect; it disqualifies exec replay.
      callbacks: {
        ...callbacks,
        onToolCallStart: (call) => {
          progress.streamed = true;
          callbacks.onToolCallStart(call);
        },
      },
      abortSignal: params.abortSignal,
      maxToolCalls: Math.max(1, params.maxIterations ?? 10),
      // The child reads MIKE_CODEX_BRIDGE_TOKEN from the env it was spawned
      // with, so per-turn bridges must pin that token rather than mint one.
      token: server.bridgeToken,
    });
  }

  let threadId = "";
  let turnId = "";
  let fullText = "";
  let usage: NormalizedLlmUsage | undefined;
  let failure = "";
  const streamedByItem = new Map<string, string>();

  let settle!: { resolve: () => void; reject: (error: Error) => void };
  const completion = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  completion.catch(() => undefined);

  const listener = (notification: Notification) => {
    if (notification.method === CLOSED) {
      settle.reject(new Error(String(notification.params.message)));
      return;
    }
    const event = notification.params;
    if (typeof event.threadId === "string" && event.threadId !== threadId) return;
    recorder?.record({
      iteration: 0,
      label: notification.method,
      payload: event,
    });
    logRawLlmStream({
      provider: "codex-app-server",
      model: params.model,
      iteration: 0,
      label: notification.method,
      payload: event,
    });
    switch (notification.method) {
      case "item/agentMessage/delta": {
        const delta = String(event.delta ?? "");
        if (!delta) return;
        const itemId = String(event.itemId ?? "");
        streamedByItem.set(itemId, (streamedByItem.get(itemId) ?? "") + delta);
        fullText += delta;
        progress.streamed = true;
        callbacks.onContentDelta(delta);
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const delta = String(event.delta ?? "");
        if (!delta || !params.enableThinking) return;
        // Reasoning reaches the caller and is persisted as transcript
        // events, so it too disqualifies exec replay — a fallback here
        // would duplicate the thinking block in the saved chat.
        progress.streamed = true;
        callbacks.onReasoningDelta(delta);
        return;
      }
      case "item/completed": {
        const item = event.item as
          | { type?: string; id?: string; text?: string }
          | undefined;
        if (item?.type === "reasoning") callbacks.onReasoningBlockEnd();
        if (item?.type !== "agentMessage" || typeof item.text !== "string") return;
        // Deltas are the streaming path; only reconcile what they missed.
        const seen = streamedByItem.get(String(item.id ?? "")) ?? "";
        const remainder = item.text.startsWith(seen)
          ? item.text.slice(seen.length)
          : seen
            ? ""
            : item.text;
        if (!remainder) return;
        fullText += remainder;
        progress.streamed = true;
        callbacks.onContentDelta(remainder);
        return;
      }
      case "thread/tokenUsage/updated":
        usage = turnUsage(event.tokenUsage) ?? usage;
        return;
      case "error":
        if (event.willRetry !== true) {
          failure = String(
            (event.error as { message?: string } | undefined)?.message ?? failure,
          );
        }
        return;
      case "turn/completed": {
        const turn = event.turn as
          | { status?: string; error?: { message?: string } }
          | undefined;
        if (turn?.status === "completed") settle.resolve();
        else if (turn?.status === "interrupted") settle.reject(codexAbortError());
        else {
          settle.reject(
            new CodexTurnError(
              turn?.error?.message || failure || "Codex turn failed.",
            ),
          );
        }
        return;
      }
      default:
    }
  };

  const interruptTurn = () => {
    void server
      .request("turn/interrupt", { threadId, turnId })
      .catch(() => terminateProcessTree(server.child));
  };
  const onAbort = () => {
    interruptTurn();
    setTimeout(() => settle.reject(codexAbortError()), INTERRUPT_GRACE_MS);
  };
  const timer = setTimeout(() => {
    interruptTurn();
    settle.reject(new CodexTurnError("Codex app-server turn timed out."));
  }, CODEX_TIMEOUT_MS);

  server.listeners.add(listener);
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const threadParams = {
      ...(modelSlug ? { model: modelSlug } : {}),
      sandbox: "read-only",
      approvalPolicy: "never",
      cwd: process.cwd(),
      config: {
        ...(bridge
          ? {
              mcp_servers: {
                mike_runtime: {
                  url: bridge.url,
                  bearer_token_env_var: "MIKE_CODEX_BRIDGE_TOKEN",
                  required: true,
                  default_tools_approval_mode: "auto",
                  startup_timeout_sec: 10,
                  tool_timeout_sec: 180,
                },
              },
            }
          : {}),
        ...(params.enableThinking
          ? { model_reasoning_summary: "auto", show_raw_agent_reasoning: false }
          : {}),
      },
    };
    const opened = continuationId
      ? await server.request<{ thread?: { id?: string } }>("thread/resume", {
          threadId: continuationId,
          ...threadParams,
        })
      : await server.request<{ thread?: { id?: string } }>("thread/start", {
          ...threadParams,
          ephemeral: !persist,
        });
    threadId = opened?.thread?.id ?? "";
    if (!CODEX_THREAD_ID.test(threadId)) {
      throw new Error("Codex app-server returned an unexpected thread ID.");
    }

    const started = await server.request<{ turn?: { id?: string } }>(
      "turn/start",
      {
        threadId,
        input: [
          { type: "text", text: prompt, text_elements: [] },
          ...imagePaths.map((imagePath) => ({
            type: "localImage",
            path: imagePath,
          })),
        ],
        ...(modelSlug ? { model: modelSlug } : {}),
        ...(effort ? { effort } : {}),
        summary: params.enableThinking ? "auto" : "none",
      },
    );
    turnId = started?.turn?.id ?? "";

    await completion;
    endReasoning();
    if (!fullText.trim()) {
      throw new CodexTurnError(
        failure || "Codex app-server returned no response.",
      );
    }
    return {
      fullText,
      ...(usage ? { usage } : {}),
      providerInvocationId: threadId,
      ...(persist ? { continuationId: threadId } : {}),
    };
  } finally {
    clearTimeout(timer);
    params.abortSignal?.removeEventListener("abort", onAbort);
    server.listeners.delete(listener);
    endReasoning();
    await bridge?.close();
    await recorder?.flush(fullText ? "completed" : "error");
    if (threadId && server.alive()) {
      // Release the loaded thread so a long-lived server does not accumulate
      // conversations; persisted threads still resume from disk by id.
      void server
        .request("thread/unsubscribe", { threadId })
        .catch(() => undefined);
    }
  }
}

export async function streamCodexAppServer(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  if (process.env.BEAVER_CODEX_EXEC === "1") return streamCodex(params);
  const progress = { streamed: false };
  try {
    return await withCodexImages(params.messages, (imagePaths) =>
      runTurn(params, buildCodexPrompt(params), imagePaths, progress),
    );
  } catch (error) {
    const aborted =
      params.abortSignal?.aborted ||
      (error as { name?: string })?.name === "AbortError";
    // Replaying on exec is only safe while nothing escaped this turn: no tokens
    // reached the caller and no tool call ran. Model-side failures are real
    // answers about the turn, so they propagate instead of costing a second run.
    if (aborted || progress.streamed || error instanceof CodexTurnError) throw error;
    if (!fallbackLogged) {
      fallbackLogged = true;
      console.warn("[codex-app-server] Unavailable; using `codex exec`.", error);
    }
    return streamCodex(params);
  }
}
