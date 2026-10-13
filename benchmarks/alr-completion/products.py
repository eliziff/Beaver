"""Run the existing Free-mode ALR consumer serially with local/replayed sources.

No builds, model calls, gold changes, or live provider requests. Bundle the
existing compose runtime first with benchmarks/alr-verifier/bundle.mjs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "benchmarks/local-data/alr-completion"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["baseline", "candidate", "repeat"])
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    output = STORE / ("products-" + args.phase)
    output.mkdir(parents=True, exist_ok=True)
    receipt = output / "inputs.json"
    if receipt.exists():
        parser.error("This capture already exists. Preserve it; select another phase for comparison.")
    inputs = sorted((ROOT / "benchmarks/local-data/alr-verifier/inputs").glob("*.docx"))
    if args.limit:
        inputs = inputs[:args.limit]
    if not inputs:
        parser.error("No existing manuscript inputs found")
    receipt.write_text(json.dumps({"submission_origin": "machine_test", "run_id": "alr-completion",
        "historical_input_origin": "unknown", "inputs": [
            {"path": str(p.relative_to(ROOT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs]}, indent=2) + "\n")
    command = ["node", "--experimental-strip-types", "--no-warnings", str(ROOT / "benchmarks/alr-verifier/compose.ts"),
               "--local-only", "--out", str(output), *[item for p in inputs for item in ("--input", str(p))]]
    env = {**os.environ, "ALR_RUNTIME_BUNDLE": str(ROOT / "backend/.alr-bundle/operations.mjs"),
           "ALR_EVAL_LABEL": "alr-completion", "UV_THREADPOOL_SIZE": "1", "RAYON_NUM_THREADS": "1"}
    print(f"{args.phase}: {len(inputs)} manuscripts, serial; live log: {output / 'run.log'}", flush=True)
    with (output / "run.log").open("w", encoding="utf-8") as log:
        with subprocess.Popen(command, cwd=ROOT / "backend", env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, encoding="utf-8", errors="replace") as process:
            try:
                for line in process.stdout:
                    log.write(line)
                    log.flush()
                    if line.startswith('{"document":'):
                        print(f"completed {len(list(output.rglob('*.run.json')))}/{len(inputs)}", flush=True)
                code = process.wait()
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
    artifacts = sorted(p.relative_to(output).as_posix() for p in output.rglob("*") if
                       p.is_file() and (p.suffix == ".xlsx" or p.name.endswith((".citations.json", ".quotation-results.json"))))
    (output / "artifacts.json").write_text(json.dumps(artifacts, indent=2) + "\n")
    if code or len(artifacts) != 3 * len(inputs):
        print("Incomplete product run; inspect run.log", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
