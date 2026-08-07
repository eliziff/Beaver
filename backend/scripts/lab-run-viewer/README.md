# lab-run-viewer

Thin, zero-dependency live viewer for Harvey LAB harness run events. Serves a
self-contained dark-mode web page that renders a run's streamed trace in real
time: reasoning, content, and tool-call cards grouped by phase (start/result
paired by `id`).

**INTERIM — hand-rolled viewer.** This is a deliberately small, dependency-free
utility for tailing `raw-sse.txt` in a browser. It is **not** a long-term
observability surface. The migration path, per the repo's base-repos-preference
convention, is to stop writing bespoke line-delimited SSE and route the same
events through a mature trace backend — **Langfuse via an OTel adapter** — once
the harness emits OpenTelemetry spans. `lab-run-viewer.js` then retires (or
degenerates to a thin demo client over the OTel/OTLP stream). Do not grow this
file into a feature; grow the harness's event surface toward OTel instead.

## Files

- `lab-run-viewer.js` — Node HTTP server + SSE endpoint + auto-follow tailer
  (stdlib only).
- `index.html` — single self-contained page (inline CSS/JS, no network fetches).
- `README.md` — this file.

## Usage

```sh
node lab-run-viewer.js                  # AUTO-FOLLOW the newest running run
node lab-run-viewer.js <run-dir>        # attach to this run first, keep following
node lab-run-viewer.js --no-follow <run-dir>   # pin to one historical run
node lab-run-viewer.js --window-minutes 5      # shorter replay window (default 30)
node lab-run-viewer.js --max-events 1000       # smaller replay cap (default 3000)
node lab-run-viewer.js --port 8080      # override port (default 8123, or $PORT)
```

Open `http://localhost:8123/` — the page connects to `/events`, an SSE stream
that first replays a **bounded recent window** of the run's history, then follows
new lines as the harness appends them. `run-state.json` is polled too, so the
status chip tracks `provider_call_pending` through to typed terminal states
(`completed`/`failed`/`context_overflow`/`quota_exhausted`/`compaction_limit`).

## Auto-follow (default)

Mirrors the TUI (`lab-sse-live.ts`): the server attaches to the newest
**running** run under `results/` (its `raw-sse.txt` touched within the last
30 s, no `metrics.json` yet), replays the last `--max-events` events within the
last `--window-minutes` minutes, then tails live. When the current run finishes
or goes quiet it rescans and switches to any newer running run, so the page
stays glued to "whatever is running" across a batch. The header shows which run
is being followed. Use `--no-follow <run-dir>` to pin a single historical run
(window is skipped; only the event cap applies, so an old run still shows its
tail).

## Why it is fast now

Three changes stopped the old viewer from grinding:

- **Bounded replay.** Replay is capped at the last 3,000 events within the last
  30 minutes (both tunable). Attaching to a long run never dumps the whole file
  — the server synchronously reads the tail at attach time and follows from
  there, so a reconnect replays a snapshot, not 88k events.
- **No raw-payload dumps.** The old page rendered the *full* event JSON under
  every tool result and generic card — including the huge `evidence_spans`
  character-offset arrays (`[0,42],[43,43],…`) that made recent treatment-arm
  reads look like random bracket-number noise. Raw events are never dumped now;
  tool results show a compact ok/fail + size line and lazily expandable result
  content.
- **Lazy payloads + coalesced text.** Payload `<pre>` bodies are only built on
  click ("show"); reasoning/content deltas are buffered and flushed as one text
  node per ~150 ms window, and empty deltas are skipped entirely (a long run
  emits tens of thousands, most empty). A replay no longer materializes
  thousands of DOM nodes up front, which also fixed autoscroll: it now actually
  reaches the bottom of what's loaded.

## How it works

- **Tailer** (`lab-run-viewer.js`): polls `fs.stat` size every 250 ms (fs.watch
  is flaky on Windows) and reads only the appended byte range. A partial
  trailing line is held in a buffer until its newline lands; a malformed
  complete line is skipped silently. If the file is recreated or truncated, the
  tailer resets and pushes a `reset` event so the client clears its DOM.
- **SSE handshake**: on connect the server sends `run_attached` → `reset` →
  current `run_state` → bounded event history, all in one synchronous block, so
  reconnects replay idempotently and no event is lost or doubled.
- **Client** (`index.html`): tool calls render as cards grouped by phase,
  pairing each `tool_call_start` with its matching `tool_call_result` by `id` —
  name, phase, ok/fail, content chars, and lazily expandable input + result
  content. Reasoning/content deltas stream as coalesced readable text.
  Auto-scroll pauses on manual scroll-up; a pill and the autoscroll checkbox
  resume it.

## Run metadata

`run-state.json` is written once at run start; typed failures update it at the
end. A successful run is signaled by `metrics.json` appearing beside it — the
status chip shows `completed` in that case (the harness leaves the last written
status otherwise).

## Zero dependencies

Node standard library only (`node:http`, `node:fs`, `node:path`, global `URL`).
No `npm install`, no build step, no package.json. Runs on Node >= 22 on Windows
11.
