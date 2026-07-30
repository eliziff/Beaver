// claude-p:<model> — Anthropic models over the subscription `claude -p`
// transport (flat rate; no metered API). This is not the Claude Code agent
// harness:
// the Beaver harness keeps its own loop and tools, and each iteration is
// one `claude -p` call whose stdin JSON carries the transport protocol,
// harness system prompt, conversation, and tool schemas.
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
  "reply only in the format it specifies.";

const TRANSPORT_PROTOCOL = `The fields of this JSON object:
- "system": the harness system prompt — treat it as your system prompt and obey it
- "messages": the conversation so far, in Anthropic Messages format ("tool_result" blocks are the outputs of your earlier "tool_use" calls)
- "tools": the tools you may call, with JSON Schema parameters

Reply in exactly one of these forms:
TOOL_CALLS
{"calls":[{"id":"toolu_<unique>","name":"<tool name>","input":{...}}]}

FINAL
<answer in ordinary Markdown>

Do not invoke tools yourself. To act, return TOOL_CALLS with one or more calls
whose inputs satisfy the named tools' schemas. When complete, return FINAL.`;

// A healthy generation streams partial chunks continuously (we pass
// --include-partial-messages); silence means a wedged call. Whole-document
// turns legitimately run 10-30 min, so patience is inactivity-based.
// Liveness counts MODEL stream events only: the CLI prints its init line
// instantly at spawn, long before prompt/cache processing of a
// Beaver-sized context finishes (observed >240s to first token) — so the
// clock is generous until the first model event, tight afterwards.
const FIRST_MODEL_EVENT_GRACE_MS = 900_000;
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
    // `claude -p` is transport only here. Beaver owns the agent loop and
    // tools, so do not expose Claude Code's tools, MCP servers, or skills.
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources",
    "",
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
      const limit = sawActivity ? INACTIVITY_LIMIT_MS : FIRST_MODEL_EVENT_GRACE_MS;
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
      const text = chunk.toString("utf8");
      stdout += text;
      if (/"type":\s*"(?:stream_event|assistant|result)"/u.test(text)) {
        sawActivity = true;
        lastActivity = Date.now();
      }
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

function parseReply(text: string, iteration: number): AnthropicBlock[] {
  const reply = text.trim();
  if (reply.startsWith("FINAL\n")) {
    const finalText = reply.slice("FINAL\n".length).trim();
    if (!finalText) throw new Error("FINAL reply is empty");
    return [{ type: "text", text: finalText }];
  }
  if (!reply.startsWith("TOOL_CALLS\n"))
    throw new Error("reply did not start with FINAL or TOOL_CALLS");
  const parsed = JSON.parse(reply.slice("TOOL_CALLS\n".length)) as {
    calls?: unknown;
  };
  if (!Array.isArray(parsed.calls) || !parsed.calls.length)
    throw new Error("TOOL_CALLS reply has no calls");
  return parsed.calls.map((rawCall, index) => {
    const call = rawCall as Record<string, unknown>;
    if (
      typeof call.name !== "string" ||
      !call.input ||
      typeof call.input !== "object" ||
      Array.isArray(call.input)
    )
      throw new Error("malformed tool call");
    return {
      type: "tool_use" as const,
      id:
        typeof call.id === "string" && call.id
          ? call.id
          : `toolu_${iteration}_${index}_${Date.now().toString(36)}`,
      name: call.name,
      input: call.input as Record<string, unknown>,
    };
  });
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
        const parsed = parseReply(String(envelope.result ?? ""), iter);
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
    if (results.some((result) => result.terminal)) break;
    // Halfway budget meter — same contract as the Responses adapter.
    if (results.length && iter + 1 === Math.floor(maxIter / 2)) {
      const last = results[results.length - 1];
      results[results.length - 1] = {
        ...last,
        content: `${last.content}\n\n[Tool budget: ${iter + 1} of ${maxIter} rounds used. Plan the remaining rounds to end with the final answer.]`,
      };
    }
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
