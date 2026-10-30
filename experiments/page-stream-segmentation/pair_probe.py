"""Bounded model comparison over prepared original-page decisions."""
import argparse
from dataclasses import replace
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import time
from threading import Lock
from types import SimpleNamespace

from annotate import POLICY, TASK, response_schema, validate_response
from author import render
from boundary_data import (DEFAULT_OUT, ROOT, atomic_json, compact_scopes, corpus_home, digest, fingerprint,
                           read_catalogue, read_json, source_path)
from codex_runner.calls import call, prepare_call
from jsonschema import Draft202012Validator, ValidationError

ARMS = {"luna-max": ("gpt-6-luna", "max"), "sol-low": ("gpt-6.1-sol", "low")}


def select_cases(sources, count):
    candidates = []
    for source in sources:
        starts = [int(p) for p, v in source["labels"].items() if v == 1]
        for page, label in source["labels"].items():
            page = int(page)
            candidates.append({"sha256": source["sha256"], "right_page": page, "expected": label,
                "family_id": source["family_id"], "kinds": source["kinds"], "split": source["split"],
                "near_split": any(abs(page - p) <= 2 for p in starts),
                "reference": source["evidence"], "case_id": f"{source['sha256']}-{page}"})
    order = lambda r: fingerprint(["two-page-paired-v1", r["case_id"]])
    picked, used = [], set()
    balance = Counter()

    def add(row):
        picked.append(row)
        used.add(row["case_id"])
        balance[row["expected"]] += 1

    # Include medical examples without letting the small existing pilot dominate.
    for row in sorted(candidates, key=order):
        if any("medical" in k for k in row["kinds"]) and balance[row["expected"]] < count // 16:
            add(row)

    def fill(label, target, near_only=False):
        families = defaultdict(list)
        for row in sorted(candidates, key=order):
            if row["expected"] == label and row["case_id"] not in used and (not near_only or row["near_split"]):
                families[row["family_id"]].append(row)
        while balance[label] < target:
            available = sorted((f for f, rows in families.items() if rows),
                               key=lambda f: (sum(r["family_id"] == f and r["expected"] == label for r in picked), f))
            if not available:
                raise ValueError("Insufficient public reference cases for the requested panel")
            for family in available:
                if balance[label] == target:
                    break
                add(families[family].pop(0))

    fill(1, count // 2)
    fill(0, count // 4, near_only=True)
    fill(0, count // 2)
    return [dict(row, cohort="existing_gold") for row in sorted(picked, key=order)]


def select_new_scopes(sources, excluded, size=8):
    selected, families = [], {r["family_id"] for r in excluded}
    for medical in (True, False):
        candidates = []
        for source in sources:
            if source["family_id"] in families or (any("medical" in k for k in source["kinds"])) != medical:
                continue
            if not medical and "affidavit" not in source["kinds"]:
                continue
            unknown = sorted(set(source["review_gaps"]) - {int(p) for p in source["labels"]})
            runs = []
            for page in unknown:
                if not runs or page != runs[-1][-1] + 1:
                    runs.append([])
                runs[-1].append(page)
            for run in runs:
                if len(run) >= size:
                    candidates.append((fingerprint(["new-pair-scope-v1", source["sha256"], run[0]]), source, run[:size]))
        taken = 0
        for _, source, pages in sorted(candidates, key=lambda r: r[0]):
            if source["family_id"] in families:
                continue
            families.add(source["family_id"])
            for page in pages:
                selected.append({"sha256": source["sha256"], "right_page": page, "expected": None,
                    "family_id": source["family_id"], "kinds": source["kinds"], "split": source["split"],
                    "reference": [], "case_id": f"{source['sha256']}-{page}", "cohort": "new_scope"})
            taken += 1
            if taken == 4:
                break
        if taken != 4:
            raise ValueError("Insufficient additional public PDFs with eight consecutive unlabeled boundaries")
    return selected


def prepare(args):
    dataset = read_json(args.root / "dataset.json")
    with read_catalogue(args.home) as db:
        records = defaultdict(list)
        for row in db.execute("select sha256,collection,jurisdiction,kind,url,final_url from documents "
                              "where url like 'https://%' or final_url like 'https://%'"):
            records[row["sha256"]].append(dict(row))
    sources = {r["sha256"]: r for r in dataset["sources"] if r["local_pdf"] and r["sha256"] in records}
    cases = select_cases(list(sources.values()), args.cases)
    prior = {p.parent.name for p in (args.root / "annotations").glob("*/gold.json")}
    cases += select_new_scopes([r for r in sources.values() if r["sha256"] not in prior], cases)
    required = defaultdict(set)
    for case in cases:
        required[case["sha256"]].update((case["right_page"] - 1, case["right_page"]))
    images = {}
    for index, (sha, pages) in enumerate(required.items(), 1):
        pdf = source_path(sources[sha], args.home)
        if digest(pdf) != sha:
            raise ValueError("Original PDF differs from its indexed identity")
        images[sha] = render(pdf, sorted(pages), args.root / "annotations" / sha / "pages", 200)
        if index % 25 == 0:
            print({"rendered_sources": index, "of": len(required)}, flush=True)
    jobs = []
    for case in cases:
        sha, page = case["sha256"], case["right_page"]
        pages = [page - 1, page]
        key = fingerprint({"sha256": sha, "pages": pages})
        schema = args.out / "schemas" / f"{page}.json"
        atomic_json(schema, response_schema([page]))
        prompt = (TASK + f"\nPass: author. Judge independently.\nSource SHA256: {sha}\n"
                  + f"Images, in order, are physical pages: {pages}.\nRequested right pages: {[page]}.\n")
        for arm, (model, effort) in ARMS.items():
            paths = [images[sha][p] for p in pages]
            parent = args.out / "calls" / arm / key
            request = prepare_call(prompt, schema, paths, parent, SimpleNamespace(model=model, effort=effort), policy=POLICY)
            jobs.append({"key": key, "case_id": case["case_id"], "arm": arm, "target": page, "prompt": prompt,
                         "schema": schema.relative_to(ROOT).as_posix(),
                         "images": [p.relative_to(ROOT).as_posix() for p in paths],
                         "request": request.relative_to(ROOT).as_posix()})
    spec = {"origin": "machine_test", "run_id": "page-stream-two-page-paired-20261024", "arms": ARMS,
            "pages_per_call": 2, "cases": cases, "jobs": jobs,
            "dataset_sha256": digest(args.root / "dataset.json"),
            "public_sources": [{"sha256": sha, "records": records[sha]} for sha in required],
            "protocol": "Both arms receive the identical two images, prompt and enum schema, with no reference labels. "
                        "64 existing-gold cases are balanced; 64 new edges cover eight additional PDFs. "
                        "Only existing-gold cases have accuracy references. Agreement on new edges is provisional."}
    atomic_json(args.out / "spec.json", spec)
    return spec


def retained_response(job, root):
    request = ROOT / job["request"]
    locations = [request]
    if job["arm"] == "luna-max":
        locations.append(root / "window-probe/calls" / job["key"] / request.name)
    for directory in locations:
        if not (directory / "request.json").is_file() or read_json(directory / "request.json")["key"] != read_json(request / "request.json")["key"]:
            continue
        for path in [directory / "response.json", *sorted(directory.glob("attempt-*/last-message.json"), reverse=True)]:
            if not path.is_file():
                continue
            try:
                value = read_json(path)
                Draft202012Validator(read_json(ROOT / job["schema"])).validate(value)
                labels = validate_response(value, [job["target"]])
            except (ValueError, ValidationError):
                # Invalid or truncated retained outputs are not accepted as results.
                continue
            return {"labels": labels, "response_path": path.relative_to(ROOT).as_posix(),
                    "response_sha256": digest(path), "retained": True}
    return None


def summarize(spec, results):
    by_job = {(r["arm"], r["case_id"]): r for r in results}
    arms, differences = {}, []
    for arm in spec["arms"]:
        counts = Counter({name: 0 for name in ("completed", "unfinished", "uncertain", "answered", "correct",
                                               "true_splits", "extra_splits", "missed_splits")})
        counts["cases"] = sum(c["expected"] is not None for c in spec["cases"])
        for case in spec["cases"]:
            if case["expected"] is None:
                continue
            row = by_job.get((arm, case["case_id"]), {})
            if row.get("status") != "complete":
                counts["unfinished"] += 1
                continue
            counts["completed"] += 1
            value = row["labels"].get(str(case["right_page"]), row["labels"].get(case["right_page"]))
            if value is None:
                counts["uncertain"] += 1
                continue
            counts["answered"] += 1
            counts["correct"] += value == case["expected"]
            counts["true_splits"] += case["expected"] == 1 and value == 1
            counts["extra_splits"] += case["expected"] == 0 and value == 1
            counts["missed_splits"] += case["expected"] == 1 and value == 0
            if value != case["expected"]:
                differences.append({"arm": arm, "case_id": case["case_id"], "reference": case["expected"], "predicted": value})
        tp, fp, fn = counts["true_splits"], counts["extra_splits"], counts["missed_splits"]
        arms[arm] = {**dict(counts), "match_on_answered": counts["correct"] / counts["answered"] if counts["answered"] else None,
                     "split_f1_on_answered": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None}
    paired = {cohort: Counter() for cohort in ("existing_gold", "new_scope")}
    disagreements = []
    for case in spec["cases"]:
        values = {}
        for arm in spec["arms"]:
            row = by_job.get((arm, case["case_id"]), {})
            if row.get("status") == "complete":
                values[arm] = row["labels"].get(str(case["right_page"]), row["labels"].get(case["right_page"]))
        if len(values) == len(spec["arms"]) > 1 and all(v is not None for v in values.values()):
            paired[case["cohort"]]["answered_by_both"] += 1
            paired[case["cohort"]]["agree"] += len(set(values.values())) == 1
            if len(set(values.values())) != 1:
                disagreements.append({"case_id": case["case_id"], "reference": case["expected"], **values})
    return {"arms": arms, "paired": {k: dict(v) for k, v in paired.items()}, "differences": differences, "disagreements": disagreements,
            "families": len({r["family_id"] for r in spec["cases"]}), "reference": spec["protocol"]}


def run(args):
    spec = read_json(args.out / "spec.json")
    started = time.monotonic()
    deadline = started + args.seconds
    jobs = spec["jobs"][:args.max_jobs] if args.max_jobs else spec["jobs"]
    spent = sum(len(read_json(ROOT / job["request"] / "receipt.json")["attempts"])
                for job in spec["jobs"] if (ROOT / job["request"] / "receipt.json").is_file())
    budget = {"calls": spent}
    lock = Lock()

    def one(job):
        result = {"key": job["key"], "case_id": job["case_id"], "arm": job["arm"]}
        began = time.monotonic()
        try:
            recovered = retained_response(job, args.root)
            if recovered is not None:
                result.update(status="complete", **recovered)
            else:
                remaining = deadline - time.monotonic()
                with lock:
                    if remaining < 15 or budget["calls"] >= len(spec["jobs"]):
                        return {**result, "status": "skipped", "reason": "Run deadline or total call cap"}
                    budget["calls"] += 1
                model, effort = spec["arms"][job["arm"]]
                options = SimpleNamespace(model=model, effort=effort, attempts=1, max_calls=None, timeout=min(args.timeout, remaining))
                request = ROOT / job["request"]
                policy = replace(POLICY, config=job["policy_config"]) if "policy_config" in job else POLICY
                labels = call(job["prompt"], ROOT / job["schema"], [ROOT / p for p in job["images"]],
                              request.parent, options, lambda r: validate_response(r, [job["target"]]), policy=policy, reuse=False)
                response = request / "response.json"
                result.update(status="complete", labels=labels, retained=False,
                              response_path=response.relative_to(ROOT).as_posix(), response_sha256=digest(response))
        except Exception as exc:
            result.update(status="failed", error=str(exc)[-500:])
        result["seconds"] = round(time.monotonic() - began, 3)
        return result

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = [pool.submit(one, job) for job in jobs]
        for future in as_completed(pending):
            results.append(future.result())
            atomic_json(args.out / "results.json", {"origin": spec["origin"], "run_id": spec["run_id"], "results": results})
            if len(results) % 16 == 0 or len(results) == len(jobs):
                report = summarize(spec, results)
                atomic_json(args.out / "report.json", report)
                print({"finished": len(results), "of": len(jobs), "statuses": dict(Counter(r["status"] for r in results)),
                       "arms": report["arms"]}, flush=True)
    candidates = defaultdict(dict)
    by_job = {(r["arm"], r["case_id"]): r for r in results if r["status"] == "complete"}
    for case in spec["cases"]:
        if case["cohort"] != "new_scope":
            continue
        values = [by_job.get((arm, case["case_id"]), {}).get("labels", {}).get(case["right_page"],
                  by_job.get((arm, case["case_id"]), {}).get("labels", {}).get(str(case["right_page"]))) for arm in spec["arms"]]
        if len(values) > 1 and values[0] is not None and all(v == values[0] for v in values):
            candidates[case["sha256"]][case["right_page"]] = values[0]
    atomic_json(args.out / "candidate-gold.json", {"sources": [scope for sha, labels in candidates.items()
                for scope in compact_scopes(sha, labels)]})
    report = {**summarize(spec, results), "elapsed_seconds": round(time.monotonic() - started, 2),
              "live_attempts_total": budget["calls"], "candidate_new_gaps": sum(map(len, candidates.values())),
              "workers": args.workers, "code_sha256": digest(Path(__file__))}
    atomic_json(args.out / "report.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT / "pair-probe")
    parser.add_argument("--home", type=Path, default=corpus_home())
    parser.add_argument("--cases", type=int, default=64, help="Existing-gold pairs; another 64 new pairs are added")
    parser.add_argument("--workers", type=int, default=64)
    parser.add_argument("--seconds", type=int, default=420)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--max-jobs", type=int)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    args.root, args.out = args.root.resolve(), args.out.resolve()
    if args.cases != 64 or min(args.workers, args.timeout, args.seconds) < 1 or args.max_jobs is not None and args.max_jobs < 1:
        parser.error("Use 64 existing-gold cases and positive execution limits")
    if args.prepare_only:
        spec = prepare(args)
        print({"cases": len(spec["cases"]), "jobs": len(spec["jobs"]), "families": len({r["family_id"] for r in spec["cases"]})})
    else:
        print(run(args))
