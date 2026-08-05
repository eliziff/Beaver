// claude-p:<model> — Anthropic models over the subscription `claude -p`
// transport (flat rate; no metered API). This is not the Claude Code agent
// harness:
// the Beaver harness keeps its own loop and tools, and each iteration is
// one `claude -p` call whose stdin JSON carries the transport protocol,
// harness system prompt, conversation, and tool schemas.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { jsonrepair } from "jsonrepair";

import { abortError, throwIfAborted } from "./abort";
import type {
  LlmContextRoundReceipt,
  NormalizedLlmUsage,
  NormalizedToolCall,
  StreamChatParams,
  StreamChatResult,
} from "./types";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

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
whose inputs satisfy the named tools' schemas. When complete, return FINAL.
The TOOL_CALLS JSON must be strict JSON: inside string values escape every
double quote as \\" and every newline as \\n. Never wrap a reply in Markdown
code fences.`;

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

/**
 * Child env with every auth source removed, not blanked. The harness itself
 * may run behind a proxy (ANTHROPIC_BASE_URL/AUTH_TOKEN for model routing);
 * `claude -p` must NOT inherit that — it would take precedence over the
 * claude.ai login and the CLI fails ("another auth source is set"). An empty
 * ANTHROPIC_API_KEY string is still "set", so delete, don't blank.
 */
function authIsolatedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
  ]) {
    delete env[key];
  }
  return env;
}

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
      env: authIsolatedEnv(),
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

/**
 * Persistent-session variant (opt-in: MIKE_CLAUDE_P_PERSIST=1). One
 * long-lived `claude -p --input-format stream-json` process serves a
 * whole agent conversation: the first turn carries the full payload
 * exactly like the per-call path; each later iteration sends ONLY the
 * new tool results, because the session already holds the context.
 * Probed live 2026-07-30 (CLI 2.1.220): one process answers sequential
 * user events with one `result` envelope each. Wins: no per-iteration
 * process spawn and no full-context reprocessing. Any session failure
 * (parse error, death, silence) falls back to a FRESH session with the
 * full conversation replayed — the maintained `messages` array makes
 * that always possible, so persistence never changes what the model
 * sees on the recovery path.
 */
const persistEnabled = () => process.env.MIKE_CLAUDE_P_PERSIST === "1";

const PERSIST_PROTOCOL_ADDENDUM =
  '\n- Follow-up user messages in this session are JSON objects {"tool_results":[{"tool_use_id","content"}, ...]} — the outputs of your last TOOL_CALLS. Continue under the same protocol and reply in the same TOOL_CALLS/FINAL format.';

class ClaudePSession {
  private child: ReturnType<typeof spawn>;
  private buffer = "";
  private stderrText = "";
  private pending: {
    resolve: (envelope: Envelope) => void;
    reject: (error: unknown) => void;
  } | null = null;
  private sawActivity = false;
  private lastActivity = Date.now();
  private turnStarted = Date.now();
  private watchdog: NodeJS.Timeout;
  private readonly onAbort = () => this.fail(abortError());
  dead = false;

  constructor(
    model: string,
    effort: string | undefined,
    private readonly abortSignal?: AbortSignal,
  ) {
    const { file, shell } = resolveCli();
    const args = [
      "-p",
      "--model",
      model,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
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
    this.child = spawn(file, args, {
      shell,
      env: authIsolatedEnv(),
      windowsHide: true,
    });
    this.watchdog = setInterval(() => {
      if (!this.pending) return;
      const now = Date.now();
      const limit = this.sawActivity
        ? INACTIVITY_LIMIT_MS
        : FIRST_MODEL_EVENT_GRACE_MS;
      if (now - this.lastActivity > limit)
        this.fail(
          new Error(`claude -p session silent for ${limit / 1000}s — killed`),
        );
      else if (now - this.turnStarted > HARD_LIMIT_MS)
        this.fail(new Error("claude -p session exceeded hard time limit — killed"));
    }, 5_000);
    this.abortSignal?.addEventListener("abort", this.onAbort, { once: true });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        if (!line.startsWith("{")) continue;
        let event: (Envelope & { type?: string }) | null = null;
        try {
          event = JSON.parse(line) as Envelope & { type?: string };
        } catch {
          continue;
        }
        if (
          event.type === "stream_event" ||
          event.type === "assistant" ||
          event.type === "result"
        ) {
          this.sawActivity = true;
          this.lastActivity = Date.now();
        }
        if (event.type === "result" && this.pending) {
          const { resolve } = this.pending;
          this.pending = null;
          resolve(event);
        }
      }
    });
    this.child.stderr?.on(
      "data",
      (chunk: Buffer) => (this.stderrText += chunk.toString("utf8")),
    );
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code) =>
      this.fail(
        new Error(
          `claude -p session closed (exit ${code}): ${this.stderrText.slice(0, 800)}`,
        ),
      ),
    );
  }

  private fail(error: unknown) {
    this.dead = true;
    clearInterval(this.watchdog);
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    this.child.kill();
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      reject(error);
    }
  }

  /** Send one user event; resolves at this turn's `result` envelope. */
  turn(text: string): Promise<Envelope> {
    if (this.dead) return Promise.reject(new Error("claude -p session is dead"));
    if (this.pending)
      return Promise.reject(new Error("claude -p session turn already pending"));
    this.sawActivity = false;
    this.lastActivity = Date.now();
    this.turnStarted = Date.now();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.stdin?.write(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
        })}\n`,
        "utf8",
        (error) => {
          if (error) this.fail(error);
        },
      );
    });
  }

  dispose() {
    this.dead = true;
    clearInterval(this.watchdog);
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    this.child.stdin?.end();
    this.child.kill();
  }
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

/** Strip one Markdown code fence wrapping the whole text, if present. */
function stripFence(text: string): string {
  const match = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/u.exec(text.trim());
  return match ? match[1].trim() : text.trim();
}

/**
 * Tolerant reply parser. The contract is a FINAL/TOOL_CALLS marker line, but
 * models drift in content-shaped ways — code fences, preamble prose, the
 * marker on the same line as the JSON, and (the Stage 12 Claude-5 failure
 * mode) unescaped quotes/newlines inside JSON string values when the tool
 * input embeds legal text that itself contains quotation marks. Tolerance
 * never invents content: JSON that even jsonrepair cannot parse still
 * throws, and a repair that mutated quoted text fails the downstream
 * deterministic verbatim gate rather than passing falsely.
 */
export function parseReply(text: string, iteration: number): AnthropicBlock[] {
  const reply = stripFence(text);
  const marker = /(?:^|\n)[ \t]*(FINAL|TOOL_CALLS)\b[ \t]*:?/u.exec(reply);
  if (!marker) throw new Error("reply did not contain FINAL or TOOL_CALLS");
  const rest = stripFence(reply.slice(marker.index + marker[0].length).trim());
  if (marker[1] === "FINAL") {
    if (!rest) throw new Error("FINAL reply is empty");
    return [{ type: "text", text: rest }];
  }
  const start = rest.indexOf("{");
  const end = rest.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("TOOL_CALLS reply has no JSON object");
  const raw = rest.slice(start, end + 1);
  let parsed: { calls?: unknown };
  try {
    parsed = JSON.parse(raw) as { calls?: unknown };
  } catch (parseError) {
    try {
      parsed = JSON.parse(jsonrepair(raw)) as { calls?: unknown };
    } catch {
      throw parseError;
    }
    console.warn("[claude-p] repaired malformed TOOL_CALLS JSON");
  }
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
  const maxIter = params.maxIterations;

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
  // Content-free per-iteration receipts. Without them the manifest reports
  // rounds: [] for claude-p, context_round_count is 0, and the harness cannot
  // separate context volume from turn count on this lane.
  const contextRounds: LlmContextRoundReceipt[] = [];

  const persist = persistEnabled();
  let session: ClaudePSession | null = null;
  let priorToolKey = "";
  // Set when the previous iteration ended in tool calls: the compact
  // follow-up a live session can consume instead of a full replay.
  let continuation: string | null = null;
  try {
    for (let iter = 0; maxIter === undefined || iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);
      const claudeTools = (params.resolveTools?.() ?? tools).map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }));
      const toolKey = JSON.stringify(claudeTools);
      if (priorToolKey && toolKey !== priorToolKey) {
        // A live claude -p continuation cannot receive a changed schema list.
        // Replay the accumulated transcript once when disclosure changes it.
        session?.dispose();
        session = null;
        continuation = null;
      }
      priorToolKey = toolKey;
      const usageBeforeRound = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
      };
      const continuationUsed =
        !!(session && !session.dead && continuation);
      let attemptsUsed = 0;
      let blocks: AnthropicBlock[] | null = null;
      let lastError: unknown = null;
      // After a parse failure the retry payload carries the bad reply plus a
      // typed correction naming the parse error — Stage 12 proved these
      // failures are content-shaped and deterministic, so an identical
      // resend just fails identically.
      let corrective: { reply: string; problem: string } | null = null;
      for (let attempt = 0; attempt < 3 && !blocks; attempt++) {
        throwIfAborted(params.abortSignal);
        attemptsUsed = attempt + 1;
        if (attempt > 0)
          await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
        const correction = corrective as {
          reply: string;
          problem: string;
        } | null;
        const payload = JSON.stringify({
          transport_protocol: persist
            ? TRANSPORT_PROTOCOL + PERSIST_PROTOCOL_ADDENDUM
            : TRANSPORT_PROTOCOL,
          system: params.systemPrompt,
          messages: correction
            ? [
                ...messages,
                { role: "assistant", content: correction.reply },
                {
                  role: "user",
                  content:
                    `Your reply could not be parsed: ${correction.problem}. ` +
                    "Resend the ENTIRE reply in the required format: the marker " +
                    "line (TOOL_CALLS or FINAL), then the content. TOOL_CALLS " +
                    "JSON must be strict single-line JSON — inside string values " +
                    'escape every double quote as \\" and every newline as \\n — ' +
                    "with no code fences and no other text.",
                },
              ]
            : messages,
          tools: claudeTools,
        });
        try {
          let envelope: Envelope;
          if (persist) {
            // A live session takes the compact follow-up; any dead or
            // absent session (including every retry) gets a fresh
            // process and the FULL replay, so recovery is stateless.
            const liveContinuation =
              session && !session.dead && continuation && attempt === 0;
            if (!liveContinuation) {
              session?.dispose();
              session = new ClaudePSession(
                slug,
                params.reasoningEffort,
                params.abortSignal,
              );
            }
            envelope = await session!.turn(
              liveContinuation ? continuation! : payload,
            );
          } else {
            const run = await runClaudeP(
              slug,
              payload,
              params.reasoningEffort,
              params.abortSignal,
            );
            if (run.code !== 0) {
              // Non-zero exit with empty stderr: the CLI puts the real reason
              // in the stdout result envelope (e.g. "Prompt is too long",
              // terminal_reason blocking_limit). Surface it for telemetry and
              // for queue classifiers that must not retry deterministic
              // context-limit failures.
              let hint = run.stderr.slice(0, 800);
              if (!hint.trim()) {
                const m = /"result"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(
                  run.stdout,
                );
                if (m) hint = m[1];
              }
              throw new Error(`claude -p exit ${run.code}: ${hint}`);
            }
            envelope = resultEnvelope(run.stdout);
          }
          if (envelope.is_error)
            throw new Error(
              `claude -p error result: ${String(envelope.result).slice(0, 300)}`,
            );
          // Usage before parsing: a reply that fails to parse still spent
          // these tokens, and telemetry should see them.
          const e = envelope.usage ?? {};
          usage.inputTokens =
            (usage.inputTokens ?? 0) + (e.input_tokens ?? 0);
          usage.outputTokens = (usage.outputTokens ?? 0) + (e.output_tokens ?? 0);
          usage.cacheReadInputTokens =
            (usage.cacheReadInputTokens ?? 0) + (e.cache_read_input_tokens ?? 0);
          usage.cacheWriteInputTokens =
            (usage.cacheWriteInputTokens ?? 0) +
            (e.cache_creation_input_tokens ?? 0);
          const rawReply = String(envelope.result ?? "");
          try {
            blocks = parseReply(rawReply, iter);
          } catch (parseError) {
            corrective = {
              reply: rawReply,
              problem: String(
                (parseError as Error).message ?? parseError,
              ).slice(0, 200),
            };
            throw parseError;
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (!blocks)
        throw new Error(
          `claude-p transport: unparseable reply after retries: ${lastError}`,
        );

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

      {
        const system = params.systemPrompt ?? "";
        const messagesJson = JSON.stringify(messages);
        const argsJson = JSON.stringify(toolCalls.map((call) => call.input));
        contextRounds.push({
          iteration: iter,
          requestAttempts: attemptsUsed,
          continuation: continuationUsed ? "provider" : "none",
          instructionsBytes: Buffer.byteLength(system),
          instructionsSha256: sha256(system),
          inputItems: messages.length,
          inputBytes: Buffer.byteLength(messagesJson),
          inputSha256: sha256(messagesJson),
          toolCount: claudeTools.length,
          toolBytes: Buffer.byteLength(toolKey),
          toolSha256: sha256(toolKey),
          toolCallCount: toolCalls.length,
          toolArgumentBytes: Buffer.byteLength(argsJson),
          toolResultBytes: 0,
          usage: {
            inputTokens:
              (usage.inputTokens ?? 0) - usageBeforeRound.inputTokens,
            outputTokens:
              (usage.outputTokens ?? 0) - usageBeforeRound.outputTokens,
            reasoningTokens: null,
            cacheReadInputTokens:
              (usage.cacheReadInputTokens ?? 0) -
              usageBeforeRound.cacheReadInputTokens,
            cacheWriteInputTokens:
              (usage.cacheWriteInputTokens ?? 0) -
              usageBeforeRound.cacheWriteInputTokens,
          },
        });
      }

      if (!toolCalls.length || !runTools) break;
      const results = await runTools(toolCalls);
      throwIfAborted(params.abortSignal);
      contextRounds[contextRounds.length - 1].toolResultBytes =
        Buffer.byteLength(
          JSON.stringify(results.map((result) => result.content)),
        );
      if (results.some((result) => result.terminal)) break;
      messages.push({ role: "assistant", content: blocks });
      messages.push({
        role: "user",
        content: results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.tool_use_id,
          content: result.content,
        })),
      });
      continuation = JSON.stringify({
        tool_results: results.map((result) => ({
          tool_use_id: result.tool_use_id,
          content: result.content,
        })),
      });
    }
  } finally {
    session?.dispose();
  }

  return { fullText, usage, contextRounds };
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
