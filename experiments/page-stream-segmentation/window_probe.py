"""Compare page-batch sizes on a fixed, private set of original-page decisions."""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import time
from types import SimpleNamespace

from annotate import POLICY, TASK, response_schema, validate_response
from author import render
from boundary_data import DEFAULT_OUT, ROOT, atomic_json, corpus_home, digest, fingerprint, read_json, source_path
from codex_runner.calls import call, prepare_call

SIZES = (2, 4, 8, 16, 32)


def page_window(right_page, page_count, size):
    size = min(size, page_count)
    start = max(1, min(right_page - 1 - (size - 2) // 2, page_count - size + 1))
    return list(range(start, start + size))


def select_cases(root, count):
    dataset = read_json(root / "dataset.json")
    sources = {r["sha256"]: r for r in dataset["sources"]}
    pilot = read_json(root / "live-pilot.json")
    public = {r["sha256"]: r for r in pilot["sources"] if r["public_source_records"]}
    candidates = {}
    for path in sorted((root / "annotations").glob("*/windows/*.json")):
        sha = path.parent.parent.name
        if sha not in public or not sources[sha]["local_pdf"] or sources[sha]["page_count"] < max(SIZES):
            continue
        for page, label in read_json(path)["labels"].items():
            page = int(page)
            candidates[sha, page] = {"sha256": sha, "right_page": page, "expected": label,
                "family_id": public[sha]["family_id"], "reference": "saved_sol_annotation"}
    picked, used = [], set()

    def add(row):
        picked.append(row.copy())
        used.add((row["sha256"], row["right_page"]))

    review = read_json(root / "luna-blitz-xhigh-max/max-disagreements-reviewed.json")
    for case in review["cases"]:
        key = case["sha256"], case["right_page"]
        if key in candidates:
            row = candidates[key].copy()
            row.update(expected=case["visual_review_label"], reference="assistant_visual_review_stress_case")
            add(row)
    order = lambda r: fingerprint(["page-window-probe-v1", r["sha256"], r["right_page"]])
    by_family = defaultdict(list)
    for row in sorted(candidates.values(), key=order):
        by_family[row["family_id"]].append(row)
    for family in sorted(by_family):
        if len(picked) >= count:
            break
        if family in {r["family_id"] for r in picked}:
            continue
        balance = Counter(r["expected"] for r in picked)
        available = [r for r in by_family[family] if balance[r["expected"]] < count // 2]
        if available:
            add(min(available, key=lambda r: (balance[r["expected"]], order(r))))
    for row in sorted(candidates.values(), key=order):
        if len(picked) == count:
            break
        if (row["sha256"], row["right_page"]) not in used and sum(r["expected"] == row["expected"] for r in picked) < count // 2:
            add(row)
    if len(picked) != count or Counter(r["expected"] for r in picked) != {0: count // 2, 1: count // 2}:
        raise ValueError("Insufficient balanced public reference cases")
    for row in picked:
        row["case_id"] = f"{row['sha256']}-{row['right_page']}"
    return picked, sources, public


def score(spec, results):
    by_key = {r["key"]: r for r in results}
    arms, differences = {}, []
    for size in SIZES:
        counts = Counter(cases=len(spec["cases"]))
        for case in spec["cases"]:
            key = spec["assignments"][case["case_id"]][str(size)]
            result = by_key.get(key)
            got = None
            if result and result["status"] == "complete":
                counts["completed_cases"] += 1
                got = result["labels"].get(str(case["right_page"]), result["labels"].get(case["right_page"]))
            wanted = case["expected"]
            counts["correct"] += got == wanted
            counts["uncertain_or_unavailable"] += got is None
            counts["true_splits"] += wanted == 1 and got == 1
            counts["extra_splits"] += wanted == 0 and got == 1
            counts["missed_splits"] += wanted == 1 and got != 1
            if got != wanted:
                differences.append({"pages_per_call": size, "case_id": case["case_id"], "sha256": case["sha256"],
                    "right_page": case["right_page"], "reference": wanted, "predicted": got, "key": key})
        tp, fp, fn = counts["true_splits"], counts["extra_splits"], counts["missed_splits"]
        arms[str(size)] = {**dict(counts), "match_rate": counts["correct"] / counts["cases"],
                          "split_f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None}
    return {"model": spec["model"], "effort": spec["effort"], "arms": arms, "differences": differences,
            "reference": "Balanced diagnostic panel; includes two visually reviewed stress cases. Other labels are saved Sol annotations.",
            "selection_criterion": "Segmentation quality", "unique_requests": len(spec["jobs"])}


def prepare(args):
    cases, sources, public = select_cases(args.root, args.cases)
    jobs, assignments, required_pages = {}, {}, defaultdict(set)
    for case in cases:
        sha = case["sha256"]
        assignments[case["case_id"]] = {}
        for size in SIZES:
            pages = page_window(case["right_page"], sources[sha]["page_count"], size)
            key = fingerprint({"sha256": sha, "pages": pages})
            jobs.setdefault(key, {"key": key, "sha256": sha, "pages": pages, "targets": pages[1:]})
            assignments[case["case_id"]][str(size)] = key
            required_pages[sha].update(pages)
    images = {}
    for sha, pages in required_pages.items():
        pdf = source_path(sources[sha], args.home)
        if digest(pdf) != sha:
            raise ValueError("Original PDF differs from its indexed identity")
        images[sha] = render(pdf, sorted(pages), args.root / "annotations" / sha / "pages", 200)
    options = SimpleNamespace(model=args.model, effort=args.effort)
    for job in jobs.values():
        sha, pages = job["sha256"], job["pages"]
        job["images"] = [images[sha][p].relative_to(ROOT).as_posix() for p in pages]
        job["schema"] = (args.out / "schemas" / (job["key"] + ".json")).relative_to(ROOT).as_posix()
        atomic_json(ROOT / job["schema"], response_schema(job["targets"]))
        job["prompt"] = (TASK + f"\nPass: author. Judge independently.\nSource SHA256: {sha}\n"
                         + f"Images, in order, are physical pages: {pages}.\nRequested right pages: {job['targets']}.\n")
        prepare_call(job["prompt"], ROOT / job["schema"], [ROOT / p for p in job["images"]],
                     args.out / "calls" / job["key"], options, policy=POLICY)
    spec = {"origin": "machine_test", "run_id": "page-stream-page-window-probe-20261024",
        "model": args.model, "effort": args.effort, "sizes": list(SIZES), "cases": cases,
        "assignments": assignments, "jobs": list(jobs.values()), "dataset_sha256": digest(args.root / "dataset.json"),
        "public_sources": [{"sha256": sha, "records": public[sha]["public_source_records"]} for sha in required_pages],
        "protocol": "Every batch labels all internal page pairs. The fixed focal cases are not disclosed to the model."}
    atomic_json(args.out / "spec.json", spec)
    return spec


def run(args):
    spec = read_json(args.out / "spec.json")
    if spec["model"] != args.model or spec["effort"] != args.effort:
        raise ValueError("Prepared model/effort differs")
    start = time.monotonic()
    deadline = start + args.seconds

    def one(job):
        remaining = deadline - time.monotonic()
        result = {"key": job["key"], "status": "skipped"}
        if remaining < 5:
            return result
        options = SimpleNamespace(model=args.model, effort=args.effort, attempts=1, max_calls=None, timeout=min(args.timeout, remaining))
        began = time.monotonic()
        try:
            labels = call(job["prompt"], ROOT / job["schema"], [ROOT / p for p in job["images"]],
                          args.out / "calls" / job["key"], options,
                          lambda r: validate_response(r, job["targets"]), policy=POLICY)
            result.update(status="complete", labels=labels)
        except Exception as exc:
            result.update(status="failed", error=str(exc)[-500:])
        result["seconds"] = time.monotonic() - began
        return result

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = [pool.submit(one, job) for job in spec["jobs"]]
        for future in as_completed(pending):
            result = future.result()
            results.append(result)
            atomic_json(args.out / "results.json", {"origin": spec["origin"], "run_id": spec["run_id"], "results": results})
            print({"completed": len(results), "of": len(pending), "status": result["status"]}, flush=True)
    report = {**score(spec, results), "elapsed_seconds": time.monotonic() - start, "workers": args.workers,
              "code_sha256": digest(Path(__file__))}
    atomic_json(args.out / "report.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT / "window-probe")
    parser.add_argument("--home", type=Path, default=corpus_home())
    parser.add_argument("--model", default="gpt-6-luna")
    parser.add_argument("--effort", default="max")
    parser.add_argument("--cases", type=int, default=16)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    args.root, args.out = args.root.resolve(), args.out.resolve()
    if args.cases < 2 or args.cases % 2 or min(args.workers, args.seconds, args.timeout) < 1:
        parser.error("Use a positive even case count and positive execution limits")
    if args.prepare_only:
        spec = prepare(args)
        print({"cases": len(spec["cases"]), "unique_requests": len(spec["jobs"]), "sizes": spec["sizes"]})
    else:
        print(run(args))
