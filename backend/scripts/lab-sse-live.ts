/**
 * Live-view a LAB run's SSE stream as it executes: reasoning traces, tool
 * calls/results, and final content — tailed from the run's raw-sse.txt as it
 * grows. The file is appended live whenever lab-beaver-arm's child process
 * sets MIKE_LLM_RAW_SSE_PATH (which it does for every run), so point this at
 * a running run and watch the model think and act in real time.
 *
 * Usage:
 *   npx tsx scripts/lab-sse-live.ts <path-to-run-dir-or-raw-sse.txt>
 *   npx tsx scripts/lab-sse-live.ts --task real-estate/extract-psa-key-terms/scenario-01
 *   npx tsx scripts/lab-sse-live.ts --arm mike_upstream_native_v1
 *   npx tsx scripts/lab-sse-live.ts            # newest run under results/
 *   npx tsx scripts/lab-sse-live.ts --replay <path>   # start from byte 0
 *
 * Default: live (tail -f) semantics — attach at the current end of the file.
 * A file that stopped growing >=30s ago is replayed from the top instead.
 * Ctrl-C to stop.
 */
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const RESULTS_ROOT = resolve(
  __dirname,
  "..",
  "..",
  "benchmarks",
  "harvey-labs",
  "results",
);
const REPLAY_IF_STALE_MS = 30_000;
const IDLE_STOP_MS = 10_000;

// ANSI palette: reasoning dim/italic, tools cyan, ok green, ! red, meta yellow.
const dim = "\x1b[2m";
const italic = "\x1b[3m";
const reset = "\x1b[0m";
const cyan = "\x1b[36m";
const green = "\x1b[32m";
const red = "\x1b[31m";
const yellow = "\x1b[33m";
const bold = "\x1b[1m";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function summarizeInput(name: string, input: unknown): string {
  if (input == null) return "";
  const o = input as Record<string, unknown>;
  const pick = (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
  const short = (v: unknown) =>
    typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v;
  try {
    switch (name) {
      case "fetch_documents":
      case "list_documents":
        return JSON.stringify(input);
      case "read_document":
        return JSON.stringify(pick(["path", "document_id", "offset", "max_chars", "limit", "head", "tail"]));
      case "find_in_document":
      case "grep":
        return JSON.stringify(pick(["path", "pattern", "head_limit", "limit", "offset"]));
      case "edit_document":
      case "generate_docx": {
        const s = JSON.stringify(input);
        return s.length > 140 ? `${s.slice(0, 140)}…` : s;
      }
      default: {
        const s = JSON.stringify(input);
        return s.length > 160 ? `${s.slice(0, 160)}…` : s;
      }
    }
  } catch {
    return "";
  }
}

let reasoningBuf: string[] = [];
let contentBuf: string[] = [];

function flushReasoning() {
  const t = reasoningBuf.join("");
  reasoningBuf = [];
  if (t) process.stdout.write(`${dim}${italic}${t}${reset}\n\n`);
}

function flushContent() {
  const c = contentBuf.join("");
  contentBuf = [];
  if (c) process.stdout.write(`${c}\n\n`);
}

function render(ev: Record<string, unknown>) {
  const type = ev.type;
  switch (type) {
    case "reasoning_delta":
      reasoningBuf.push(String(ev.text ?? ""));
      break;
    case "reasoning_block_end":
      flushReasoning();
      break;
    case "tool_call_start": {
      const input = summarizeInput(String(ev.name ?? ""), ev.input);
      const phase = ev.phase ? ` ${dim}[${String(ev.phase)}]${reset}` : "";
      process.stdout.write(`\n${cyan}▶ ${String(ev.name)}${reset} ${input}${phase}\n`);
      break;
    }
    case "tool_call_result": {
      const ok = ev.ok === true;
      const meta = [String(ev.name ?? "tool")];
      if (ev.content_chars != null) meta.push(`${String(ev.content_chars)} chars`);
      if (ev.content_sha256) meta.push(yellow + String(ev.content_sha256).slice(0, 8) + reset);
      if (ev.error) meta.push(`error: ${String(ev.error)}`);
      const preview = ev.content_preview
        ? ` ${dim}— ${String(ev.content_preview).replace(/\s+/g, " ").slice(0, 120)}${reset}`
        : "";
      process.stdout.write(`${ok ? green : red}${ok ? "✓" : "✗"}${reset} ${meta.join(" · ")}${preview}\n`);
      break;
    }
    case "content_delta":
      contentBuf.push(String(ev.text ?? ""));
      break;
    case "content_reset":
      contentBuf = [];
      break;
    case "content_snapshot":
      contentBuf = [String(ev.text ?? "")];
      break;
    case "content_final":
      flushContent();
      break;
    case "content_done":
      process.stdout.write(`${dim}— content done —${reset}\n`);
      break;
    case "error":
      process.stdout.write(`${red}${bold}ERROR: ${String(ev.message ?? "provider error")}${reset}\n`);
      break;
    default:
      // chat_id / benchmark_surface / transcript_version / citations: skip
      break;
  }
}

function handleLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!trimmed.startsWith("data: ")) return;
  const payload = trimmed.slice("data: ".length).trim();
  if (payload === "[DONE]") {
    process.stdout.write(`${dim}— stream done —${reset}\n`);
    return;
  }
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(payload);
  } catch {
    return;
  }
  render(ev);
}

function readAll(stream: import("node:fs").ReadStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let out = "";
    stream.setEncoding("utf8");
    stream.on("data", (c: string) => (out += c));
    stream.on("end", () => resolvePromise(out));
    stream.on("error", reject);
  });
}

function newestRunDir(task: string | null, arm: string | null): string {
  const candidates: { path: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (/^\d{4}-\d{2}-\d{2}T/.test(e.name)) {
        if (task && !p.includes(task)) continue;
        if (arm && !p.includes(`beaver-${arm}`)) continue;
        candidates.push({ path: p, mtime: statSync(p).mtimeMs });
      } else {
        walk(p);
      }
    }
  };
  if (existsSync(RESULTS_ROOT)) walk(RESULTS_ROOT);
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) {
    console.error(`no run dirs found under ${RESULTS_ROOT}`);
    process.exit(1);
  }
  return candidates[0].path;
}

async function tail(filePath: string, replay: boolean) {
  const start = Date.now();
  while (!existsSync(filePath)) {
    if (Date.now() - start > 120_000) {
      console.error(`\n${filePath} never appeared within 120s`);
      process.exit(1);
    }
    await sleep(200);
  }

  let size = replay ? 0 : statSync(filePath).size;
  let stale = Date.now() - statSync(filePath).mtimeMs > REPLAY_IF_STALE_MS;
  if (!replay && stale) {
    size = 0; // finished run: replay from the top instead of tailing nothing
    replay = true;
  }
  let buf = "";
  let lastGrowth = Date.now();

  console.log(`${dim}watching ${filePath}${replay ? " (replay)" : " (live tail)"}${reset}\n`);

  while (true) {
    await sleep(120);
    let cur: number;
    try {
      cur = statSync(filePath).size;
    } catch {
      continue;
    }
    if (cur < size) {
      // file was truncated/rewritten (run finished) — restart from 0
      size = 0;
      buf = "";
    }
    if (cur > size) {
      lastGrowth = Date.now();
      const chunk = await readAll(
        createReadStream(filePath, { start: size, end: cur - 1, encoding: "utf8" }),
      );
      size = cur;
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    } else if (Date.now() - lastGrowth > IDLE_STOP_MS) {
      break;
    }
  }
  flushReasoning();
  flushContent();
  console.log(`\n${dim}— stream idle, stopped —${reset}`);
}

function main() {
  const argv = process.argv.slice(2);
  let replay = false;
  let task: string | null = null;
  let arm: string | null = null;
  let pathArg: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--replay") replay = true;
    else if (a === "--task") task = argv[++i] ?? null;
    else if (a === "--arm") arm = argv[++i] ?? null;
    else if (!a.startsWith("--")) pathArg = a;
  }

  let filePath: string;
  if (pathArg) {
    const p = resolve(pathArg);
    filePath = /raw-sse\.txt$/.test(p) ? p : join(p, "raw-sse.txt");
  } else {
    filePath = join(newestRunDir(task, arm), "raw-sse.txt");
  }
  tail(filePath, replay).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

main();
