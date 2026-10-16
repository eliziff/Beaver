"""Capture/compare engine behavior and performance, or delivered file bytes.

Inputs and receipts belong in ignored benchmarks/local-data/alr-completion.
This harness never builds, changes gold, fetches sources, or calls a model.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import threading
import time
import zipfile


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def peak_memory(process: subprocess.Popen) -> int:
    if os.name == "nt":
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in
                ("peak", "working", "peak_paged", "paged", "peak_nonpaged", "nonpaged", "pagefile", "peak_pagefile")]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        query = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
        query.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        query.restype = wintypes.BOOL
        if not query(int(process._handle), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return counters.peak
    status = Path(f"/proc/{process.pid}/status").read_text()
    return int(next(line.split()[1] for line in status.splitlines() if line.startswith("VmHWM:"))) * 1024


def schema4_request(request: dict) -> dict:
    """Translate this frozen suite's schema-3 split request, without changing text or policy."""
    if request["method"] != "splitSources":
        return request
    body = dict(request["request"])
    if body.pop("extendedUs", None) is not False:
        raise ValueError("The frozen split baseline must explicitly use extendedUs=false")
    body["jurisdictionPriority"] = ["ca"]
    return {**request, "request": body}


def schema4_response(raw: bytes) -> bytes:
    """Compare payload bytes under the old envelope; reject any unplanned profile change."""
    decoded = json.loads(raw)
    result = decoded.get("result")
    if isinstance(result, dict):
        if "schemaVersion" in result:
            if result["schemaVersion"] != 4:
                raise ValueError("Expected schema 4 response")
            result["schemaVersion"] = 3
        for name in ("sourceParts", "parts"):
            for part in result.get(name, []):
                if "jurisdictionPriority" not in part:
                    continue
                if part["jurisdictionPriority"] != ["ca"]:
                    raise ValueError("The candidate changed a frozen source-part jurisdiction profile")
                restored = {("extendedUs" if key == "jurisdictionPriority" else key):
                            (False if key == "jurisdictionPriority" else value) for key, value in part.items()}
                part.clear()
                part.update(restored)
    return (json.dumps(decoded, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def sample(binary: Path, calls: list[dict], repeats: int, log: Path, schema4: bool = False) -> tuple[dict, list[str], list[str]]:
    started = time.perf_counter()
    with log.open("ab") as errors, subprocess.Popen(
        [str(binary), "batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors
    ) as process:
        # Kill a hung native call and always reap it; no orphan benchmark processes.
        deadline = threading.Timer(600, process.kill)
        deadline.start()
        try:
            def call(request: dict) -> bytes:
                wire = schema4_request(request) if schema4 else request
                process.stdin.write(json.dumps(wire, ensure_ascii=False).encode("utf-8") + b"\n")
                process.stdin.flush()
                result = process.stdout.readline()
                if not result:
                    raise RuntimeError(f"Engine exited without a response; see {log}")
                decoded = json.loads(result)
                if decoded.get("id") != request["id"] or "error" in decoded:
                    raise RuntimeError(f"Engine failed request {request['id']}; see retained input and stderr")
                return result

            # First citation extraction, not a cheap metadata/version endpoint.
            call(next(request for request in calls if request["method"] == "extract"))
            cold = time.perf_counter() - started
            # Warm every path before measuring steady-state throughput.
            outputs = [call(request) for request in calls]
            wire_expected = [digest(output) for output in outputs]
            expected = [digest(schema4_response(output) if schema4 else output) for output in outputs]
            durations = []
            for _ in range(repeats):
                started = time.perf_counter()
                actual = [digest(call(request)) for request in calls]
                durations.append(time.perf_counter() - started)
                if actual != wire_expected:
                    raise RuntimeError("Repeated identical requests produced different output bytes")
            memory = peak_memory(process)
            process.stdin.close()
            process.wait(timeout=10)
            if process.returncode:
                raise RuntimeError(f"Engine exited {process.returncode}; see {log}")
            return {"cold_s": cold, "warm_s": statistics.median(durations), "peak_bytes": memory,
                    "warm_samples_s": durations}, expected, wire_expected
        finally:
            deadline.cancel()
            if process.poll() is None:
                process.kill()
            process.wait()


def compare(before: dict, after: dict) -> list[str]:
    failures = []
    for field in ("input_sha256", "request_count", "repeats", "samples", "platform"):
        if before[field] != after[field]:
            failures.append(f"Incomparable run: {field} changed")
    if before["responses"] != after["responses"]:
        failures.append("Response bytes changed")
    for metric in ("cold_s", "warm_s", "peak_bytes", "wasm_bytes"):
        if before[metric] is None or after[metric] is None:
            failures.append(f"Unmeasured: {metric}")
        elif after[metric] > before[metric]:
            failures.append(f"Regression: {metric} {before[metric]} -> {after[metric]}")
    return failures


def engine(args) -> int:
    raw = args.requests.read_bytes()
    calls = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if not calls or any(not isinstance(call, dict) or "method" not in call or "request" not in call for call in calls):
        raise ValueError("Requests must be a nonempty JSONL stream of method/request objects")
    for index, call in enumerate(calls):
        call["id"] = index
    args.out.parent.mkdir(parents=True, exist_ok=True)
    log = args.out.with_suffix(".stderr.log")
    log.write_bytes(b"")
    measurements, hashes, wire_hashes = [], None, None
    for index in range(args.samples):
        measured, outputs, wire_outputs = sample(args.cli.resolve(), calls, args.repeats, log, args.schema4)
        if hashes is not None and hashes != outputs:
            raise RuntimeError("Fresh processes produced different response bytes")
        if wire_hashes is not None and wire_hashes != wire_outputs:
            raise RuntimeError("Fresh processes produced different raw response bytes")
        hashes = outputs
        wire_hashes = wire_outputs
        measurements.append(measured)
        print(f"sample {index + 1}/{args.samples}: cold={measured['cold_s']:.3f}s "
              f"warm={measured['warm_s']:.3f}s peak={measured['peak_bytes'] / 2**20:.1f}MiB", flush=True)
    result = {"format": 1, "platform": platform.platform(), "input_sha256": digest(raw),
              "cli_sha256": digest(args.cli.read_bytes()), "request_count": len(calls),
              "samples": args.samples, "repeats": args.repeats, "responses": hashes,
              "response_envelope": "schema-4-to-frozen-3" if args.schema4 else "original",
              "wire_responses": wire_outputs,
              "measurements": measurements,
              **{key: statistics.median(m[key] for m in measurements) for key in ("cold_s", "warm_s", "peak_bytes")},
              "wasm_bytes": args.wasm.stat().st_size if args.wasm else None,
              "wasm_sha256": digest(args.wasm.read_bytes()) if args.wasm else None}
    failures = compare(json.loads(args.baseline.read_text()), result) if args.baseline else []
    result["failures"] = failures
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for failure in failures:
        print(failure, flush=True)
    return int(bool(failures))


def artifacts(args) -> int:
    # An explicit list prevents accidental comparison of an empty or incomplete run.
    paths = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(paths, list) or not paths:
        raise ValueError("Artifact manifest must be a nonempty list of relative filenames")
    result, containers = {}, {}
    for name in paths:
        path = (args.root / name).resolve()
        if not path.is_relative_to(args.root.resolve()):
            raise ValueError("Artifact path escapes the supplied root")
        containers[name] = digest(path.read_bytes())
        if args.zip_members and path.suffix.lower() in (".xlsx", ".docx", ".zip"):
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                if len(set(names)) != len(names):
                    raise ValueError(f"Duplicate ZIP members: {name}")
                result[name] = {member: digest(archive.read(member)) for member in names}
        else:
            result[name] = containers[name]
    failures = []
    if args.baseline:
        saved = json.loads(args.baseline.read_text())
        if saved["zip_members"] != args.zip_members:
            raise ValueError("The baseline and candidate use different ZIP comparison modes")
        before = saved["artifacts"]
        failures = [name for name in sorted(before.keys() | result.keys()) if before.get(name) != result.get(name)]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"zip_members": args.zip_members, "artifacts": result,
                                   "container_sha256": containers}, indent=2) + "\n", encoding="utf-8")
    print(f"{len(result)} artifacts; {len(failures)} byte differences", flush=True)
    for name in failures:
        print(name, flush=True)
    return int(bool(failures))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    bench = commands.add_parser("engine")
    bench.add_argument("--cli", type=Path, required=True)
    bench.add_argument("--requests", type=Path, required=True)
    bench.add_argument("--wasm", type=Path)
    bench.add_argument("--samples", type=int, default=5)
    bench.add_argument("--repeats", type=int, default=3)
    bench.add_argument("--schema4", action="store_true",
                       help="translate only the frozen split flag and schema/profile envelope; retain all wire hashes")
    bench.set_defaults(run=engine)
    files = commands.add_parser("artifacts")
    files.add_argument("--root", type=Path, required=True)
    files.add_argument("--manifest", type=Path, required=True)
    files.add_argument("--zip-members", action="store_true",
                       help="compare every uncompressed ZIP member byte; retain container hashes separately")
    files.set_defaults(run=artifacts)
    for command in (bench, files):
        command.add_argument("--out", type=Path, required=True)
        command.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    if args.baseline and args.baseline.resolve() == args.out.resolve():
        parser.error("The candidate must not overwrite the baseline")
    if args.command == "engine" and (args.samples < 1 or args.repeats < 1):
        parser.error("samples and repeats must be positive")
    return args.run(args)


if __name__ == "__main__":
    raise SystemExit(main())
