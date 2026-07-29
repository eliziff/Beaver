// claude-p:<model> — Anthropic models over headless Claude Code
// (`claude -p`, subscription flat rate; no metered API). Transport-only:
// the Beaver harness keeps its own loop and tools, and each iteration is
// one `claude -p` call whose stdin JSON carries the transport protocol,
// harness system prompt, conversation, and tool schemas. The model replies
// with one JSON object shaped like an Anthropic assistant message
// (tool calls as JSON-in-text; no schema enforcement, so parses retry).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { abortError, throwIfAborted } from "./abort";
import type {
  NormalizedLlmUsage,
  NormalizedToolCall,
  StreamChatParams,
  StreamChatResult,
} from "./types";

// Single-line and quote-free by necessity: if the CLI resolves to the npm
// .CMD shim, cmd.exe re-parses argv and mangles newlines/quotes.
const SYSTEM_ARG =
  "You are the model inside an automated agent harness. The user message " +
  "is a JSON object; follow its transport_protocol field exactly and " +
  "reply with only the JSON object it specifies.";

const TRANSPORT_PROTOCOL = `The fields of this JSON object:
- "system": the harness system prompt — treat it as your system prompt and obey it
- "messages": the conversation so far, in Anthropic Messages format ("tool_result" blocks are the outputs of your earlier "tool_use" calls)
- "tools": the tools you may call, with JSON Schema parameters

Reply with ONLY one JSON object — no prose, no code fences:
{"content": [{"type": "text", "text": "..."} and/or {"type": "tool_use", "id": "toolu_<unique>", "name": "<tool name>", "input": {...}}]}

Rules: to act, emit tool_use blocks (one or several); tool input must satisfy that tool's schema; ids must be unique. When the task is fully complete, reply with text blocks only and no tool_use.`;

// A healthy generation streams partial chunks continuously (we pass
// --include-partial-messages); silence means a wedged call. Whole-document
// turns legitimately run 10-30 min, so patience is inactivity-based.
// Before the FIRST byte, silence usually means server-side rate-limit
// queueing, not a wedge — allow a much longer time-to-first-byte.
const FIRST_ACTIVITY_GRACE_MS = 600_000;
const INACTIVITY_LIMIT_MS = 240_000;
const HARD_LIMIT_MS = 3_600_000;

export function claudePModelSlug(model: string): string | null {
  return model.startsWith("claude-p:")
    ? model.slice("claude-p:".length).trim() || null
    : null;
}

/** Prefer the real claude.exe — spawning the npm .CMD shim needs a shell. */
function resolveCli(): { file: string; shell: boolean } {
  const appData = process.env.APPDATA;
  if (appData) {
    const exe = path.join(
      appData,
      "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    );
    if (existsSync(exe)) return { file: exe, shell: false };
  }
  return { file: "claude", shell: true };
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type Envelope = {
  is_error?: boolean;
  result?: string;
  usage?: Record<string, number | undefined>;
};

function runClaudeP(
  model: string,
  payload: string,
  effort?: string,
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { file, shell } = resolveCli();
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--system-prompt",
    shell ? `"${SYSTEM_ARG}"` : SYSTEM_ARG,
  ];
  if (effort) args.push("--effort", effort);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell,
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let sawActivity = false;
    let lastActivity = Date.now();
    const started = Date.now();
    const watchdog = setInterval(() => {
      const now = Date.now();
      const limit = sawActivity ? INACTIVITY_LIMIT_MS : FIRST_ACTIVITY_GRACE_MS;
      if (now - lastActivity > limit) {
        child.kill();
        reject(new Error(`claude -p silent for ${limit / 1000}s — killed`));
      } else if (now - started > HARD_LIMIT_MS) {
        child.kill();
        reject(new Error("claude -p exceeded hard time limit — killed"));
      }
    }, 5_000);
    const onAbort = () => {
      child.kill();
      reject(abortError());
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      sawActivity = true;
      lastActivity = Date.now();
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearInterval(watchdog);
      abortSignal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code });
    });
    child.stdin.write(payload, "utf8");
    child.stdin.end();
  });
}

/** Last `type:"result"` event line of a stream-json transcript. */
function resultEnvelope(stdout: string): Envelope {
  const lines = stdout.split(/\r?\n/u);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const stripped = lines[i].trim();
    if (!stripped.startsWith("{")) continue;
    try {
      const event = JSON.parse(stripped) as Envelope & { type?: string };
      if (event.type === "result") return event;
    } catch {
      continue;
    }
  }
  throw new Error("stream ended without a result envelope");
}

function extractJson(text: string): { content?: unknown } {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    stripped = stripped.replace(/^```(?:json)?/u, "").replace(/```$/u, "").trim();
  }
  try {
    return JSON.parse(stripped) as { content?: unknown };
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object in reply");
    return JSON.parse(stripped.slice(start, end + 1)) as { content?: unknown };
  }
}

export async function streamClaudeP(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const slug = claudePModelSlug(params.model);
  if (!slug) throw new Error(`Not a claude-p model: ${params.model}`);
  const { callbacks = {}, runTools, tools = [] } = params;
  const maxIter = params.maxIterations ?? 10;

  const claudeTools = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
  // Images are not carried over this transport (modelSupportsImageInput
  // fails closed for claude-p models).
  const messages: Array<{ role: string; content: string | AnthropicBlock[] }> =
    params.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

  let fullText = "";
  const usage: NormalizedLlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };

  for (let iter = 0; iter < maxIter; iter++) {
    throwIfAborted(params.abortSignal);
    const payload = JSON.stringify({
      transport_protocol: TRANSPORT_PROTOCOL,
      system: params.systemPrompt,
      messages,
      tools: claudeTools,
    });

    let blocks: AnthropicBlock[] | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3 && !blocks; attempt++) {
      throwIfAborted(params.abortSignal);
      if (attempt > 0)
        await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
      const run = await runClaudeP(
        slug,
        payload,
        params.reasoningEffort,
        params.abortSignal,
      );
      try {
        if (run.code !== 0)
          throw new Error(`claude -p exit ${run.code}: ${run.stderr.slice(0, 300)}`);
        const envelope = resultEnvelope(run.stdout);
        if (envelope.is_error)
          throw new Error(`claude -p error result: ${String(envelope.result).slice(0, 300)}`);
        const reply = extractJson(String(envelope.result ?? ""));
        if (!Array.isArray(reply.content) || reply.content.length === 0)
          throw new Error("reply JSON has no content blocks");
        const parsed: AnthropicBlock[] = [];
        for (const block of reply.content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string") {
            parsed.push({ type: "text", text: block.text });
          } else if (
            block.type === "tool_use" &&
            typeof block.name === "string" &&
            block.input !== null &&
            typeof block.input === "object"
          ) {
            parsed.push({
              type: "tool_use",
              id:
                typeof block.id === "string" && block.id
                  ? block.id
                  : `toolu_${iter}_${parsed.length}_${Date.now().toString(36)}`,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }
        if (!parsed.length) throw new Error("no usable content blocks in reply");
        const e = envelope.usage ?? {};
        usage.inputTokens =
          (usage.inputTokens ?? 0) + (e.input_tokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (e.output_tokens ?? 0);
        usage.cacheReadInputTokens =
          (usage.cacheReadInputTokens ?? 0) + (e.cache_read_input_tokens ?? 0);
        usage.cacheWriteInputTokens =
          (usage.cacheWriteInputTokens ?? 0) + (e.cache_creation_input_tokens ?? 0);
        blocks = parsed;
      } catch (error) {
        lastError = error;
      }
    }
    if (!blocks)
      throw new Error(`claude-p transport: unparseable reply after retries: ${lastError}`);

    const toolCalls: NormalizedToolCall[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        fullText += block.text;
        callbacks.onContentDelta?.(block.text);
      } else if (block.type === "tool_use") {
        const call: NormalizedToolCall = {
          id: block.id,
          name: block.name,
          input: block.input,
        };
        callbacks.onToolCallStart?.(call);
        toolCalls.push(call);
      }
    }
    callbacks.onContentBlockEnd?.();

    if (!toolCalls.length || !runTools) break;
    const results = await runTools(toolCalls);
    throwIfAborted(params.abortSignal);
    messages.push({ role: "assistant", content: blocks });
    messages.push({
      role: "user",
      content: results.map((result) => ({
        type: "tool_result" as const,
        tool_use_id: result.tool_use_id,
        content: result.content,
      })),
    });
  }

  return { fullText, usage };
}

export async function completeClaudePText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
}): Promise<string> {
  const result = await streamClaudeP({
    model: params.model,
    systemPrompt: params.systemPrompt ?? "",
    messages: [{ role: "user", content: params.user }],
  });
  return result.fullText;
}
