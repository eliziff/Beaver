#!/usr/bin/env python3
"""Verify real Chromium text-fragment markers without screenshots."""
from __future__ import annotations

import argparse
import ast
import bisect
from contextlib import ExitStack, nullcontext
import hashlib
import importlib.util
import json
import re
import time
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.chrome.options import Options

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fragment_exact_gate", HERE / "webdriver-exact-gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
AX_TEXT_CACHE = gate.RESULTS / "browser-ax-text"
VERIFICATION_CONTRACT = "chromium-global-intervals-v3"


def options(profile_dir, headed=False):
    value = Options()
    for argument in (
        "--no-sandbox", "--disable-gpu", "--disable-extensions",
        "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
        "--disable-sync", "--metrics-recording-only", "--no-first-run",
        "--disable-features=MediaRouter,OptimizationHints,Translate", "--disable-blink-features=AutomationControlled",
        "--force-renderer-accessibility",
        "--window-size=480,520", "--force-device-scale-factor=1",
    ):
        value.add_argument(argument)
    if not headed:
        value.add_argument("--headless=new")
    value.add_argument(f"--user-data-dir={profile_dir}")
    return value


def wait_for_stable_document(driver, timeout=15):
    deadline = time.monotonic() + timeout
    state = driver.execute_script("return document.readyState")
    while state != "complete" and time.monotonic() < deadline:
        time.sleep(0.05)
        state = driver.execute_script("return document.readyState")
    driver.execute_async_script(r"""
const done = arguments[0];
requestAnimationFrame(() => requestAnimationFrame(done));
""")
    return state


def normalized_with_map(text):
    chars, raw_map = [], []
    spaced = True
    for index, raw in enumerate(text):
        for char in unicodedata.normalize("NFKD", raw.casefold()):
            char = {
                "\u05f3": "'", "\u05f4": '"', "\u2018": "'", "\u2019": "'",
                "\u201c": '"', "\u201d": '"',
            }.get(char, char)
            if char == "\u00ad" or unicodedata.category(char) == "Mn":
                continue
            if not (char.isspace() or char in "\u00a0\u202f\u2007\u2009\u200b"):
                chars.append(char)
                raw_map.append(index)
                spaced = False
            elif not spaced and chars:
                chars.append(" ")
                raw_map.append(index)
                spaced = True
    if chars and chars[-1] == " ":
        chars.pop()
        raw_map.pop()
    return "".join(chars), raw_map


def fragment_fold(text):
    return normalized_with_map(text)[0]


def occurrences(text, wanted):
    found, at = [], 0
    while wanted and (at := text.find(wanted, at)) >= 0:
        found.append((at, at + len(wanted)))
        at += max(1, len(wanted))
    return found


def merge(spans, text=None):
    merged = []
    for start, end in sorted(spans):
        joins_whitespace = text is not None and merged and text[merged[-1][1]:start].isspace()
        if merged and (start <= merged[-1][1] or joins_whitespace):
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def locate_expected_span(text, wanted, block):
    candidates = occurrences(text, wanted)
    if not candidates:
        return None, "quote-not-rendered"
    if len(candidates) == 1:
        return candidates[0], "located"
    block_hits = occurrences(text, block) if block else []
    inside = [span for span in candidates
              if any(start <= span[0] and span[1] <= end for start, end in block_hits)]
    if len(inside) == 1:
        return inside[0], "located-in-block"
    quote_in_block = occurrences(block, wanted) if block else []
    if len(quote_in_block) != 1:
        return None, "ambiguous-location"
    quote_at = quote_in_block[0][0]
    before = block[max(0, quote_at - 160):quote_at]
    after = block[quote_at + len(wanted):quote_at + len(wanted) + 160]
    scored = []
    for span in inside or candidates:
        left = next((size for size in range(len(before), 11, -1)
                     if text[max(0, span[0] - size):span[0]] == before[-size:]), 0)
        right = next((size for size in range(len(after), 11, -1)
                      if text[span[1]:span[1] + size] == after[:size]), 0)
        scored.append((left + right, span))
    scored.sort(key=lambda item: item[0], reverse=True)
    if not scored or not scored[0][0] or len(scored) > 1 and scored[0][0] == scored[1][0]:
        return None, "ambiguous-location"
    return scored[0][1], "located-by-context"


def desired_spans(text, seed):
    quotes = seed["paintQuotes"] if "paintQuotes" in seed else seed.get("quotes")
    if not quotes:
        return None, "builder-empty" if "paintQuotes" in seed else "quote-not-rendered"
    block = fragment_fold(seed.get("blockText", ""))
    spans, proofs = [], []
    for raw in quotes:
        wanted = fragment_fold(raw)
        span, status = locate_expected_span(text, wanted, block) if wanted else (None, "empty-quote")
        proofs.append({"quote": raw, "status": status, "span": span})
        if span is None:
            return None, status
        spans.append(span)
    if len(set(spans)) != len(spans) or any(
            left[0] < right[1] and right[0] < left[1]
            for index, left in enumerate(spans) for right in spans[index + 1:]):
        return None, "expected-intervals-overlap"
    return spans, "located"


def parse_directive(value):
    parts = value.split(",")
    prefix = fragment_fold(unquote(parts.pop(0)[:-1])) if parts and parts[0].endswith("-") else ""
    suffix = fragment_fold(unquote(parts.pop()[1:])) if parts and parts[-1].startswith("-") else ""
    if not 1 <= len(parts) <= 2:
        return None
    terms = [fragment_fold(unquote(part)) for part in parts]
    return prefix, terms[0], terms[1] if len(terms) == 2 else "", suffix


def directive_candidates(text, raw):
    parsed = parse_directive(raw)
    if not parsed:
        return []
    prefix, start_text, end_text, suffix = parsed
    candidates = []
    for start, start_end in occurrences(text, start_text):
        before = text[:start].rstrip()
        if prefix and not before.endswith(prefix):
            continue
        ends = [(start, start_end)] if not end_text else [
            (start, end) for end_start, end in occurrences(text, end_text)
            if end_start >= start_end
        ]
        for span in ends:
            after = text[span[1]:].lstrip()
            if not suffix or after.startswith(suffix):
                candidates.append(span)
                break
    return candidates


def directive_interval_proof(text, seed, expected):
    directive = urlsplit(seed.get("target", "")).fragment.partition(":~:")[2]
    values = [part[5:] for part in directive.split("&") if part.startswith("text=")]
    if len(values) != len(expected):
        return None, "directive-count-mismatch"
    mapped, proofs = [], []
    for raw in values:
        candidates = directive_candidates(text, raw)
        expected_candidates = [span for span in expected if span in candidates]
        proofs.append({
            "directive": unquote(raw), "candidateCount": len(candidates),
            "expectedCandidates": expected_candidates,
        })
        if len(expected_candidates) != 1:
            return proofs, "directive-does-not-map-one-to-one"
        mapped.append(expected_candidates[0])
    if Counter(mapped) != Counter(expected):
        return proofs, "directive-interval-multiset-mismatch"
    return proofs, "directive-intervals-exact"


def word_coverage(text, spans):
    full, touched = set(), set()
    for index, match in enumerate(re.finditer(r"[^\W_]+", text, re.UNICODE)):
        for start, end in spans or []:
            if start < match.end() and match.start() < end:
                touched.add(index)
            if start <= match.start() and match.end() <= end:
                full.add(index)
    return full, touched


def unescape_name(value):
    try:
        return ast.literal_eval("'" + value + "'")
    except (SyntaxError, ValueError):
        return value


def parse_tree(tree, cached_names=None):
    text_parts, raw_spans = [], []
    for line in tree.splitlines():
        if "staticText" not in line:
            continue
        if cached_names is not None:
            if len(text_parts) >= len(cached_names):
                raise ValueError("AX static-text node count grew")
            name = cached_names[len(text_parts)]
            attrs = line
        else:
            match = re.search(r" name='((?:\\.|[^'])*)'", line)
            name, attrs = (unescape_name(match.group(1)), line) if match else ("", line)
        text_parts.append(name)
        if "markerTypes=" in attrs:
            values = {}
            for key in ("markerTypes", "markerStarts", "markerEnds"):
                match = re.search(rf"(?:^| ){key}=([0-9,]+)(?: |$)", attrs)
                values[key] = [int(value) for value in match.group(1).split(",")] if match else []
            geometry = ax_geometry(line)
            for kind, start, end in zip(values["markerTypes"], values["markerStarts"], values["markerEnds"]):
                if kind & 4:
                    raw_spans.append((len(text_parts) - 1, start, end, geometry))
    if cached_names is not None and len(text_parts) != len(cached_names):
        raise ValueError(f"AX static-text node count changed: {len(cached_names)} -> {len(text_parts)}")
    return normalize_marker_spans(text_parts, raw_spans)


def ax_geometry(line):
    number = r"(-?\d+(?:\.\d+)?)"
    location = re.search(rf"(?:^| )location=\({number},\s*{number}\)(?: |$)", line)
    size = re.search(rf"(?:^| )size=\({number},\s*{number}\)(?: |$)", line)
    if not location or not size:
        return None
    return [float(location.group(1)), float(location.group(2)),
            float(size.group(1)), float(size.group(2))]


def normalize_marker_spans(names, raw_spans):
    offsets, raw_at = [], 0
    for name in names:
        offsets.append(raw_at)
        raw_at += len(name)
    normalized, raw_map = normalized_with_map("".join(names))
    spans, details = [], []
    for node_index, start, end, geometry in raw_spans:
        normalized_start = bisect.bisect_left(raw_map, offsets[node_index] + start)
        normalized_end = bisect.bisect_left(raw_map, offsets[node_index] + end)
        while normalized_start < normalized_end and normalized[normalized_start] == " ":
            normalized_start += 1
        while normalized_end > normalized_start and normalized[normalized_end - 1] == " ":
            normalized_end -= 1
        if normalized_end > normalized_start:
            spans.append((normalized_start, normalized_end))
            details.append({"span": (normalized_start, normalized_end), "node": node_index,
                            "geometry": geometry, "text": normalized[normalized_start:normalized_end],
                            "rawSpan": [start, end], "rawText": names[node_index][start:end]})
    return normalized, merge(spans, normalized), names, details


def parse_compact(compact, names):
    if compact["staticCount"] != len(names):
        raise ValueError(f"AX static-text node count changed: {len(names)} -> {compact['staticCount']}")
    raw_spans = []
    for index, types, starts, ends, location, size in compact["markers"]:
        geometry = [*location, *size] if location and size else None
        for kind, start, end in zip(types, starts, ends):
            if kind & 4:
                raw_spans.append((index, start, end, geometry))
    return normalize_marker_spans(names, raw_spans)


SOURCE_WORD_RE = re.compile(r"[^\W_]+(?:['\u2019][^\W_]+)*", re.UNICODE)
LEADING_FURNITURE = re.compile(
    r"^\s*(?:[#>*_`-]+\s*)*(?:"
    r"\[\s*\d{1,4}\s*\]|\d{1,4}\s*[\].:]|"
    r"\((?:\d{1,5}|[a-z]|[ivxlcdm]{1,6})\)|"
    r"(?:para(?:graph)?|s(?:ection)?|subsection)\.?\s+\d{1,4}(?:\.\d+)*(?:\s*\([^)]{1,8}\))*|"
    r"\d{1,4}(?:\.\d+)*(?:\s*\((?:\d{1,5}|[a-z]|[ivxlcdm]{1,6})\))+"
    r")\s*", re.IGNORECASE,
)
LOCATOR_COMPONENT = re.compile(
    r"(?:\d+(?:\.\d+)+(?:\s*\((?:\d{1,5}|[a-z]|[ivxlcdm]{1,6})\))*|"
    r"\[\s*\d{1,4}\s*\])",
    re.IGNORECASE,
)
PAREN_LOCATOR = re.compile(r"\((?:\d{1,5}|[a-z]|[ivxlcdm]{1,6})\)", re.IGNORECASE)
TRAILING_BILINGUAL_TRANSLATION = re.compile(
    r"\s*\(\s*(?:\u00ab|\u00c2\u00ab|\u00c3\u201a\u00c2\u00ab)\s*[^)]*$", re.IGNORECASE,
)
ACCEPTED_OMISSION_REASONS = {
    "line-start-furniture",
    "decimal-or-subsection-locator",
    "appended-bilingual-translation",
}


def source_words(value):
    return [{"word": fragment_fold(match.group()), "raw": match.group(),
             "start": match.start(), "end": match.end()}
            for match in SOURCE_WORD_RE.finditer(value)]


def source_literal_fold(value):
    """Fold only source whitespace; punctuation and spelling stay evidentiary."""
    return re.sub(r"\s+", " ", value).strip()


def omission_reason(raw, words, index, is_pdf, allow_bilingual):
    token = words[index]
    leading = LEADING_FURNITURE.match(raw)
    if leading and token["end"] <= leading.end():
        return "line-start-furniture"
    if any(match.start() <= token["start"] and token["end"] <= match.end()
           for match in LOCATOR_COMPONENT.finditer(raw)):
        return "decimal-or-subsection-locator"
    parenthetical = next((match for match in PAREN_LOCATOR.finditer(raw)
                          if match.start() <= token["start"] and token["end"] <= match.end()), None)
    if parenthetical:
        prefix = raw[:parenthetical.start()]
        line_prefix = prefix[prefix.rfind("\n") + 1:]
        if not line_prefix.strip() or re.search(r"(?:sub)?section\s*$", prefix, re.IGNORECASE):
            return "decimal-or-subsection-locator"
    bilingual = TRAILING_BILINGUAL_TRANSLATION.search(raw) if allow_bilingual else None
    if bilingual and bilingual.start() == 0:
        bilingual = None
    if bilingual and bilingual.start() <= token["start"]:
        return "appended-bilingual-translation"
    if is_pdf:
        before = words[index - 1]["end"] if index else 0
        after = words[index + 1]["start"] if index + 1 < len(words) else len(raw)
        if "\n" in raw[before:token["start"]] or "\r" in raw[before:token["start"]] or \
                "\n" in raw[token["end"]:after] or "\r" in raw[token["end"]:after]:
            return "pdf-extraction-line-seam"
    return None


def source_quote_coverage(seed, is_pdf):
    quote_rows, seen = [], set()
    for raw in seed.get("quotes") or []:
        words = source_words(raw)
        key = tuple(item["word"] for item in words)
        if key in seen:
            continue
        seen.add(key)
        quote_rows.append({
            "raw": raw, "literal": source_literal_fold(raw), "words": words,
            "covered": set(), "cursor": 0, "literalCursor": 0,
        })
    if not quote_rows:
        return {"status": "source-quote-empty", "accepted": False}
    mapped = []
    for paint_index, raw in enumerate(seed.get("paintQuotes") or []):
        wanted = [item["word"] for item in source_words(raw)]
        literal = source_literal_fold(raw)
        candidates = []
        for quote_index, row in enumerate(quote_rows):
            at = row["literal"].find(literal, row["literalCursor"]) if literal else -1
            while at >= 0:
                start = len(source_words(row["literal"][:at]))
                end = start + len(wanted)
                values = [item["word"] for item in row["words"]]
                if start >= row["cursor"] and values[start:end] == wanted:
                    candidates.append((quote_index, at, at + len(literal), start, end))
                at = row["literal"].find(literal, at + 1)
        if not wanted or not candidates:
            return {"status": "paint-quote-not-literal-source-substring", "paintIndex": paint_index,
                    "paintQuote": raw, "accepted": False}
        quote_index, literal_start, literal_end, start, end = min(candidates)
        row = quote_rows[quote_index]
        row["covered"].update(range(start, end))
        row["cursor"] = end
        row["literalCursor"] = literal_end
        mapped.append({"paintIndex": paint_index, "quoteIndex": quote_index,
                       "sourceWordStart": start, "sourceWordEnd": end,
                       "sourceLiteralStart": literal_start, "sourceLiteralEnd": literal_end})
    declared = seed.get("paintedWords")
    counted = sum(len(source_words(raw)) for raw in seed.get("paintQuotes") or [])
    if declared is not None and declared != counted:
        return {"status": "painted-word-count-mismatch", "declared": declared,
                "counted": counted, "accepted": False}
    omitted = []
    for quote_index, row in enumerate(quote_rows):
        for token_index, token in enumerate(row["words"]):
            if token_index in row["covered"]:
                continue
            reason = omission_reason(
                row["raw"], row["words"], token_index, is_pdf,
                seed.get("dataset") == "LEGISLATION-MB",
            )
            omitted.append({"quoteIndex": quote_index, "tokenIndex": token_index,
                            "token": token["raw"], "reason": reason or "unclassified-substantive"})
    unaccepted = [item for item in omitted if item["reason"] not in ACCEPTED_OMISSION_REASONS]
    return {
        "status": "source-coverage-unaccepted-omission" if unaccepted else
                  "source-coverage-classified" if omitted else "source-coverage-exact",
        "accepted": not unaccepted,
        "builderSourceSafeComplete": seed.get("sourceSafeComplete"),
        "paintedWords": counted,
        "omitted": omitted,
        "unacceptedOmissions": unaccepted,
        "mappedPaintQuotes": mapped,
    }


def self_check():
    assert normalized_with_map("A,\u00a0 \u201cb\u201d\u00ad!")[0] == 'a, "b"!'
    assert merge([(0, 1), (2, 3)]) == [(0, 1), (2, 3)]
    assert merge([(0, 1), (2, 3)], "a b") == [(0, 3)]
    assert desired_spans("a", {"paintQuotes": []}) == (None, "builder-empty")
    rendered, spans, _, details = parse_compact(
        {"staticCount": 2, "markers": [[1, [5], [0], [2], [10, 20], [30, 12]]]},
        ["A, ", "B!"],
    )
    assert (rendered, spans) == ("a, b!", [(3, 5)])
    assert details[0]["geometry"] == [10, 20, 30, 12]
    coverage = source_quote_coverage({
        "blockText": "[48] Alpha 33.43(1) beta", "quotes": ["[48] Alpha 33.43(1) beta"],
        "paintQuotes": ["Alpha", "beta"], "paintedWords": 2,
    }, False)
    assert coverage["accepted"] and {item["reason"] for item in coverage["omitted"]} == {
        "line-start-furniture", "decimal-or-subsection-locator",
    }
    missing_prose = source_quote_coverage({
        "quotes": ["Alpha beta"], "paintQuotes": ["Alpha"],
        "paintedWords": 1, "sourceSafeComplete": False,
    }, False)
    assert not missing_prose["accepted"] and missing_prose["omitted"] == [{
        "quoteIndex": 0, "tokenIndex": 1, "token": "beta",
        "reason": "unclassified-substantive",
    }]
    pdf_seam = source_quote_coverage({
        "quotes": ["Alpha\nbeta"], "paintQuotes": ["Alpha"], "paintedWords": 1,
    }, True)
    assert not pdf_seam["accepted"] and pdf_seam["status"] == \
        "source-coverage-unaccepted-omission"
    assert pdf_seam["unacceptedOmissions"][0]["reason"] == "pdf-extraction-line-seam"
    whitespace_only = source_quote_coverage({
        "quotes": ["Alpha\n  beta"], "paintQuotes": ["Alpha beta"], "paintedWords": 2,
    }, False)
    assert whitespace_only["accepted"]
    punctuation_changed = source_quote_coverage({
        "quotes": ["Issue #2-"], "paintQuotes": ["Issue #2:"], "paintedWords": 2,
    }, False)
    assert punctuation_changed["status"] == "paint-quote-not-literal-source-substring" and \
        not punctuation_changed["accepted"]
    landing = finalize_html_landing(
        {"status": "landing-html-pending",
         "viewport": {"x": 0, "y": 1000, "deviceScaleFactor": 1},
         "paintComponents": [{"bounds": [10, 20, 30, 40], "pixels": 100}]},
        [{"span": (4, 8), "geometry": [10, 1020, 20, 20]}],
        [{"expectedCandidates": [(4, 8)]}],
    )
    assert landing["status"] == "landing-exact" and landing["mappedPaintComponents"]
    geometry = gate.pdf_paint_geometry_proof(
        {"components": [{"bounds": [10, 90, 20, 99], "pixels": 110}], "deltaPixels": 110},
        gate.Image.new("RGB", (100, 100), "white"),
        {"pageSize": [100, 100], "lineBounds": [[10, 0, 20, 10]], "page": 1},
    )
    assert geometry["status"] == "pdf-paint-geometry-exact"
    assert gate.search_normalized_with_map(" A\nB ")[0] == "a b"
    browser_options = options("profile", headed=True)
    assert browser_options.page_load_strategy == "normal"
    assert "--renderer-process-limit=1" not in browser_options.arguments


def write_ax_names(source, names):
    stat = source.stat()
    (AX_TEXT_CACHE / f"{source.stem}.json").write_text(
        json.dumps({"size": stat.st_size, "mtimeNs": stat.st_mtime_ns, "names": names}, ensure_ascii=False),
        encoding="utf-8",
    )


def finalize_html_landing(landing, marker_details, directive_proof):
    if landing.get("status") != "landing-html-pending":
        return landing
    first = (directive_proof or [{}])[0].get("expectedCandidates") or []
    if len(first) != 1:
        return {**landing, "status": "landing-marker-geometry-unverified"}
    first_start, first_end = first[0]
    viewport = landing["viewport"]
    scale = viewport.get("deviceScaleFactor") or 1
    geometries = []
    for detail in marker_details:
        span = detail.get("span") or []
        geometry = detail.get("geometry") or []
        if len(span) != 2 or len(geometry) != 4 or not (
                span[0] < first_end and first_start < span[1]):
            continue
        x, y, width, height = geometry
        geometries.append([
            (x - viewport["x"]) * scale,
            (y - viewport["y"]) * scale,
            (x + width - viewport["x"]) * scale,
            (y + height - viewport["y"]) * scale,
        ])
    overlaps = []
    for component in landing.get("paintComponents") or []:
        left, top, right, bottom = component["bounds"]
        matched = next((bounds for bounds in geometries
                        if left <= bounds[2] and bounds[0] <= right and
                        top <= bounds[3] and bounds[1] <= bottom), None)
        if matched:
            overlaps.append({"component": component, "markerBounds": matched})
    return {
        **landing,
        "status": "landing-exact" if overlaps else
                  "landing-marker-geometry-unverified" if not geometries else
                  "landing-wrong-viewport",
        "firstDirectiveInterval": [first_start, first_end],
        "firstDirectiveMarkerBounds": geometries,
        "mappedPaintComponents": overlaps,
    }


def analyze(seed, cached, ax_result, cached_names, source, baseline_verdict, navigation_ms, dump_ms,
            parsed=None, write_ax_cache=True, landing=None):
    if parsed is not None:
        rendered, actual, names, marker_details = parsed
        tree = ax_result["tree"]
        tree_chars = len(tree)
        marker_lines = sum("markerTypes=" in line for line in tree.splitlines())
    elif cached_names is not None:
        rendered, actual, names, marker_details = parse_compact(ax_result["compact"], cached_names)
        tree_chars, marker_lines = 0, len(ax_result["compact"]["markers"])
    else:
        tree = ax_result["tree"]
        rendered, actual, names, marker_details = parse_tree(tree)
        tree_chars = len(tree)
        marker_lines = sum("markerTypes=" in line for line in tree.splitlines())
    if cached_names is None and names and write_ax_cache:
        write_ax_names(source, names)
    intended, location = desired_spans(rendered, seed)
    directive_proof, directive_status = directive_interval_proof(rendered, seed, intended or []) \
        if intended is not None else (None, "expected-location-failed")
    source_coverage = source_quote_coverage(seed, source.suffix.lower() == ".pdf")
    actual_full, actual_touched = word_coverage(rendered, actual)
    intended_full, _ = word_coverage(rendered, intended)
    exact_intervals = intended is not None and actual == merge(intended, rendered)
    geometry_exact = bool(marker_details) and all(
        detail.get("geometry") and detail["geometry"][2] > 0 and detail["geometry"][3] > 0
        for detail in marker_details
    )
    landing = landing or {"status": "landing-unverified"}
    landing = finalize_html_landing(landing, marker_details, directive_proof)
    if not source_coverage.get("accepted"):
        verdict = source_coverage["status"]
    elif intended is None:
        verdict = location
    elif directive_status != "directive-intervals-exact":
        verdict = directive_status
    elif not actual:
        verdict = "marker-no-match"
    elif not exact_intervals:
        verdict = "marker-interval-partial" if actual_touched and actual_touched <= intended_full \
            else "marker-interval-extraneous"
    elif not geometry_exact:
        verdict = "marker-geometry-unverified"
    elif landing.get("status") not in {"landing-exact", "landing-paint-visible"}:
        verdict = landing.get("status", "landing-unverified")
    else:
        verdict = "marker-exact"
    agrees = baseline_verdict is None or (verdict == "marker-exact") == (baseline_verdict == "exact-match")
    safe_core = bool(intended_full) and exact_intervals and source_coverage.get("accepted", False)
    covered_words = len(actual_full & intended_full)
    return {
        "label": seed["label"], "verdict": verdict, "target": seed["target"], "cacheFile": cached["file"],
        "actual": actual, "intended": intended, "directiveProof": directive_proof,
        "directiveStatus": directive_status, "sourceCoverage": source_coverage,
        "markerGeometry": marker_details, "landing": landing,
        "textualIdentity": {
            "comparison": "Unicode base/case folded; browser whitespace folded; punctuation preserved",
            "rawAxOffsetsRetained": True,
            "paintEdgeLimit": "CSS pixels cannot distinguish invisible whitespace edges; Chromium AX offsets do",
        },
        "paintedText": [rendered[start:end] for start, end in actual],
        "intendedText": [rendered[start:end] for start, end in intended] if intended else [],
        "safeCore": safe_core,
        "coverage": round(covered_words / len(intended_full), 4) if intended_full else 0,
        "paintedWords": len(actual_full), "intendedWords": len(intended_full),
        "axNodes": len(names), "treeChars": tree_chars,
        "axPayloadChars": len(json.dumps(ax_result)), "axTextCache": "hit" if cached_names is not None else "miss",
        "axMeta": ax_result.get("meta"), "markerLines": marker_lines, "markerRetries": 0,
        "baselineVerdict": baseline_verdict, "agrees": agrees,
        "timings": {"navigationMs": navigation_ms, "markerDumpMs": dump_ms},
    }


ERROR_PAGE_TITLE = re.compile(
    r"^\s*(?:403 forbidden|404(?: not found)?|page not found|access denied|validation|"
    r"just a moment(?:\.\.\.)?|robot check)\s*$", re.IGNORECASE,
)
ERROR_PAGE_BODY = re.compile(
    r"^\s*(?:403 forbidden|404(?: not found)?|page not found|access denied|"
    r"captcha|verify (?:that )?you are human)", re.IGNORECASE,
)
CHALLENGE_TITLE = re.compile(
    r"^\s*(?:validation|just a moment|robot check|captcha)\b", re.IGNORECASE,
)
CHALLENGE_BODY = re.compile(
    r"(?:captcha|verify (?:that )?you are human|checking (?:your )?browser|security verification)",
    re.IGNORECASE,
)


def wait_for_headed_challenge(driver, timeout=180):
    def challenge():
        try:
            title = driver.title or ""
            body = driver.execute_script("return (document.body?.innerText || '').slice(0, 2000)") or ""
            return title, bool(CHALLENGE_TITLE.search(title) or CHALLENGE_BODY.search(body))
        except Exception:
            return "navigation in progress", True

    title, blocked = challenge()
    if not blocked:
        return
    print(json.dumps({
        "event": "challenge-wait", "title": title, "timeoutSeconds": timeout,
        "message": "Please solve the browser challenge; verification will resume automatically.",
    }), flush=True)
    deadline, next_progress = time.monotonic() + timeout, time.monotonic() + 15
    while time.monotonic() < deadline:
        time.sleep(0.5)
        title, blocked = challenge()
        if not blocked:
            print(json.dumps({"event": "challenge-cleared", "title": title}), flush=True)
            return
        if time.monotonic() >= next_progress:
            print(json.dumps({
                "event": "challenge-waiting", "secondsRemaining": round(deadline - time.monotonic()),
            }), flush=True)
            next_progress += 15
    print(json.dumps({"event": "challenge-timeout", "title": title}), flush=True)


def has_text_fragment_marker(ax_result):
    compact = ax_result.get("compact")
    if compact is not None:
        return any(any(kind & 4 for kind in marker[1]) for marker in compact["markers"])
    return any(
        any(int(value) & 4 for value in match.group(1).split(","))
        for match in re.finditer(r"(?:^| )markerTypes=([0-9,]+)(?: |$)", ax_result.get("tree", ""), re.MULTILINE)
    )


def freeze_and_refresh_cache(driver, cached, source):
    if source.suffix.lower() == ".pdf":
        if not source.exists():
            return {"status": "missing-pdf"}
        with gate.MANIFEST.open("a", encoding="utf-8") as manifest_file:
            manifest_file.write(json.dumps(cached, ensure_ascii=False) + "\n")
        return {"status": "preserved-pdf"}
    frozen = driver.execute_script(r"""
const properties = ['display', 'visibility', 'content-visibility', 'white-space'];
const elements = [...document.querySelectorAll('*')];
const values = elements.map(element => {
  const style = getComputedStyle(element);
  return properties.map(property => style.getPropertyValue(property));
});
const before = document.body?.innerText ?? '';
for (let index = 0; index < elements.length; index += 1) {
  for (let property = 0; property < properties.length; property += 1) {
    elements[index].style.setProperty(properties[property], values[index][property], 'important');
  }
}
return {
  before,
  after: document.body?.innerText ?? '',
  contentType: document.contentType,
  elements: elements.length,
  title: document.title,
  url: location.href,
};
""")
    title = frozen.get("title") or ""
    body = frozen.get("before") or ""
    if ERROR_PAGE_TITLE.search(title) or ERROR_PAGE_BODY.search(body[:500]):
        return {"status": "skipped-error-page", "title": title, "url": frozen.get("url")}
    if not body.strip():
        return {"status": "skipped-empty-page", "title": title, "url": frozen.get("url")}
    if frozen.get("after") != body:
        return {"status": "skipped-text-changed", "title": title, "url": frozen.get("url")}
    html = driver.page_source
    encoded = html.encode("utf-8")
    source.parent.mkdir(parents=True, exist_ok=True)
    gate.BROWSER_TEXT_CACHE.mkdir(parents=True, exist_ok=True)
    source.write_bytes(encoded)
    (gate.BROWSER_TEXT_CACHE / f"{source.stem}.txt").write_text(body, encoding="utf-8")
    cached.update({"bytes": len(encoded), "contentType": "text/html", "challenged": False})
    with gate.MANIFEST.open("a", encoding="utf-8") as manifest_file:
        manifest_file.write(json.dumps(cached, ensure_ascii=False) + "\n")
    return {
        "status": "refreshed", "bytes": len(encoded), "textChars": len(body),
        "frozenElements": frozen.get("elements"), "url": frozen.get("url"),
    }


def request_tree(driver, cache_file, allow, allow_empty="", compact=False):
    driver.execute_script("window.__axCompact=arguments[0]", compact)
    requested = driver.execute_script(r"""
const [cacheFile, allow, allowEmpty] = arguments;
const xhr = new XMLHttpRequest();
xhr.open('GET', 'targets-data.json', false);
xhr.send(null);
if (xhr.status !== 200) return {ok: false, status: xhr.status};
const data = JSON.parse(xhr.responseText);
const decoded = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
const targetKey = (value) => {
  try {
    const url = new URL(value);
    const query = [...url.searchParams.entries()]
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
    return JSON.stringify([
      url.protocol.toLowerCase(), url.username, url.password, url.hostname.toLowerCase(),
      url.port, decoded(url.pathname), query,
    ]);
  } catch {
    return JSON.stringify(['', decoded(String(value).split('#', 1)[0])]);
  }
};
const wanted = targetKey(cacheFile);
const pageMatches = (value) => {
  if (targetKey(value) === wanted) return true;
  try {
    const url = new URL(value);
    return [...url.searchParams.entries()].some(([name, embedded]) =>
      ['file', 'url'].includes(name.toLowerCase()) && targetKey(embedded) === wanted);
  } catch {
    return false;
  }
};
const pages = data.pages.filter(page => pageMatches(page.url || ''));
const page = pages.find(page => page.url?.startsWith('chrome-extension://')) || pages.at(-1);
window.__axTarget = {selector: cacheFile, selected: page?.url, matches: pages.map(page => page.url)};
if (!page) return {ok: false, pages: data.pages.map(page => page.url)};
window.__axResult = null;
chrome.send('requestWebContentsTree', [{
  processId: page.processId, routingId: page.routingId, requestType: 'showOrRefreshTree',
  filters: {allow, allowEmpty, deny: ''},
}]);
return {ok: true};
""", cache_file, allow, allow_empty)
    if not requested.get("ok"):
        raise RuntimeError(f"current accessibility target not found for {cache_file}: {requested}")
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        result = driver.execute_script("return window.__axResult")
        if result:
            result["meta"] = driver.execute_script("return window.__axTarget")
            return result
        time.sleep(0.01)
    raise TimeoutError("Chromium accessibility tree did not arrive")


def natural_landing_proof(driver, seed, is_pdf):
    """Capture the browser's initial landing before any verifier scroll."""
    viewport = driver.execute_script(r"""
return {x:scrollX, y:scrollY, width:innerWidth, height:innerHeight,
        deviceScaleFactor:devicePixelRatio};
""")
    if is_pdf:
        viewer = gate.wait_pdf_viewer(driver, 15, {})
        deadline, previous = time.monotonic() + 8, None
        png, image, mask, components = b"", None, None, []
        while viewer.get("status") == "ready" and time.monotonic() < deadline:
            png = driver.get_screenshot_as_png()
            image = gate.Image.open(gate.io.BytesIO(png)).convert("RGB")
            mask = gate.target_mask(image, "pdf")
            components = gate.mask_components(mask)
            if gate.pdf_page_visible(image) and gate.component_sets_agree(previous, components):
                break
            previous = components
            time.sleep(0.08)
        visible = bool(image and gate.pdf_page_visible(image))
        return {
            "status": "landing-paint-visible" if viewer.get("status") == "ready" and visible and components else
                      "landing-pdf-viewer-not-ready" if viewer.get("status") != "ready" else
                      "landing-pdf-page-not-visible" if not visible else "landing-paint-not-visible",
            "viewport": viewport, "paintPixels": gate.mask_count(mask) if mask is not None else 0,
            "paintComponents": components,
            "screenshotSha256": hashlib.sha256(png).hexdigest(),
            "viewer": viewer,
        }
    before = dict(viewport)
    png = driver.get_screenshot_as_png()
    image = gate.Image.open(gate.io.BytesIO(png)).convert("RGB")
    mask = gate.target_mask(image, "html")
    components = gate.mask_components(mask)
    after = driver.execute_script("return {x:scrollX,y:scrollY,width:innerWidth,height:innerHeight}")
    if before["x"] != after["x"] or before["y"] != after["y"]:
        status = "landing-verifier-scrolled"
    else:
        status = "landing-html-pending"
    return {
        "status": status, "viewport": before, "afterProbe": after,
        "paintPixels": gate.mask_count(mask), "paintComponents": components,
        "screenshotSha256": hashlib.sha256(png).hexdigest(),
    }


def setup_ax(driver):
    driver.refresh()
    driver.execute_script(r"""
window.__axResult = null;
const original = cr.webUIListenerCallback;
cr.webUIListenerCallback = function(event, ...values) {
  if (event === 'showOrRefreshTree' && values[0]?.tree) {
    if (!window.__axCompact) { window.__axResult = {tree: values[0].tree}; return; }
    let staticCount = 0;
    const markers = [];
    const list = (line, key) => (line.match(new RegExp(`(?:^| )${key}=([0-9,]+)(?: |$)`))?.[1] || '').split(',').filter(Boolean).map(Number);
    const pair = (line, key) => (line.match(new RegExp(`(?:^| )${key}=\\((-?[0-9.]+),\\s*(-?[0-9.]+)\\)(?: |$)`))?.slice(1).map(Number) || null);
    for (const line of values[0].tree.split('\n')) {
      if (!line.includes('staticText')) continue;
      const index = staticCount++;
      if (line.includes('markerTypes=')) markers.push([
        index, list(line, 'markerTypes'), list(line, 'markerStarts'), list(line, 'markerEnds'),
        pair(line, 'location'), pair(line, 'size'),
      ]);
    }
    window.__axResult = {compact: {staticCount, markers}};
    return;
  }
  return original.call(this, event, ...values);
};
""")


def main():
    gate.install_cleanup_signal_handlers()
    self_check()
    parser = argparse.ArgumentParser()
    parser.add_argument("targets", type=Path)
    parser.add_argument("--out", type=Path, default=gate.RESULTS / "webdriver-marker.jsonl")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--label")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--only", choices=("all", "html", "pdf"), default="all")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--refresh-cache", action="store_true")
    parser.add_argument("--exclude-proven-404", action="store_true")
    args = parser.parse_args()
    if args.refresh_cache and not args.live:
        parser.error("--refresh-cache requires --live")

    seeds = gate.read_jsonl(args.targets)
    corpus_rows = len(seeds)
    excluded_404 = [seed for seed in seeds if gate.is_proven_404_seed(seed)] \
        if args.exclude_proven_404 else []
    if args.exclude_proven_404 and len(excluded_404) != 1:
        raise RuntimeError(f"expected exactly one proven label+URL 404, found {len(excluded_404)}")
    if excluded_404:
        seeds = [seed for seed in seeds if not gate.is_proven_404_seed(seed)]
    gettable_rows = len(seeds)
    if args.label:
        seeds = [seed for seed in seeds if seed["label"] == args.label]
    if args.limit:
        seeds = seeds[:args.limit]
    manifest, files = {}, {}
    for row in gate.read_jsonl(gate.MANIFEST):
        file = gate.CACHE / (row.get("file") or "")
        if row.get("url") and row.get("file") and not row.get("challenged") and file.exists():
            key = gate.url_key(row["url"])
            manifest[key] = row
            files[row["file"]] = file
    digest_cache = {}

    def cache_identity(source):
        stat = source.stat()
        key = (str(source), stat.st_size, stat.st_mtime_ns)
        digest = digest_cache.get(key)
        if digest is None:
            digest = gate.file_sha256(source)
            digest_cache[key] = digest
        return {"file": source.name, "bytes": stat.st_size, "sha256": digest}

    def cached_for(seed):
        base = seed.get("target", "").split("#", 1)[0]
        key = gate.url_key(base)
        cached = manifest.get(key)
        if cached is None and args.live:
            suffix = ".pdf" if gate.PDF_RE.search(base) else ".html"
            cached = {
                "url": base,
                "file": f"{hashlib.sha1(base.encode()).hexdigest()}{suffix}",
                "contentType": "application/pdf" if suffix == ".pdf" else "text/html",
                "challenged": False,
            }
            manifest[key] = cached
        return cached

    baseline = {row["label"]: row.get("verdict") for row in gate.read_jsonl(args.baseline)} if args.baseline else {}
    cached_seeds = [seed for seed in seeds if cached_for(seed)]
    missing_count = len(seeds) - len(cached_seeds)
    pdf_count = sum(cached_for(seed)["file"].lower().endswith(".pdf") for seed in cached_seeds)
    if (missing_count):
        raise RuntimeError(f"{missing_count} targets have no usable cached page")
    gate_seeds = cached_seeds
    if args.only != "all":
        want_pdf = args.only == "pdf"
        gate_seeds = [seed for seed in gate_seeds
                      if cached_for(seed)["file"].lower().endswith(".pdf") == want_pdf]
    if args.shard_count > 1:
        gate_seeds = [
            seed for seed in gate_seeds
            if int(hashlib.sha256(seed["target"].split("#")[0].encode()).hexdigest(), 16) % args.shard_count == args.shard_index
        ]
    gate_seeds.sort(key=lambda seed: cached_for(seed)["file"])
    wanted = {seed["label"]: seed["target"] for seed in gate_seeds}
    source_mode = "live" if args.live else "cache"
    resume_rows = gate.read_jsonl(args.out) if args.resume else []
    existing = [
        row for row in resume_rows
        if wanted.get(row.get("label")) == row.get("target")
        and row.get("verificationContract") == VERIFICATION_CONTRACT
        and row.get("sourceMode") == source_mode
        and row.get("headed") is args.headed
        and row.get("refreshCache") is args.refresh_cache
        and (row.get("cacheIdentity") or {}).get("file") == row.get("cacheFile")
        and len((row.get("cacheIdentity") or {}).get("sha256", "")) == 64
    ]
    discarded_resume_rows = len(resume_rows) - len(existing)
    completed = {(row["label"], row["target"]) for row in existing}
    gate_seeds = [seed for seed in gate_seeds if (seed["label"], seed["target"]) not in completed]
    if not gate_seeds:
        print(json.dumps({
            "inputRows": corpus_rows, "gettableRows": gettable_rows, "excluded404": len(excluded_404),
            "pendingRows": 0, "pdfRows": pdf_count,
            "rows": len(existing), "seconds": 0, "reused": len(existing),
            "discardedResumeRows": discarded_resume_rows,
            "verificationContract": VERIFICATION_CONTRACT,
        }), flush=True)
        return

    started = time.perf_counter()
    AX_TEXT_CACHE.mkdir(exist_ok=True)
    server_context = nullcontext(None) if args.live else gate.CacheServer(files)
    with server_context as server, args.out.open("w", encoding="utf-8") as output:
        for row in existing:
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
        output.flush()
        lifecycle = ExitStack()
        try:
            profile_dir = lifecycle.enter_context(gate.owned_chrome_profile("browser-profile-"))
            phase = time.perf_counter()
            driver, _browser_timings, _pdf_oopif = lifecycle.enter_context(
                gate.chrome_session(options(profile_dir, args.headed))
            )
            driver.set_page_load_timeout(15)
            print(json.dumps({"browserStartMs": round((time.perf_counter() - phase) * 1000, 1)}), flush=True)
            target_handle = driver.current_window_handle
            if args.live:
                driver.get("about:blank")
            else:
                first_row = cached_for(gate_seeds[0])
                driver.get(f"{server.origin}/page/{first_row['file']}")
            driver.switch_to.new_window("tab")
            ax_handle = driver.current_window_handle
            driver.get("chrome://accessibility/")
            print(json.dumps({"axReadyMs": round((time.perf_counter() - started) * 1000, 1)}), flush=True)
            setup_ax(driver)

            tally, disagreements = {}, sum(not row.get("agrees", True) for row in existing)
            for row in existing:
                tally[row["verdict"]] = tally.get(row["verdict"], 0) + 1
            def persist_terminal_browser_failure(seed, cached, source, event, error):
                message = str(error).splitlines()[0][:300]
                verdict = "browser-tab-crash" if "tab crashed" in str(error).lower() \
                    else f"browser-{event}-error"
                row = {
                    "label": seed["label"], "verdict": verdict,
                    "target": seed["target"], "cacheFile": cached["file"],
                    "actual": [], "intended": [], "safeCore": False,
                    "sourceCoverage": {"status": "browser-unavailable", "accepted": False},
                    "browserError": {"event": event, "message": message},
                    "verificationContract": VERIFICATION_CONTRACT,
                    "sourceMode": source_mode, "headed": args.headed,
                    "refreshCache": args.refresh_cache,
                    "cacheIdentity": cache_identity(source),
                }
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                print(json.dumps({"event": "terminal-row-failure", "label": seed["label"],
                                  "verdict": verdict, "error": message}), flush=True)

            refreshed_sources, refresh_failures, refresh_outcomes = set(), {}, {}
            refresh_expected = {cached_for(seed)["file"] for seed in gate_seeds} if args.refresh_cache else set()
            remaining_sources = {}
            for seed in gate_seeds:
                file = cached_for(seed)["file"]
                remaining_sources[file] = remaining_sources.get(file, 0) + 1
            for index, seed in enumerate(gate_seeds, 1):
                phase = time.perf_counter()
                cached = cached_for(seed)
                source = gate.CACHE / cached["file"]
                if args.live:
                    cached_names = None
                else:
                    stat = source.stat()
                    cache_path = AX_TEXT_CACHE / f"{source.stem}.json"
                    ax_cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else None
                    cached_names = ax_cache.get("names") if ax_cache and ax_cache.get("names") and ax_cache.get("size") == stat.st_size and ax_cache.get("mtimeNs") == stat.st_mtime_ns else None
                replay = hashlib.sha1(seed["label"].encode()).hexdigest()[:12]
                driver.switch_to.window(target_handle)
                navigation_timed_out = False
                navigation_url = (seed["target"] if args.live else
                                  f"{server.origin}/page/{cached['file']}?verify={replay}#{seed['target'].partition('#')[2]}")
                try:
                    if args.live:
                        driver.get("about:blank")
                    driver.get(navigation_url)
                except TimeoutException as error:
                    navigation_timed_out = True
                    print(json.dumps({
                        "event": "navigation-timeout", "label": seed["label"],
                        "target": seed["target"], "error": str(error).splitlines()[0][:200],
                    }), flush=True)
                    driver.execute_script("window.stop()")
                except WebDriverException as error:
                    print(json.dumps({
                        "event": "navigation-error", "label": seed["label"],
                        "target": seed["target"], "error": str(error).splitlines()[0][:200],
                    }), flush=True)
                    persist_terminal_browser_failure(seed, cached, source, "navigation", error)
                    raise
                if args.live and args.headed:
                    wait_for_headed_challenge(driver)
                try:
                    document_ready_state = wait_for_stable_document(driver)
                except WebDriverException as error:
                    print(json.dumps({
                        "event": "document-error", "label": seed["label"],
                        "target": seed["target"], "error": str(error).splitlines()[0][:200],
                    }), flush=True)
                    persist_terminal_browser_failure(seed, cached, source, "document", error)
                    raise
                if document_ready_state != "complete":
                    print(json.dumps({
                        "event": "document-incomplete", "label": seed["label"],
                        "target": seed["target"], "readyState": document_ready_state,
                    }), flush=True)
                    raise TimeoutException(
                        f"{seed['label']} document remained {document_ready_state!r} after navigation"
                    )
                current_url = driver.current_url
                live_url = current_url if args.live else None
                page_title = driver.title if args.live else None
                navigation_ms = round((time.perf_counter() - phase) * 1000, 1)
                is_pdf = cached["file"].lower().endswith(".pdf")
                try:
                    landing = natural_landing_proof(driver, seed, is_pdf)
                except WebDriverException as error:
                    persist_terminal_browser_failure(seed, cached, source, "landing", error)
                    raise
                phase = time.perf_counter()
                try:
                    driver.switch_to.window(ax_handle)
                    allow = ("location size markerTypes markerStarts markerEnds" if cached_names is not None else
                             "name location size markerTypes markerStarts markerEnds")
                    selector = current_url.split("#", 1)[0]
                    ax_result = request_tree(driver, selector, allow, "name" if cached_names is None else "", cached_names is not None)
                except WebDriverException as error:
                    persist_terminal_browser_failure(seed, cached, source, "accessibility", error)
                    raise
                if is_pdf and cached_names is None:
                    deadline = time.monotonic() + 4
                    while "staticText" not in ax_result.get("tree", "") and time.monotonic() < deadline:
                        time.sleep(0.08)
                        ax_result = request_tree(driver, selector, allow, "name location size", False)
                marker_retries = 0
                if ":~:" in seed["target"] and not has_text_fragment_marker(ax_result):
                    deadline = time.monotonic() + (4 if is_pdf else 2)
                    while time.monotonic() < deadline and not has_text_fragment_marker(ax_result):
                        time.sleep(0.04)
                        ax_result = request_tree(
                            driver, selector, allow, "name" if cached_names is None else "",
                            cached_names is not None,
                        )
                        marker_retries += 1
                dump_ms = round((time.perf_counter() - phase) * 1000, 1)
                parsed = parse_tree(ax_result["tree"]) if args.live and cached_names is None else None
                remaining_sources[cached["file"]] -= 1
                cache_refresh = None
                should_refresh = (args.refresh_cache and not remaining_sources[cached["file"]]
                                  and cached["file"] not in refreshed_sources)
                try:
                    row = analyze(
                        seed, cached, ax_result, cached_names, source, baseline.get(seed["label"]),
                        navigation_ms, dump_ms, parsed=parsed,
                        write_ax_cache=not args.live, landing=landing,
                    )
                except ValueError:
                    if cached_names is None:
                        raise
                    phase = time.perf_counter()
                    ax_result = request_tree(
                        driver, selector, "name location size markerTypes markerStarts markerEnds", "name", False,
                    )
                    dump_ms += round((time.perf_counter() - phase) * 1000, 1)
                    parsed = parse_tree(ax_result["tree"]) if args.live else None
                    row = analyze(
                        seed, cached, ax_result, None, source, baseline.get(seed["label"]),
                        navigation_ms, dump_ms, parsed=parsed,
                        write_ax_cache=not args.live, landing=landing,
                    )
                if should_refresh:
                    driver.switch_to.window(target_handle)
                    try:
                        cache_refresh = freeze_and_refresh_cache(driver, cached, source)
                    except Exception as error:
                        cache_refresh = {"status": "refresh-error", "error": str(error)[:200]}
                    finally:
                        driver.switch_to.window(ax_handle)
                    refresh_outcomes[cached["file"]] = cache_refresh["status"]
                    if cache_refresh["status"] in {"refreshed", "preserved-pdf"}:
                        refreshed_sources.add(cached["file"])
                        refresh_failures.pop(cached["file"], None)
                        names = parsed[2] if parsed is not None else cached_names
                        if names and source.exists():
                            try:
                                write_ax_names(source, names)
                            except OSError as error:
                                cache_refresh["axTextCacheError"] = str(error)[:200]
                    else:
                        refresh_failures[cached["file"]] = cache_refresh
                if args.live:
                    row.update({
                        "liveUrl": live_url, "pageTitle": page_title,
                        "navigationTimedOut": navigation_timed_out,
                        "documentReadyState": document_ready_state,
                    })
                if cache_refresh is not None:
                    row["cacheRefresh"] = cache_refresh
                row["markerRetries"] = marker_retries
                row.update({
                    "verificationContract": VERIFICATION_CONTRACT,
                    "sourceMode": source_mode,
                    "headed": args.headed,
                    "refreshCache": args.refresh_cache,
                })
                if source.exists():
                    row["cacheIdentity"] = cache_identity(source)
                disagreements += not row["agrees"]
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                tally[row["verdict"]] = tally.get(row["verdict"], 0) + 1
                if index % 25 == 0:
                    print(json.dumps({"progress": index, "of": len(gate_seeds), "disagreements": disagreements}), flush=True)
            unrefreshed = refresh_expected - refreshed_sources
            refresh_failure_statuses = {}
            for file in unrefreshed:
                status = refresh_failures.get(file, {}).get("status", "not-attempted")
                refresh_failure_statuses[status] = refresh_failure_statuses.get(status, 0) + 1
            print(json.dumps({
                "inputRows": corpus_rows, "gettableRows": gettable_rows, "excluded404": len(excluded_404),
                "verifiedRows": len(gate_seeds), "pdfRows": pdf_count,
                "rows": len(existing) + len(gate_seeds), "seconds": round(time.perf_counter() - started, 2),
                "verdicts": tally, "disagreements": disagreements, "reused": len(existing),
                "discardedResumeRows": discarded_resume_rows,
                "verificationContract": VERIFICATION_CONTRACT,
                "sourceMode": source_mode,
                "cacheSources": len(refresh_expected),
                "cacheRefreshes": sum(status == "refreshed" for status in refresh_outcomes.values()),
                "cachePreservedPdfs": sum(status == "preserved-pdf" for status in refresh_outcomes.values()),
                "cacheCoveredSources": len(refreshed_sources),
                "cacheRefreshFailures": refresh_failure_statuses,
            }), flush=True)
        finally:
            lifecycle.close()


if __name__ == "__main__":
    main()
