"""Three-way attestation-signal calibration (H13 configuration decision).

Compares, over the same labeled claims (archived receipts; labels are
checker-derived, not gold):

  A. word-trigram unattested share    (interim sqlite index)
  B. GPT-2 token n-gram unattested    (tokengrams, LM convention)
  C. character n-gram unattested      (tokengrams chars stream,
                                       QUIP-canonical, artifact-free)

Reports rank-AUC per signal + threshold sweeps for the leader of each
family. Decision rule (research plan workstream C2): adopt the best AUC
at matched flag-rate operating points, tie-broken by boundary
robustness and base-repo preference.

    python -X utf8 scripts/calibrate_attestation_signals.py
"""
from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_alienness_index import fnv1a64, trigram_hashes  # noqa: E402

from tokengrams import MemmapIndex  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402

ALIEN_DIR = Path(os.path.expandvars(r"%LOCALAPPDATA%\ALR Quote Verifier\alienness"))
ARCHIVE = os.path.expandvars(
    r"%LOCALAPPDATA%\OpenLegalData\experiments\legal-grounding\2026-07-30"
)
STAGE6 = os.path.expandvars(r"%TEMP%\beaver-legal-grounding\stage6-h6.jsonl")


def labeled_claims():
    files = glob.glob(os.path.join(ARCHIVE, "*.jsonl"))
    if os.path.exists(STAGE6):
        files.append(STAGE6)
    for path in files:
        for line in open(path, encoding="utf-8"):
            if not line.strip():
                continue
            row = json.loads(line)
            rec = row.get("legal_evidence_receipt") or row.get("receipt")
            if not rec:
                continue
            verdict = (rec.get("verification") or {}).get("holistic")
            if verdict in (None, "not_run"):
                continue
            claims = rec.get("claims") or []
            if verdict == "supported":
                label = "accepted"
            elif len(claims) == 1:
                label = "rejected"
            else:
                continue
            for claim in claims:
                if claim.get("deterministic_support"):
                    continue
                text = (claim.get("text") or "").strip()
                if len(text) >= 60:
                    yield label, text


def auc(accepted: list[float], rejected: list[float]) -> float:
    wins = sum(1 for a in accepted for b in rejected if b > a)
    ties = sum(1 for a in accepted for b in rejected if b == a)
    return (wins + ties / 2) / (len(accepted) * len(rejected))


def main() -> int:
    word_db = sqlite3.connect(
        f"file:{ALIEN_DIR / 'trigrams-en.sqlite'}?mode=ro", uri=True
    )
    token_index = MemmapIndex(
        str(ALIEN_DIR / "tokengrams-en.bin"), str(ALIEN_DIR / "tokengrams-en.idx")
    )
    chars_index = MemmapIndex(
        str(ALIEN_DIR / "tokengrams-en-chars.bin"),
        str(ALIEN_DIR / "tokengrams-en-chars.idx"),
    )
    tokenizer = AutoTokenizer.from_pretrained("gpt2")

    def word_unattested(text: str) -> float | None:
        hashes = trigram_hashes(text)
        if len(hashes) < 5:
            return None
        missing = 0
        for value in hashes:
            row = word_db.execute(
                "select n from trigram where hash = ?", (value,)
            ).fetchone()
            if row is None:
                missing += 1
        return missing / len(hashes)

    def token_unattested(text: str, n: int) -> float | None:
        # Leading-space mitigation for the BPE boundary artifact.
        ids = tokenizer(" " + text, add_special_tokens=False)["input_ids"]
        if len(ids) < n + 2:
            return None
        windows = [ids[i : i + n] for i in range(len(ids) - n + 1)]
        missing = sum(1 for w in windows if not token_index.contains(w))
        return missing / len(windows)

    def char_unattested(text: str, n: int) -> float | None:
        normalized = re.sub(r"\s+", " ", text).strip()
        codes = [min(ord(ch), 0xFFFE) for ch in normalized]
        if len(codes) < n + 5:
            return None
        windows = [codes[i : i + n] for i in range(len(codes) - n + 1)]
        missing = sum(1 for w in windows if not chars_index.contains(w))
        return missing / len(windows)

    signals = {
        "word-trigram (interim)": word_unattested,
        "gpt2-token n=5": lambda t: token_unattested(t, 5),
        "gpt2-token n=8": lambda t: token_unattested(t, 8),
        "char n=30": lambda t: char_unattested(t, 30),
        "char n=50": lambda t: char_unattested(t, 50),
    }
    values: dict[str, dict[str, list[float]]] = {
        name: {"accepted": [], "rejected": []} for name in signals
    }
    total = 0
    for label, text in labeled_claims():
        total += 1
        for name, fn in signals.items():
            value = fn(text)
            if value is not None:
                values[name][label].append(value)

    print(f"labeled claims: {total}")
    print(f"{'signal':24s} {'acc mean':>9s} {'rej mean':>9s} {'AUC':>6s} {'n':>9s}")
    leaders: list[tuple[float, str]] = []
    for name, groups in values.items():
        acc, rej = groups["accepted"], groups["rejected"]
        if not acc or not rej:
            continue
        area = auc(acc, rej)
        leaders.append((area, name))
        print(
            f"{name:24s} {statistics.mean(acc):9.3f} {statistics.mean(rej):9.3f} "
            f"{area:6.3f} {len(acc):4d}/{len(rej):3d}"
        )

    leaders.sort(reverse=True)
    for _, name in leaders[:2]:
        groups = values[name]
        print(f"\nthreshold sweep — {name}")
        print("t     flag(rej)  flag(acc)")
        for t in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
            fr = sum(1 for v in groups["rejected"] if v > t) / len(groups["rejected"])
            fa = sum(1 for v in groups["accepted"] if v > t) / len(groups["accepted"])
            print(f"{t:.2f}  {fr:9.3f} {fa:10.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
