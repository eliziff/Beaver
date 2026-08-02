"""Run Codex Luna against a Qwen receipt's compact post-verification state."""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--effort", choices=("low", "medium", "high", "max"), default="low")
    return parser.parse_args()


def compact_state(receipt: dict) -> str:
    for message in reversed(receipt.get("messages_at_end") or []):
        if message.get("role") == "user" and "[POST-VERIFICATION STATE]" in str(message.get("content")):
            return str(message["content"])
    raise RuntimeError("source receipt has no post-verification compact state")


def main() -> int:
    args = parse_args()
    receipt = json.loads(args.source_run.read_text(encoding="utf-8"))
    checkpoint = compact_state(receipt)
    prompt = (
        "Produce the final legal research answer from this compact state. "
        "Use the completed cards and verified quotations. Preserve exact quotation text, "
        "handles, and paragraph references. Compare Bhasin, Wastech, and Callow. "
        "Do not discuss this experiment or ask questions.\n\n"
        + checkpoint
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            r"C:\Users\elias\AppData\Roaming\npm\codex.cmd",
            "exec",
            "-m",
            args.model,
            "-c",
            f'model_reasoning_effort="{args.effort}"',
            "-s",
            "read-only",
            "-o",
            str(args.out),
            "-",
        ],
        input=prompt,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=1800,
    )
    answer = args.out.read_text(encoding="utf-8") if args.out.exists() else result.stdout
    receipt_out = args.out.with_suffix(".receipt.json")
    receipt_out.write_text(
        json.dumps(
            {
                "experiment": "legal_compaction_qwen_codex_luna_same_state",
                "created_utc": datetime.now(timezone.utc).isoformat(),
                "source_run": str(args.source_run),
                "model": args.model,
                "effort": args.effort,
                "returncode": result.returncode,
                "answer": answer,
                "stderr": result.stderr[-4000:],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {args.out}")
    print(f"wrote {receipt_out}")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
