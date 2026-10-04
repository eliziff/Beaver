#!/usr/bin/env python3
"""Run ALR verifier arms on the private benchmark inputs.

    python run.py baseline                 # current Python app, Free mode (no model calls)
    python run.py arm free                 # new pipeline, free mode
    python run.py arm sol-low --mode high_accuracy
    python run.py arm luna-max --mode ultra_economy

Each arm writes one latest folder, benchmarks/local-data/alr-verifier/arms/<arm>/,
holding one payload per document in the Python live-benchmark shape that
score.py feeds to the Python scorers. Model arms go through `codex exec`
(codexArm.ts) and record answers once, so a rerun after a pipeline fix replays
unchanged prompts and only spends on prompts that changed.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from suite import ALR, HERE, REPO, SUITE

ARMS = SUITE / "arms"
PYTHON = SUITE / ".venv" / "Scripts" / "python.exe"
TSX = [shutil.which("node") or "node", str(REPO / "node_modules" / "tsx" / "dist" / "cli.mjs")]


def inputs() -> list[Path]:
    docs = json.loads((SUITE / "inputs" / "manifest.json").read_text(encoding="utf-8"))["documents"]
    paths = sorted({REPO / d["input"] for d in docs if d.get("input")})
    return paths + [SUITE / "inputs" / "split-gold" / "split-gold-footnotes.docx"]


def baseline(args) -> None:
    """Python app, Free mode. Lean = splitting/links only (the Python benchmark's own
    default); --app = the whole app in local-only mode (quote checks, local A2AJ)."""
    out = ARMS / ("python-free-app" if args.app else "python-free")
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    cache = SUITE / "python-cache"
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    for path in inputs():
        target = out / f"{path.stem}.json"
        started = time.time()
        runner = [str(HERE / "python_app_local.py")] if args.app else ["dev/benchtools/benchmark_live_hybrid_docx.py"]
        extra = ["--execution", "app", "--workbook-output", str(SUITE / "raw" / out.name / f"[CHECKED] {path.stem}.xlsx")] if args.app else ["--execution", "lean"]
        proc = subprocess.run(
            [str(PYTHON), *runner, "run", "--input", str(path),
             "--mode", "free", "--supra-linking", "safe", "--cache-dir", str(cache),
             "--output", str(target), *extra],
            cwd=ALR, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode:
            print(proc.stdout[-3000:], proc.stderr[-3000:], file=sys.stderr)
            raise SystemExit(f"python baseline failed on {path.name}")
        payload = json.loads(target.read_text(encoding="utf-8"))
        payload["metrics"]["process_s"] = round(time.time() - started, 3)
        target.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"python-free {path.name}: {payload['metrics']['parts']} parts, {payload['metrics']['elapsed_s']}s", flush=True)


def workbook_rows(path: Path) -> list[dict]:
    """Read the delivered workbook's FootnoteReferences sheet as Python row dicts.

    Scoring the workbook (not an in-memory side channel) grades exactly what a
    user receives. The diagnostic columns carry the Python row keys; the
    displayed `Citation` cell is the citation part's original text.
    """
    import openpyxl

    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = book["FootnoteReferences"]
    lines = sheet.iter_rows(values_only=True)
    header = [str(h or "") for h in next(lines)]
    rows = []
    for values in lines:
        cell = {h: ("" if v is None else v) for h, v in zip(header, values)}
        if not any(str(v).strip() for v in cell.values()):
            continue
        row = dict(cell)
        row["footnote_id"] = int(str(cell.get("footnote_internal_id") or cell.get("footnote_id") or 0))
        row["citation_part_index"] = int(str(cell.get("citation_part_index") or 1))
        row["citation_part_text"] = str(cell.get("Citation") or "")
        for key in ("pinpoint_fragments", "page_pinpoints"):
            try:
                row[key] = json.loads(str(cell.get(key) or "[]"))
            except ValueError:
                row[key] = []
        rows.append(row)
    book.close()
    return rows


def to_payload(run: dict, workbook: Path, source: Path) -> dict:
    """Arrange one alr-verify document in the Python live-benchmark payload shape."""
    rows = workbook_rows(workbook)
    return {
        "source_doc": source.name,
        "records": [],  # score.py uses the Python app's record list for footnote identity
        "arm": {"rows": rows, "fallbacks": [], "replacements": {}},
        "summary": run.get("summary"),
        "missingSources": run.get("missingSources"),
        "sourceFailures": run.get("sourceFailures"),
        "pipeline_usage": run.get("usage"),
        "metrics": {
            "elapsed_s": round(float(run.get("seconds") or 0), 3),
            "parts": len(rows),
            "pipeline_model_calls": run.get("modelCalls"),
        },
    }


def arm(args) -> None:
    name = args.arm if args.arm == "free" else f"{args.arm}-{args.mode}"
    out = ARMS / name
    raw = SUITE / "raw" / name
    for folder in (out, raw):
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True)
    env = {**os.environ, "ALR_EVAL_LABEL": name}
    command = [*TSX, "--tsconfig", "tsconfig.dev.json", "scripts/alr-verify.ts",
               "--mode", "free" if args.arm == "free" else args.mode]
    llm_dir = SUITE / "llm" / args.arm
    if args.arm != "free":
        env.update({"ALR_EVAL_ARM": args.arm, "ALR_EVAL_LLM_DIR": str(llm_dir),
                    "ALR_EVAL_CONCURRENCY": str(args.concurrency)})
        command += ["--llm", str(HERE / "codexArm.ts")]
    for setting in args.setting or []:
        command += ["--setting", setting]
    docs = [p for p in inputs() if not args.only or any(o.casefold() in p.name.casefold() for o in args.only)]
    usage_log = llm_dir / "process-usage.jsonl"

    def one(path: Path) -> None:
        doc_out = raw / path.stem
        doc_out.mkdir(parents=True, exist_ok=True)
        before = usage_log.stat().st_size if usage_log.exists() else 0
        started = time.time()
        proc = subprocess.run(command + ["--input", str(path), "--out", str(doc_out)], cwd=REPO / "backend",
                              env={**env, "ALR_EVAL_LABEL": f"{name}:{path.stem}"},
                              capture_output=True, text=True, encoding="utf-8", errors="replace")
        elapsed = time.time() - started
        (doc_out / "stdout.log").write_text(proc.stdout, encoding="utf-8")
        (doc_out / "stderr.log").write_text(proc.stderr, encoding="utf-8")
        runs = sorted(doc_out.glob("*.run.json"))
        books = sorted(doc_out.glob("*.xlsx"))
        if proc.returncode or not runs or not books:
            print(f"{name} {path.name}: FAILED exit {proc.returncode}: {proc.stderr[-800:]}", flush=True)
            return
        payload = to_payload(json.loads(runs[0].read_text(encoding="utf-8")), books[0], path)
        payload["metrics"]["process_s"] = round(elapsed, 3)
        if usage_log.exists():
            with usage_log.open(encoding="utf-8") as stream:
                stream.seek(before)
                for line in stream:
                    stats = json.loads(line)
                    if stats.get("label") != f"{name}:{path.stem}":
                        continue
                    for key in ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens"):
                        payload["metrics"][key] = payload["metrics"].get(key, 0) + int(stats["usage"][key])
                    payload["metrics"]["live_calls"] = payload["metrics"].get("live_calls", 0) + int(stats["calls"])
                    payload["metrics"]["replayed_calls"] = payload["metrics"].get("replayed_calls", 0) + int(stats["replayed"])
                    payload["metrics"]["failed_calls"] = payload["metrics"].get("failed_calls", 0) + int(stats["failures"])
        (out / f"{path.stem}.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{name} {path.name}: {payload['metrics']['parts']} parts, {elapsed:.1f}s, "
              f"calls={payload['metrics'].get('live_calls', 0)} replayed={payload['metrics'].get('replayed_calls', 0)}", flush=True)

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        list(pool.map(one, docs))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("baseline")
    b.add_argument("--app", action="store_true", help="whole app, local-only (quote checks)")
    b.set_defaults(func=baseline)
    a = sub.add_parser("arm")
    a.add_argument("arm", choices=("free", "luna-max", "sol-low"))
    a.add_argument("--mode", default="high_accuracy", choices=("high_accuracy", "economy", "ultra_economy"))
    a.add_argument("--only", nargs="*", help="substrings of input names to run")
    a.add_argument("--parallel", type=int, default=1, help="documents run at once")
    a.add_argument("--concurrency", type=int, default=6, help="codex turns at once per document process")
    a.add_argument("--setting", action="append", help="key=value passed to alr-verify --setting")
    a.set_defaults(func=arm)
    args = parser.parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
