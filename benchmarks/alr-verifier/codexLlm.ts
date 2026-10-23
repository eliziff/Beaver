// `llm` implementation for the ALR verifier pipeline backed by `codex exec`.
// Each completion is one ephemeral, read-only codex turn whose final message is
// constrained by --output-schema; token usage comes from the turn.completed
// JSON event. Answers are recorded once per (model, effort, messages, schema)
// and replayed on later runs, so iterating on the pipeline does not re-spend.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CODEX_ARMS = {
  "luna-max": { model: "gpt-6-luna", effort: "max" },
  "sol-low": { model: "gpt-6.1-sol", effort: "low" },
  "terra-low": { model: "gpt-5.6-terra", effort: "low" },
} as const;
export type CodexArm = keyof typeof CODEX_ARMS;

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };
export type LlmUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
};
export type SourceReaderInput = { documents: string[]; checks: Record<string, number> };
export type SourceRead = { check_id: string; tool: string; spans: [number, number][] };
export type LlmResult = { text: string; usage: LlmUsage; sourceReads?: SourceRead[] };
type CompletionOptions = { schema?: unknown; name?: string; sourceReader?: SourceReaderInput };
export type Llm = {
  complete(messages: LlmMessage[], options?: CompletionOptions): Promise<LlmResult>;
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

// Only model turns run remotely; source lookup and gold writes stay with the coordinator.
const REMOTE_TURN = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  let directory, child, timer;
  try {
    const request = JSON.parse(input);
    const root = path.resolve(os.homedir(), 'Desktop', 'MikeOSS Fork', '.tmp', 'alr-codex');
    fs.mkdirSync(root, {recursive:true});
    directory = fs.mkdtempSync(path.join(root, 'turn-'));
    if (path.dirname(directory) !== root) throw Error('Invalid owned scratch path');
    const instructions = path.join(directory, 'instructions.md'), schema = path.join(directory, 'schema.json');
    fs.writeFileSync(instructions, request.system || 'Answer the request with the requested JSON.'); fs.writeFileSync(schema, JSON.stringify(request.schema));
    const args = request.args.map((arg, index) => arg.startsWith('model_instructions_file=')
      ? 'model_instructions_file=' + JSON.stringify(instructions.replaceAll('\\\\','/'))
      : request.args[index-1] === '--output-schema' ? schema : request.args[index-1] === '-C' ? directory : arg);
    const readLog = path.join(directory, 'reads.jsonl');
    if (request.source_reader) {
      const program = path.join(directory, 'reader.cjs'), data = path.join(directory, 'sources.json');
      fs.writeFileSync(program, request.reader_program); fs.writeFileSync(data, JSON.stringify(request.source_reader));
      args.push('-c', 'mcp_servers.quote_sources.command=' + JSON.stringify(process.execPath.replaceAll('\\\\','/')),
        '-c', 'mcp_servers.quote_sources.args=' + JSON.stringify([program, data, readLog].map(p => p.replaceAll('\\\\','/'))),
        '-c', 'mcp_servers.quote_sources.required=true', '-c', 'mcp_servers.quote_sources.default_tools_approval_mode="approve"');
    }
    const env = {...process.env}; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    if (request.codex_home) {
      if (!path.isAbsolute(request.codex_home) || !fs.existsSync(path.join(request.codex_home, 'auth.json'))) throw Error('Remote Codex home must contain an existing login');
      env.CODEX_HOME = request.codex_home;
    }
    child = spawn(process.execPath, [path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...args], {stdio:['pipe','pipe','pipe'], windowsHide:true, env});
    timer = setTimeout(() => child.kill(), request.timeout_ms);
    process.on('SIGTERM', () => child.kill()); process.on('SIGINT', () => child.kill());
    process.stdout.on('error', () => child.kill());
    child.stdout.pipe(process.stdout, {end:false}); child.stderr.pipe(process.stderr); child.stdin.end(request.prompt);
    process.exitCode = await new Promise((resolve,reject) => { child.on('error',reject); child.on('close',code => resolve(code ?? 1)); });
    if (fs.existsSync(readLog)) process.stdout.write(JSON.stringify({type:'source.reads', reads:fs.readFileSync(readLog,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)}) + '\\n');
  } catch(error) { console.error(String(error)); process.exitCode = 1; }
  finally { clearTimeout(timer); if(directory) fs.rmSync(directory,{recursive:true,force:true}); }
});`;

const LIMIT_PATTERN = /usage limit|rate limit|quota|too many requests|limit reached|429/i;

function emptyUsage(): LlmUsage {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
}

export function createCodexLlm(options: {
  arm: CodexArm;
  workDir: string;
  receiptsPath: string;
  concurrency?: number;
  replay?: boolean;
  timeoutMs?: number;
  remoteHost?: string;
  remoteCodexHome?: string;
}): Llm & { stats: CodexLlmStats } {
  const { model, effort } = CODEX_ARMS[options.arm];
  if (options.remoteHost && !/^[a-zA-Z0-9][\w.-]*$/.test(options.remoteHost)) throw new Error("Invalid SSH host alias");
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
  let nextRemoteStart = 0;

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

  async function runTurn(key: string, system: string, prompt: string, schema: unknown, sourceReader?: SourceReaderInput): Promise<LlmResult> {
    if (options.remoteHost) {
      // OpenSSH limits simultaneous unauthenticated connections; spread the burst.
      const delay = Math.max(0, nextRemoteStart - Date.now());
      nextRemoteStart = Date.now() + delay + 500;
      if (delay) await new Promise(done => setTimeout(done, delay));
    }
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
      "--disable", "multi_agent", "--disable", "multi_agent_v2", "--disable", "view_image",
      // Only an explicitly supplied source reader is available; no general tools.
      "--disable", "shell_tool", "--disable", "image_generation", "--disable", "skill_search",
      "--disable", "sleep_tool", "-c", "web_search=\"disabled\"",
      "--output-schema", schemaPath, "--json", "-",
    ];
    const dataPath = join(scratch, `${key}.sources.json`), readLog = join(scratch, `${key}.reads.jsonl`);
    const readerProgram = sourceReader ? readFileSync(join(import.meta.dirname, "quoteSourceReader.cjs"), "utf8") : undefined;
    if (sourceReader && !options.remoteHost) {
      writeFileSync(dataPath, JSON.stringify(sourceReader), "utf8");
      args.push("-c", `mcp_servers.quote_sources.command=${JSON.stringify(process.execPath.replaceAll("\\", "/"))}`,
        "-c", `mcp_servers.quote_sources.args=${JSON.stringify([join(import.meta.dirname, "quoteSourceReader.cjs"), dataPath, readLog].map(p => p.replaceAll("\\", "/")))}`,
        "-c", "mcp_servers.quote_sources.required=true", "-c", 'mcp_servers.quote_sources.default_tools_approval_mode="approve"');
    }
    return new Promise((resolveTurn, reject) => {
      const [command, prefix] = options.remoteHost ? ["ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", options.remoteHost,
        `node -e "eval(Buffer.from('${Buffer.from(REMOTE_TURN).toString("base64")}','base64').toString('utf8'))"`]] : codexCommand();
      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      const child = spawn(command, options.remoteHost ? prefix : [...prefix, ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 300_000);
      const cleanup = () => {
        clearTimeout(timer);
        for (const file of [instructions, schemaPath, dataPath, readLog]) rmSync(file, { force: true });
      };
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdin.on("error", (error) => { stderr += String(error); });
      child.on("error", (error) => { cleanup(); reject(error); });
      child.on("close", (code) => {
        const sourceReads: SourceRead[] = existsSync(readLog) ? readFileSync(readLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
        cleanup();
        if (timedOut) return reject(new Error(`codex ${model} timed out`));
        let text = "";
        let usage: LlmUsage | null = null;
        const errors: string[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim().startsWith("{")) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "item.completed" && event.item?.type === "agent_message") text = String(event.item.text ?? "");
          if (event.type === "source.reads") sourceReads.push(...event.reads);
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
        if (code === 0 && usage && text) return resolveTurn({ text, usage, ...(sourceReader ? { sourceReads } : {}) });
        const detail = `${errors.join(" | ")} ${stderr.slice(-2000)}`.trim();
        if (LIMIT_PATTERN.test(detail)) return reject(new UsageLimitError(`codex ${model} refused the turn: ${detail}`));
        reject(new Error(`codex ${model} exited ${code} without a completed turn: ${detail}`));
      });
      child.stdin.end(options.remoteHost ? JSON.stringify({ system, prompt, schema: schema ?? { type: "object", additionalProperties: false, properties: { text: { type: "string" } }, required: ["text"] }, args, timeout_ms: options.timeoutMs ?? 300_000, codex_home: options.remoteCodexHome,
        source_reader: sourceReader, reader_program: readerProgram }) : prompt, "utf8");
    });
  }

  async function complete(messages: LlmMessage[], callOptions: CompletionOptions = {}): Promise<LlmResult> {
    if (stopped) throw stopped;
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const prompt = messages.filter((m) => m.role !== "system")
      .map((m) => (m.role === "user" ? m.content : `Earlier assistant reply:\n${m.content}`)).join("\n\n");
    const readerHash = callOptions.sourceReader ? createHash("sha256").update(readFileSync(join(import.meta.dirname, "quoteSourceReader.cjs")))
      .update(JSON.stringify(callOptions.sourceReader)).digest("hex") : null;
    const key = createHash("sha256").update(JSON.stringify([model, effort, system, prompt, callOptions.schema ?? null, ...(readerHash ? [readerHash] : [])])).digest("hex");
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
          result = await runTurn(key, system, prompt, callOptions.schema, callOptions.sourceReader);
        } catch (error) {
          lastError = error;
          if (error instanceof UsageLimitError) {
            stopped = error;
            stats.failures += 1;
            appendFileSync(options.receiptsPath, JSON.stringify({ key, model, effort, host: options.remoteHost ?? "local", name: callOptions.name ?? "", ok: false, error: String(error), elapsed_ms: Date.now() - started }) + "\n");
            throw error;
          }
        }
      }
      const elapsed = Date.now() - started;
      stats.wallMs += elapsed;
      if (!result) {
        stats.failures += 1;
        appendFileSync(options.receiptsPath, JSON.stringify({ key, model, effort, host: options.remoteHost ?? "local", name: callOptions.name ?? "", ok: false, error: String(lastError), elapsed_ms: elapsed }) + "\n");
        throw lastError;
      }
      stats.calls += 1;
      add(result.usage);
      writeFileSync(recorded, JSON.stringify(result), "utf8");
      appendFileSync(options.receiptsPath, JSON.stringify({ key, model, effort, host: options.remoteHost ?? "local", name: callOptions.name ?? "", ok: true, elapsed_ms: elapsed, source_tool_calls: result.sourceReads?.length ?? 0, ...result.usage }) + "\n");
      return result;
    });
  }

  return { complete, stats };
}
