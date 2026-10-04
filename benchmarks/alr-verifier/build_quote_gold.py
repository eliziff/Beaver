#!/usr/bin/env python3
"""Build an independent quote-check gold from the benchmark documents.

Neither app's quote matcher is used. For each body passage that ends in a
footnote naming exactly one Canadian decision (neutral citation) or statute
held in the local A2AJ store (directly, or as a bare ibid after one that did), every quotation of five or more words in the passage becomes a
candidate. Its label comes from a plain text comparison against the full
source text:

- verbatim: after typographic normalization (quote marks, dashes, spacing,
  case), every segment between ellipses and bracketed editorial insertions
  occurs in the source, in order;
- altered: not verbatim, but every segment shares a run of at least 60% of
  its characters with the source (wording changed, dropped, or misquoted);
- absent: some segment has no such run.

Labels other than verbatim are then reviewed by reading the best-matching
source window (stored as `evidence`); decisions are kept in quotes/review.json
and applied here (`review: agent`). Each row lists the app outcomes it accepts:
verbatim -> Perfect, altered -> Partial, absent -> No match. The gold stays private under benchmarks/local-data/alr-verifier/quotes/.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import sys
import unicodedata
import zipfile
from difflib import SequenceMatcher
from pathlib import Path
from xml.etree import ElementTree

from suite import REPO, SUITE
A2AJ = Path.home() / "AppData" / "Local" / "OpenLegalData" / "providers" / "a2aj" / "a2aj.sqlite"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NEUTRAL = re.compile(r"\b((?:19|20)\d{2})\s+([A-Z][A-Za-z]{1,9})\s+(\d{1,5})\b")
QUOTE = re.compile(r"“([^“”]{20,}?)”|\"([^\"]{20,}?)\"")
SPLIT = re.compile(r"\s*(?:\.\s?\.\s?\.|…|\[[^\]]*\])\s*")
PER_DOCUMENT = 12


def norm(text: str) -> str:
    """Typography-insensitive text: no accents, no quote marks, one dash, single spaces, lower case."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub("[\"'‘’“”«»`´]", "", text)
    text = re.sub("[‐-―−]", "-", text)
    text = re.sub(r"\s*-\s*", "-", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def paragraphs(docx: Path):
    with zipfile.ZipFile(docx) as archive:
        body = ElementTree.fromstring(archive.read("word/document.xml"))
        notes_root = ElementTree.fromstring(archive.read("word/footnotes.xml"))
    notes = {}
    for note in notes_root.findall(f"{W}footnote"):
        if not note.get(f"{W}type"):
            notes[int(note.get(f"{W}id"))] = re.sub(r"\s+", " ", "".join(t.text or "" for t in note.iter(f"{W}t"))).strip()
    for para in body.iter(f"{W}p"):
        pieces: list[tuple[str, object]] = []
        for node in para.iter():
            if node.tag == f"{W}t":
                pieces.append(("text", node.text or ""))
            elif node.tag == f"{W}footnoteReference":
                pieces.append(("note", int(node.get(f"{W}id"))))
        yield pieces, notes


STATUTE = re.compile(r"\b(?:RS|S)(?:[A-Z]{1,3})?\s+(?:1[89]|20)\d{2},\s*c\s*[A-Z]{0,2}-?\s?\d+(?:\.\d+)?")


def sources_in(note: str) -> set[str]:
    found = {m.group(0) for m in NEUTRAL.finditer(note)} | {m.group(0) for m in STATUTE.finditer(note)}
    return {re.sub(r"[^0-9a-z]", "", c.casefold()): c for c in found}


def candidates(docx: Path):
    """Body quotations whose footnote names exactly one source.

    The footnote must cite exactly one decision or statute and not say it is
    "citing" or "quoting" another work; a footnote that is only an ibid (with
    an optional pinpoint) qualifies when the footnote right before it did.
    """
    previous: dict[str, str] = {}
    for pieces, notes in paragraphs(docx):
        passage = ""
        for kind, value in pieces:
            if kind == "text":
                passage += value
                continue
            note = notes.get(value, "")
            cites = sources_in(note)
            bare_ibid = re.fullmatch(r"\s*ibid\.?(\s+at\s+(paras?|s|ss|pp?)?\s*[\d–\-, ()a-z]+)?\.?\s*", note, re.I)
            if re.search(r"\b(citing|quoting|cited in|quoted in)\b", note, re.I):
                cites = {}
            elif bare_ibid:
                cites = dict(previous)
            elif re.search(r"\b(supra|ibid)\b", note, re.I):
                cites = {}
            previous = cites if len(cites) == 1 else {}
            if len(cites) == 1:
                key, citation = next(iter(cites.items()))
                for match in QUOTE.finditer(passage):
                    quote = (match.group(1) or match.group(2) or "").strip()
                    if len(quote.split()) >= 5:
                        yield {"word_footnote_id": value,
                               "footnote_text": note, "citation": citation, "citation_key": key,
                               "quote": quote, "passage": passage.strip()}
            passage = ""


def label(quote: str, source: str) -> tuple[str, str, float]:
    text = norm(source)
    segments = [s for s in (norm(part).strip(" ,.;:'\"") for part in SPLIT.split(quote)) if len(s.split()) >= 2]
    if not segments:
        return "skip", "", 0.0
    position, verbatim = 0, True
    for segment in segments:
        found = text.find(segment, position)
        if found < 0:
            verbatim = False
            break
        position = found + len(segment)
    if verbatim:
        return "verbatim", "", 1.0
    worst, evidence = 1.0, ""
    for segment in segments:
        matcher = SequenceMatcher(None, segment, text, autojunk=False)
        block = matcher.find_longest_match(0, len(segment), 0, len(text))
        coverage = block.size / max(1, len(segment))
        if coverage < worst:
            worst = coverage
            start = max(0, block.b - block.a - 40)
            evidence = text[start:start + len(segment) + 120]
    return ("altered" if worst >= 0.6 else "absent"), evidence, round(worst, 3)


def main() -> int:
    docs = json.loads((SUITE / "inputs" / "manifest.json").read_text(encoding="utf-8"))["documents"]
    inputs = sorted({REPO / d["input"] for d in docs if d.get("input")})
    db = sqlite3.connect(f"file:{A2AJ.as_posix()}?mode=ro", uri=True)
    gold = []
    for docx in inputs:
        found = []
        records = json.loads((SUITE / "arms" / "python-free" / f"{docx.stem}.json").read_text(encoding="utf-8"))["records"]
        # Footnote identity comes from the Python app's record list, matched by text
        # (its internal ids are not always Word's footnote ids).
        by_text: dict[str, list[dict]] = {}
        for record in records:
            by_text.setdefault(re.sub(r"[^0-9a-z]", "", record["text"].casefold()), []).append(record)
        for item in candidates(docx):
            same = by_text.get(re.sub(r"[^0-9a-z]", "", item["footnote_text"].casefold()), [])
            if len(same) != 1:
                continue
            item["footnote_internal_id"] = int(same[0]["internal_id"])
            item["footnote_display_id"] = str(same[0]["display_id"])
            row = db.execute(
                "select d.id, d.unofficial_text_en from citation_lookup c join document d on d.id = c.document_id "
                "where c.citation_key = ? limit 1", (item["citation_key"],)).fetchone()
            if not row or not row[1]:
                continue
            verdict, evidence, coverage = label(item["quote"], row[1])
            if verdict == "skip":
                continue
            item.update({"document": docx.name, "a2aj_document_id": row[0], "label": verdict,
                         "coverage": coverage, "evidence": evidence, "review": "auto" if verdict == "verbatim" else "pending"})
            item["id"] = "q-" + hashlib.sha256(f"{docx.name}|{item['word_footnote_id']}|{item['quote']}".encode()).hexdigest()[:12]
            found.append(item)
        # Keep each document's share small and fixed: all non-verbatim candidates are
        # informative, then verbatim ones by stable hash order.
        found.sort(key=lambda q: q["id"])
        other = [q for q in found if q["label"] != "verbatim"][: PER_DOCUMENT // 2]
        kept = other + [q for q in found if q["label"] == "verbatim"][: PER_DOCUMENT - len(other)]
        gold.extend(kept)
        print(f"{docx.name}: {len(found)} candidates, kept {len(kept)}", file=sys.stderr)
    out = SUITE / "quotes"
    out.mkdir(parents=True, exist_ok=True)
    target = out / "quote_gold.jsonl"
    # Agent review decisions live beside the gold: {id: {label, accept?, note}}; label
    # "exclude" drops a candidate that is not a quotation of the cited source.
    reviews_path = out / "review.json"
    reviews = json.loads(reviews_path.read_text(encoding="utf-8")) if reviews_path.exists() else {}
    with target.open("w", encoding="utf-8") as stream:
        for item in gold:
            review = reviews.get(item["id"])
            if review:
                item.update({"label": review["label"], "review": "agent", "review_note": review.get("note", "")})
                if review.get("accept"):
                    item["accept"] = review["accept"]
            if item["label"] == "exclude":
                continue
            item.setdefault("accept", {"verbatim": ["perfect"], "altered": ["partial"], "absent": ["no_match"]}[item["label"]])
            stream.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(f"{len(gold)} quote gold rows -> {target}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
