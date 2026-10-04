"""Locations shared by the ALR verifier eval scripts.

Machine-specific paths (the Python ALR-Quote-Verifier checkout, folders holding
the private benchmark documents, where to write the regression list) live in
the ignored benchmarks/local-data/alr-verifier/config.json:

    {"alr_quote_verifier": "<checkout>", "docx_roots": ["<folder>", ...],
     "regressions": "<file>"}
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SUITE = REPO / "benchmarks" / "local-data" / "alr-verifier"
_CONFIG_PATH = SUITE / "config.json"
CONFIG = json.loads(_CONFIG_PATH.read_text(encoding="utf-8")) if _CONFIG_PATH.exists() else {}
if "alr_quote_verifier" not in CONFIG:
    raise SystemExit(f"Set alr_quote_verifier in {_CONFIG_PATH}")
ALR = Path(CONFIG["alr_quote_verifier"])
GOLD_DIR = ALR / "dev" / "benchmarks"
SPLIT_GOLD = GOLD_DIR / "fast_split_manual_gold.jsonl"
FIELD_GOLD = GOLD_DIR / "field_gold_provisional.jsonl"
SUPRA_GOLD = GOLD_DIR / "supra_gold_candidates.jsonl"
DOCX_ROOTS = [REPO / "benchmarks" / "docx_corpus" / "private_sources", ALR / "data" / "inputs",
              *(Path(p) for p in CONFIG.get("docx_roots", []))]
REGRESSIONS = Path(CONFIG.get("regressions") or SUITE / "REGRESSIONS.md")
