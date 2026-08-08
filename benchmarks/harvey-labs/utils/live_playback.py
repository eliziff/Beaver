#!/usr/bin/env python3
"""Compact, live, tabbed playback for LAB result directories."""

import argparse
import json
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from utils.stdio import force_utf8_stdio


BENCH_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = BENCH_ROOT / "results"


def _json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _events(path: Path) -> list[dict]:
    events = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return events
    for line in lines:
        if not line.startswith("data: {"):
            continue
        try:
            event = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "tool_call_start":
            args = event.get("input") or {}
            target = args.get("file_path") or args.get("filename") or args.get("pattern") or ""
            events.append({"kind": "tool", "name": event.get("name", "tool"), "target": target})
        elif kind == "doc_created":
            events.append({"kind": "document", "name": event.get("filename", "document")})
        elif kind == "content_final":
            events.append({"kind": "done", "name": "Model response"})
    return events


def collect_runs(root: Path, since_hours: float = 24, match: str = "") -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)
    runs = []
    for raw in root.rglob("raw-sse.txt"):
        if match and match not in str(raw.parent).replace("\\", "/"):
            continue
        try:
            updated = datetime.fromtimestamp(raw.stat().st_mtime, timezone.utc)
        except OSError:
            continue
        if updated < cutoff:
            continue
        run_dir = raw.parent
        state = _json(run_dir / "run-state.json")
        metrics = _json(run_dir / "metrics.json")
        events = _events(raw)
        run_id = state.get("run_id") or str(run_dir.relative_to(root)).replace("\\", "/")
        status = state.get("status") or ("running" if not metrics else "completed")
        runs.append({
            "id": run_id,
            "label": run_dir.name,
            "task": state.get("task") or metrics.get("task") or "",
            "arm": state.get("arm") or metrics.get("arm") or "",
            "model": metrics.get("model") or "",
            "status": status,
            "updated": updated.isoformat(),
            "stats": {
                "turns": metrics.get("turn_count"),
                "tools": metrics.get("tool_call_count") or sum(e["kind"] == "tool" for e in events),
                "documents": metrics.get("deliverable_count") or sum(e["kind"] == "document" for e in events),
                "input": metrics.get("input_tokens"),
                "cache": metrics.get("cache_read_input_tokens"),
                "output": metrics.get("output_tokens"),
                "seconds": metrics.get("wall_clock_seconds"),
                "failed": metrics.get("failed_tool_calls"),
            },
            "events": events,
        })
    return sorted(runs, key=lambda run: run["updated"], reverse=True)


HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>LAB live playback</title><style>
:root{color-scheme:light dark;--bg:#f5f4ef;--panel:#fff;--ink:#20242a;--muted:#6b7280;--line:#d9d6cd;--accent:#315fca;--good:#26805d;--bad:#b4532a;--mono:ui-monospace,"Cascadia Code",monospace}
@media(prefers-color-scheme:dark){:root{--bg:#10151d;--panel:#171e28;--ink:#e7ebf1;--muted:#97a2b1;--line:#303a48;--accent:#8eb1ff;--good:#71c7a6;--bad:#ef9a68}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 system-ui,sans-serif}.shell{min-height:100vh;padding:14px}.top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 auto 10px;max-width:1500px}h1{font-size:16px;margin:0}.live{color:var(--muted);font:11px var(--mono)}.tabs{display:flex;flex-wrap:wrap;gap:6px;max-width:1500px;margin:0 auto 10px}.tab{appearance:none;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted);padding:6px 9px;max-width:260px;text-align:start;cursor:pointer}.tab[aria-selected=true]{border-color:var(--accent);color:var(--ink);box-shadow:inset 0 -2px var(--accent)}.tab:active{scale:.96}.tab strong,.tab small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tab small{font:10px var(--mono)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-inline-end:6px;background:var(--good)}.done .dot{background:var(--muted)}main{max-width:1500px;margin:auto;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px}.runhead{display:flex;justify-content:space-between;gap:16px;align-items:start}.runhead h2{font-size:15px;margin:0;overflow-wrap:anywhere}.meta{color:var(--muted);font:11px var(--mono);overflow-wrap:anywhere}.stats{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.stat{background:color-mix(in srgb,var(--panel),var(--line) 25%);border-radius:6px;padding:5px 8px;min-width:72px}.stat b{display:block;font:600 13px var(--mono)}.stat span{color:var(--muted);font-size:10px}.timeline{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 10px;max-height:calc(100vh - 210px);overflow:auto;padding:2px}.event{display:contents}.kind{color:var(--muted);font:10px var(--mono);text-transform:uppercase;padding-top:3px}.event.document .kind,.event.document .detail{color:var(--good)}.event.done .kind{color:var(--accent)}.detail{min-width:0;padding:2px 0;overflow-wrap:anywhere}.detail code{font:11px var(--mono);color:var(--muted)}.empty{color:var(--muted);padding:24px;text-align:center}@media(max-width:600px){.runhead{display:block}.shell{padding:8px}.timeline{grid-template-columns:70px minmax(0,1fr)}}
</style></head><body><div class="shell"><header class="top"><h1>LAB runs</h1><span class="live" id="live">connecting</span></header><nav class="tabs" id="tabs" role="tablist" aria-label="Runs"></nav><main id="main"><div class="empty">Waiting for runs…</div></main></div><script>
let selected=location.hash.slice(1), runs=[];
const fmt=n=>n==null?'—':Intl.NumberFormat('en',{notation:n>9999?'compact':'standard',maximumFractionDigits:1}).format(n);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function draw(){if(!runs.length)return; if(!runs.some(r=>r.id===selected))selected=runs[0].id; const active=runs.find(r=>r.id===selected);
 tabs.innerHTML=runs.map(r=>`<button class="tab ${r.status==='completed'?'done':''}" role="tab" aria-selected="${r.id===selected}" data-id="${esc(r.id)}"><strong><i class="dot"></i>${esc(r.label)}</strong><small>${esc(r.arm||r.task)}</small></button>`).join('');
 tabs.querySelectorAll('button').forEach(b=>b.onclick=()=>{selected=b.dataset.id;location.hash=selected;draw()});
 const s=active.stats, cards=[['documents',s.documents],['tools',s.tools],['turns',s.turns],['input',s.input],['cache',s.cache],['output',s.output],['seconds',s.seconds],['failed',s.failed]];
 main.innerHTML=`<div class="runhead"><div><h2>${esc(active.task||active.label)}</h2><div class="meta">${esc(active.model)} · ${esc(active.arm)} · ${esc(active.id)}</div></div><div class="meta">${esc(active.status)} · ${new Date(active.updated).toLocaleTimeString()}</div></div><div class="stats">${cards.map(([k,v])=>`<div class="stat"><b>${fmt(v)}</b><span>${k}</span></div>`).join('')}</div><div class="timeline">${active.events.length?active.events.map(e=>`<div class="event ${e.kind}"><span class="kind">${esc(e.kind==='tool'?e.name:e.kind)}</span><span class="detail">${esc(e.name)}${e.target?` <code>${esc(e.target)}</code>`:''}</span></div>`).join(''):'<div class="empty">No events yet</div>'}</div>`;
 const pane=main.querySelector('.timeline');if(pane)pane.scrollTop=pane.scrollHeight;
}
async function refresh(){try{const r=await fetch('/api/runs',{cache:'no-store'});runs=await r.json();draw();live.textContent=`live · ${new Date().toLocaleTimeString()}`}catch(e){live.textContent='reconnecting'}setTimeout(refresh,1500)}refresh();
</script></body></html>"""


def make_handler(root: Path, since_hours: float, match: str = ""):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] == "/api/runs":
                body = json.dumps(collect_runs(root, since_hours, match)).encode()
                content_type = "application/json"
            elif self.path.split("?", 1)[0] == "/":
                body = HTML.encode()
                content_type = "text/html; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format, *_args):
            pass

    return Handler


def main():
    force_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=RESULTS_DIR)
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--since-hours", type=float, default=24)
    parser.add_argument("--match", default="", help="Only show run paths containing this text")
    args = parser.parse_args()
    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port),
        make_handler(args.root.resolve(), args.since_hours, args.match),
    )
    print(f"LAB live playback: http://127.0.0.1:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
