#!/usr/bin/env python3
"""Run exact verification in isolated Chrome processes and merge the shards."""
import argparse
import ctypes
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
GATE = HERE / "webdriver-exact-gate.py"
MARKER_GATE = HERE / "webdriver-marker-gate.py"

if hasattr(ctypes, "windll"):
    kernel32 = ctypes.windll.kernel32
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.SetPriorityClass.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    kernel32.SetPriorityClass.restype = ctypes.c_int
    if not kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000):
        raise ctypes.WinError()


def rows(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


parser = argparse.ArgumentParser()
parser.add_argument("--workers", type=int, default=4)
parser.add_argument("--gate", choices=("exact", "marker"), default="exact")
parser.add_argument("--only", choices=("all", "html", "pdf"), default="all")
parser.add_argument("--targets", type=Path)
parser.add_argument("--fresh", action="store_true")
parser.add_argument("--limit-per-worker", type=int)
parser.add_argument("--tag")
parser.add_argument("--mine-oracle", action="store_true")
parser.add_argument("--save-shots", action="store_true")
parser.add_argument("--find-probe", action="store_true")
parser.add_argument("--range-only", action="store_true")
parser.add_argument("--baseline", type=Path)
args = parser.parse_args()
name = args.tag or ("marker" if args.gate == "marker" else args.only)
shards = [RESULTS / f"webdriver-exact-{name}-shard-{index}.jsonl" for index in range(args.workers)]
if args.fresh:
    for shard in shards:
        shard.unlink(missing_ok=True)

started = time.time()
processes = []
drainers = []
for index, shard in enumerate(shards):
    if args.gate == "marker":
        if not args.targets:
            parser.error("--targets is required with --gate marker")
        command = [sys.executable, str(MARKER_GATE), str(args.targets.resolve()), "--shard-index", str(index), "--shard-count", str(args.workers), "--out", str(shard)]
        if args.baseline:
            command.extend(("--baseline", str(args.baseline.resolve())))
    else:
        command = [
            sys.executable, str(GATE), "--shard-index", str(index),
            "--shard-count", str(args.workers), "--out", str(shard), "--only", args.only,
        ]
    if args.limit_per_worker:
        command.extend(("--limit", str(args.limit_per_worker)))
    if args.mine_oracle and args.gate == "exact":
        command.append("--mine-oracle")
    if args.targets and args.gate == "exact":
        command.extend(("--targets", str(args.targets.resolve())))
    if args.save_shots and args.gate == "exact":
        command.append("--save-shots")
    if args.find_probe and args.gate == "exact":
        command.append("--find-probe")
    if args.range_only and args.gate == "exact":
        command.append("--range-only")
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
    processes.append((index, process))
    def drain(worker=index, stream=process.stdout):
        for line in stream or ():
            print(json.dumps({"worker": worker, "message": line.strip()}), flush=True)
    thread = threading.Thread(target=drain, daemon=True)
    thread.start()
    drainers.append(thread)

for index, process in processes:
    if process.wait():
        raise SystemExit(f"worker {index} failed with {process.returncode}")
for thread in drainers:
    thread.join()

merged = []
for shard in shards:
    merged.extend(rows(shard))
by_label = {row["label"]: row for row in merged}
out = RESULTS / f"webdriver-exact-{name}.jsonl"
ordered = sorted(by_label.values(), key=lambda row: row["label"])
out.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in ordered), encoding="utf-8")
tally = {}
for row in ordered:
    tally[row["verdict"]] = tally.get(row["verdict"], 0) + 1
print(json.dumps({"workers": args.workers, "rows": len(ordered), "seconds": round(time.time() - started, 1), "verdicts": tally}), flush=True)
