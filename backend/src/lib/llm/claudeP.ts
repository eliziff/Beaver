// claude-p:<model> — Anthropic models over the subscription `claude -p`
// transport (flat rate; no metered API). This is not the Claude Code agent
// harness:
// the Beaver harness keeps its own loop and tools, and each iteration is
// one `claude -p` call whose stdin JSON carries the transport protocol,
// harness system prompt, conversation, and tool schemas.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonrepair } from "jsonrepair";

import { abortError, throwIfAborted } from "./abort";
import type {
  LlmCompactionReceipt,
  LlmContextRoundReceipt,
  NormalizedLlmUsage,
  NormalizedToolCall,
  StreamChatParams,
  StreamChatResult,
} from "./types";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Deterministic CLI failures that retrying can never fix. context_overflow is
 * a MEASURED OUTCOME for whole-read arms on 200K-class models — the harness
 * records it as the result, it is not a transient error. quota_exhausted is
 * the weekly subscription wall; a retry burns another spawn against a hard
 * quota with zero chance of success.
 */
export type ClaudePFatalCode =
  | "context_overflow"
  | "quota_exhausted"
  | "compaction_limit";

/**
 * Real-degradation bound, not an artificial cap: each CLI auto-compaction
 * replaces served document content with a lossy summary, so by the third
 * cycle the model is drafting from summaries-of-summaries (the 2026-08-06
 * v1 acq pilot was already unusable after two). Rounds are otherwise
 * unbounded on non-native arms, and compaction re-opens window headroom
 * each time — without this bound a thrashing run can cycle indefinitely.
 */
const MAX_PROVIDER_COMPACTIONS = 3;

export class ClaudePFatalError extends Error {
  constructor(
    message: string,
    public readonly code: ClaudePFatalCode,
  ) {
    super(message);
    this.name = "ClaudePFatalError";
  }
}

function fatalCode(text: string): ClaudePFatalCode | null {
  if (/prompt is too long|blocking_limit/iu.test(text))
    return "context_overflow";
  if (/hit your (?:weekly |session )?limit/iu.test(text))
    return "quota_exhausted";
  return null;
}

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
// At effort max the tight limit is wrong: HSR transcripts (2026-08-06)
// prove healthy max-effort generations pause >240s at summarized-thinking
// flush and internal continuation seams — sessions that had streamed
// deltas for 1,310s+ were killed mid-generation, forfeiting the
// server-side cache each time. So the inactivity limit scales with
// effort; HARD_LIMIT_MS stays the per-turn runaway backstop.
const FIRST_MODEL_EVENT_GRACE_MS = 900_000;
const INACTIVITY_LIMIT_MS = 240_000;
const HARD_LIMIT_MS = 3_600_000;
const inactivityLimitMs = (effort?: string): number =>
  effort === "max" ? FIRST_MODEL_EVENT_GRACE_MS : INACTIVITY_LIMIT_MS;

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
function authIsolatedEnv(model?: string): NodeJS.ProcessEnv {
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
  // The CLI's default 32k per-message output cap truncates one-shot
  // whole-document drafts once max-effort thinking shares the budget
  // (2026-08-06: 83%/72% of employment/insurance drafting output was
  // discarded in truncate-rewrite cycles). Sonnet models support 64k
  // output; other families keep the CLI default until measured. An
  // operator-set value always wins.
  if (
    model?.includes("sonnet") &&
    !env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  ) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "64000";
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
      env: authIsolatedEnv(model),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let sawActivity = false;
    let lastActivity = Date.now();
    const started = Date.now();
    const inactivityMs = inactivityLimitMs(effort);
    const watchdog = setInterval(() => {
      const now = Date.now();
      const limit = sawActivity ? inactivityMs : FIRST_MODEL_EVENT_GRACE_MS;
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
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      // CLI retry/backoff chatter is stderr-only; a child talking on
      // stderr is not wedged. HARD_LIMIT_MS still bounds true wedges.
      lastActivity = Date.now();
    });
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
  private readonly inactivityMs: number;
  private readonly onAbort = () => this.fail(abortError());
  /** Last non-null stop_reason seen since this turn started. */
  lastStopReason: string | null = null;
  dead = false;

  constructor(
    model: string,
    effort: string | undefined,
    private readonly abortSignal?: AbortSignal,
    private readonly onCompaction?: (event: ClaudePCompactionEvent) => void,
  ) {
    this.inactivityMs = inactivityLimitMs(effort);
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
      env: authIsolatedEnv(model),
      windowsHide: true,
    });
    this.watchdog = setInterval(() => {
      if (!this.pending) return;
      const now = Date.now();
      const limit = this.sawActivity
        ? this.inactivityMs
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
          event.type === "result" ||
          // System events (init, compact_boundary) are CLI liveness: a
          // child mid-compaction is summarizing, not wedged. The pilot's
          // second auto-compaction ran 377s — past the 240s inactivity
          // limit — so without this the watchdog kills healthy sessions.
          event.type === "system"
        ) {
          this.sawActivity = true;
          this.lastActivity = Date.now();
        }
        const compaction = compactionFromStreamLine(line);
        if (compaction) this.onCompaction?.(compaction);
        const stopReason = stopReasonFromLine(line);
        if (stopReason) this.lastStopReason = stopReason;
        if (event.type === "result" && this.pending) {
          const { resolve } = this.pending;
          this.pending = null;
          resolve(event);
        }
      }
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
      // CLI retry/backoff chatter is stderr-only; a child talking on
      // stderr is not wedged. HARD_LIMIT_MS still bounds true wedges.
      this.lastActivity = Date.now();
    });
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
    this.lastStopReason = null;
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

/**
 * stop_reason carried by one stream-json line, if any. The CLI reports
 * it in `assistant` events (message.stop_reason) and in `message_delta`
 * stream events (event.delta.stop_reason); "max_tokens" means the
 * generation was cut at the output cap. Field access only — never a
 * regex over the transcript, which would false-hit model-authored text.
 */
function stopReasonFromLine(line: string): string | null {
  if (!line.startsWith("{")) return null;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      message?: { stop_reason?: string | null };
      event?: { delta?: { stop_reason?: string | null } };
    };
    if (event.type === "assistant") return event.message?.stop_reason ?? null;
    if (event.type === "stream_event")
      return event.event?.delta?.stop_reason ?? null;
  } catch {
    return null;
  }
  return null;
}

/** Last non-null stop_reason in a stream-json transcript. */
function lastStopReasonInStream(stdout: string): string | null {
  let last: string | null = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const reason = stopReasonFromLine(line.trim());
    if (reason) last = reason;
  }
  return last;
}

/**
 * CLI-side auto-compaction observed in one stream-json line, if any. The
 * CLI emits `{"type":"system","subtype":"compact_boundary","compactMetadata":
 * {"trigger":"auto","preTokens":N,"durationMs":M}}` when it summarizes the
 * conversation in place (observed live 2026-08-06, coding_markdown_v1 acq
 * pilot: two auto-compactions at preTokens 207,948 and 179,180 silently
 * replaced whole-read document content with lossy summaries). Field access
 * only, like stopReasonFromLine — never a regex over model-authored text.
 * Snake_case fallbacks cover SDK serialization variants.
 */
export type ClaudePCompactionEvent = {
  trigger: string | null;
  preTokens: number | null;
  durationMs: number | null;
};

export function compactionFromStreamLine(
  line: string,
): ClaudePCompactionEvent | null {
  if (!line.startsWith("{") || !line.includes('"compact_boundary"'))
    return null;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      compactMetadata?: {
        trigger?: string;
        preTokens?: number;
        durationMs?: number;
      };
      compact_metadata?: {
        trigger?: string;
        pre_tokens?: number;
        duration_ms?: number;
      };
    };
    if (event.type !== "system" || event.subtype !== "compact_boundary")
      return null;
    const camel = event.compactMetadata;
    const snake = event.compact_metadata;
    return {
      trigger: camel?.trigger ?? snake?.trigger ?? null,
      preTokens: camel?.preTokens ?? snake?.pre_tokens ?? null,
      durationMs: camel?.durationMs ?? snake?.duration_ms ?? null,
    };
  } catch {
    return null;
  }
}

/** Every CLI auto-compaction in a per-call stream-json transcript. */
function compactionsInStream(stdout: string): ClaudePCompactionEvent[] {
  const found: ClaudePCompactionEvent[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const event = compactionFromStreamLine(line.trim());
    if (event) found.push(event);
  }
  return found;
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

/** Preserve a problematic raw reply for post-mortem; never throws. */
function preserveRawReply(rawReply: string, label: string): string | null {
  try {
    const dir = path.join(tmpdir(), "beaver-claudep-badreplies");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `reply-${Date.now().toString(36)}-${label}.txt`);
    writeFileSync(file, rawReply, "utf8");
    return file;
  } catch {
    return null;
  }
}

/** A string value's closing quote followed only by closing brackets. */
const TAIL_CLOSER_RE = /"(?:\s*[}\]])+\s*$/u;

/** Payloads below this size keep the pre-salvage behavior exactly: small
 * structural slips regenerate cheaply and lack a dominant string to
 * salvage, so jsonrepair keeps sole authority there. */
const SALVAGE_MIN_CHARS = 4096;

/** Salvage tries at most this many openings, newest first. Real payloads
 * have a handful; pathological lookalike-dense content is quadratic
 * (2026-08-06 adversarial probe: 6000 lookalikes = 25s), so cap it. */
const MAX_SALVAGE_CANDIDATES = 64;

/** Multiset of `"key":` openings in raw text. Escaped quotes inside
 * string values cannot match (a backslash sits between the identifier
 * and its quote), so only structural keys — and raw-quote defect
 * lookalikes, which over-count and therefore fail closed — are counted. */
function keyOpeningCounts(raw: string): Map<string, number> {
  const counts = new Map<string, number>();
  const opening = /"([A-Za-z_][\w-]*)"\s*:/gu;
  for (let m = opening.exec(raw); m; m = opening.exec(raw))
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts;
}

/** Count every object property name occurrence in a parsed JSON tree. */
function parsedKeyCounts(
  value: unknown,
  counts = new Map<string, number>(),
): Map<string, number> {
  if (Array.isArray(value)) {
    for (const item of value) parsedKeyCounts(item, counts);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      parsedKeyCounts(child, counts);
    }
  }
  return counts;
}

/**
 * A repaired/salvaged parse preserves the payload iff every `"key":`
 * opening in the raw text still appears at least that many times as a
 * key in the parse. A swallowed sibling field, a dropped call, or a
 * duplicate-key collapse all surface as a shortfall (2026-08-06
 * adversarial review F1-F3: salvage silently absorbed sibling fields
 * and later calls into the draft before this check existed). One-sided
 * on purpose: repairs legitimately ADD keys the raw scan cannot see —
 * jsonrepair quoting an unquoted or single-quoted key — and forbidding
 * that only recreates refusal regressions.
 */
function inventoryPreserved(
  rawCounts: Map<string, number>,
  parsed: unknown,
): boolean {
  const parsedCounts = parsedKeyCounts(parsed);
  for (const [key, count] of rawCounts)
    if ((parsedCounts.get(key) ?? 0) < count) return false;
  return true;
}

/** The full downstream shape contract for a TOOL_CALLS parse. */
function callsShapeOk(parsed: { calls?: unknown }): boolean {
  return (
    Array.isArray(parsed.calls) &&
    parsed.calls.length > 0 &&
    parsed.calls.every((rawCall) => {
      const call = rawCall as Record<string, unknown>;
      return (
        typeof call.name === "string" &&
        !!call.input &&
        typeof call.input === "object" &&
        !Array.isArray(call.input)
      );
    })
  );
}

/**
 * Decode a JSON string body tolerantly: valid escape sequences decode,
 * invalid ones and raw specials (the defects being salvaged) pass
 * through verbatim.
 */
function lenientUnescapeJsonString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === '"' || next === "\\" || next === "/") {
      out += next;
      i += 1;
    } else if (next === "n") {
      out += "\n";
      i += 1;
    } else if (next === "t") {
      out += "\t";
      i += 1;
    } else if (next === "r") {
      out += "\r";
      i += 1;
    } else if (next === "b") {
      out += "\b";
      i += 1;
    } else if (next === "f") {
      out += "\f";
      i += 1;
    } else if (
      next === "u" &&
      /^[0-9A-Fa-f]{4}$/u.test(body.slice(i + 2, i + 6))
    ) {
      out += String.fromCharCode(parseInt(body.slice(i + 2, i + 6), 16));
      i += 5;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * End index (exclusive) of the first string-aware balanced JSON object
 * starting at `from`, or null if it never closes. Malformed strings (the
 * dominant-string defect) derail the scan, so callers must accept the
 * prefix only when it strictly parses; a generation truncated inside the
 * envelope has an unterminated string or open braces and returns null.
 */
function scanBalancedJsonPrefix(s: string, from: number): number | null {
  let depth = 0;
  let inString = false;
  for (let i = from; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

type DominantStringSalvage = {
  parsed: { calls?: unknown };
  field: string;
  valueChars: number;
};

/**
 * Structural salvage for the dominant-string parse-failure class: a large
 * TOOL_CALLS payload (in practice a generate_docx call whose `markdown`
 * carries a whole legal draft) whose only defect is invalid escaping
 * INSIDE one big string value — e.g. one raw interior double quote, which
 * on 2026-08-06 discarded a completed 60KB DPA draft and bought a ~30%
 * shorter corrective regeneration. Generic jsonrepair cannot know where
 * such a string was meant to end; the envelope does: its closing quote is
 * the last one followed only by closing brackets. Each `"key":"` opening
 * is paired with that anchor; the value is re-derived from the model's
 * own bytes (valid escapes decode, defective sequences pass through
 * verbatim — nothing is invented), re-escaped strictly, and a candidate
 * is accepted only if the whole reply then parses as strict JSON that
 * satisfies the downstream shape contract AND preserves the raw
 * payload's full key inventory. The latest surviving opening wins:
 * earlier openings would swallow sibling fields into the value (the
 * inventory check rejects them), and content-lookalike openings inside
 * the value leave the defect in their prefix and self-eliminate on the
 * strict re-parse. Truncated tails or zero survivors refuse (null) so
 * the corrective-replay path keeps owning genuinely broken generations.
 */
function salvageDominantStringField(
  raw: string,
): DominantStringSalvage | null {
  if (raw.length < SALVAGE_MIN_CHARS) return null;
  const tail = TAIL_CLOSER_RE.exec(raw);
  if (!tail) return null;
  const closeQuote = tail.index;
  const opening = /"([A-Za-z_][\w-]*)"\s*:\s*"/gu;
  const candidates: Array<{ field: string; valueStart: number }> = [];
  for (let m = opening.exec(raw); m; m = opening.exec(raw)) {
    const valueStart = m.index + m[0].length;
    if (valueStart >= closeQuote) break;
    candidates.push({ field: m[1], valueStart });
  }
  const rawCounts = keyOpeningCounts(raw);
  for (const { field, valueStart } of candidates
    .slice(-MAX_SALVAGE_CANDIDATES)
    .reverse()) {
    const logical = lenientUnescapeJsonString(
      raw.slice(valueStart, closeQuote),
    );
    const candidate =
      raw.slice(0, valueStart) +
      JSON.stringify(logical).slice(1, -1) +
      raw.slice(closeQuote);
    try {
      const parsed = JSON.parse(candidate) as { calls?: unknown };
      if (!callsShapeOk(parsed)) continue;
      if (!inventoryPreserved(rawCounts, parsed)) continue;
      return { parsed, field, valueChars: logical.length };
    } catch {
      continue;
    }
  }
  return null;
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
export function parseReply(
  text: string,
  iteration: number,
  opts?: { truncated?: boolean },
): AnthropicBlock[] {
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
  let raw = rest.slice(start, end + 1);
  // Model-continued-transcript defect (2026-08-06 indenture cell): a valid
  // TOOL_CALLS envelope followed by a hallucinated {"tool_results":...}
  // continuation and citations. first-{..last-} spans both objects, and no
  // repair path can parse the concatenation, so a completed 126KB two-call
  // envelope was discarded. The balanced scan recovers the model's own
  // first complete object; it is accepted only when it strictly parses
  // with the downstream shape, so defective-string payloads still take
  // the repair chain over the full span. This intentionally runs before
  // the truncation refusal: if the output cap hit inside the hallucinated
  // continuation, the envelope itself is complete and usable.
  const prefixEnd = scanBalancedJsonPrefix(rest, start);
  if (prefixEnd !== null && prefixEnd - start < raw.length) {
    const prefix = rest.slice(start, prefixEnd);
    try {
      const candidate = JSON.parse(prefix) as { calls?: unknown };
      if (callsShapeOk(candidate)) {
        const file = preserveRawReply(text, `continued-iter${iteration}`);
        console.warn(
          `[claude-p] TOOL_CALLS envelope followed by ${rest.length - prefixEnd} ` +
            "chars of model-continued transcript; kept the envelope, discarded " +
            `the continuation${file ? ` (original preserved at ${file})` : ""}`,
        );
        raw = prefix;
      }
    } catch {
      // Not a strict-JSON prefix — the full-span repair chain owns it.
    }
  }
  let parsed: { calls?: unknown };
  try {
    parsed = JSON.parse(raw) as { calls?: unknown };
  } catch (parseError) {
    // The transport saw the generation stop at the output cap: the JSON
    // is incomplete by construction. Neither repair path may run —
    // jsonrepair auto-closes partial structures, and the salvage anchor
    // can be faked by content that mimics the envelope tail — so a
    // partial draft must regenerate instead of passing as complete.
    if (opts?.truncated)
      throw new Error(
        "TOOL_CALLS JSON incomplete: generation stopped at the output cap " +
          `(${String((parseError as Error).message ?? parseError).slice(0, 120)})`,
      );
    // jsonrepair first: it correctly preserves all fields for small
    // structural slips anywhere in the payload (trailing commas, missing
    // closers, raw newlines in short fields). For large payloads its
    // result must preserve the raw key inventory — a repair that
    // swallowed a field or call is worse than no repair.
    let repaired: { calls?: unknown } | null = null;
    try {
      repaired = JSON.parse(jsonrepair(raw)) as { calls?: unknown };
    } catch {
      repaired = null;
    }
    if (
      repaired &&
      (raw.length < SALVAGE_MIN_CHARS ||
        inventoryPreserved(keyOpeningCounts(raw), repaired))
    ) {
      parsed = repaired;
      console.warn("[claude-p] repaired malformed TOOL_CALLS JSON");
    } else {
      const salvage = salvageDominantStringField(raw);
      if (!salvage) throw parseError;
      const file = preserveRawReply(text, `salvaged-iter${iteration}`);
      console.warn(
        `[claude-p] structurally salvaged TOOL_CALLS JSON (field "${salvage.field}", ` +
          `${salvage.valueChars} chars${file ? `; original preserved at ${file}` : ""})`,
      );
      parsed = salvage.parsed;
    }
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
  // CLI auto-compactions ride the existing StreamChatResult.compactions
  // rail (manifest passes them through; the LAB runner already ingests
  // them). A compaction silently replaces conversation content with a
  // lossy summary — on this lane that means served documents vanish from
  // context mid-run, so every event must be visible downstream.
  const compactions: LlmCompactionReceipt[] = [];
  // The session outlives loop iterations; its sink stamps events with the
  // iteration that was in flight when the CLI compacted.
  const iterBox = { iter: 0 };
  const recordCompaction = (event: ClaudePCompactionEvent) => {
    console.warn(
      `[claude-p] provider auto-compaction (trigger=${event.trigger ?? "?"}, ` +
        `preTokens=${event.preTokens ?? "?"}, iteration=${iterBox.iter}) — ` +
        "the CLI summarized the conversation in place; earlier tool results " +
        "are now lossy",
    );
    compactions.push({
      iteration: iterBox.iter,
      // The CLI does not report its threshold; preTokens is the observed
      // trigger point. Request/output fields describe harness compaction
      // requests and have no analog here; usage stays zeroed (not null)
      // because the spend is inside the turn envelope's usage and the
      // runner's null-usage path would double-count via estimates.
      thresholdTokens: 0,
      triggerInputTokens: event.preTokens ?? 0,
      triggerReason: "provider_auto",
      requestInputItems: 0,
      requestInputBytes: 0,
      requestInputSha256: "",
      requestInstructionsBytes: 0,
      requestInstructionsSha256: "",
      requestToolCount: 0,
      requestToolBytes: 0,
      requestToolSha256: "",
      outputItems: 0,
      outputBytes: 0,
      outputSha256: "",
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      latencyMs: event.durationMs ?? 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: null,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
    });
  };

  const persist = persistEnabled();
  let session: ClaudePSession | null = null;
  let priorToolKey = "";
  // Set when the previous iteration ended in tool calls: the compact
  // follow-up a live session can consume instead of a full replay.
  let continuation: string | null = null;
  try {
    for (let iter = 0; maxIter === undefined || iter < maxIter; iter++) {
      iterBox.iter = iter;
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
      // Per-attempt failure kinds. A three-failure round can mix causes
      // (HSR 2026-08-06: parse failure, then two watchdog kills of the
      // corrective replays) and the summary error must say which.
      const attemptErrors: string[] = [];
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
        const correctiveBefore = corrective;
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
          let stopReason: string | null = null;
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
                recordCompaction,
              );
            }
            envelope = await session!.turn(
              liveContinuation ? continuation! : payload,
            );
            stopReason = session!.lastStopReason;
          } else {
            const run = await runClaudeP(
              slug,
              payload,
              params.reasoningEffort,
              params.abortSignal,
            );
            // Scan before the exit-code gate: a compaction can precede a
            // failing turn, and the spend/visibility matter either way.
            for (const event of compactionsInStream(run.stdout))
              recordCompaction(event);
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
              const fatal = fatalCode(hint);
              const message = `claude -p exit ${run.code}: ${hint}`;
              throw fatal
                ? new ClaudePFatalError(message, fatal)
                : new Error(message);
            }
            envelope = resultEnvelope(run.stdout);
            stopReason = lastStopReasonInStream(run.stdout);
          }
          if (envelope.is_error) {
            const detail = String(envelope.result).slice(0, 300);
            const fatal = fatalCode(detail);
            const message = `claude -p error result: ${detail}`;
            throw fatal
              ? new ClaudePFatalError(message, fatal)
              : new Error(message);
          }
          // Typed stop when the CLI has compacted repeatedly: the turn that
          // just completed is already summaries-of-summaries, and nothing
          // else bounds the cycle. Thrown here (not in the stream callback)
          // so it rides the fatal-error path: terminal, never retried.
          if (compactions.length >= MAX_PROVIDER_COMPACTIONS) {
            throw new ClaudePFatalError(
              `claude -p provider compaction limit: ${compactions.length} ` +
                "auto-compactions this run — conversation content has been " +
                "summarized repeatedly; aborting instead of thrashing",
              "compaction_limit",
            );
          }
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
            blocks = parseReply(rawReply, iter, {
              truncated: stopReason === "max_tokens",
            });
          } catch (parseError) {
            corrective = {
              reply: rawReply,
              problem: String(
                (parseError as Error).message ?? parseError,
              ).slice(0, 200),
            };
            // A parse failure discards a COMPLETED generation (HSR lost a
            // 16-minute 58.7KB draft this way). Preserve the raw reply for
            // post-mortem/manual recovery; never let preservation mask the
            // parse error itself.
            const file = preserveRawReply(
              rawReply,
              `iter${iter}-attempt${attempt + 1}`,
            );
            if (file)
              console.warn(
                `[claude-p] parse failure on a completed generation; raw reply preserved at ${file}`,
              );
            throw parseError;
          }
        } catch (error) {
          // Deterministic failures are terminal: retrying a context overflow
          // resends the same oversized prompt, and retrying a quota wall
          // burns spawns against a hard weekly limit.
          if (error instanceof ClaudePFatalError) throw error;
          lastError = error;
          const detail = String((error as Error).message ?? error);
          // corrective is (re)assigned only inside the parseReply catch, so
          // reference inequality is an exact parse-failure marker.
          const kind =
            corrective !== correctiveBefore
              ? "parse-failure"
              : detail.includes("silent for")
                ? "watchdog-kill"
                : detail.includes("hard time limit")
                  ? "hard-limit"
                  : "transport";
          attemptErrors.push(
            `attempt ${attempt + 1}: ${kind} (${detail.slice(0, 160)})`,
          );
        }
      }
      if (!blocks)
        throw new Error(
          `claude-p transport: unparseable reply after retries: ${lastError} ` +
            `[${attemptErrors.join("; ")}]`,
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

  return { fullText, usage, contextRounds, compactions };
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
