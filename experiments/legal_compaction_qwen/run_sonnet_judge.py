"""Blindly judge the Luna and Qwen answers with Sonnet 4.6."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RUBRIC = (ROOT / "sonnet_judge_rubric.md").read_text(encoding="utf-8")
QWEN = ROOT / "runs" / "span-selector-qwen35-9b-callow-25-100k.json"
LUNA = ROOT / "runs" / "luna-none-bhasin-wastech-callow.receipt.json"
OUT = ROOT / "runs" / "sonnet-4-6-judge-blind-luna-v-qwen.json"


def main() -> None:
    qwen = json.loads(QWEN.read_text(encoding="utf-8"))["final_answer"]
    luna_receipt = json.loads(LUNA.read_text(encoding="utf-8"))
    luna = luna_receipt["answer"]
    # Keep provider/arm identity out of the judge prompt. The mapping is written
    # only to the audit receipt after the anonymous evaluation is complete.
    prompt = f"""You are a blind legal-answer evaluator. Apply this rubric exactly.

{RUBRIC}

Evaluate both answers independently, then compare them. Do not reward verbosity or tool activity.
Return only valid JSON matching the rubric's requested schema.

ANSWER 1:
{qwen}

ANSWER 2:
{luna}
"""
    result = subprocess.run(
        [r"C:\Users\elias\AppData\Roaming\npm\claude.cmd", "-p",
         "--model", "claude-sonnet-4-6", "--effort", "high",
         "--output-format", "json",
         "--system-prompt", "Return only the requested JSON object."],
        input=prompt, text=True, encoding="utf-8", errors="replace",
        capture_output=True, timeout=900,
    )
    envelope = json.loads(result.stdout) if result.stdout.strip() else {}
    payload = {
        "judge_model": "claude-sonnet-4-6",
        "judge_effort": "high",
        "answer_order": {"answer_1": "qwen_span_selector", "answer_2": "luna_none"},
        "returncode": result.returncode,
        "stderr": result.stderr[-4000:],
        "verdict": envelope.get("result", result.stdout),
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
