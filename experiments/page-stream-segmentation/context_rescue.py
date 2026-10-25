"""Test additional context on frozen failures and successful controls, without changing the task."""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
import time
from types import SimpleNamespace

from annotate import POLICY, TASK, response_schema, validate_response
from author import render
from boundary_data import DEFAULT_OUT, ROOT, atomic_json, corpus_home, digest, fingerprint, read_json, source_path
from codex_runner.calls import call, prepare_call
from pair_probe import ARMS, retained_response
from window_probe import page_window

SIZES = (2, 4, 8, 16)


def select_cases(original, report, review, sources):
    by_id = {c["case_id"]: c for c in original["cases"]}
    failure_ids = {r["case_id"] for r in report["differences"]}
    cases = [dict(by_id[key], group="previous_mismatch") for key in sorted(failure_ids)]
    duplicates = {sha for group in review["identical_sampled_page_groups"] for sha in group["sha256s"][1:]}
    for key, decision in review["decisions"].items():
        row = by_id[key]
        if row["sha256"] not in duplicates:
            cases.append(dict(row, expected=decision["label"],
                              group="mixed_page" if decision["label"] is None else "reviewed_disagreement"))
    families = {c["family_id"] for c in cases}
    for label in (0, 1):
        eligible = [c for c in original["cases"] if c["cohort"] == "existing_gold"
                    and c["expected"] == label and c["case_id"] not in failure_ids
                    and sources[c["sha256"]]["page_count"] >= max(SIZES)]
        chosen = 0
        for row in sorted(eligible, key=lambda c: fingerprint(["context-rescue-control-v1", c["case_id"]])):
            if row["family_id"] in families:
                continue
            cases.append(dict(row, group="successful_control"))
            families.add(row["family_id"])
            chosen += 1
            if chosen == 6:
                break
        if chosen != 6:
            raise ValueError("Insufficient independent successful controls")
    return cases


def prepare(args):
    prior = args.root / "pair-probe"
    original = read_json(prior / "spec.json")
    sources = {r["sha256"]: r for r in read_json(args.root / "dataset.json")["sources"]}
    cases = select_cases(original, read_json(prior / "reviewed-report.json"), read_json(prior / "review.json"), sources)
    jobs, assignments, required = {}, {}, defaultdict(set)
    for case in cases:
        sha, page = case["sha256"], case["right_page"]
        assignments[case["case_id"]] = {}
        for size in SIZES:
            pages = page_window(page, sources[sha]["page_count"], size)
            assignments[case["case_id"]][str(size)] = {}
            for arm in ARMS:
                key = fingerprint({"sha256": sha, "pages": pages, "target": page, "arm": arm})
                jobs.setdefault(key, {"key": key, "case_id": case["case_id"], "arm": arm, "target": page,
                                      "sha256": sha, "pages": pages})
                assignments[case["case_id"]][str(size)][arm] = key
            required[sha].update(pages)
    images = {}
    for sha, pages in required.items():
        pdf = source_path(sources[sha], args.home)
        if digest(pdf) != sha:
            raise ValueError("Original PDF differs from its indexed identity")
        images[sha] = render(pdf, sorted(pages), args.root / "annotations" / sha / "pages", 200)
    previous = {(j["arm"], j["case_id"]): j for j in original["jobs"]}
    for job in jobs.values():
        sha, page, arm, pages = job["sha256"], job["target"], job["arm"], job["pages"]
        schema = args.out / "schemas" / f"{page}.json"
        atomic_json(schema, response_schema([page]))
        job["schema"] = schema.relative_to(ROOT).as_posix()
        job["images"] = [images[sha][p].relative_to(ROOT).as_posix() for p in pages]
        job["prompt"] = (TASK + f"\nPass: author. Judge independently.\nSource SHA256: {sha}\n"
                         + f"Images, in order, are physical pages: {pages}.\nRequested right pages: {[page]}.\n")
        if len(pages) == 2:
            job["request"] = previous[arm, job["case_id"]]["request"]
            job["baseline_only"] = True
        else:
            model, effort = ARMS[arm]
            request = prepare_call(job["prompt"], schema, [ROOT / p for p in job["images"]],
                                   args.out / "calls" / arm / job["key"], SimpleNamespace(model=model, effort=effort), policy=POLICY)
            job["request"] = request.relative_to(ROOT).as_posix()
            job["baseline_only"] = False
    spec = {"origin": "machine_test", "run_id": "page-stream-context-rescue-20261024", "sizes": list(SIZES),
            "arms": ARMS, "cases": cases, "jobs": list(jobs.values()), "assignments": assignments,
            "prior_spec_sha256": digest(prior / "spec.json"), "prior_results_sha256": digest(prior / "results.json"),
            "public_sources": [r for r in original["public_sources"] if r["sha256"] in required],
            "protocol": "The same single boundary is requested at every context size. Task instructions, model, effort and enum schema are fixed. "
                        "Only visible original pages change. Sizes are capped at the original PDF length; identical requests are deduplicated. "
                        "Mixed-page references require abstention. This failure-enriched panel is not a population accuracy estimate."}
    atomic_json(args.out / "spec.json", spec)
    return spec


def prediction(result, page):
    if not result or result["status"] != "complete":
        return "unfinished"
    return result["labels"].get(str(page), result["labels"].get(page))


def summarize(spec, results):
    by_key = {r["key"]: r for r in results}
    rows, arms = [], {}
    for size in spec["sizes"]:
        for arm in ARMS:
            groups = defaultdict(Counter)
            for case in spec["cases"]:
                key = spec["assignments"][case["case_id"]][str(size)][arm]
                value = prediction(by_key.get(key), case["right_page"])
                baseline_key = spec["assignments"][case["case_id"]]["2"][arm]
                baseline = prediction(by_key.get(baseline_key), case["right_page"])
                counts = groups[case["group"]]
                counts["cases"] += 1
                if value == "unfinished":
                    outcome = "unfinished"
                elif case["expected"] is None:
                    outcome = "appropriate_abstention" if value is None else "confident_on_mixed_page"
                elif value is None:
                    outcome = "uncertain"
                else:
                    outcome = "correct" if value == case["expected"] else "wrong"
                counts[outcome] += 1
                if case["expected"] is not None and baseline != "unfinished" and baseline is not None and baseline != case["expected"]:
                    counts["baseline_wrong"] += 1
                    counts["rescued_to_correct"] += outcome == "correct"
                    counts["rescued_to_uncertain"] += outcome == "uncertain"
                rows.append({"case_id": case["case_id"], "group": case["group"], "arm": arm, "requested_images": size,
                             "actual_images": len(next(j["pages"] for j in spec["jobs"] if j["key"] == key)),
                             "expected": case["expected"], "prediction": value, "baseline": baseline, "outcome": outcome})
            arms[f"{arm}/{size}"] = {group: dict(counts) for group, counts in groups.items()}
    return {"arms": arms, "cases": rows, "unique_requests": len(spec["jobs"]), "protocol": spec["protocol"]}


def run(args):
    spec = read_json(args.out / "spec.json")
    prior_jobs = {(j["arm"], j["case_id"]): j for j in read_json(args.root / "pair-probe/spec.json")["jobs"]}
    start = time.monotonic()
    deadline = start + args.seconds
    paid_jobs = [j for j in spec["jobs"] if not j["baseline_only"]]
    budget = {"calls": sum(len(read_json(ROOT / j["request"] / "receipt.json")["attempts"])
                           for j in paid_jobs if (ROOT / j["request"] / "receipt.json").is_file())}
    lock = Lock()

    def one(job):
        result = {"key": job["key"], "arm": job["arm"], "case_id": job["case_id"]}
        began = time.monotonic()
        try:
            cache_job = dict(job, key=prior_jobs[job["arm"], job["case_id"]]["key"]) if job["baseline_only"] else job
            retained = retained_response(cache_job, args.root)
            if retained is not None:
                result.update(status="complete", **retained)
            elif job["baseline_only"]:
                raise ValueError("Saved baseline missing; do not spend a replacement call")
            else:
                remaining = deadline - time.monotonic()
                with lock:
                    if remaining < 15 or budget["calls"] >= len(paid_jobs):
                        return {**result, "status": "skipped"}
                    budget["calls"] += 1
                model, effort = ARMS[job["arm"]]
                options = SimpleNamespace(model=model, effort=effort, attempts=1, max_calls=None, timeout=min(args.timeout, remaining))
                request = ROOT / job["request"]
                labels = call(job["prompt"], ROOT / job["schema"], [ROOT / p for p in job["images"]], request.parent,
                              options, lambda r: validate_response(r, [job["target"]]), policy=POLICY, reuse=False)
                result.update(status="complete", labels=labels, retained=False,
                              response_path=(request / "response.json").relative_to(ROOT).as_posix(),
                              response_sha256=digest(request / "response.json"))
        except Exception as exc:
            result.update(status="failed", error=str(exc)[-500:])
        return {**result, "seconds": round(time.monotonic() - began, 3)}

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = [pool.submit(one, j) for j in spec["jobs"]]
        for future in as_completed(pending):
            results.append(future.result())
            atomic_json(args.out / "results.json", {"origin": spec["origin"], "run_id": spec["run_id"], "results": results})
            if len(results) % 16 == 0 or len(results) == len(pending):
                atomic_json(args.out / "report.json", summarize(spec, results))
                print({"finished": len(results), "of": len(pending), "statuses": dict(Counter(r["status"] for r in results))}, flush=True)
    report = {**summarize(spec, results), "live_attempts_total": budget["calls"], "workers": args.workers,
              "elapsed_seconds": round(time.monotonic() - start, 2), "code_sha256": digest(Path(__file__))}
    atomic_json(args.out / "report.json", report)
    return {k: v for k, v in report.items() if k != "cases"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT / "context-rescue")
    parser.add_argument("--home", type=Path, default=corpus_home())
    parser.add_argument("--workers", type=int, default=64)
    parser.add_argument("--seconds", type=int, default=480)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    args.root, args.out = args.root.resolve(), args.out.resolve()
    if min(args.workers, args.seconds, args.timeout) < 1:
        parser.error("Execution limits must be positive")
    if args.prepare_only:
        spec = prepare(args)
        print({"cases": len(spec["cases"]), "groups": dict(Counter(c["group"] for c in spec["cases"])),
               "new_calls_cap": sum(not j["baseline_only"] for j in spec["jobs"]), "requests": len(spec["jobs"])})
    else:
        print(run(args))
