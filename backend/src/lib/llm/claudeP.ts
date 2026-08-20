// claude-p:<model> — Anthropic models over the subscription-authenticated
// Claude Code print transport. Claude Code owns the native MCP agent loop;
// Beaver owns the MCP registry and executes every tool call.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { abortError, throwIfAborted } from "./abort";
import { modelContextWindow } from "./contextWindow";
import { startMcpToolBridge, type McpToolBridge } from "./mcpToolBridge";
import { flattenedPrompt } from "./prompt";
import { isolatedProcessEnv } from "../subprocessEnv";
import type {
  LlmContextRoundReceipt,
  NormalizedLlmUsage,
  StreamCallbacks,
  StreamChatParams,
  StreamChatResult,
} from "./types";

const FIRST_MODEL_EVENT_GRACE_MS = 900_000;
const INACTIVITY_LIMIT_MS = 240_000;
const HARD_LIMIT_MS = 3_600_000;
const MAX_PROVIDER_COMPACTIONS = 3;
const MCP_TOKEN_ENV = "BEAVER_CLAUDE_MCP_TOKEN";
const CLAUDE_SESSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const CLAUDE_MODEL = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;

export type ClaudePFatalCode =
  | "context_overflow"
  | "quota_exhausted"
  | "compaction_limit";

class ClaudePFatalError extends Error {
  constructor(
    message: string,
    public readonly code: ClaudePFatalCode,
  ) {
    super(message);
    this.name = "ClaudePFatalError";
  }
}

function fatalCode(text: string): ClaudePFatalCode | null {
  if (/prompt is too long|blocking_limit/iu.test(text)) return "context_overflow";
  if (/hit your (?:weekly |session )?limit/iu.test(text)) return "quota_exhausted";
  return null;
}

export function claudePModelSlug(model: string): string | null {
  const slug = model.startsWith("claude-p:")
    ? model.slice("claude-p:".length).trim() : "";
  return CLAUDE_MODEL.test(slug) ? slug : null;
}

function resolveCli(): { file: string; shell: boolean } {
  const appData = process.env.APPDATA;
  if (appData) {
    const exe = path.join(
      appData,
      "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    );
    if (existsSync(exe)) return { file: exe, shell: false };
  }
  return { file: "claude", shell: process.platform === "win32" };
}

function authIsolatedEnv(model: string, bridge: McpToolBridge | null) {
  const env = isolatedProcessEnv([
    "CLAUDE_CODE_*", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE",
    "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ]);
  for (const key of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE",
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
    MCP_TOKEN_ENV,
  ]) {
    delete env[key];
  }
  if (model.includes("sonnet") && !env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "64000";
  }
  if (bridge) env[MCP_TOKEN_ENV] = bridge.token;
  return env;
}

type ResultEnvelope = {
  type?: string; is_error?: boolean; result?: string; session_id?: string;
  usage?: Record<string, number | undefined>;
};

type RunState = {
  result: ResultEnvelope | null; fullText: string;
  compactions: number; contentOpen: boolean;
  mcpReady: boolean; mcpError: string;
};

function handleStreamLine(
  line: string,
  state: RunState,
  callbacks: StreamCallbacks,
) {
  let message: ResultEnvelope & {
    subtype?: string;
    mcp_servers?: Array<{ name?: string }>;
    mcp_server_errors?: Array<{ name?: string; message?: string }>;
    event?: {
      type?: string;
      delta?: { type?: string; text?: string };
    };
  };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return false;
  }
  if (message.type === "result") state.result = message;
  if (message.type === "system" && message.subtype === "init") {
    state.mcpReady = message.mcp_servers?.some(({ name }) => name === "beaver") ?? false;
    state.mcpError = message.mcp_server_errors
      ?.map(({ name, message: detail }) => `${name ?? "server"}: ${detail ?? "failed"}`)
      .join("; ") ?? "";
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    state.compactions += 1;
    callbacks.onCompaction?.("completed");
  }

  const event = message.type === "stream_event" ? message.event : undefined;
  if (event?.type === "content_block_delta") {
    if (event.delta?.type === "text_delta" && event.delta.text) {
      state.contentOpen = true;
      state.fullText += event.delta.text;
      callbacks.onContentDelta?.(event.delta.text);
    }
  } else if (event?.type === "content_block_stop") {
    if (state.contentOpen) callbacks.onContentBlockEnd?.();
    state.contentOpen = false;
  }
  return ["assistant", "stream_event", "result"].includes(message.type ?? "") ||
    (message.type === "system" &&
      ["compact_boundary", "api_retry"].includes(message.subtype ?? ""));
}

type RunParams = StreamChatParams & {
  model: string; prompt: string; bridge: McpToolBridge | null;
  callbacks: StreamCallbacks;
};

async function runClaudeP(params: RunParams) {
  const directory = await mkdtemp(path.join(tmpdir(), "beaver-claude-p-"));
  const systemFile = path.join(directory, "system.txt");
  const mcpFile = path.join(directory, "mcp.json");
  const mcpConfig = { mcpServers: params.bridge ? {
    beaver: {
      type: "http",
      url: params.bridge.url,
      headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
    },
  } : {} };
  await Promise.all([
    writeFile(systemFile, params.systemPrompt, { mode: 0o600 }),
    writeFile(mcpFile, JSON.stringify(mcpConfig), { mode: 0o600 }),
  ]);

  const { file, shell } = resolveCli();
  const args = [
    "-p", "--model", params.model,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--mcp-config", mcpFile,
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources", "",
    "--no-chrome",
    "--system-prompt-file", systemFile,
  ];
  if (params.bridge) args.push("--allowedTools", "mcp__beaver");
  if (!params.providerSession?.persist) args.push("--no-session-persistence");
  if (params.providerSession?.continuationId) {
    args.push("--resume", params.providerSession.continuationId);
  }
  if (params.reasoningEffort) args.push("--effort", params.reasoningEffort);
  if (params.maxIterations !== undefined) {
    args.push(
      "--max-turns",
      String(Math.max(1, Math.trunc(params.maxIterations))),
    );
  }

  try {
    return await new Promise<RunState>((resolve, reject) => {
      const child = spawn(file, args, {
        shell,
        cwd: tmpdir(),
        env: authIsolatedEnv(params.model, params.bridge),
        windowsHide: true,
      });
      const state: RunState = {
        result: null,
        fullText: "",
        compactions: 0,
        mcpReady: false,
        mcpError: "",
        contentOpen: false,
      };
      let buffer = "";
      let stderr = "";
      let settled = false;
      let sawActivity = false;
      let lastActivity = Date.now();
      const started = Date.now();
      const inactivityMs =
        params.reasoningEffort === "max"
          ? FIRST_MODEL_EVENT_GRACE_MS
          : INACTIVITY_LIMIT_MS;
      const cleanup = () => {
        clearInterval(watchdog);
        params.abortSignal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        reject(error);
      };
      const onAbort = () => fail(abortError());
      const closeBlocks = () => {
        if (state.contentOpen) params.callbacks.onContentBlockEnd?.();
        state.contentOpen = false;
      };
      const processLine = (line: string) => {
        if (
          handleStreamLine(line.trim(), state, params.callbacks)
        ) {
          sawActivity = true;
          lastActivity = Date.now();
        }
        if (state.result) child.stdin.end();
        if (state.compactions >= MAX_PROVIDER_COMPACTIONS) {
          fail(
            new ClaudePFatalError(
              `claude -p provider compaction limit: ${state.compactions}`,
              "compaction_limit",
            ),
          );
        }
      };
      const watchdog = setInterval(() => {
        const now = Date.now();
        const limit = sawActivity ? inactivityMs : FIRST_MODEL_EVENT_GRACE_MS;
        if (now - lastActivity > limit) {
          fail(new Error(`claude -p silent for ${limit / 1000}s — killed`));
        } else if (now - started > HARD_LIMIT_MS) {
          fail(new Error("claude -p exceeded hard time limit — killed"));
        }
      }, 5_000);

      params.abortSignal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          processLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
        lastActivity = Date.now();
      });
      child.on("error", fail);
      child.on("close", (code) => {
        if (settled) return;
        if (buffer.trim()) processLine(buffer);
        if (settled) return;
        closeBlocks();
        cleanup();
        if (code !== 0) {
          const hint = stderr.trim() || String(state.result?.result ?? "");
          const message = `claude -p exit ${code}: ${hint.slice(0, 800)}`;
          const fatal = fatalCode(hint);
          fail(fatal ? new ClaudePFatalError(message, fatal) : new Error(message));
          return;
        }
        if (!state.result) {
          fail(new Error("claude -p stream ended without a result envelope"));
          return;
        }
        settled = true;
        if (state.result.is_error) {
          const detail = String(state.result.result ?? "").slice(0, 800);
          const fatal = fatalCode(detail);
          reject(
            fatal
              ? new ClaudePFatalError(`claude -p error result: ${detail}`, fatal)
              : new Error(`claude -p error result: ${detail}`),
          );
          return;
        }
        resolve(state);
      });
      child.stdin.write(
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: params.prompt }],
          },
        })}\n`,
        "utf8",
        (error) => {
          if (error) fail(error);
        },
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function streamClaudeP(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const model = claudePModelSlug(params.model);
  if (!model) throw new Error(`Not a claude-p model: ${params.model}`);
  throwIfAborted(params.abortSignal);

  const continuationId = params.providerSession?.continuationId;
  if (continuationId && !CLAUDE_SESSION_ID.test(continuationId)) {
    throw new Error("Invalid Claude continuation ID.");
  }
  const callbacks = params.callbacks ?? {};
  const initialTools =
    params.resolveTools?.() ?? params.staticTools ?? params.tools ?? [];
  let bridge: McpToolBridge | null = null;
  if (initialTools.length && params.runTools) {
    bridge = await startMcpToolBridge({
      tools: params.staticTools ?? params.tools ?? initialTools,
      resolveTools: params.resolveTools,
      runTools: params.runTools,
      callbacks,
      abortSignal: params.abortSignal,
      maxToolCalls:
        params.maxIterations === undefined
          ? undefined
          : Math.max(1, Math.trunc(params.maxIterations)),
    });
  }
  try {
    const state = await runClaudeP({
      ...params,
      model,
      prompt: flattenedPrompt(params.messages),
      bridge,
      callbacks,
    });
    const envelope = state.result!;
    if (bridge && !state.mcpReady) {
      throw new Error(`Claude did not load the Beaver MCP server${state.mcpError ? `: ${state.mcpError}` : "."}`);
    }
    const rawUsage = envelope.usage ?? {};
    const usage: NormalizedLlmUsage = {
      inputTokens: rawUsage.input_tokens ?? 0,
      outputTokens: rawUsage.output_tokens ?? 0,
      reasoningTokens: null,
      cacheReadInputTokens: rawUsage.cache_read_input_tokens ?? 0,
      cacheWriteInputTokens: rawUsage.cache_creation_input_tokens ?? 0,
    };
    const contextWindowTokens = modelContextWindow(params.model);
    if (contextWindowTokens) {
      callbacks.onContextUsage?.({
        usedTokens: usage.inputTokens ?? 0,
        contextWindowTokens,
      });
    }

    let fullText = state.fullText;
    const finalText = String(envelope.result ?? "");
    if (!fullText && finalText) {
      fullText = finalText;
      callbacks.onContentDelta?.(finalText);
      callbacks.onContentBlockEnd?.();
    }
    if (!fullText.trim() && !bridge?.hasTerminalResult()) {
      throw new Error("claude -p completed without a final response");
    }

    const sessionId = envelope.session_id || "";
    if (params.providerSession?.persist && sessionId) {
      if (!CLAUDE_SESSION_ID.test(sessionId)) {
        throw new Error("Claude returned an invalid continuation ID.");
      }
      params.providerSession.onContinuationId?.(sessionId);
    }
    const messagesJson = JSON.stringify(params.messages);
    const toolsJson = JSON.stringify(initialTools);
    const stats = bridge?.stats() ?? {
      toolCallCount: 0,
      toolArgumentBytes: 0,
      toolResultBytes: 0,
    };
    const contextRounds: LlmContextRoundReceipt[] = [
      {
        iteration: 0,
        requestAttempts: 1,
        instructionsBytes: Buffer.byteLength(params.systemPrompt),
        inputItems: params.messages.length,
        inputBytes: Buffer.byteLength(messagesJson),
        toolCount: initialTools.length,
        toolBytes: Buffer.byteLength(toolsJson),
        ...stats,
        usage,
      },
    ];

    return {
      fullText,
      usage,
      contextRounds,
      ...(params.providerSession?.persist && sessionId
        ? { continuationId: sessionId }
        : {}),
    };
  } finally {
    await bridge?.close();
  }
}
