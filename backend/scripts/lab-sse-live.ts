/**
 * Live-view a LAB run's SSE stream as it executes: reasoning traces, tool
 * calls/results, and final content — tailed from the run's raw-sse.txt as it
 * grows. The file is appended live whenever lab-beaver-arm's child process
 * sets MIKE_LLM_RAW_SSE_PATH (which it does for every run), so point this at
 * a running run and watch the model think and act in real time.
 *
 * Default is AUTO-FOLLOW: it attaches to whatever LAB run is currently
 * running under benchmarks/harvey-labs/results/ (newest run whose raw-sse.txt
 * was modified in the last 30s and that has not finished), and when that run
 * finishes or goes quiet it scans for a newer run and switches to it — so the
 * viewer stays glued to "whatever is currently running" across a batch.
 * Ctrl-C to stop.
 *
 * Usage:
 *   npx tsx scripts/lab-sse-live.ts            # auto-follow the newest running run
 *   npx tsx scripts/lab-sse-live.ts --arm mike_upstream_native_v1   # scope to an arm
 *   npx tsx scripts/lab-sse-live.ts --exclude-arm mike_upstream_native_v1  # everything but an arm
 *   npx tsx scripts/lab-sse-live.ts --task real-estate/extract-psa-key-terms/scenario-01
 *   npx tsx scripts/lab-sse-live.ts --dir <capture-dir>  # tail raw-SSE files in a
 *                                           # non-results capture dir (one per chat),
 *                                           # auto-following the newest
 *   npx tsx scripts/lab-sse-live.ts --once <path>  # attach once, stop on idle
 *   npx tsx scripts/lab-sse-live.ts --replay <path> # start from byte 0
 */
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

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
const RESCAN_MS = 2_000;

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

function isFinishedRun(runDir: string): boolean {
  return (
    existsSync(join(runDir, "metrics.json")) ||
    existsSync(join(runDir, "scores.json"))
  );
}

function rawSseActive(runDir: string): boolean {
  const p = join(runDir, "raw-sse.txt");
  if (!existsSync(p)) return false;
  return Date.now() - statSync(p).mtimeMs < REPLAY_IF_STALE_MS;
}

/**
 * Find the newest candidate run dir under RESULTS_ROOT matching optional
 * task/arm filters. Candidates are timestamp dirs named 2026-08-07T….
 * When preferRunning is true (auto-follow), running runs (raw-sse.txt touched
 * within REPLAY_IF_STALE_MS and no metrics.json yet) are preferred; the newest
 * running run wins. If none are running, the newest overall is returned so a
 * just-finished run still shows.
 */
function newestRunDir(
  task: string | null,
  arm: string | null,
  preferRunning = false,
  excludeArm: string | null = null,
): string {
  const all: { path: string; mtime: number }[] = [];
  const running: { path: string; mtime: number }[] = [];
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
        const pNorm = p.replace(/\\/g, "/");
        if (task && !pNorm.includes(task)) continue;
        if (arm && !pNorm.includes(`beaver-${arm}`)) continue;
        if (excludeArm && pNorm.includes(`beaver-${excludeArm}`)) continue;
        const mtime = statSync(p).mtimeMs;
        all.push({ path: p, mtime });
        if (rawSseActive(p) && !isFinishedRun(p)) running.push({ path: p, mtime });
      } else {
        walk(p);
      }
    }
  };
  if (existsSync(RESULTS_ROOT)) walk(RESULTS_ROOT);
  const pool = preferRunning && running.length ? running : all;
  pool.sort((a, b) => b.mtime - a.mtime);
  if (!pool.length) return "";
  return pool[0].path;
}

/**
 * Tail a raw-SSE file. Returns when the stream has been idle for IDLE_STOP_MS
 * (or immediately when the file never appeared within 120s, which exits).
 * Live semantics by default: attach at the current end. A file that stopped
 * growing >=REPLAY_IF_STALE_MS ago is replayed from the top instead.
 */
async function tailFile(filePath: string, replay: boolean): Promise<void> {
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

/** Wait until a run dir NEWER than `currentDir` appears (or differs). */
async function waitForNewerRun(
  task: string | null,
  arm: string | null,
  currentDir: string,
  excludeArm: string | null = null,
): Promise<string> {
  for (;;) {
    await sleep(RESCAN_MS);
    const next = newestRunDir(task, arm, true, excludeArm);
    if (next && next !== currentDir) return next;
  }
}

/** Auto-follow: keep attaching to whatever is currently running. */
async function followRuns(
  task: string | null,
  arm: string | null,
  replay: boolean,
  excludeArm: string | null = null,
) {
  let current = "";
  for (;;) {
    const dir = newestRunDir(task, arm, true, excludeArm);
    if (!dir) {
      if (!current) console.log(`${dim}no run dirs yet under ${RESULTS_ROOT} — waiting…${reset}`);
      await sleep(RESCAN_MS);
      continue;
    }
    if (dir !== current) {
      current = dir;
      console.log(`${yellow}${bold}══ attached to run: ${basename(dir)}${reset}`);
      await tailFile(join(dir, "raw-sse.txt"), replay);
      replay = false;
      // tailFile returned on idle. If the run is finished, wait for a newer
      // run; otherwise (just a slow pause) retry the same run after a beat.
      if (isFinishedRun(dir)) {
        console.log(`${dim}run finished — scanning for the next run…${reset}`);
        current = await waitForNewerRun(task, arm, dir, excludeArm);
      } else {
        await sleep(RESCAN_MS);
      }
    } else {
      // Same newest run; if it's finished and we've moved on, this only
      // happens transiently — wait for a newer one.
      await sleep(RESCAN_MS);
    }
  }
}

/** Tail the newest raw-SSE file in a capture directory, auto-following. */
async function followDir(dir: string) {
  let current = "";
  for (;;) {
    let newest = "";
    let newestMtime = 0;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      console.error(`${dir} not readable`);
      process.exit(1);
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(sse|txt|jsonl)$/.test(e.name)) continue;
      const p = join(dir, e.name);
      const m = statSync(p).mtimeMs;
      if (m > newestMtime) {
        newestMtime = m;
        newest = p;
      }
    }
    if (!newest) {
      if (!current) console.log(`${dim}no capture files in ${dir} — waiting…${reset}`);
      await sleep(RESCAN_MS);
      continue;
    }
    if (newest !== current) {
      current = newest;
      console.log(`${yellow}${bold}══ attached to capture: ${basename(newest)}${reset}`);
      await tailFile(newest, false);
    } else {
      await sleep(RESCAN_MS);
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  let replay = false;
  let once = false;
  let task: string | null = null;
  let arm: string | null = null;
  let excludeArm: string | null = null;
  let dir: string | null = null;
  let pathArg: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--replay") replay = true;
    else if (a === "--once") once = true;
    else if (a === "--task") task = argv[++i] ?? null;
    else if (a === "--arm") arm = argv[++i] ?? null;
    else if (a === "--exclude-arm") excludeArm = argv[++i] ?? null;
    else if (a === "--dir") dir = argv[++i] ?? null;
    else if (!a.startsWith("--")) pathArg = a;
  }

  const fail = (msg: string): never => {
    console.error(msg);
    process.exit(1);
  };

  if (dir) {
    followDir(resolve(dir)).catch((e) => fail(String(e)));
    return;
  }

  if (pathArg) {
    const p = resolve(pathArg);
    const filePath = /raw-sse\.txt$/.test(p) ? p : join(p, "raw-sse.txt");
    tailFile(filePath, replay).catch((e) => fail(String(e)));
    return;
  }

  if (once) {
    const filePath = join(newestRunDir(task, arm, false, excludeArm), "raw-sse.txt");
    if (!existsSync(filePath)) fail(`no run dirs found under ${RESULTS_ROOT}`);
    tailFile(filePath, replay).catch((e) => fail(String(e)));
    return;
  }

  // Default: auto-follow whatever is currently running.
  followRuns(task, arm, replay, excludeArm).catch((e) => fail(String(e)));
}

main();
