"""Mechanical v2 experiment controller; the agent proposes mutations between calls.

init ROOT OLD_V1_ROOT; noise ROOT; evaluate ROOT HYPOTHESIS; confirm ROOT; status ROOT
No publication or installed-app actions. Mutable receipts live under ignored .tmp/.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import psutil

REPO = Path(__file__).resolve().parents[1]
ALLOWED = ("frontend/src/app/court-records/pdfText.ts", "frontend/src/app/court-records/assembly.ts",
           "backend/src/lib/pdfAssembly.ts")
EVALUATOR = ("scripts/benchmark-court-pdf.mjs", "scripts/monitor-court-pdf-benchmark.py",
             "scripts/court-pdf-score.mjs", "scripts/court-pdf-score.test.mjs", "scripts/court-pdf-search.py",
             "scripts/fixtures/court-pdf-benchmark.ts", "scripts/fixtures/court-pdf-benchmark.html")


def sha(filename):
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(["git", "-c", f"safe.directory={REPO.as_posix()}", "-C", str(REPO), *args],
                                   text=True, encoding="utf-8").strip()


def save(filename, value):
    temporary = filename.with_suffix(filename.suffix + ".pending")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, filename)


def journal(root, value):
    with (root / "ledger.jsonl").open("a", encoding="utf-8") as output:
        output.write(json.dumps({"utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **value}) + "\n")


def run(command, logfile):
    with logfile.open("w", encoding="utf-8") as output:
        result = subprocess.run(command, cwd=REPO, stdout=output, stderr=subprocess.STDOUT)
    return result.returncode


def verify(root):
    frozen = json.loads((root / "frozen.json").read_text(encoding="utf-8"))
    for name, expected in frozen["evaluator"].items():
        if sha(REPO / name) != expected:
            raise ValueError(f"Evaluator changed: versioned restart/rebaseline required ({name})")
    for name, expected in frozen["files"].items():
        if sha(root / name) != expected:
            raise ValueError(f"Frozen input changed: versioned restart/rebaseline required ({name})")
    return json.loads((root / "owner.json").read_text(encoding="utf-8"))


@contextlib.contextmanager
def timing_window(gates):
    # All concurrent timing tasks should take this shared lock. Never stop their processes.
    filename = Path(os.environ.get("BEAVER_TIMING_LOCK", Path(tempfile.gettempdir()) / "beaver-objective-timing.lock"))
    marker = {"kind": "beaver.timing-lock.v1", "pid": os.getpid(), "created": psutil.Process().create_time()}
    try:
        descriptor = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        previous = json.loads(filename.read_text(encoding="utf-8"))
        alive = psutil.pid_exists(previous.get("pid", -1))
        if alive:
            alive = abs(psutil.Process(previous["pid"]).create_time() - previous.get("created", 0)) < 0.001
        if previous.get("kind") != marker["kind"] or alive:
            raise RuntimeError(f"Timing window held by another task: {filename}")
        if json.loads(filename.read_text(encoding="utf-8")) != previous:
            raise RuntimeError("Timing lock changed while inspecting an abandoned owner")
        filename.unlink()
        descriptor = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(marker, output)
        psutil.cpu_percent()
        samples = []
        for _ in range(5):
            time.sleep(0.2)
            samples.append(psutil.cpu_percent())
        if max(samples) > gates["maximumBackgroundCpuPercent"]:
            raise RuntimeError(f"Host not quiet enough for serialized timing: CPU samples {samples}; limit {gates['maximumBackgroundCpuPercent']}%")
        yield samples
    finally:
        if filename.exists() and json.loads(filename.read_text(encoding="utf-8")) == marker:
            filename.unlink()


def main():
    mode, root_arg, *extra = sys.argv[1:]
    root = Path(root_arg).resolve()
    if not root.is_relative_to(REPO / ".tmp"):
        raise ValueError("Experiment root must be inside this isolated checkout's .tmp")
    if mode == "init":
        if git("status", "--porcelain"):
            raise ValueError("Commit the evaluator before freezing an initial incumbent")
        if run(["node", "scripts/benchmark-court-pdf.mjs", "freeze", str(root)], REPO / ".tmp" / "search-v2-freeze.log"):
            raise RuntimeError("Freeze failed; preserve log and use a fresh versioned root")
        owner = json.loads((root / "owner.json").read_text(encoding="utf-8"))
        old = Path(extra[0]).resolve()
        old_owner = json.loads((old / "owner.json").read_text(encoding="utf-8"))
        if owner["sourceSha256"] != old_owner["sourceSha256"] or git("diff", old_owner["head"], "HEAD", "--", "frontend/src", "shared", "backend/src/lib/pdfAssembly.ts"):
            raise ValueError("Legacy oracle cannot seed changed production source")
        for workload in ("medium", "large"):
            if sha(root / "fixtures" / f"{workload}.json") != sha(old / "fixtures" / f"{workload}.json"):
                raise ValueError("Legacy oracle inputs differ")
        if any(owner["inputs"].get(name) != expected for name, expected in old_owner["inputs"].items()):
            raise ValueError("Legacy source PDF hashes differ")
        (root / "oracle.json").write_bytes((old / "oracle.json").read_bytes())
        files = {str(name.relative_to(root)).replace("\\", "/"): sha(name)
                 for directory in (root / "fixtures", root / "baseline") for name in directory.rglob("*") if name.is_file()}
        files.update({name: sha(root / name) for name in ("owner.json", "oracle.json")})
        save(root / "frozen.json", {"evaluator": {name: sha(REPO / name) for name in EVALUATOR}, "files": files,
                                    "restartReason": "User corrected objective; v1 is archived, not reinterpreted as an accepted gain"})
        best = {"commit": git("rev-parse", "HEAD"), "score": 1.0, "normalizedCells": {key: 1.0 for key in
                ("medium/cold", "medium/warm", "large/cold", "large/warm")}, "assets": "baseline", "assetHashes": owner["baselineAssets"]}
        save(root / "best.json", best)
        save(root / "state.json", {"nextExperiment": 1, "noiseEstablished": False, "confirmed": [], "completedExperiments": 0,
                                   "legacyCompletedExperiments": 1, "legacyRoot": str(old)})
        journal(root, {"experiment": 0, "base": best["commit"], "candidate": best["commit"], "hypothesis": "Frozen initial incumbent",
                       "scoreVector": best["normalizedCells"], "score": 1.0, "constraints": owner["gates"], "timings": None,
                       "decision": "baseline", "reason": "Normalization anchor; A/A noise calibration required before search"})
        print(json.dumps({"root": str(root), "incumbent": best, "objective": owner["objective"], "constraints": owner["gates"]}))
        return 0
    owner = verify(root)
    best = json.loads((root / "best.json").read_text(encoding="utf-8"))
    state = json.loads((root / "state.json").read_text(encoding="utf-8"))
    if mode == "status":
        print(json.dumps({"best": best, "state": state, "constraints": owner["gates"]}, indent=2))
        return 0
    if mode not in ("noise", "evaluate", "confirm"):
        raise ValueError("Unknown search operation")
    if git("rev-parse", "HEAD") != best["commit"]:
        raise ValueError("HEAD differs from the saved global incumbent")
    changed = git("diff", "HEAD", "--name-only").splitlines()
    if any(name not in ALLOWED for name in changed) or git("ls-files", "--others", "--exclude-standard"):
        raise ValueError("Refusing candidate work outside the explicitly owned production files")
    if mode == "evaluate" and (not changed or not state["noiseEstablished"]):
        raise ValueError("A bounded candidate and a valid A/A calibration are required")
    if mode != "evaluate" and changed:
        raise ValueError("Noise/held-out checks require a clean incumbent")
    if mode == "confirm" and best["commit"] in state["confirmed"]:
        raise ValueError("Held-out confirmation already exists for this incumbent")
    event_count = len((root / "ledger.jsonl").read_text(encoding="utf-8").splitlines())
    attempt = root / f"event-{event_count:04d}-{mode}"
    attempt.mkdir()
    row = {"experiment": state["nextExperiment"] if mode == "evaluate" else 0, "base": best["commit"],
           "candidate": best["commit"], "hypothesis": extra[0] if extra else mode, "scoreVector": None, "score": None,
           "constraints": owner["gates"], "timings": None, "decision": "failure", "reason": None,
           "baseSourceHashes": {name: hashlib.sha256(subprocess.check_output(["git", "-C", str(REPO), "show", f"HEAD:{name}"])).hexdigest() for name in ALLOWED},
           "candidateSourceHashes": {name: sha(REPO / name) for name in ALLOWED}, "receipt": str(attempt.relative_to(root))}
    if changed:
        git("diff", "HEAD", "--binary", f"--output={attempt / 'candidate.patch'}", "--", *changed)
        row["candidatePatchSha256"] = sha(attempt / "candidate.patch")
    committed = False
    try:
        with timing_window(owner["gates"]) as cpu_samples:
            row["preflightCpuPercent"] = cpu_samples
            if mode == "evaluate":
                git("diff", "--check")
                tests = ["node", "--max-old-space-size=384", "./node_modules/vitest/vitest.mjs", "run", "src/app/court-records/assembly.test.ts"]
                with (attempt / "focused-tests.log").open("w", encoding="utf-8") as output:
                    if subprocess.run(tests, cwd=REPO / "frontend", stdout=output, stderr=subprocess.STDOUT).returncode:
                        raise RuntimeError("Focused PDF assembly behavior tests failed")
                git("add", "--", *changed)
                if run([sys.executable, "scripts/check_privacy.py", "--staged"], attempt / "privacy.log"):
                    raise RuntimeError("Staged privacy check failed")
                git("-c", "user.name=Codex", "-c", "user.email=codex@users.noreply.github.com", "commit", "-m", f"PDF search experiment {state['nextExperiment']}: {row['hypothesis']}")
                committed = True
                row["candidate"] = git("rev-parse", "HEAD")
            measurement = attempt / "measurement"
            operation = "compare" if mode == "evaluate" else mode
            command = [sys.executable, "scripts/monitor-court-pdf-benchmark.py", str(measurement), "--", "node",
                       "scripts/benchmark-court-pdf.mjs", operation, str(root), str(measurement), "10", "3"]
            row["evaluatorCommand"] = command
            code = run(command, attempt / "evaluator.log")
            report = json.loads((measurement / "report.json").read_text(encoding="utf-8"))
            host = json.loads((measurement / "host.json").read_text(encoding="utf-8"))
            row.update(scoreVector=report["score"], timings=report["summary"], host=host["summary"])
            row["score"] = best["score"] * report["score"]["normalizedRatio"]
            if code or not report["outputEquivalent"] or report["failures"] or host["failures"]:
                raise RuntimeError("; ".join(report["failures"] + host["failures"]) or "Evaluator failed")
            if mode == "noise":
                if not report["score"]["lower05"] <= 1 <= report["score"]["upper95"]:
                    raise RuntimeError("A/A confidence interval excludes equality; investigate evaluator bias before mutations")
                state["noiseEstablished"] = True
                state["noise"] = report["score"]
                row.update(decision="baseline", reason="A/A calibration passed; noise interval archived")
            elif mode == "confirm":
                state["confirmed"].append(best["commit"])
                row.update(decision="confirmation", reason="Held-out exact outputs and constraints passed")
            else:
                cells = {key: best["normalizedCells"][key] * ratio for key, ratio in report["score"]["ratios"].items()}
                best = {"commit": row["candidate"], "score": row["score"], "normalizedCells": cells,
                        "assets": str((measurement / "candidate").relative_to(root)).replace("\\", "/"),
                        "assetHashes": report["candidateAssetHashes"]}
                save(root / "best.json", best)
                row.update(decision="keep", reason="Strict repeatable geometric-mean improvement; all constraints passed")
    except Exception as error:
        row["reason"] = str(error)
        row["decision"] = "discard" if mode == "evaluate" else "failure"
    finally:
        if mode == "evaluate":
            state["completedExperiments"] += 1
            state["nextExperiment"] += 1
            if row["decision"] != "keep" and changed:
                # Restore only this attempt's known files; keep its committed candidate for resumption.
                git("restore", f"--source={row['base']}", "--staged", "--worktree", "--", *changed)
                if committed:
                    git("reset", "--soft", row["base"])
        save(root / "state.json", state)
        journal(root, row)
        print(json.dumps({"experiment": row["experiment"], "candidate": row["candidate"], "decision": row["decision"],
                          "reason": row["reason"], "bestCommit": best["commit"], "bestScore": best["score"]}))
    return 0 if row["decision"] in ("keep", "baseline", "confirmation") else 1


if __name__ == "__main__":
    raise SystemExit(main())
