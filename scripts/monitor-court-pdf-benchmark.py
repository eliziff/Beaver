"""Sample an isolated benchmark's process tree and host; requires existing psutil.

python scripts/monitor-court-pdf-benchmark.py RUN_DIR -- node scripts/benchmark-court-pdf.mjs compare ROOT RUN_DIR 10 3
"""
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time

import psutil


def main():
    split = sys.argv.index("--")
    output = Path(sys.argv[1])
    command = sys.argv[split + 1:]
    policy = json.loads((Path(command[3]) / "owner.json").read_text(encoding="utf-8"))
    if policy["kind"] != "beaver.court-pdf-tournament.v2":
        raise ValueError("Versioned evaluator restart required")
    gates = policy["gates"]
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding="utf-8", errors="replace")
    process = psutil.Process(child.pid)
    lock = threading.Lock()
    state = {"active": None}
    phases = []
    log = []

    def read_output():
        for line in child.stdout:
            log.append(line)
            if output.exists():
                with (output / "command.live.log").open("a", encoding="utf-8") as journal:
                    journal.write(line)
            if line.startswith("BENCH_PHASE "):
                event = json.loads(line[len("BENCH_PHASE "):])
                with lock:
                    if event["event"] == "start":
                        phase = {**event, "samples": [], "startedMonotonic": time.monotonic()}
                        phases.append(phase)
                        state["active"] = phase
                    else:
                        if state["active"]:
                            state["active"]["operationRequests"] = event["operationRequests"]
                            state["active"]["durationSeconds"] = time.monotonic() - state["active"]["startedMonotonic"]
                        state["active"] = None
            print(line, end="", flush=True)

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    previous = {}
    previous_time = time.monotonic()
    cores = psutil.cpu_count()
    psutil.cpu_percent()
    while child.poll() is None:
        time.sleep(0.05)
        now = time.monotonic()
        try:
            owned = [process, *process.children(recursive=True)]
        except psutil.Error:
            owned = []
        rss = peak_sum = cpu_delta = 0
        current = {}
        for member in owned:
            try:
                memory = member.memory_info()
                cpu = member.cpu_times()
                identity = (member.pid, member.create_time())
                current[identity] = cpu.user + cpu.system
                if identity in previous:
                    cpu_delta += max(0, current[identity] - previous[identity])
                rss += memory.rss
                peak_sum += getattr(memory, "peak_wset", memory.rss)
            except psutil.Error:
                pass
        host = psutil.cpu_percent()
        own = cpu_delta / max(0.001, now - previous_time) / cores * 100
        previous, previous_time = current, now
        sample = {"rssBytes": rss, "sumProcessLifetimePeaksBytes": peak_sum,
                  "hostCpuPercent": host, "ownCpuPercent": own,
                  "backgroundCpuPercent": max(0, host - own), "processCount": len(owned)}
        with lock:
            if state["active"]:
                state["active"]["samples"].append(sample)
    reader.join()
    output.mkdir(parents=True, exist_ok=True)
    (output / "command.log").write_text("".join(log), encoding="utf-8")
    failures = []
    for phase in phases:
        samples = phase["samples"]
        phase["sampleCount"] = len(samples)
        phase["peakRssBytes"] = max((sample["rssBytes"] for sample in samples), default=0)
        phase["sumProcessLifetimePeaksBytes"] = max((sample["sumProcessLifetimePeaksBytes"] for sample in samples), default=0)
        phase["medianBackgroundCpuPercent"] = statistics.median(sample["backgroundCpuPercent"] for sample in samples) if samples else None
        if not samples:
            failures.append(f"No host samples for {phase['label']}/{phase['workload']}/{phase['pair']}")
    summary = {}
    for workload in sorted({phase["workload"] for phase in phases}):
        groups = {label: [phase for phase in phases if phase["workload"] == workload and phase["label"] == label]
                  for label in ("baseline", "candidate")}
        if not all(groups.values()):
            if command[2] != "profile":
                failures.append(f"{workload}: incomplete paired workload")
            continue
        before, after = groups["baseline"], groups["candidate"]
        if any(phase["medianBackgroundCpuPercent"] is None for phase in before + after):
            continue
        stats = lambda rows: {"peakRssBytes": max(row["peakRssBytes"] for row in rows),
                              "medianPeakRssBytes": statistics.median(row["peakRssBytes"] for row in rows),
                              "medianBackgroundCpuPercent": statistics.median(row["medianBackgroundCpuPercent"] for row in rows)}
        baseline, candidate = stats(before), stats(after)
        load_differences = [abs(next(row for row in after if row["pair"] == old["pair"])["medianBackgroundCpuPercent"]
                                - old["medianBackgroundCpuPercent"]) for old in before]
        summary[workload] = {"baseline": baseline, "candidate": candidate,
                             "pairedLoadDifferencesPercentagePoints": load_differences,
                             "medianPairedLoadDifferencePercentagePoints": statistics.median(load_differences)}
        if statistics.median(load_differences) > gates["backgroundLoadDifferencePercentagePoints"]:
            failures.append(f"{workload}: background host load invalidates the timing comparison")
        if max(baseline["medianBackgroundCpuPercent"], candidate["medianBackgroundCpuPercent"]) > gates["maximumBackgroundCpuPercent"]:
            failures.append(f"{workload}: background host saturation invalidates the timing comparison")
        if candidate["peakRssBytes"] > baseline["peakRssBytes"] * gates["memoryMaximumRatio"] + gates["memoryAllowanceMiB"] * 1024 * 1024:
            failures.append(f"{workload}: process-tree peak memory gate failed")
    receipt = {"command": command, "nodeExitCode": child.returncode, "samplerPid": os.getpid(),
               "sampleIntervalSeconds": 0.05, "logicalCpus": cores, "summary": summary, "phases": phases,
               "failures": failures, "limits": "RSS sums shared pages; 50 ms sampling can miss brief peaks. Lifetime process peaks are supplementary, not a simultaneous peak. Background CPU estimates subtract sampled owned-process CPU from host CPU."}
    (output / "host.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps({"hostSummary": summary, "hostFailures": failures}))
    return child.returncode or (1 if failures else 0)


if __name__ == "__main__":
    raise SystemExit(main())
