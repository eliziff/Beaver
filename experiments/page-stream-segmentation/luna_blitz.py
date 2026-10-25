"""Bounded concurrent Luna comparison on the exact saved public pilot requests."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import gzip
import json
import math
from pathlib import Path
import statistics
import time
from types import SimpleNamespace

from boundary_data import DEFAULT_OUT, atomic_json, digest, read_json
from annotate import POLICY, validate_response
from codex_runner.calls import call, call_key


EFFORTS = ("low", "medium", "high", "xhigh", "max")


def summarize(results):
    arms, differences = {}, []
    for effort in EFFORTS:
        rows = [r for r in results if r["effort"] == effort]
        if not rows:
            continue
        complete = [r for r in rows if r["status"] == "complete"]
        known = matched = emitted = tp = fp = fn = uncertain = 0
        usage = {}
        for row in complete:
            reference = {int(p): v for p, v in row["reference"].items()}
            labels = {int(p): v for p, v in row["labels"].items()}
            known += len(reference)
            uncertain += len(row["targets"]) - len(labels)
            for p, wanted in reference.items():
                got = labels.get(p)
                emitted += got is not None
                matched += got == wanted
                tp += wanted == 1 and got == 1
                fp += wanted == 0 and got == 1
                fn += wanted == 1 and got != 1
                if got != wanted:
                    differences.append({"sha256": row["sha256"], "right_page": p, "effort": effort,
                                        "sol": wanted, "luna": got, "reference_call": row["reference_call"]})
            for attempt in read_json(Path(row["call_directory"]) / "receipt.json")["attempts"]:
                for name, value in attempt["usage"].items():
                    usage[name] = usage.get(name, 0) + value
        latencies = sorted(r["seconds"] for r in complete)
        arms[effort] = {"completed": len(complete), "failed_or_skipped": len(rows) - len(complete),
                       "reference_known_gaps": known, "matching_labels": matched,
                       "label_agreement": matched / known if known else None,
                       "coverage_on_reference_known": emitted / known if known else None,
                       "uncertain_gaps": uncertain, "split_true_positive_vs_sol": tp,
                       "extra_splits_vs_sol": fp, "missed_splits_vs_sol": fn,
                       "split_f1_vs_sol": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
                       "median_seconds": statistics.median(latencies) if latencies else None,
                       "p90_seconds": latencies[math.ceil(0.9 * (len(latencies) - 1))] if latencies else None,
                       "usage": usage}
    return arms, differences


def run(args):
    start = time.monotonic()
    deadline = start + args.seconds
    pilot = read_json(args.root / "live-pilot.json")
    public = {r["sha256"] for r in pilot["sources"] if r["public_source_records"]}
    inputs = []
    for path in sorted((args.root / "annotations").glob("*/windows/*.json")):
        job = path.parent.parent
        if job.name not in public:
            continue
        window = read_json(path)
        reference_call = job / window["calls"][0]
        request = read_json(reference_call / "request.json")
        images = [(reference_call / row["path"]).resolve() for row in request["images"]]
        if [digest(p) for p in images] != [r["sha256"] for r in request["images"]]:
            raise ValueError("Saved reference images changed")
        reference = validate_response(read_json(reference_call / "response.json"), window["targets"])
        inputs.append({"sha256": job.name, "targets": window["targets"], "reference": reference,
                       "reference_call": str(reference_call.resolve()), "images": images,
                       "schema": reference_call / "schema.json",
                       "prompt": gzip.decompress((reference_call / "prompt.txt.gz").read_bytes()).decode()})
    if not inputs:
        raise ValueError("No saved public pilot requests")

    def one(source, effort):
        began = time.monotonic()
        result = {k: source[k] for k in ("sha256", "targets", "reference", "reference_call")}
        result.update(effort=effort, status="skipped")
        remaining = deadline - began
        if remaining < 5:
            return result
        options = SimpleNamespace(model=args.model, effort=effort, attempts=1, max_calls=None,
                                  timeout=min(args.timeout, remaining))
        parent = args.out / "calls" / f"{source['sha256']}-{source['targets'][0]}-{effort}"
        key = call_key(source["prompt"], read_json(source["schema"]), source["images"], options, POLICY)
        result["call_directory"] = str((parent / key[:16]).resolve())
        try:
            labels = call(source["prompt"], source["schema"], source["images"], parent, options,
                          lambda value: validate_response(value, source["targets"]), policy=POLICY)
            result.update(status="complete", labels=labels)
        except Exception as exc:
            result.update(status="failed", error=str(exc)[-500:])
        result["seconds"] = time.monotonic() - began
        return result

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = [pool.submit(one, source, effort) for source in inputs for effort in args.efforts]
        for future in as_completed(pending):
            result = future.result()
            results.append(result)
            atomic_json(args.out / "results.json", {"origin": "machine_test", "run_id": "page-stream-luna-blitz-20261024-" + "-".join(args.efforts), "results": results})
            print(json.dumps({"completed": len(results), "of": len(pending), "effort": result["effort"],
                              "status": result["status"], "seconds": round(result.get("seconds", 0), 2)}), flush=True)
    arms, differences = summarize(results)
    report = {"model": args.model, "efforts": args.efforts, "workers": args.workers, "windows": len(inputs),
              "elapsed_seconds": time.monotonic() - start, "arms": arms,
              "reference": "Exact Sol low author requests; comparison is not independently adjudicated accuracy",
              "code_sha256": digest(Path(__file__)), "pilot_sha256": digest(args.root / "live-pilot.json")}
    atomic_json(args.out / "differences.json", differences)
    atomic_json(args.out / "report.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT / "luna-blitz")
    parser.add_argument("--model", default="gpt-6-luna")
    parser.add_argument("--efforts", nargs="+", choices=EFFORTS, default=["medium", "high"])
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--seconds", type=int, default=210)
    parser.add_argument("--timeout", type=int, default=60)
    options = parser.parse_args()
    if min(options.workers, options.seconds, options.timeout) < 1:
        parser.error("Limits must be positive")
    if len(options.efforts) != len(set(options.efforts)):
        parser.error("Each effort may be requested only once")
    print(json.dumps(run(options), indent=2))
