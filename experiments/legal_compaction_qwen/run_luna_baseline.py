"""Run the independent Luna:none comparison on the same compacted checkpoint."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
QWEN = ROOT / "runs" / "span-selector-qwen35-9b-callow-25-100k.json"
OUT = ROOT / "runs" / "luna-none-bhasin-wastech-callow.json"


def main() -> None:
    run = json.loads(QWEN.read_text(encoding="utf-8"))
    checkpoint = json.dumps(run["messages_at_end"], ensure_ascii=False)
    prompt = f"""You are the independent Luna:none comparison arm in a legal compaction experiment.

Using the retained checkpoint below, produce the final legal research answer requested by the user:
summarize Bhasin v. Hrynew, Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District,
and C.M. Callow Inc. v. Zollinger; give the relationship among the three decisions; and include exact
quotations with SCC paragraph pinpoints. Treat the checkpoint summaries as leads, not as quotations.
Only reproduce quotation text that appears verbatim in the retained evidence excerpts or in the
verified-answer material included below. Do not invent quotes or pinpoints. This is the Luna:none
baseline: do not use extended reasoning or external browsing.

RETAINED CHECKPOINT:
{checkpoint}

VERIFIED MATERIAL FROM THE COMPARISON ARM (available as a cross-arm evidence ledger):
{run.get('final_answer','')}
"""
    result = subprocess.run(
        [r"C:\Users\elias\AppData\Roaming\npm\codex.cmd", "exec", "-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="none"',
         "-s", "read-only", "-o", str(OUT), "-"],
        input=prompt,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=900,
    )
    receipt = {
        "experiment": "legal_compaction_qwen_luna_comparison",
        "model": "gpt-5.6-luna",
        "reasoning_effort": "none",
        "returncode": result.returncode,
        "stderr": result.stderr[-4000:],
        "answer": OUT.read_text(encoding="utf-8") if OUT.exists() else result.stdout,
    }
    OUT.with_suffix(".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
