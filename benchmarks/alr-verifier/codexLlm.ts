// `llm` implementation for the ALR verifier pipeline backed by `codex exec`.
// Each completion is one ephemeral, read-only codex turn whose final message is
// constrained by --output-schema; token usage comes from the turn.completed
// JSON event. Answers are recorded once per (model, effort, messages, schema)
// and replayed on later runs, so iterating on the pipeline does not re-spend.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CODEX_ARMS = {
  "luna-max": { model: "gpt-6-luna", effort: "max" },
  "sol-low": { model: "gpt-6.1-sol", effort: "low" },
} as const;
export type CodexArm = keyof typeof CODEX_ARMS;

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };
export type LlmUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
};
export type LlmResult = { text: string; usage: LlmUsage };
export type Llm = {
  complete(messages: LlmMessage[], options?: { schema?: unknown; name?: string }): Promise<LlmResult>;
};

export class UsageLimitError extends Error {}

export type CodexLlmStats = {
  calls: number;
  replayed: number;
  failures: number;
  wallMs: number;
  usage: LlmUsage;
};

// npm installs codex as a .cmd shim on Windows, which cannot be spawned
// without a shell (and a shell would split paths with spaces); run its JS entry.
function codexCommand(): [string, string[]] {
  if (process.platform !== "win32") return ["codex", []];
  const entry = join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  return [process.execPath, [entry]];
}

const LIMIT_PATTERN = /usage limit|rate limit|quota|too many requests|limit reached|429/i;

function emptyUsage(): LlmUsage {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
}

export function cacheAdjustedTokens(usage: LlmUsage): number {
  return usage.input_tokens - usage.cached_input_tokens + 0.1 * usage.cached_input_tokens + usage.output_tokens;
}

export function createCodexLlm(options: {
  arm: CodexArm;
  workDir: string;
  receiptsPath: string;
  concurrency?: number;
  replay?: boolean;
}): Llm & { stats: CodexLlmStats } {
  const { model, effort } = CODEX_ARMS[options.arm];
  const workDir = resolve(options.workDir);
  const cacheDir = join(workDir, "answers");
  const scratch = join(workDir, "turns");
  const emptyCwd = join(workDir, "cwd");
  for (const dir of [cacheDir, scratch, emptyCwd]) mkdirSync(dir, { recursive: true });
  const stats: CodexLlmStats = { calls: 0, replayed: 0, failures: 0, wallMs: 0, usage: emptyUsage() };
  const limit = Math.max(1, options.concurrency ?? 6);
  let active = 0;
  const waiting: Array<() => void> = [];
  let stopped: UsageLimitError | null = null;

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((done) => waiting.push(done));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  function add(usage: LlmUsage) {
    for (const key of Object.keys(usage) as Array<keyof LlmUsage>) stats.usage[key] += usage[key];
  }

  function runTurn(key: string, system: string, prompt: string, schema: unknown): Promise<LlmResult> {
    const instructions = join(scratch, `${key}.instructions.md`);
    const schemaPath = join(scratch, `${key}.schema.json`);
    writeFileSync(instructions, system || "Answer the request with the requested JSON.", "utf8");
    writeFileSync(schemaPath, JSON.stringify(schema ?? { type: "object", additionalProperties: false, properties: { text: { type: "string" } }, required: ["text"] }), "utf8");
    const args = [
      "exec", "-m", model, "-c", `model_reasoning_effort=${effort}`,
      "-c", `model_instructions_file=${JSON.stringify(instructions.replace(/\\/g, "/"))}`,
      "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
      "--ignore-user-config", "-C", emptyCwd,
      "--disable", "apps", "--disable", "browser_use", "--disable", "computer_use",
      "--disable", "goals", "--disable", "hooks",
      "--output-schema", schemaPath, "--json", "-",
    ];
    return new Promise((resolveTurn, reject) => {
      const [command, prefix] = codexCommand();
      const child = spawn(command, [...prefix, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        let text = "";
        let usage: LlmUsage | null = null;
        const errors: string[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim().startsWith("{")) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "item.completed" && event.item?.type === "agent_message") text = String(event.item.text ?? "");
          if (event.type === "turn.completed" && event.usage) {
            usage = {
              input_tokens: Number(event.usage.input_tokens ?? 0),
              cached_input_tokens: Number(event.usage.cached_input_tokens ?? 0),
              output_tokens: Number(event.usage.output_tokens ?? 0),
              reasoning_tokens: Number(event.usage.reasoning_output_tokens ?? 0),
            };
          }
          if (event.type === "error" || event.type === "turn.failed") errors.push(JSON.stringify(event.error ?? event.message ?? event));
        }
        if (usage && text) return resolveTurn({ text, usage });
        const detail = `${errors.join(" | ")} ${stderr.slice(-2000)}`.trim();
        if (LIMIT_PATTERN.test(detail)) return reject(new UsageLimitError(`codex ${model} refused the turn: ${detail}`));
        reject(new Error(`codex ${model} exited ${code} without a completed turn: ${detail}`));
      });
      child.stdin.end(prompt, "utf8");
    });
  }

  async function complete(messages: LlmMessage[], callOptions: { schema?: unknown; name?: string } = {}): Promise<LlmResult> {
    if (stopped) throw stopped;
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const prompt = messages.filter((m) => m.role !== "system")
      .map((m) => (m.role === "user" ? m.content : `Earlier assistant reply:\n${m.content}`)).join("\n\n");
    const key = createHash("sha256").update(JSON.stringify([model, effort, system, prompt, callOptions.schema ?? null])).digest("hex");
    const recorded = join(cacheDir, `${key}.json`);
    if (options.replay !== false && existsSync(recorded)) {
      const saved = JSON.parse(readFileSync(recorded, "utf8")) as LlmResult;
      stats.replayed += 1;
      add(saved.usage);
      return saved;
    }
    return slot(async () => {
      if (stopped) throw stopped;
      const started = Date.now();
      let result: LlmResult | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
        try {
          result = await runTurn(key, system, prompt, callOptions.schema);
        } catch (error) {
          lastError = error;
          if (error instanceof UsageLimitError) {
            stopped = error;
            throw error;
          }
        }
      }
      const elapsed = Date.now() - started;
      stats.wallMs += elapsed;
      if (!result) {
        stats.failures += 1;
        appendFileSync(options.receiptsPath, JSON.stringify({ key, model, effort, name: callOptions.name ?? "", ok: false, error: String(lastError), elapsed_ms: elapsed }) + "\n");
        throw lastError;
      }
      stats.calls += 1;
      add(result.usage);
      writeFileSync(recorded, JSON.stringify(result), "utf8");
      appendFileSync(options.receiptsPath, JSON.stringify({ key, model, effort, name: callOptions.name ?? "", ok: true, elapsed_ms: elapsed, ...result.usage }) + "\n");
      return result;
    });
  }

  return { complete, stats };
}
