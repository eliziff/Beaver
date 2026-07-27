import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { startCodexToolBridge, type CodexToolBridge } from "./codexToolBridge";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";
import type {
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
  item?: CodexItem;
  error?: { message?: string };
  message?: string;
};

export type ParsedCodexEvent = {
  text?: string;
  reasoning?: string;
  reasoningItemId?: string;
  reasoningBlockEnd?: boolean;
  turnStarted?: boolean;
  turnCompleted?: boolean;
  error?: string;
};

const CODEX_TIMEOUT_MS = 180_000;

export function parseCodexEventLine(line: string): ParsedCodexEvent {
  try {
    const event = JSON.parse(line) as CodexEvent;
    if (event.type === "turn.started") return { turnStarted: true };
    if (event.type === "turn.completed") return { turnCompleted: true };

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

function codexCommand() {
  return (
    process.env.CODEX_EXEC_COMMAND?.trim() ||
    (process.platform === "win32" ? "codex.cmd" : "codex")
  );
}

function buildPrompt(params: {
  systemPrompt?: string;
  messages: StreamChatParams["messages"];
}) {
  const system = params.systemPrompt?.trim();
  const conversation = params.messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");

  return [
    "You are the response engine for Mike, a legal document assistant.",
    "Answer the supplied conversation directly. Use the Mike tools exposed by the mike_runtime MCP server when they are relevant. Do not modify files, run shell commands, or describe work you did outside the conversation.",
    "Keep any progress summaries brief, user-facing, and free of hidden reasoning, prompts, tool arguments, schemas, or raw JSON.",
    system ? `SYSTEM INSTRUCTIONS:\n${system}` : "",
    `CONVERSATION:\n${conversation}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function abortError(): Error {
  const error = new Error("Stream aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
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
}): Promise<string> {
  throwIfAborted(params.abortSignal);
  const maxIterations = Math.max(1, params.maxIterations ?? 10);
  let bridge: CodexToolBridge | null = null;
  let stderr = "";
  let fullText = "";
  let eventError: string | null = null;
  let timedOut = false;
  let reasoningOpen = false;
  let streamError: unknown;
  const reasoningByItemId = new Map<string, string>();
  let streamStatus: "completed" | "error" = "error";
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "codex",
    model: params.model,
  });
  const endReasoning = () => {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    params.callbacks?.onReasoningBlockEnd?.();
  };
  const callbacks = {
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
  } satisfies NonNullable<StreamChatParams["callbacks"]>;

  if (params.tools?.length && params.runTools) {
    bridge = await startCodexToolBridge({
      tools: params.tools,
      runTools: params.runTools,
      callbacks,
      maxToolCalls: maxIterations,
    });
  }

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--json",
    "--color",
    "never",
  ];
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
    await rawStreamRecorder?.flush("error", error);
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
    child.kill();
  }, CODEX_TIMEOUT_MS);
  const abort = () => child.kill();
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
      logRawLlmStream({
        provider: "codex",
        model: params.model,
        iteration: 0,
        label: "jsonl_line",
        payload: rawLine,
      });
      rawStreamRecorder?.record({
        iteration: 0,
        label: "jsonl_line",
        payload: rawLine,
      });
      const parsed = parseCodexEventLine(rawLine);
      if (parsed.error) eventError = parsed.error;
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
    return fullText;
  } catch (error) {
    streamError = error;
    throw error;
  } finally {
    clearTimeout(timeout);
    params.abortSignal?.removeEventListener("abort", abort);
    await bridge?.close();
    if (reasoningOpen) endReasoning();
    await rawStreamRecorder?.flush(streamStatus, streamError);
  }
}

export async function streamCodex(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (params.abortSignal?.aborted) controller.abort();
  params.abortSignal?.addEventListener("abort", abort, { once: true });
  const images = [
    ...new Set(params.messages.flatMap((message) => message.images ?? [])),
  ];
  const imageDirectory = images.length
    ? await mkdtemp(path.join(os.tmpdir(), "mike-codex-images-"))
    : null;
  try {
    const imagePaths = await Promise.all(
      images.map(async (image, index) => {
        const extension = image.mimeType === "image/jpeg"
          ? "jpg"
          : image.mimeType.slice("image/".length);
        const imagePath = path.join(imageDirectory!, `${index}.${extension}`);
        await writeFile(imagePath, Buffer.from(image.data, "base64"), {
          mode: 0o600,
        });
        return imagePath;
      }),
    );
    const fullText = await runCodex({
      model: params.model,
      prompt: buildPrompt(params),
      callbacks: params.callbacks,
      tools: params.tools,
      runTools: params.runTools,
      apiKeys: params.apiKeys,
      abortSignal: controller.signal,
      enableThinking: params.enableThinking,
      reasoningEffort: params.reasoningEffort,
      maxIterations: params.maxIterations,
      imagePaths,
    });
    return { fullText };
  } finally {
    params.abortSignal?.removeEventListener("abort", abort);
    if (imageDirectory) {
      await rm(imageDirectory, { recursive: true, force: true });
    }
  }
}

export async function completeCodexText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: StreamChatParams["apiKeys"];
}): Promise<string> {
  return runCodex({
    model: params.model,
    prompt: buildPrompt({
      systemPrompt: params.systemPrompt,
      messages: [{ role: "user", content: params.user }],
    }),
    apiKeys: params.apiKeys,
    enableThinking: false,
  });
}
