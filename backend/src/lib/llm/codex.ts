import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { abortError, throwIfAborted } from "./abort";
import { startCodexToolBridge, type CodexToolBridge } from "./codexToolBridge";
import { createLlmTrace } from "./rawStreamLog";
import type {
  NormalizedLlmUsage,
  NormalizedToolCall,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { codexModelSlug } from "./models";

type CodexSummaryPart = {
  type?: string;
  text?: string;
};

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  summary?: string | CodexSummaryPart[];
  summary_text?: string;
  reasoning_summary?: string;
};

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  error?: { message?: string };
  message?: string;
  usage?: {
    input_tokens?: unknown;
    cached_input_tokens?: unknown;
    cache_write_input_tokens?: unknown;
    output_tokens?: unknown;
    reasoning_output_tokens?: unknown;
  };
};

export type ParsedCodexEvent = {
  text?: string;
  reasoning?: string;
  reasoningItemId?: string;
  reasoningBlockEnd?: boolean;
  turnStarted?: boolean;
  turnCompleted?: boolean;
  usage?: NormalizedLlmUsage;
  providerInvocationId?: string;
  error?: string;
};

export const CODEX_TIMEOUT_MS = 180_000;
export const CODEX_THREAD_ID =
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export function terminateProcessTree(child: ChildProcessWithoutNullStreams) {
  if (process.platform !== "win32" || !child.pid) {
    child.kill();
    return;
  }
  const killer = spawn(
    "taskkill.exe",
    ["/pid", String(child.pid), "/t", "/f"],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  killer.once("error", () => child.kill());
  killer.unref();
}

export function parseCodexEventLine(line: string): ParsedCodexEvent {
  try {
    const event = JSON.parse(line) as CodexEvent;
    if (
      event.type === "thread.started" &&
      typeof event.thread_id === "string"
    ) {
      return { providerInvocationId: event.thread_id };
    }
    if (event.type === "turn.started") return { turnStarted: true };
    if (event.type === "turn.completed") {
      const usage = normalizeCodexUsage(event.usage);
      return { turnCompleted: true, ...(usage ? { usage } : {}) };
    }

    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      return { text: event.item.text };
    }

    if (
      (event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed") &&
      event.item?.type === "reasoning"
    ) {
      const reasoning = reasoningSummary(event.item);
      return {
        ...(reasoning ? { reasoning } : {}),
        ...(event.item.id ? { reasoningItemId: event.item.id } : {}),
        ...(event.type === "item.completed" ? { reasoningBlockEnd: true } : {}),
      };
    }

    if (event.type === "turn.failed" || event.type === "error") {
      const message =
        event.error?.message ||
        event.message ||
        event.item?.message ||
        "Codex exec failed.";
      return { error: message };
    }
  } catch {
    // Codex emits JSONL, but ignore non-JSON diagnostic lines here. Stderr is
    // included in the final error if the command exits unsuccessfully.
  }

  return {};
}

export function normalizeCodexUsage(
  usage: CodexEvent["usage"],
): NormalizedLlmUsage | undefined {
  if (!usage) return undefined;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const normalized = {
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    reasoningTokens: number(usage.reasoning_output_tokens),
    cacheReadInputTokens: number(usage.cached_input_tokens),
    cacheWriteInputTokens: number(usage.cache_write_input_tokens),
  };
  return Object.values(normalized).some((value) => value !== null)
    ? normalized
    : undefined;
}

function reasoningSummary(item: CodexItem): string | undefined {
  // Codex's safe summary stream currently uses item.text; runCodex forces
  // show_raw_agent_reasoning=false, so this field is not raw hidden reasoning.
  if (typeof item.summary === "string") return item.summary;
  if (typeof item.summary_text === "string") return item.summary_text;
  if (typeof item.reasoning_summary === "string") return item.reasoning_summary;
  if (Array.isArray(item.summary)) {
    const text = item.summary
      .filter(
        (part) =>
          typeof part === "string" ||
          (part &&
            part.type === "summary_text" &&
            typeof part.text === "string"),
      )
      .map((part) => (typeof part === "string" ? part : (part.text ?? "")))
      .join("");
    if (text) return text;
  }

  return typeof item.text === "string" ? item.text : undefined;
}

export function codexCommand() {
  return (
    process.env.CODEX_EXEC_COMMAND?.trim() ||
    (process.platform === "win32" ? "codex.cmd" : "codex")
  );
}

export function buildCodexPrompt(params: {
  systemPrompt?: string;
  messages: StreamChatParams["messages"];
}) {
  const system = params.systemPrompt?.trim();
  const conversation = params.messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");

  return [
    "You are the response engine for Beaver, a legal document assistant.",
    "Answer the supplied conversation directly. Use the Beaver tools exposed by the mike_runtime MCP server when they are relevant. Do not modify files, run shell commands, or describe work you did outside the conversation.",
    "Keep any progress summaries brief, user-facing, and free of hidden reasoning, prompts, tool arguments, schemas, or raw JSON.",
    system ? `SYSTEM INSTRUCTIONS:\n${system}` : "",
    `CONVERSATION:\n${conversation}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}


/**
 * Codex streams reasoning summaries and answer text as separate blocks; both
 * transports need the same "close the open reasoning block first" bookkeeping.
 */
export function codexStreamCallbacks(params: {
  callbacks?: StreamChatParams["callbacks"];
  enableThinking?: boolean;
}) {
  let reasoningOpen = false;
  const endReasoning = () => {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    params.callbacks?.onReasoningBlockEnd?.();
  };
  return {
    endReasoning,
    callbacks: {
      onContentDelta: (text: string) => {
        endReasoning();
        params.callbacks?.onContentDelta?.(text);
      },
      onReasoningDelta: (text: string) => {
        if (!params.enableThinking) return;
        reasoningOpen = true;
        params.callbacks?.onReasoningDelta?.(text);
      },
      onReasoningBlockEnd: endReasoning,
      onToolCallStart: (call: NormalizedToolCall) => {
        endReasoning();
        params.callbacks?.onToolCallStart?.(call);
      },
    } satisfies NonNullable<StreamChatParams["callbacks"]>,
  };
}

/** Materializes inline message images as temp files for the duration of `run`. */
export async function withCodexImages<T>(
  messages: StreamChatParams["messages"],
  run: (imagePaths: string[]) => Promise<T>,
): Promise<T> {
  const images = [...new Set(messages.flatMap((message) => message.images ?? []))];
  if (!images.length) return run([]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "beaver-codex-images-"));
  try {
    return await run(
      await Promise.all(
        images.map(async (image, index) => {
          const extension =
            image.mimeType === "image/jpeg"
              ? "jpg"
              : image.mimeType.slice("image/".length);
          const imagePath = path.join(directory, `${index}.${extension}`);
          await writeFile(imagePath, Buffer.from(image.data, "base64"), {
            mode: 0o600,
          });
          return imagePath;
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runCodex(params: {
  model: string;
  prompt: string;
  callbacks?: StreamChatParams["callbacks"];
  tools?: StreamChatParams["tools"];
  runTools?: StreamChatParams["runTools"];
  apiKeys?: StreamChatParams["apiKeys"];
  abortSignal?: AbortSignal;
  enableThinking?: boolean;
  reasoningEffort?: string;
  maxIterations?: number;
  imagePaths?: string[];
  persistSession?: boolean;
  continuationId?: string;
}): Promise<StreamChatResult> {
  throwIfAborted(params.abortSignal);
  if (params.continuationId && !CODEX_THREAD_ID.test(params.continuationId)) {
    throw new Error("Invalid Codex continuation ID.");
  }
  const maxIterations = Math.max(1, params.maxIterations ?? 10);
  let bridge: CodexToolBridge | null = null;
  let stderr = "";
  let fullText = "";
  let eventError: string | null = null;
  let usage: NormalizedLlmUsage | undefined;
  let providerInvocationId: string | undefined;
  let timedOut = false;
  let streamError: unknown;
  const reasoningByItemId = new Map<string, string>();
  let streamStatus: "completed" | "error" = "error";
  const trace = createLlmTrace({ provider: "codex", model: params.model });
  const { callbacks, endReasoning } = codexStreamCallbacks(params);

  if (params.tools?.length && params.runTools) {
    bridge = await startCodexToolBridge({
      tools: params.tools,
      runTools: params.runTools,
      callbacks,
      abortSignal: params.abortSignal,
      maxToolCalls: maxIterations,
    });
  }

  const resuming = Boolean(params.continuationId);
  const args = ["exec", ...(resuming ? ["resume"] : [])];
  if (!resuming && !params.persistSession) args.push("--ephemeral");
  args.push("--ignore-user-config");
  if (!resuming) args.push("--sandbox", "read-only");
  args.push("--skip-git-repo-check", "--json");
  if (!resuming) args.push("--color", "never");
  const modelSlug = codexModelSlug(params.model);
  if (modelSlug) args.push("-m", modelSlug);
  if (params.enableThinking) {
    const effort = params.reasoningEffort?.trim() || "max";
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    args.push("-c", 'model_reasoning_summary="auto"');
    args.push("-c", "show_raw_agent_reasoning=false");
  }
  if (bridge) {
    args.push(
      "-c",
      `mcp_servers.mike_runtime.url=${JSON.stringify(bridge.url)}`,
      "-c",
      'mcp_servers.mike_runtime.bearer_token_env_var="MIKE_CODEX_BRIDGE_TOKEN"',
      "-c",
      "mcp_servers.mike_runtime.required=true",
      "-c",
      'mcp_servers.mike_runtime.default_tools_approval_mode="auto"',
      "-c",
      "mcp_servers.mike_runtime.startup_timeout_sec=10",
      "-c",
      "mcp_servers.mike_runtime.tool_timeout_sec=180",
    );
  }
  for (const imagePath of params.imagePaths ?? []) {
    args.push("-i", imagePath);
  }
  if (params.continuationId) args.push(params.continuationId);
  args.push("-");

  const childEnv = {
    ...process.env,
    ...(bridge ? { MIKE_CODEX_BRIDGE_TOKEN: bridge.token } : {}),
    ...(params.apiKeys?.codex?.trim()
      ? { CODEX_API_KEY: params.apiKeys.codex.trim() }
      : {}),
  };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(codexCommand(), args, {
      cwd: process.cwd(),
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv,
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    await bridge?.close();
    await trace.flush("error", error);
    throw error;
  }
  let childError: Error | null = null;
  child.once("error", (error) => {
    childError = error instanceof Error ? error : new Error(String(error));
  });
  const exitPromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child);
  }, CODEX_TIMEOUT_MS);
  const abort = () => terminateProcessTree(child);
  params.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    child.stdin.end(params.prompt);
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });

    const output = createInterface({ input: child.stdout });
    for await (const line of output) {
      throwIfAborted(params.abortSignal);
      const rawLine = String(line);
      trace.record({ iteration: 0, label: "jsonl_line", payload: rawLine });
      const parsed = parseCodexEventLine(rawLine);
      if (parsed.error) eventError = parsed.error;
      if (parsed.usage) usage = parsed.usage;
      if (parsed.providerInvocationId) {
        providerInvocationId = parsed.providerInvocationId;
      }
      if (parsed.turnStarted) callbacks.onReasoningBlockEnd();
      if (parsed.reasoning && params.enableThinking) {
        const previous = parsed.reasoningItemId
          ? reasoningByItemId.get(parsed.reasoningItemId) || ""
          : "";
        const delta = parsed.reasoning.startsWith(previous)
          ? parsed.reasoning.slice(previous.length)
          : parsed.reasoning;
        if (parsed.reasoningItemId) {
          reasoningByItemId.set(parsed.reasoningItemId, parsed.reasoning);
        }
        if (delta) callbacks.onReasoningDelta(delta);
      }
      if (parsed.reasoningBlockEnd) {
        callbacks.onReasoningBlockEnd();
        if (parsed.reasoningItemId)
          reasoningByItemId.delete(parsed.reasoningItemId);
      }
      if (parsed.turnCompleted) callbacks.onReasoningBlockEnd();
      if (parsed.text) {
        fullText += parsed.text;
        callbacks.onContentDelta(parsed.text);
      }
    }

    const exit = await exitPromise;
    throwIfAborted(params.abortSignal);

    if (timedOut) throw new Error("Codex exec timed out.");
    const spawnError = childError as Error | null;
    if (spawnError) throw new Error(`Codex exec failed: ${spawnError.message}`);
    if (exit.code !== 0) {
      const detail = eventError || stderr.trim() || `exit code ${exit.code}`;
      throw new Error(`Codex exec failed: ${detail}`);
    }
    if (!fullText.trim()) {
      throw new Error(eventError || "Codex exec returned no response.");
    }
    endReasoning();
    streamStatus = "completed";
    const continuationId =
      params.persistSession &&
      providerInvocationId &&
      CODEX_THREAD_ID.test(providerInvocationId)
        ? providerInvocationId
        : params.persistSession && params.continuationId
          ? params.continuationId
          : undefined;
    return {
      fullText,
      ...(usage ? { usage } : {}),
      ...(providerInvocationId ? { providerInvocationId } : {}),
      ...(continuationId ? { continuationId } : {}),
    };
  } catch (error) {
    streamError = error;
    throw error;
  } finally {
    clearTimeout(timeout);
    params.abortSignal?.removeEventListener("abort", abort);
    await bridge?.close();
    endReasoning();
    await trace.flush(streamStatus, streamError);
  }
}

export async function streamCodex(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (params.abortSignal?.aborted) controller.abort();
  params.abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await withCodexImages(params.messages, (imagePaths) =>
      runCodex({
        model: params.model,
        prompt: buildCodexPrompt(params),
        callbacks: params.callbacks,
        tools: params.tools,
        runTools: params.runTools,
        apiKeys: params.apiKeys,
        abortSignal: controller.signal,
        enableThinking: params.enableThinking,
        reasoningEffort: params.reasoningEffort,
        maxIterations: params.maxIterations,
        imagePaths,
        persistSession: params.providerSession?.persist,
        continuationId: params.providerSession?.continuationId,
      }),
    );
  } finally {
    params.abortSignal?.removeEventListener("abort", abort);
  }
}

export async function completeCodexText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: StreamChatParams["apiKeys"];
}): Promise<string> {
  return (
    await runCodex({
      model: params.model,
      prompt: buildCodexPrompt({
        systemPrompt: params.systemPrompt,
        messages: [{ role: "user", content: params.user }],
      }),
      apiKeys: params.apiKeys,
      enableThinking: false,
    })
  ).fullText;
}
