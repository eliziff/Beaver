/**
 * Thin, zero-dependency live viewer for Harvey LAB run events.
 *
 * Serves a self-contained HTML page (`index.html`, same dir) that renders a
 * LAB run's streamed SSE trace, and an `/events` SSE endpoint that replays a
 * BOUNDED recent window of the run's history on connect and then follows new
 * lines appended to raw-sse.txt in real time. Polls file size (fs.stat) rather
 * than fs.watch — the latter is flaky on Windows — and also polls
 * run-state.json so the page's status chip tracks the run through its typed
 * terminal states.
 *
 * Default is AUTO-FOLLOW, mirroring the TUI (lab-sse-live.ts): it attaches to
 * the newest RUNNING run under results/ (raw-sse.txt touched within 30s, no
 * metrics.json yet), replays the last `--max-events` events (default 3000)
 * within the last `--window-minutes` minutes (default 30), then tails live.
 * When the run finishes or goes quiet it scans for a newer run and switches —
 * so the page stays glued to "whatever is currently running" across a batch.
 * `--no-follow <run-dir>` pins it to a single historical run (window skipped;
 * only the event cap applies, so an old run still shows its tail).
 *
 * Run layout: benchmarks/harvey-labs/results/<task>/beaver-<arm>-<model>/<ts>/
 *   raw-sse.txt    line-delimited `data: {json}` SSE events, appended live
 *   run-state.json run metadata (task/arm/run_id/status), written at start
 *
 * The raw events (after the `data: ` prefix) are: chat_id, benchmark_surface,
 * reasoning_delta, reasoning_block_end, content_delta, content_final,
 * tool_call_start, tool_call_result, plus doc_created_start/doc_created/
 * transcript_version/content_done/citations and a `[DONE]` sentinel. Tool calls
 * are paired by `id` on the client and grouped by `phase`.
 *
 * Usage:
 *   node lab-run-viewer.js                  # auto-follow the newest running run
 *   node lab-run-viewer.js --no-follow <run-dir>
 *   node lab-run-viewer.js --window-minutes 5   # shorter replay window
 *   node lab-run-viewer.js --max-events 1000    # smaller replay cap (0 = no cap)
 *   node lab-run-viewer.js --port 8080          # override port (or $PORT)
 */
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const RESULTS_ROOT = path.join(
  __dirname, "..", "..", "..", "benchmarks", "harvey-labs", "results",
);
const POLL_MS = 250;            // file-growth poll cadence (fs.watch unreliable on Windows)
const RESCAN_MS = 2_000;        // follow-mode rescan cadence (TUI parity)
const RUNNING_WINDOW_MS = 30_000; // raw-sse touched within this counts as "running"
const IDLE_SWITCH_MS = 20_000;    // current run quiet this long before following a newer run
const DEFAULT_WINDOW_MS = 0;              // preserve the complete trace
const DEFAULT_MAX_EVENTS = 0;             // preserve the complete trace

let runDir = "";
let ssePath = "";
let statePath = "";
let pageHtml = "";

// Shared tail state: one tailer drives every SSE client, so late-connecting
// clients replay `events` (a parsed history snapshot) and then receive live
// appends via broadcast — no per-client file handles.
let sseOffset = 0;        // bytes of raw-sse.txt already consumed
let tailBuf = "";         // partial line still awaiting its newline
let events = [];          // {ts, ev} parsed event history (windowed + capped)
let lastStateJson = null; // last run-state.json serialization (change detection)
let sawMissing = false;   // true between file deletion and recreation
let lastGrowth = 0;       // last time the attached raw-sse grew (idle switching)
let attached = "";        // run dir currently attached to
const clients = new Set();

let windowMs = DEFAULT_WINDOW_MS;
let maxEvents = DEFAULT_MAX_EVENTS;
let follow = true;

const usage = () =>
  console.log(
    "Usage: node lab-run-viewer.js [<run-dir>] [--port N] [--window-minutes N] [--max-events N] [--no-follow]\n" +
    "  (no args)    Auto-follow the newest RUNNING run under:\n" +
    `               ${RESULTS_ROOT}\n` +
    "  <run-dir>    Attach to this run first, then keep auto-following.\n" +
    "  --no-follow  Pin to the given run dir (or newest run) and never switch.\n" +
    "  --window-minutes N  Replay window on connect (default 30; 0 = whole history).\n" +
    "  --max-events N      Hard cap on replayed events (default 3000; 0 = no cap).\n" +
    "  --port N     HTTP port (default 8123, or $PORT).",
  );

/** True when a run's raw-sse.txt was written within RUNNING_WINDOW_MS. */
function rawSseActive(dir) {
  const p = path.join(dir, "raw-sse.txt");
  try {
    return Date.now() - fs.statSync(p).mtimeMs < RUNNING_WINDOW_MS;
  } catch {
    return false;
  }
}

/** A run is finished once metrics.json (or scores.json) appears beside it. */
function isFinishedRun(dir) {
  return (
    fs.existsSync(path.join(dir, "metrics.json")) ||
    fs.existsSync(path.join(dir, "scores.json"))
  );
}

/**
 * Find the newest candidate run dir under RESULTS_ROOT. Candidates are the
 * timestamp dirs (named 2026-08-07T…). When preferRunning is true (auto-follow),
 * running runs (raw-sse.txt touched within RUNNING_WINDOW_MS and not finished)
 * are preferred; the newest running run wins. If none are running, the newest
 * overall is returned so a just-finished run still shows. Mirrors lab-sse-live.
 */
function newestRunDir(preferRunning) {
  const all = [];
  const running = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (/^\d{4}-\d{2}-\d{2}T/.test(e.name)) {
        let mtime;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          continue; // run dir mid-creation/deletion — skip, rescan catches it
        }
        if (!fs.existsSync(path.join(p, "raw-sse.txt"))) continue;
        all.push({ path: p, mtime });
        if (rawSseActive(p) && !isFinishedRun(p)) running.push({ path: p, mtime });
      } else {
        walk(p);
      }
    }
  };
  if (fs.existsSync(RESULTS_ROOT)) walk(RESULTS_ROOT);
  const pool = preferRunning && running.length ? running : all;
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool.length ? pool[0].path : "";
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null; // missing or mid-write — caller retries next poll
  }
}

function broadcast(ev) {
  const line = "data: " + JSON.stringify(ev) + "\n\n";
  for (const res of clients) {
    if (res.writableEnded || res.destroyed) {
      clients.delete(res);
      continue;
    }
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Parse raw-SSE text into [{ts, ev}] entries. A malformed complete line is
 * skipped silently and the stream keeps going; `[DONE]` becomes a done event.
 * All entries get the same `ts` stamp (chunk read time, or the file mtime for
 * an already-stale run) so the replay window can age them out.
 */
function parseText(text, stamp) {
  const out = [];
  let line;
  let from = 0;
  while ((line = text.indexOf("\n", from)) >= 0) {
    const trimmed = text.slice(from, line).trim();
    from = line + 1;
    if (!trimmed || !trimmed.startsWith("data: ")) continue;
    const payload = trimmed.slice("data: ".length).trim();
    let ev;
    if (payload === "[DONE]") {
      ev = { type: "done" };
    } else {
      try {
        ev = JSON.parse(payload);
      } catch {
        continue; // malformed/truncated line — skip and keep going
      }
    }
    out.push({ ts: stamp, ev });
  }
  return out;
}

/** Drop events outside the replay window and beyond the cap (from the front). */
function applyBounds() {
  if (windowMs > 0) {
    const cut = Date.now() - windowMs;
    while (events.length && events[0].ts < cut) events.shift();
  }
  if (maxEvents > 0 && events.length > maxEvents) {
    events.splice(0, events.length - maxEvents);
  }
}

// Consume complete lines from tailBuf into `events` (stamped now) and broadcast
// each kept event. A line still missing its trailing newline stays buffered.
function processLines() {
  const stamp = Date.now();
  let idx;
  while ((idx = tailBuf.indexOf("\n")) >= 0) {
    const line = tailBuf.slice(0, idx).trim();
    tailBuf = tailBuf.slice(idx + 1);
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    let ev;
    if (payload === "[DONE]") {
      ev = { type: "done" };
    } else {
      try {
        ev = JSON.parse(payload);
      } catch {
        continue; // malformed/truncated line — skip and keep going
      }
    }
    events.push({ ts: stamp, ev });
    if (windowMs > 0 || maxEvents > 0) {
      // Keep the buffer bounded as the run streams: drop an old event for
      // every new one once the cap is reached, so a long live run never grows
      // the replayed snapshot unboundedly.
      applyBounds();
    }
    broadcast(ev);
  }
}

function resetTail() {
  sseOffset = 0;
  tailBuf = "";
  events.length = 0;
  broadcast({ type: "reset" });
}

/**
 * Switch the viewer to `dir`: reset all tail state, synchronously replay a
 * bounded window of the run's existing raw-sse.txt (so attaching to a long or
 * old run never floods the client with the whole file), then let the poll loop
 * follow new appends. `stale` means the file is not being written right now —
 * the bulk replay is stamped with the file mtime so a run finished more than
 * the window ago correctly shows "no recent events".
 */
function attachTo(dir, stale) {
  if (dir === attached) return;
  attached = dir;
  runDir = dir;
  ssePath = path.join(dir, "raw-sse.txt");
  statePath = path.join(dir, "run-state.json");
  sawMissing = false;
  lastStateJson = null;
  lastGrowth = Date.now();

  let replay = [];
  let offset = 0;
  try {
    const text = fs.readFileSync(ssePath, "utf8");
    const stamp = stale ? fs.statSync(ssePath).mtimeMs : Date.now();
    replay = parseText(text, stamp);
    offset = fs.statSync(ssePath).size;
  } catch {
    replay = []; // file not there yet (a run is just starting) — poll will catch it
  }
  events = replay;
  if (windowMs > 0 || maxEvents > 0) applyBounds();
  tailBuf = "";
  sseOffset = offset;

  console.log(
    `[lab-run-viewer] attached to run: ${path.basename(dir)}` +
      ` (replay ${events.length} events${stale ? ", stale run" : ""})`,
  );
  broadcast({ type: "run_attached", run_dir: runDir, stale });
  broadcast({ type: "reset" });
  const state = readState();
  if (state) broadcast({ type: "run_state", data: state });
  for (const { ev } of events) broadcast(ev);
}

function poll() {
  // 1. raw-sse.txt growth (live appends only — attachTo already consumed the tail).
  let cur;
  try {
    cur = fs.statSync(ssePath).size;
  } catch {
    cur = -1;
  }
  if (cur >= 0) {
    if (sawMissing || cur < sseOffset) {
      // File was recreated/truncated (e.g. a new run reusing the path).
      sawMissing = false;
      resetTail();
    }
    if (cur > sseOffset) {
      lastGrowth = Date.now();
      let chunk = "";
      try {
        const fd = fs.openSync(ssePath, "r");
        const buf = Buffer.alloc(cur - sseOffset);
        const n = fs.readSync(fd, buf, 0, buf.length, sseOffset);
        fs.closeSync(fd);
        chunk = buf.subarray(0, n).toString("utf8");
        sseOffset += n;
      } catch {
        // Transient read error while the file churns — retry next poll.
      }
      if (chunk) {
        tailBuf += chunk;
        processLines();
      }
    }
  } else {
    sawMissing = true; // file gone — wait for it to reappear, then reset
  }

  // 2. run-state.json — broadcast on any change (status transitions).
  const state = readState();
  const json = state ? JSON.stringify(state) : null;
  if (json && json !== lastStateJson) {
    lastStateJson = json;
    broadcast({ type: "run_state", data: state });
  }

  // 3. Auto-follow: once the current run stops growing (or finishes) and a
  //    newer running run appears, switch to it — the browser equivalent of the
  //    TUI's followRuns loop.
  if (follow && (Date.now() - lastGrowth > IDLE_SWITCH_MS || isFinishedRun(runDir))) {
    const next = newestRunDir(true);
    if (next && next !== attached) attachTo(next, !rawSseActive(next));
  }

  // 4. Idle keepalive so proxies/timeouts never drop a quiet SSE connection.
  if (Date.now() - lastKeepAlive > 10_000) {
    lastKeepAlive = Date.now();
    for (const res of clients) {
      if (res.writableEnded || res.destroyed) continue;
      try {
        res.write(": keepalive\n\n");
      } catch {
        /* disconnected mid-write — poll cleanup handles it */
      }
    }
  }
}

function onEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  clients.add(res);
  res.on("close", () => clients.delete(res));
  // Handshake: reset clears the client DOM (so reconnect/replay is idempotent),
  // then current run state, then the bounded event history. The add-to-clients
  // and replay happen in one synchronous block, so no poll can interleave and
  // every event reaches the client exactly once.
  let out = "data: " + JSON.stringify({ type: "run_attached", run_dir: runDir, stale: !rawSseActive(runDir) }) + "\n\n";
  out += "data: " + JSON.stringify({ type: "reset" }) + "\n\n";
  const state = readState();
  if (state) {
    out += "data: " + JSON.stringify({ type: "run_state", data: state }) + "\n\n";
  }
  for (const { ev } of events) {
    out += "data: " + JSON.stringify(ev) + "\n\n";
  }
  try {
    res.write(out);
  } catch {
    clients.delete(res);
  }
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageHtml);
      return;
    }
    if (pathname === "/events") {
      onEvents(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  // SSE holds the response open; disable Node's idle/timeout guards that would
  // otherwise kill long-lived connections.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  server.listen(port, () => {
    console.log(`[lab-run-viewer] serving ${runDir} (follow=${follow}, window=${windowMs / 60000}min, maxEvents=${maxEvents})`);
    console.log(`  page:   http://localhost:${port}/`);
    console.log(`  events: http://localhost:${port}/events  (SSE)`);
  });

  process.on("SIGINT", () => {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

function main() {
  const argv = process.argv.slice(2);
  let port = Number(process.env.PORT) || 8123;
  let dirArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i] ?? port) || port;
    else if (a === "--window-minutes") windowMs = Number(argv[++i] ?? 0) * 60_000 || 0;
    else if (a === "--max-events") maxEvents = Number(argv[++i] ?? 0) || 0;
    else if (a === "--no-follow") follow = false;
    else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else if (!a.startsWith("-")) dirArg = a;
  }

  const pagePath = path.join(__dirname, "index.html");
  try {
    pageHtml = fs.readFileSync(pagePath, "utf8");
  } catch {
    console.error(`[lab-run-viewer] missing ${pagePath} — expected beside this script`);
    process.exit(1);
  }

  if (dirArg) {
    attachTo(path.resolve(dirArg), false);
  } else {
    // Auto-follow: attach to the newest running run (or newest overall if none
    // running); if none exist yet, wait — the follow loop picks one up.
    const detected = newestRunDir(true) || newestRunDir(false);
    if (detected) attachTo(detected, !rawSseActive(detected));
    else console.log(`[lab-run-viewer] no run dirs yet under ${RESULTS_ROOT} — waiting for one…`);
  }

  lastKeepAlive = Date.now();
  setInterval(poll, POLL_MS);
  startServer(port);
}

let lastKeepAlive = Date.now();
main();
