#!/usr/bin/env python3
"""Find the private DOCX behind every ALR benchmark gold document.

Gold rows name their source document by file name (sometimes the name of a
checked workbook made from it). This script scans local private folders,
matches each gold document to the DOCX whose footnotes reproduce the gold
footnote texts, copies the match into the ignored suite folder, and writes a
manifest with source paths and hashes. Nothing here is committed or uploaded.

Run with the oracle venv (see README.md):
    python benchmarks/alr-verifier/locate_inputs.py
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree

from suite import DOCX_ROOTS as ROOTS, REPO, SPLIT_GOLD, SUITE, SUPRA_GOLD
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def loose(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    for a, b in (("‘", "'"), ("’", "'"), ("“", '"'), ("”", '"'), ("–", "-"), ("—", "-"), ("\ufffd", "")):
        text = text.replace(a, b)
    return re.sub(r"[^0-9a-z]+", "", text.casefold())


def footnotes(path: Path) -> dict[str, str]:
    try:
        with zipfile.ZipFile(path) as archive:
            root = ElementTree.fromstring(archive.read("word/footnotes.xml"))
    except (KeyError, zipfile.BadZipFile, OSError, ElementTree.ParseError):
        return {}
    notes: dict[str, str] = {}
    for note in root.findall(f"{W}footnote"):
        if note.get(f"{W}type"):
            continue
        text = "".join(node.text or "" for node in note.iter(f"{W}t"))
        if text.strip():
            notes[str(note.get(f"{W}id"))] = loose(text)
    return notes


def gold_documents() -> dict[str, list[tuple[str, str]]]:
    docs: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for path, statuses in ((SPLIT_GOLD, {"accepted"}), (SUPRA_GOLD, {"auto", "agent"})):
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("status") not in statuses:
                continue
            name = Path(str(row.get("source_doc") or "").replace("\\", "/")).name
            docs[name].append((str(row.get("footnote_number") or ""), loose(row.get("footnote_text"))))
    return docs


def main() -> int:
    candidates = sorted({p.resolve() for root in ROOTS if root.exists() for p in root.rglob("*.docx") if not p.name.startswith("~$")})
    indexed = [(path, footnotes(path)) for path in candidates]
    indexed = [(path, notes) for path, notes in indexed if notes]
    print(f"scanned {len(candidates)} docx, {len(indexed)} with footnotes", file=sys.stderr)
    inputs = SUITE / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    manifest = {"generated_by": "benchmarks/alr-verifier/locate_inputs.py", "documents": []}
    for name, rows in sorted(gold_documents().items()):
        unique = sorted(set(rows))
        best = None
        for path, notes in indexed:
            texts = set(notes.values())
            numbered = sum(1 for number, text in unique if notes.get(number) == text)
            anywhere = sum(1 for _number, text in unique if text in texts)
            score = (anywhere, numbered)
            if best is None or score > best[0]:
                best = (score, path, notes)
        (anywhere, numbered), path, notes = best
        coverage = anywhere / max(1, len(unique))
        entry = {
            "gold_source_doc": name,
            "gold_footnotes": len(unique),
            "matched_by_number": numbered,
            "matched_anywhere": anywhere,
            "coverage": round(coverage, 4),
        }
        if coverage >= 0.8:
            data = path.read_bytes()
            # One copy per distinct document; workbook-named gold aliases share it.
            stem = re.sub(r"^(\[CHECKED\]\s*|_\d+_\s*)+", "", Path(name).stem)
            stem = re.sub(r"(\[testing\]|\s*\(\d+\))+$", "", stem).strip()
            target = inputs / f"{stem}.docx"
            if not target.exists() or target.read_bytes() != data:
                shutil.copyfile(path, target)
            entry.update({
                "input": target.relative_to(REPO).as_posix(),
                "source_path": str(path),
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            })
        else:
            entry["unmatched_best_candidate"] = str(path)
        manifest["documents"].append(entry)
        print(f"{coverage:6.1%} {anywhere:4}/{len(unique):<4} {name} <- {path.name}", file=sys.stderr)
    (inputs / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
