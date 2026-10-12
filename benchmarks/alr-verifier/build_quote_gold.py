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

import argparse
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

REPO = Path(__file__).resolve().parents[2]
SUITE = REPO / "benchmarks" / "local-data" / "alr-verifier"
A2AJ = Path.home() / "AppData" / "Local" / "OpenLegalData" / "providers" / "a2aj" / "a2aj.sqlite"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NEUTRAL = re.compile(r"\b((?:19|20)\d{2})\s+([A-Z][A-Za-z]{1,9})\s+(\d{1,5})\b")
QUOTE = re.compile(r"“([^“”]{20,}?)”|\"([^\"]{20,}?)\"")
SPLIT = re.compile(r"\s*(?:\.\s?\.\s?\.|…|\[[^\]]*\])\s*")
PER_DOCUMENT = 12

# The wide inventory is independent of both checkers and never labels their output.
WIDE_OUTCOMES = {"literal", "supported_explicit_edits", "wording_mismatch", "absent", "not_source_quotation", "pending"}


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def utf16_slice(text: str, start: int, end: int) -> str:
    return text.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")


def _xml_member(archive: zipfile.ZipFile, name: str):
    matches = [member for member in archive.namelist() if member.replace("\\", "/") == name]
    if len(matches) > 1:
        raise ValueError(f"Ambiguous DOCX member: {name}")
    return (matches[0], ElementTree.fromstring(archive.read(matches[0]))) if matches else (None, None)


def _styles(root) -> dict:
    styles = {}
    if root is not None:
        for style in root.findall(f"{W}style"):
            name, parent = style.find(f"{W}name"), style.find(f"{W}basedOn")
            styles[style.get(f"{W}styleId")] = {
                "name": name.get(f"{W}val", "") if name is not None else "",
                "parent": parent.get(f"{W}val") if parent is not None else None,
                "properties": style.find(f"{W}pPr"),
            }
    return styles


def _paragraph_style(para, styles: dict) -> dict:
    props = para.find(f"{W}pPr")
    style_node = props.find(f"{W}pStyle") if props is not None else None
    style_id = style_node.get(f"{W}val") if style_node is not None else None
    ancestry, seen, current = [], set(), style_id
    inherited = []
    while current in styles and current not in seen:
        seen.add(current)
        style = styles[current]
        ancestry.append({"id": current, "name": style["name"]})
        if style["properties"] is not None:
            inherited.append(style["properties"])
        current = style["parent"]
    properties = ([props] if props is not None else []) + inherited
    indent = 0
    for item in properties:
        node = item.find(f"{W}ind")
        if node is not None and (node.get(f"{W}start") is not None or node.get(f"{W}left") is not None):
            indent = int(node.get(f"{W}start", node.get(f"{W}left", "0")))
            break
    numbered = any(item.find(f"{W}numPr") is not None for item in properties)
    quote_style = any(re.search(r"(?:^|[^a-z])(?:quote|quotation|blockquote|blocktext)(?:$|[^a-z])",
                               re.sub(r"([a-z])([A-Z])", r"\1 \2", item["name"] or item["id"]), re.I)
                      for item in ancestry)
    return {"style_id": style_id, "style_ancestry": ancestry, "indent_twips": indent,
            "numbered": numbered, "block_candidate": "quotation_style" if quote_style else
            "indented_paragraph" if indent >= 360 and not numbered else None}


def _visible_paragraph(para, index: int, start: int, styles: dict) -> dict:
    pieces, runs, references, symbols = [], [], [], []
    offset, run_index = start, -1

    def visit(node, path: list[int], owner: int):
        nonlocal offset, run_index
        if node is not para and node.tag in {f"{W}p", f"{W}del", f"{W}moveFrom"}:
            return
        if node.tag == f"{W}r":
            run_index += 1
            owner = run_index
        kind = node.tag.removeprefix(W)
        value = None
        if kind == "t":
            value = node.text or ""
        elif kind == "tab":
            value = "\t"
        elif kind in {"br", "cr"}:
            value = "\n"
        elif kind == "noBreakHyphen":
            value = "\u2011"
        elif kind == "softHyphen":
            value = "\u00ad"
        elif kind in {"footnoteReference", "endnoteReference"}:
            references.append({"kind": "footnote" if kind == "footnoteReference" else "endnote",
                               "word_note_id": int(node.get(f"{W}id")), "span": {"start": offset, "end": offset},
                               "node_path": path})
        elif kind == "sym":
            value = "\ufffc"
            symbols.append({"span": {"start": offset, "end": offset + 1},
                            "font": node.get(f"{W}font"), "char": node.get(f"{W}char"), "node_path": path})
        if value is not None:
            end = offset + utf16_length(value)
            pieces.append(value)
            runs.append({"run_index": owner, "node_path": path, "kind": kind,
                         "text": value, "span": {"start": offset, "end": end}})
            offset = end
        for child_index, child in enumerate(node):
            visit(child, path + [child_index], owner)

    visit(para, [], -1)
    return {"index": index, "text": "".join(pieces), "span": {"start": start, "end": offset},
            "runs": runs, "references": references, "unresolved_symbols": symbols,
            **_paragraph_style(para, styles)}


def _story(root, member: str, story_id: str, kind: str, word_note_id, styles: dict) -> dict:
    paragraphs, cursor = [], 0
    parents = {child: parent for parent in root.iter() for child in parent}
    for index, para in enumerate(root.iter(f"{W}p")):
        ancestor = parents.get(para)
        excluded = False
        while ancestor is not None and ancestor is not root:
            if ancestor.tag in {f"{W}del", f"{W}moveFrom"}:
                excluded = True
                break
            ancestor = parents.get(ancestor)
        if excluded:
            continue
        packet = _visible_paragraph(para, index, cursor, styles)
        paragraphs.append(packet)
        cursor = packet["span"]["end"] + 1
    return {"id": story_id, "kind": kind, "xml_member": member, "word_note_id": word_note_id,
            "paragraphs": paragraphs, "text": "\n".join(para["text"] for para in paragraphs)}


def _quotation_spans(text: str, paragraphs: list[dict]) -> list[dict]:
    """Keep nested delimiters and unmatched candidates; contractions are not delimiters."""
    openers = {"\u201c": "curly_double", "\u2018": "curly_single", "\u00ab": "guillemet",
               "\u2039": "single_guillemet"}
    closers = {"\u201d": "curly_double", "\u2019": "curly_single", "\u00bb": "guillemet",
               "\u203a": "single_guillemet"}
    boundaries, cursor = {}, 0
    for index, para in enumerate(paragraphs[:-1]):
        cursor += len(para["text"])
        boundaries[cursor] = (para, paragraphs[index + 1])
        cursor += 1
    stack, spans = [], []
    for position, char in enumerate(text):
        if position in boundaries and stack:
            para, following = boundaries[position]
            next_text = following["text"].lstrip()
            next_family = openers.get(next_text[:1], {"\"": "straight_double", "'": "straight_single"}.get(next_text[:1]))
            named_block = para.get("block_candidate") == following.get("block_candidate") == "quotation_style"
            if not named_block and next_family != stack[0]["family"]:
                for item in stack:
                    spans.append({**item, "end": position, "inner_start": item["start"] + 1,
                                  "inner_end": position, "delimiter_status": "unclosed_paragraph"})
                stack.clear()
            elif not named_block:
                stack[0]["continuation_ambiguous"] = True
        before = text[position - 1] if position else ""
        after = text[position + 1] if position + 1 < len(text) else ""
        if char in {"'", "\u2019", "\u2018"} and before.isalnum() and after.isalnum():
            continue
        if char in {"\"", "'"}:
            family = "straight_double" if char == "\"" else "straight_single"
            is_close = bool(stack and stack[-1]["family"] == family)
            if char == "'" and not is_close and (before.isalnum() or not after or after.isspace()):
                continue
        elif char in openers:
            family, is_close = openers[char], False
        elif char in closers:
            family, is_close = closers[char], True
            if char == "\u2019" and not any(item["family"] == family for item in stack) and before.isalnum():
                continue
        else:
            continue
        if not is_close:
            # Repeated opening marks at new paragraphs can continue the same quotation.
            if stack and stack[-1]["family"] == family and position > 0 and not text[text.rfind("\n", 0, position) + 1:position].strip():
                stack[-1].setdefault("continuation_marks", []).append(position)
            else:
                stack.append({"start": position, "family": family,
                              "parent_start": stack[-1]["start"] if stack else None})
            continue
        matching = next((index for index in range(len(stack) - 1, -1, -1) if stack[index]["family"] == family), None)
        if matching is None:
            spans.append({"start": text.rfind("\n", 0, position) + 1, "end": position + 1,
                          "inner_start": text.rfind("\n", 0, position) + 1, "inner_end": position,
                          "family": family, "parent_start": stack[-1]["start"] if stack else None,
                          "delimiter_status": "unmatched_closer"})
            continue
        for item in stack[matching + 1:]:
            spans.append({**item, "end": position, "inner_start": item["start"] + 1,
                          "inner_end": position, "delimiter_status": "crossed_or_unclosed"})
        item = stack[matching]
        spans.append({**item, "end": position + 1, "inner_start": item["start"] + 1,
                      "inner_end": position, "delimiter_status": "continuation_candidate" if item.get("continuation_ambiguous") else "paired"})
        if item.get("continuation_ambiguous"):
            for mark in item.get("continuation_marks", []):
                spans.append({"start": mark, "end": position + 1, "inner_start": mark + 1,
                              "inner_end": position, "family": family, "parent_start": None,
                              "delimiter_status": "paired", "detection": "possible_repeated_opener_continuation"})
        del stack[matching:]
    for item in stack:
        spans.append({**item, "end": len(text), "inner_start": item["start"] + 1,
                      "inner_end": len(text), "delimiter_status": "unclosed"})
    return sorted(spans, key=lambda item: (item["start"], -item["end"]))


def _block_spans(story: dict) -> list[dict]:
    groups, current = [], []
    for para in story["paragraphs"]:
        reason = para["block_candidate"] if para["text"].strip() else None
        if current and (not reason or reason != current[-1]["block_candidate"]):
            groups.append(current)
            current = []
        if reason:
            current.append(para)
    if current:
        groups.append(current)
    return [{"start": group[0]["span"]["start"], "end": group[-1]["span"]["end"],
             "inner_start": group[0]["span"]["start"], "inner_end": group[-1]["span"]["end"],
             "family": "block", "delimiter_status": "block_candidate", "parent_start": None,
             "detection": group[0]["block_candidate"]} for group in groups]


def wide_document_inventory(entry: dict) -> dict:
    """Original OOXML all-occurrence inventory; every verdict starts explicitly pending."""
    path = Path(entry["input"])
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    if sha != entry["sha256"]:
        raise ValueError(f"Manuscript hash changed: {entry['id']}")
    with zipfile.ZipFile(path) as archive:
        member, body = _xml_member(archive, "word/document.xml")
        if body is None:
            raise ValueError(f"Missing document.xml: {entry['id']}")
        styles = _styles(_xml_member(archive, "word/styles.xml")[1])
        stories = [_story(body, member, "body", "body", None, styles)]
        for kind in ("footnote", "endnote"):
            member, root = _xml_member(archive, f"word/{kind}s.xml")
            if root is not None:
                for note in root.findall(f"{W}{kind}"):
                    if note.get(f"{W}type") in {"separator", "continuationSeparator", "continuationNotice"}:
                        continue
                    note_id = int(note.get(f"{W}id"))
                    stories.append(_story(note, member, f"{kind}:{note_id}", kind, note_id, styles))
    notes = {(story["kind"], story["word_note_id"]): story for story in stories if story["kind"] != "body"}
    records = []
    for story in stories:
        text = story["text"]
        offsets = [0]
        for char in text:
            offsets.append(offsets[-1] + utf16_length(char))
        inline = [{**item, "start": offsets[item["start"]], "end": offsets[item["end"]],
                   "inner_start": offsets[item["inner_start"]], "inner_end": offsets[item["inner_end"]],
                   "parent_start": offsets[item["parent_start"]] if item.get("parent_start") is not None else None,
                   "continuation_marks": [offsets[value] for value in item.get("continuation_marks", [])]}
                  for item in _quotation_spans(text, story["paragraphs"])]
        blocks = _block_spans(story)
        for block in blocks:
            covering = next((item for item in inline if item["start"] <= block["start"] + 1 and item["end"] >= block["end"] - 1), None)
            if covering:
                covering["block_detection"] = block["detection"]
            else:
                inline.append(block)
        story_records = []
        for item in sorted(inline, key=lambda value: (value["start"], -value["end"])):
            covered = [para for para in story["paragraphs"] if para["span"]["start"] < item["end"] and para["span"]["end"] >= item["start"]]
            if not covered:
                continue
            context_start, context_end = covered[0]["span"]["start"], covered[-1]["span"]["end"]
            context = utf16_slice(text, context_start, context_end)
            related = []
            for para in covered:
                for ref in para["references"]:
                    note = notes.get((ref["kind"], ref["word_note_id"]))
                    related.append({"kind": ref["kind"], "word_note_id": ref["word_note_id"],
                                    "text": note["text"] if note else None, "reference_span": ref["span"]})
            if story["kind"] != "body":
                related.insert(0, {"kind": story["kind"], "word_note_id": story["word_note_id"],
                                   "text": text, "reference_span": None})
            identity = f"{sha}|{story['xml_member']}|{story['id']}|{item['family']}|{item['start']}:{item['end']}"
            record_id = "q-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
            authored = {"quote": utf16_slice(text, item["inner_start"], item["inner_end"]),
                        "context": context, "context_span": {"start": context_start, "end": context_end},
                        "xml_member": story["xml_member"], "story_id": story["id"],
                        "paragraph_index": covered[0]["index"], "paragraph_indices": [para["index"] for para in covered],
                        "word_note_id": story["word_note_id"], "quote_kind": item["family"],
                        "outer_span": {"start": item["start"], "end": item["end"]},
                        "inner_span": {"start": item["inner_start"], "end": item["inner_end"]},
                        "outer_text": utf16_slice(text, item["start"], item["end"]),
                        "context_sha256": hashlib.sha256(context.encode("utf-8")).hexdigest(),
                        "related_notes": related, "delimiter_status": item["delimiter_status"],
                        "continuation_marks": item.get("continuation_marks", [])}
            if item.get("detection") or item.get("block_detection"):
                authored["block_detection"] = item.get("detection", item.get("block_detection"))
            authored["editorial_marker_candidates"] = [
                {"text": marker.group(), "span": {"start": item["inner_start"] + utf16_length(authored["quote"][:marker.start()]),
                                                   "end": item["inner_start"] + utf16_length(authored["quote"][:marker.end()])}}
                for marker in re.finditer(r"\[[^\]\n]*\]|\u2026|\.(?:\s*\.){2,}", authored["quote"])]
            record = {"id": record_id, "authored": authored, "cited_pinpoints": [],
                      "expected": {"outcome": "pending", "correct_pinpoints": [], "source_witnesses": [],
                                   "altered_authored_spans": [], "retained_authored_spans": []},
                      "review": {"status": "pending", "method": "independent_original_ooxml_inventory",
                                 "agent": "/root/alr_review", "reason": "Source, editorial meaning and correct pinpoint require independent review."}}
            story_records.append((item, record))
        for item, record in story_records:
            parent = next((other for other_item, other in story_records if other_item["delimiter_status"] == "paired" and
                           item["delimiter_status"] == "paired" and other_item["start"] == item.get("parent_start") and
                           other_item["start"] < item["start"] and other_item["end"] >= item["end"]), None)
            if parent:
                record["parent_record_id"] = parent["id"]
                record["review"].update(status="covered_by_parent", reason="Nested source quotation is retained; the complete owning outer quotation is scored once.")
            records.append(record)
    return {"schema_version": 1, "run_id": "quotation-gold-wide-inventory", "submission_origin": "machine_test",
            "historical_input_origin": "unknown", "privacy": "private local-only ignored independent gold",
            "manuscript": {"id": entry["id"], "index": entry["index"], "sha": sha, "input": str(path)},
            "coordinates": "UTF16 code units in story visible text, with one LF between paragraphs; half-open spans",
            "visible_view": "OOXML text including insertions/moveTo and field results; excludes deletions/moveFrom/instructions; unresolved symbols use U+FFFC",
            "comparison_policy": {"word_boundaries": "whole words required", "case": "existing initial-letter variation allowed; other case retained",
                                  "typography": "quote/dash/spacing variants may be independently normalized; exact authored text is always retained",
                                  "editorial_edits": "must be explicitly marked and individually supported; empty brackets are not presumed supported"},
            "stories": [{key: value for key, value in story.items() if key != "text"} for story in stories],
            "records": records,
            "inventory": {"complete": True, "occurrences": len(records),
                          "covered_by_parent": sum(record["review"]["status"] == "covered_by_parent" for record in records),
                          "unresolved_symbols": sum(len(para["unresolved_symbols"]) for story in stories for para in story["paragraphs"]),
                          "adjudication_complete": False}}


def a2aj_sources_for_citation(db: sqlite3.Connection, citation: str) -> list[dict]:
    """Canonical source retrieval for independent annotation, never a quotation verdict."""
    columns = ("id", "citation_en", "citation_fr", "citation2_en", "citation2_fr", "name_en", "name_fr",
               "unofficial_text_en", "unofficial_text_fr", "unofficial_sections_en", "unofficial_sections_fr")
    match = re.fullmatch(r"((?:19|20)\d{2})\s+([A-Za-z][A-Za-z.]{1,15})\s+(\d+)", citation.strip())
    key = f"3:neutral:{match[1]}:{match[2].casefold()}:{match[3]}" if match else None
    scr = re.fullmatch(r"\[?(\d{4})\]?\s*(\d*)\s*S\.?C\.?R\.?\s*(\d+)", citation.strip(), re.I)
    if scr:
        key = ":".join(["3", "reporter", "scr", "scr", scr[1], *([scr[2]] if scr[2] else []), scr[3]])
    if key:
        sql = "select " + ",".join("d." + column for column in columns) + " from citation_lookup c join document d on d.id=c.document_id where c.citation_key=?"
        args = [key]
    else:
        sql = "select " + ",".join("d." + column for column in columns) + " from document d where "
        sql += "d.citation_en=? or d.citation_fr=? or d.citation2_en=? or d.citation2_fr=?"
        args = [citation] * 4
    result = []
    for row in db.execute(sql, args):
        packet = dict(zip(columns, row))
        packet["provider"], packet["document_id"] = "a2aj", packet.pop("id")
        packet["id"] = packet["citation_en"] or packet["citation_fr"]
        result.append(packet)
    return result


def build_wide_gold(manifest_path: Path) -> int:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    out = SUITE / "quotes" / "wide"
    out.mkdir(parents=True, exist_ok=True)
    documents = []
    for entry in manifest["documents"]:
        target = out / f"{entry['id']}.json"
        if target.exists():
            packet = json.loads(target.read_text(encoding="utf-8"))
            if packet["manuscript"]["sha"] != entry["sha256"]:
                raise ValueError(f"Existing reviewed gold has a different manuscript hash: {target}")
        else:
            packet = wide_document_inventory(entry)
            target.write_text(json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        documents.append({"id": entry["id"], "index": entry["index"], "sha256": entry["sha256"],
                          "gold": target.relative_to(out).as_posix(), "occurrences": len(packet["records"])})
        print(f"{entry['id']}: {len(packet['records'])} original quotation candidates", file=sys.stderr)
    legacy = SUITE / "quotes" / "quote_gold.jsonl"
    gold_manifest = {"schema_version": 1, "run_id": "quotation-gold-wide-inventory", "submission_origin": "machine_test",
                     "historical_input_origin": "unknown", "scope": "quotation only; cited and correct source pinpoints remain separate",
                     "source_manifest": {"path": str(manifest_path), "sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest()},
                     "regeneration": "python benchmarks/alr-verifier/build_quote_gold.py --wide-manifest <canonical wide-manifest.json>; existing reviewed packets are preserved",
                     "legacy_gold": {"path": str(legacy), "sha256": hashlib.sha256(legacy.read_bytes()).hexdigest()} if legacy.exists() else None,
                     "documents": documents}
    (out / "manifest.json").write_text(json.dumps(gold_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


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


def review_sources(request: dict) -> list[dict]:
    """Read the canonical sources already used by the saved app output."""
    provider = request["provider"]
    if len(request.get("query", "")) > 4000 or len(request.get("citation", "")) > 500:
        raise ValueError("Evidence query is too long")
    if provider == "a2aj":
        store = A2AJ
    elif provider == "journal":
        config = json.loads((SUITE / "config.json").read_text(encoding="utf-8"))
        store = Path(config["alr_quote_verifier"]) / "data" / "public_endpoint.db"
    else:
        raise ValueError("Unsupported evidence provider")
    with sqlite3.connect(store.as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        identifier = request.get("document_id")
        lookup = request.get("citation", "").strip()
        if provider == "a2aj":
            if identifier is not None:
                rows = [dict(row) for row in db.execute("select * from document where id=?", (int(identifier),))]
            else:
                neutral = list(NEUTRAL.finditer(lookup))
                scr_match = re.search(r"\[?(\d{4})\]?\s*(\d*)\s*S\.?C\.?R\.?\s*(\d+)", lookup, re.I)
                if len(neutral) == 1:
                    lookup = neutral[0][0]
                elif scr_match:
                    lookup = scr_match[0]
                if not (NEUTRAL.fullmatch(lookup) or re.fullmatch(r"\[?(\d{4})\]?\s*(\d*)\s*S\.?C\.?R\.?\s*(\d+)", lookup, re.I)):
                    return []
                rows = a2aj_sources_for_citation(db, lookup)
                scr = re.fullmatch(r"\[?(\d{4})\]?\s*(\d*)\s*S\.?C\.?R\.?\s*(\d+)", lookup, re.I)
                if not rows and scr:
                    key = ":".join(["3", "reporter", "scr", "scr", scr[1], *([scr[2]] if scr[2] else []), scr[3]])
                    rows = [dict(row) for row in db.execute("select d.* from citation_lookup c join document d on d.id=c.document_id where c.citation_key=?", (key,))]
        else:
            title = re.search(r'[“"]([^”"]+)[”"]', lookup)
            if title:
                lookup = title[1]
            if identifier is not None:
                rows = [dict(row) for row in db.execute("select * from articles where article_id=?", (int(identifier),))]
            else:
                index = A2AJ.parent.parent / "journals" / "public_endpoint-search.sqlite"
                words = re.findall(r"\w+", lookup)
                if not words or not index.exists():
                    rows = []
                else:
                    with sqlite3.connect(index.as_uri() + "?mode=ro", uri=True) as search:
                        ids = [row[0] for row in search.execute("select rowid from article_metadata where article_metadata match ? limit 4",
                               (" AND ".join('"' + word + '"' for word in words[:18]),))]
                    rows = [dict(row) for identifier in ids for row in db.execute("select * from articles where article_id=?", (identifier,))]
    results = []
    query = request.get("query", "")
    for row in rows:
        column = request.get("column") or ("unofficial_text_en" if provider == "a2aj" else "text")
        if column not in ({"unofficial_text_en", "unofficial_text_fr"} if provider == "a2aj" else {"text"}):
            raise ValueError("Unsupported evidence column")
        text = row.get(column) or ""
        source = {"provider": provider, "id": (row.get("citation_en") or row.get("citation_fr")) if provider == "a2aj" else str(row["article_id"]),
                  "document_id": row.get("document_id", row.get("id")) if provider == "a2aj" else row["article_id"],
                  "kind": ("legislation" if row.get("doc_type") == "laws" else "case") if provider == "a2aj" else "journal",
                  "column": column, "sha256": hashlib.sha256(text.encode()).hexdigest(),
                  "title": row.get("name_en"), "citation": row.get("citation_en"),
                  "sections": json.loads(row.get("unofficial_sections_" + column[-2:]) or "{}") if provider == "a2aj" else {}}
        results.append({**source, "text": text})
    return results


def prepare_review_jobs(manifest_path: Path, batch_size: int) -> int:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    folder = manifest_path.parent / "correction-jobs"
    folder.mkdir(exist_ok=True)
    runs = {}
    identities = {}
    for path in (manifest_path.parent / "run").rglob("*.quotes.json"):
        run = json.loads(path.read_text(encoding="utf-8"))
        digest = run["document"]["sha256"]
        if digest in runs:
            raise ValueError("Multiple saved outputs for one manuscript")
        runs[digest] = (run, hashlib.sha256(path.read_bytes()).hexdigest())
        for quote in run["quotes"]:
            for check in quote["checks"]:
                if check.get("receipt"):
                    source = check["receipt"]["source"]
                    identities[(source["provider"], source["id"], source["language"])] = None
    citations = sorted({key[1] for key in identities if key[0] == "a2aj"})
    with sqlite3.connect(A2AJ.as_uri() + "?mode=ro", uri=True) as db:
        placeholders = ",".join("?" for _ in citations)
        columns = ("citation_en", "citation_fr", "citation2_en", "citation2_fr")
        sql = "select id," + ",".join(columns) + " from document where " + " or ".join(column + " in (" + placeholders + ")" for column in columns)
        by_citation = {}
        for row in db.execute(sql, citations * 4):
            for citation in row[1:]:
                if citation:
                    by_citation.setdefault(citation, []).append(row[0])
    for key in identities:
        provider, citation, language = key
        if provider == "journal":
            identifiers = [int(citation)]
        else:
            identifiers = sorted(set(by_citation.get(citation, [])))
        if len(identifiers) != 1:
            raise ValueError(f"Saved source identity is absent or ambiguous: {key}")
        identities[key] = {"provider": provider, "document_id": identifiers[0],
                           "column": "text" if provider == "journal" else "unofficial_text_" + language}
    jobs = []
    for entry in manifest["documents"]:
        packet = json.loads((manifest_path.parent / entry["gold"]).read_text(encoding="utf-8"))
        run, run_hash = runs[packet["manuscript"]["sha"]]
        units = {unit["id"]: unit for unit in run["units"]}
        if packet.get("baseline_output_sha256") != run_hash:
            records = []
            for quote in run["quotes"]:
                checks = [check for check in quote["checks"] if check.get("receipt")]
                if not checks:
                    continue
                unit = units[quote["unitId"]]
                related = {int(ref[0]) for ref in unit.get("footnoteRefs", [])}
                for candidate in quote["candidates"]:
                    note = units.get(candidate["unitId"], {}).get("footnoteId")
                    if note is not None:
                        related.add(note)
                records.append({"id": quote["id"], "authored": {
                    "quote": quote["quote"], "context": unit["text"], "story_id": unit["id"],
                    "word_note_id": unit.get("footnoteId"), "quote_kind": "saved_output",
                    "delimiter_status": "saved_output", "context_span": {"start": 0, "end": utf16_length(unit["text"])},
                    "inner_span": {"start": quote["start"], "end": quote["end"]},
                    "related_notes": [{"kind": "footnote", "word_note_id": note} for note in sorted(related)]},
                    "observed": {**quote, "checks": checks},
                    "source_targets": [{**identities[(check["receipt"]["source"]["provider"], check["receipt"]["source"]["id"], check["receipt"]["source"]["language"])],
                                        "candidate_id": check["candidateId"]} for check in checks],
                    "expected": {"outcome": "pending", "correct_pinpoints": [], "source_witnesses": []},
                    "review": {"status": "pending", "method": "saved_output_correction"}})
            packet.update({"schema_version": 2, "scope": "Correct saved source-backed quote checks; source acquisition is outside this gold",
                           "baseline_output_sha256": run_hash, "records": records,
                           "inventory": {"complete": True, "occurrences": len(records), "source_checks": sum(len(r["observed"]["checks"]) for r in records),
                                         "adjudication_complete": False}})
            (manifest_path.parent / entry["gold"]).write_text(json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        note_numbers, notes = {}, []
        for para in packet["stories"][0]["paragraphs"]:
            for ref in para["references"]:
                key = (ref["kind"], ref["word_note_id"])
                if key not in note_numbers:
                    note_numbers[key] = len(note_numbers) + 1
        for story in packet["stories"]:
            if story["kind"] != "body":
                notes.append({"kind": story["kind"], "word_note_id": story["word_note_id"],
                              "display_number": note_numbers.get((story["kind"], story["word_note_id"])),
                              "text": "\n".join(p["text"] for p in story["paragraphs"])})
        records = [r for r in packet["records"] if r["review"]["status"] != "covered_by_parent"]
        for offset in range(0, len(records), batch_size):
            batch = records[offset:offset + batch_size]
            by_number = {(note["kind"], note["display_number"]): note for note in notes}
            by_id = {(note["kind"], note["word_note_id"]): note for note in notes}
            needed = set()
            for record in batch:
                authored = record["authored"]
                if authored["word_note_id"] is not None:
                    needed.add((authored["story_id"].split(":")[0], authored["word_note_id"]))
                needed.update((note["kind"], note["word_note_id"]) for note in authored["related_notes"])
            pending = list(needed)
            while pending:
                key = pending.pop()
                note = by_id.get(key)
                if note is None:
                    continue
                references = [int(number) for number in re.findall(r"\bsupra(?:\s+at)?\s+notes?\s+(\d+)", note["text"], re.I)]
                if re.search(r"\bibid\b", note["text"], re.I) and note["display_number"]:
                    references.append(note["display_number"] - 1)
                for number in references:
                    target = by_number.get((note["kind"], number))
                    if target and (target["kind"], target["word_note_id"]) not in needed:
                        linked = (target["kind"], target["word_note_id"])
                        needed.add(linked)
                        pending.append(linked)
            payload = {"manuscript": packet["manuscript"], "comparison_policy": packet["comparison_policy"],
                       "notes": [note for note in notes if (note["kind"], note["word_note_id"]) in needed],
                       "records": [{"id": r["id"], "observed": r["observed"], "source_targets": r["source_targets"], "authored": {key: r["authored"][key] for key in
                           ("quote", "context", "story_id", "word_note_id", "quote_kind", "delimiter_status")},
                           "related_note_ids": [{"kind": note["kind"], "word_note_id": note["word_note_id"]}
                                                for note in r["authored"]["related_notes"]]} for r in batch]}
            path = folder / f"{entry['id']}-{offset // batch_size:03}.json"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            jobs.append({"id": path.stem, "input": path.name, "gold": entry["gold"],
                         "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "records": len(batch)})
    (folder / "manifest.json").write_text(json.dumps({"schema_version": 1, "jobs": jobs}, indent=2), encoding="utf-8")
    manifest["scope"] = "Correction of saved source-backed quotation checks, including fragments, wording and correct pinpoints"
    for entry in manifest["documents"]:
        packet = json.loads((manifest_path.parent / entry["gold"]).read_text(encoding="utf-8"))
        entry["occurrences"] = packet["inventory"]["occurrences"]
        entry["source_checks"] = packet["inventory"]["source_checks"]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"jobs": len(jobs), "records": sum(j["records"] for j in jobs), "folder": str(folder)}))
    return 0


def apply_review(manifest_path: Path, result_path: Path) -> int:
    result = json.loads(result_path.read_text(encoding="utf-8"))
    gold_path = manifest_path.parent / result["gold"]
    if gold_path.parent.resolve() != manifest_path.parent.resolve():
        raise ValueError("Gold packet must be in the owning directory")
    packet = json.loads(gold_path.read_text(encoding="utf-8"))
    if packet["manuscript"]["sha"] != result["manuscript_sha256"]:
        raise ValueError("Review manuscript identity changed")
    records = {r["id"]: r for r in packet["records"]}
    seen, counts, sources = set(), {}, {}
    for review in result["records"]:
        if review["id"] in seen or review["id"] not in records:
            raise ValueError("Duplicate or unknown review occurrence")
        seen.add(review["id"])
        record = records[review["id"]]
        witnesses, problems = [], []
        for witness in review["sources"]:
            key = (witness["provider"], witness["document_id"], witness["column"])
            if key not in sources:
                sources[key] = review_sources({**witness, "full_text": True})
            raw = sources[key]
            if len(raw) != 1 or not raw[0]["text"]:
                problems.append("Canonical source unavailable")
                continue
            source = raw[0]
            if witness.get("source_sha256") != source["sha256"]:
                problems.append("Selected source version changed")
            spans, points = [], []
            for passage in witness["passages"]:
                span = witness.get("source_span")
                if not span or not 0 <= span["start"] < span["end"] <= utf16_length(source["text"]) or utf16_slice(source["text"], span["start"], span["end"]) != passage:
                    problems.append("Selected offsets do not reproduce canonical source wording")
                    continue
                spans.append(span)
                points = witness["pinpoints"]
            fragment = witness.get("source_fragment")
            if fragment is not None and fragment not in source["text"]:
                problems.append("Source fragment is not literal canonical source text")
            if witness["outcome"] == "literal":
                def literal_text(value: str) -> str:
                    value = unicodedata.normalize("NFKC", value).translate(str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-"}))
                    value = re.sub(r"(?<!\w)\[([A-Za-z])\](?=[A-Za-z])", r"\1", value)
                    value = re.sub(r"(?<!\w)'|'(?!\w)|\"", "", value)
                    value = re.sub(r"\s*-\s*", "-", value)
                    return re.sub(r"\s+", " ", value).strip()
                quote = literal_text(record["authored"]["quote"]).rstrip(".,;:!?")
                pattern = ((r"(?<!\w)" if quote[:1].isalnum() else "") +
                           ("(?i:" + re.escape(quote[:1]) + ")" + re.escape(quote[1:]) if quote else "(?!)") +
                           (r"(?!\w)" if quote[-1:].isalnum() else ""))
                proof = " ".join(witness["passages"])
                if source["provider"] == "journal":
                    footnotes = set(re.findall(r"(?m)^[ \t]*(\d{1,3})(?:[ \t]|\n)", source["text"]))
                    proof = re.sub(r"(?<=[.!?])([0-9]{1,3})(?=\s+[A-Z])",
                                   lambda match: "" if match[1] in footnotes else match[0], proof)
                if not re.search(pattern, literal_text(proof)):
                    problems.append("Literal verdict does not cover complete authored wording at whole-word boundaries")
            if witness["outcome"] not in {"pending", "absent"} and not spans:
                problems.append("Reviewed wording lacks an exact canonical witness")
                continue
            item = {key: source[key] for key in ("provider", "id", "document_id", "column", "sha256")}
            item.update({"outcome": witness["outcome"], "spans": spans, "pinpoints": points, "review_reason": witness["reason"],
                         "candidate_id": witness["candidate_id"], "source_passages": witness["passages"]})
            if not points and witness["outcome"] != "absent":
                if witness.get("pinpoint_basis") == "source_offsets" and spans:
                    item["pinpoint_basis"] = "source_offsets"
                else:
                    problems.append("Correct source location lacks printed markers or validated offsets")
            for key in ("corrected_quote", "source_fragment"):
                if witness.get(key) is not None:
                    item["corrected_quotes" if key == "corrected_quote" else "source_fragments"] = [witness[key]]
            witnesses.append(item)
        outcome = review["outcome"]
        if outcome not in WIDE_OUTCOMES or (outcome not in {"pending", "not_source_quotation"} and not witnesses):
            problems.append("Reviewed outcome lacks source evidence")
        required = {(target["candidate_id"], target["provider"], target["document_id"], target["column"]) for target in record["source_targets"]}
        returned = {(w["candidate_id"], w["provider"], w["document_id"], w["column"]) for w in review["sources"]}
        if outcome != "not_source_quotation" and required != returned:
            problems.append("Correction omitted or changed a supplied quote-source check")
        if problems or outcome == "pending" or any(w["outcome"] == "pending" or w.get("pinpoint_review", {}).get("status") == "pending" for w in witnesses):
            raise ValueError(f"Incomplete correction {review['id']}: {'; '.join(problems) or 'unfinished verdict or pinpoint'}")
        record["expected"] = {"outcome": outcome, "correct_pinpoints": [],
                              "source_witnesses": witnesses, "altered_authored_spans": [], "retained_authored_spans": []}
        record["review"] = {"status": "pending" if problems or outcome == "pending" else "reviewed",
                            "method": "codex_exec_saved_output_correction", "agent": result["arm"],
                            "reason": "; ".join(problems) if problems else review["reason"], "job": result["job"]}
        counts[record["expected"]["outcome"]] = counts.get(record["expected"]["outcome"], 0) + 1
    packet["inventory"]["adjudication_complete"] = all(r["review"]["status"] == "covered_by_parent" or
        (r["expected"]["outcome"] != "pending" and all(w["outcome"] != "pending" and w.get("pinpoint_review", {}).get("status") != "pending"
         for w in r["expected"].get("source_witnesses", []))) for r in packet["records"])
    temporary = gold_path.with_suffix(".json.new")
    try:
        temporary.write_text(json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(gold_path)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps(counts))
    return 0


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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wide-manifest", type=Path, help="Inventory every original quotation in the canonical private manuscript manifest; preserve existing reviewed packets.")
    parser.add_argument("--review-manifest", type=Path, help="Wide quotation gold manifest for scoped Codex review")
    parser.add_argument("--prepare-review", action="store_true")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--source-requests", action="store_true", help="Read scoped canonical source requests as JSON from stdin")
    parser.add_argument("--apply-review", type=Path)
    arguments = parser.parse_args()
    if arguments.source_requests:
        print(json.dumps([review_sources(request) for request in json.load(sys.stdin)], ensure_ascii=False))
    elif arguments.review_manifest and arguments.prepare_review:
        if arguments.batch_size < 1:
            parser.error("--batch-size must be positive")
        raise SystemExit(prepare_review_jobs(arguments.review_manifest, arguments.batch_size))
    elif arguments.review_manifest and arguments.apply_review:
        raise SystemExit(apply_review(arguments.review_manifest, arguments.apply_review))
    else:
        raise SystemExit(build_wide_gold(arguments.wide_manifest) if arguments.wide_manifest else main())
