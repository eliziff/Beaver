#!/usr/bin/env python3
"""Verify real Chromium text-fragment markers without screenshots."""
from __future__ import annotations

import argparse
import ast
import bisect
import hashlib
import importlib.util
import json
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fragment_exact_gate", HERE / "webdriver-exact-gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
AX_TEXT_CACHE = gate.RESULTS / "browser-ax-text"


def options(profile_dir):
    value = Options()
    value.page_load_strategy = "eager"
    for argument in (
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions",
        "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
        "--disable-sync", "--metrics-recording-only", "--no-first-run", "--renderer-process-limit=1",
        "--disable-features=MediaRouter,OptimizationHints,Translate", "--force-renderer-accessibility",
        "--window-size=480,520", "--force-device-scale-factor=1",
    ):
        value.add_argument(argument)
    value.add_argument(f"--user-data-dir={profile_dir}")
    return value


def normalized_with_map(text):
    chars, raw_map = [], []
    spaced = True
    for index, char in enumerate(text.lower()):
        char = {
            "\u05f3": "'", "\u05f4": '"', "\u2018": "'", "\u2019": "'",
            "\u201c": '"', "\u201d": '"',
        }.get(char, char)
        if char == "\u00ad":
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


def locator_with_map(text):
    chars, strict_map = [], []
    spaced = True
    for index, char in enumerate(text.lower()):
        if char.isalnum():
            chars.append(char)
            strict_map.append(index)
            spaced = False
        elif not spaced:
            chars.append(" ")
            strict_map.append(index)
            spaced = True
    return "".join(chars), strict_map


def occurrences(text, wanted):
    found, at = [], 0
    while wanted and (at := text.find(wanted, at)) >= 0:
        found.append((at, at + len(wanted)))
        at += max(1, len(wanted))
    return found


def merge(spans):
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def intended_spans(text, seed):
    locator, strict_map = locator_with_map(text)
    block = locator_with_map(seed.get("blockText", ""))[0]
    blocks = occurrences(locator, block)
    spans = []

    def locate(wanted):
        candidates = occurrences(locator, wanted)
        if not candidates:
            return None
        in_block = [span for span in candidates if any(start <= span[0] and span[1] <= end for start, end in blocks)]
        if len(in_block) == 1:
            return in_block[0]
        quote_in_block = block.find(wanted)
        scored = []
        for span in candidates:
            score = 0
            if quote_in_block >= 0:
                before = block[max(0, quote_in_block - 120):quote_in_block]
                after = block[quote_in_block + len(wanted):quote_in_block + len(wanted) + 120]
                for size in range(len(before), 11, -1):
                    if locator[max(0, span[0] - size):span[0]] == before[-size:]:
                        score += size
                        break
                for size in range(len(after), 11, -1):
                    if locator[span[1]:span[1] + size] == after[:size]:
                        score += size
                        break
            scored.append((score, span))
        scored.sort(reverse=True)
        if len(scored) > 1 and scored[0][0] == scored[1][0]:
            return None
        return scored[0][1]

    def strict_span(span):
        start, end = strict_map[span[0]], strict_map[span[1] - 1] + 1
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        return start, end

    directive = urlsplit(seed.get("target", "")).fragment.partition(":~:")[2]
    values = [part[5:] for part in directive.split("&") if part.startswith("text=")]
    for value in values:
        parts = value.split(",")
        if parts and parts[0].endswith("-"):
            parts.pop(0)
        if parts and parts[-1].startswith("-"):
            parts.pop()
        if not parts or len(parts) > 2:
            return None, "invalid-directive"
        start = locate(locator_with_map(unquote(parts[0]))[0])
        if start is None:
            return None, "quote-not-rendered"
        if len(parts) == 1:
            spans.append(strict_span(start))
            continue
        end_text = locator_with_map(unquote(parts[1]))[0]
        ends = [span for span in occurrences(locator, end_text) if span[0] >= start[1]]
        if not ends:
            return None, "quote-not-rendered"
        spans.append((strict_span(start)[0], strict_span(ends[0])[1]))
    return merge(spans), "located"


def desired_spans(text, seed):
    values = [f"text={quote(value, safe='')}" for value in seed.get("quotes") or []]
    if not values:
        return None, "quote-not-rendered"
    return intended_spans(text, {**seed, "target": f"#:~:{'&'.join(values)}"})


def unescape_name(value):
    try:
        return ast.literal_eval("'" + value + "'")
    except (SyntaxError, ValueError):
        return value


def parse_tree(tree, cached_names=None):
    text_parts, raw_spans = [], []
    raw_at = 0
    for line in tree.splitlines():
        if "staticText" not in line:
            continue
        if cached_names is not None:
            if len(text_parts) >= len(cached_names):
                raise ValueError("AX static-text node count grew")
            name = cached_names[len(text_parts)]
            attrs = line
        else:
            if " name='" not in line:
                name, attrs = "", line
            else:
                tail = line.split(" name='", 1)[1]
                marker_at = tail.rfind("' markerTypes=")
                name_raw = tail[:marker_at] if marker_at >= 0 else tail[:-1] if tail.endswith("'") else tail
                name = unescape_name(name_raw)
                attrs = tail[marker_at + 2:] if marker_at >= 0 else ""
        text_parts.append(name)
        if "markerTypes=" in attrs:
            values = {}
            for key in ("markerTypes", "markerStarts", "markerEnds"):
                match = re.search(rf"(?:^| ){key}=([0-9,]+)(?: |$)", attrs)
                values[key] = [int(value) for value in match.group(1).split(",")] if match else []
            for kind, start, end in zip(values["markerTypes"], values["markerStarts"], values["markerEnds"]):
                if kind == 4:
                    raw_spans.append((raw_at + start, raw_at + end))
        raw_at += len(name)
    if cached_names is not None and len(text_parts) != len(cached_names):
        raise ValueError(f"AX static-text node count changed: {len(cached_names)} -> {len(text_parts)}")
    return normalize_marker_spans(text_parts, raw_spans)


def normalize_marker_spans(names, raw_spans):
    raw_text = "".join(names)
    normalized, raw_map = normalized_with_map(raw_text)
    spans = []
    for start, end in raw_spans:
        normalized_start = bisect.bisect_left(raw_map, start)
        normalized_end = bisect.bisect_left(raw_map, end)
        while normalized_start < normalized_end and normalized[normalized_start] == " ":
            normalized_start += 1
        while normalized_end > normalized_start and normalized[normalized_end - 1] == " ":
            normalized_end -= 1
        if normalized_end > normalized_start:
            spans.append((normalized_start, normalized_end))
    merged = []
    for start, end in sorted(spans):
        if merged and (start <= merged[-1][1] or normalized[merged[-1][1]:start].isspace()):
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return normalized, merged, names


def parse_compact(compact, names):
    if compact["staticCount"] != len(names):
        raise ValueError(f"AX static-text node count changed: {len(names)} -> {compact['staticCount']}")
    offsets, raw_at = [], 0
    for name in names:
        offsets.append(raw_at)
        raw_at += len(name)
    raw_spans = []
    for index, types, starts, ends in compact["markers"]:
        for kind, start, end in zip(types, starts, ends):
            if kind == 4:
                raw_spans.append((offsets[index] + start, offsets[index] + end))
    return normalize_marker_spans(names, raw_spans)


def self_check():
    assert normalized_with_map("A,\u00a0 “b”\u00ad!")[0] == 'a, "b"!'
    assert locator_with_map("A,  b!")[0] == "a b "
    assert merge([(0, 1), (2, 3)]) == [(0, 1), (2, 3)]
    rendered, spans, _ = parse_compact(
        {"staticCount": 2, "markers": [[1, [4], [0], [2]]]},
        ["A, ", "B!"],
    )
    assert (rendered, spans) == ("a, b!", [(3, 5)])


def analyze(seed, cached, ax_result, cached_names, source, baseline_verdict, navigation_ms, dump_ms):
    if cached_names is not None:
        rendered, actual, names = parse_compact(ax_result["compact"], cached_names)
        tree_chars, marker_lines = 0, len(ax_result["compact"]["markers"])
    else:
        tree = ax_result["tree"]
        rendered, actual, names = parse_tree(tree)
        tree_chars = len(tree)
        marker_lines = sum("markerTypes=" in line for line in tree.splitlines())
        stat = source.stat()
        if names:
            (AX_TEXT_CACHE / f"{source.stem}.json").write_text(
                json.dumps({"size": stat.st_size, "mtimeNs": stat.st_mtime_ns, "names": names}, ensure_ascii=False),
                encoding="utf-8",
            )
    directive_intended, _ = intended_spans(rendered, seed)
    intended, location = desired_spans(rendered, seed)
    if intended is None:
        verdict = location
    elif not actual:
        verdict = "marker-no-match"
    elif actual == intended:
        verdict = "marker-exact"
    elif all(any(wanted_start <= start and end <= wanted_end for wanted_start, wanted_end in intended) for start, end in actual):
        verdict = "marker-partial"
    else:
        verdict = "marker-extraneous"
    agrees = baseline_verdict is None or (verdict == "marker-exact") == (baseline_verdict == "exact-match")
    safe_core = bool(actual and intended) and all(
        any(wanted_start <= start and end <= wanted_end for wanted_start, wanted_end in intended)
        for start, end in actual
    ) and all(
        any(wanted_start <= start and end <= wanted_end for start, end in actual)
        for wanted_start, wanted_end in intended
    )
    covered = sum(end - start for start, end in actual) if safe_core else 0
    desired_chars = sum(end - start for start, end in intended) if intended else 0
    return {
        "label": seed["label"], "verdict": verdict, "target": seed["target"], "cacheFile": cached["file"],
        "actual": actual, "intended": intended, "directiveIntended": directive_intended,
        "paintedText": [rendered[start:end] for start, end in actual],
        "intendedText": [rendered[start:end] for start, end in intended] if intended else [],
        "safeCore": safe_core,
        "coverage": round(covered / desired_chars, 4) if desired_chars else 0,
        "axNodes": len(names), "treeChars": tree_chars,
        "axPayloadChars": len(json.dumps(ax_result)), "axTextCache": "hit" if cached_names is not None else "miss",
        "axMeta": ax_result.get("meta"), "markerLines": marker_lines, "markerRetries": 0,
        "baselineVerdict": baseline_verdict, "agrees": agrees,
        "timings": {"navigationMs": navigation_ms, "markerDumpMs": dump_ms},
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
const pages = data.pages.filter(page => decoded(page.url || '').includes(cacheFile));
const page = pages.find(page => page.url?.startsWith('chrome-extension://')) || pages.at(-1);
window.__axTarget = {selected: page?.url, matches: pages.map(page => page.url)};
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
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        result = driver.execute_script("return window.__axResult")
        if result:
            result["meta"] = driver.execute_script("return window.__axTarget")
            return result
        time.sleep(0.01)
    raise TimeoutError("Chromium accessibility tree did not arrive")


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
    for (const line of values[0].tree.split('\n')) {
      if (!line.includes('staticText')) continue;
      const index = staticCount++;
      if (line.includes('markerTypes=')) markers.push([index, list(line, 'markerTypes'), list(line, 'markerStarts'), list(line, 'markerEnds')]);
    }
    window.__axResult = {compact: {staticCount, markers}};
    return;
  }
  return original.call(this, event, ...values);
};
""")


def main():
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
    args = parser.parse_args()

    seeds = gate.read_jsonl(args.targets)
    if args.label:
        seeds = [seed for seed in seeds if seed["label"] == args.label]
    if args.limit:
        seeds = seeds[:args.limit]
    manifest, files = {}, {}
    for row in gate.read_jsonl(gate.MANIFEST):
        file = gate.CACHE / (row.get("file") or "")
        if row.get("url") and row.get("file") and not row.get("challenged") and file.exists():
            manifest[gate.url_key(row["url"])] = row
            files[row["file"]] = file
    baseline = {row["label"]: row.get("verdict") for row in gate.read_jsonl(args.baseline)} if args.baseline else {}
    cached_seeds = [seed for seed in seeds if manifest.get(gate.url_key(seed.get("target", "").split("#")[0]))]
    missing_count = len(seeds) - len(cached_seeds)
    pdf_count = sum(manifest[gate.url_key(seed["target"].split("#")[0])]["file"].lower().endswith(".pdf") for seed in cached_seeds)
    if (missing_count):
        raise RuntimeError(f"{missing_count} targets have no usable cached page")
    gate_seeds = cached_seeds
    if args.shard_count > 1:
        gate_seeds = [
            seed for seed in gate_seeds
            if int(hashlib.sha256(seed["target"].split("#")[0].encode()).hexdigest(), 16) % args.shard_count == args.shard_index
        ]
    gate_seeds.sort(key=lambda seed: manifest[gate.url_key(seed["target"].split("#")[0])]["file"])
    wanted = {seed["label"]: seed["target"] for seed in gate_seeds}
    existing = [row for row in gate.read_jsonl(args.out) if wanted.get(row.get("label")) == row.get("target")] if args.resume else []
    completed = {(row["label"], row["target"]) for row in existing}
    gate_seeds = [seed for seed in gate_seeds if (seed["label"], seed["target"]) not in completed]
    if not gate_seeds:
        print(json.dumps({"inputRows": len(seeds), "pendingRows": 0, "pdfRows": pdf_count, "rows": len(existing), "seconds": 0, "reused": len(existing)}), flush=True)
        return

    started = time.perf_counter()
    AX_TEXT_CACHE.mkdir(exist_ok=True)
    with gate.CacheServer(files) as server, args.out.open("w", encoding="utf-8") as output:
        for row in existing:
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
        output.flush()
        phase = time.perf_counter()
        profile_dir = Path(tempfile.mkdtemp(prefix="browser-profile-", dir=gate.RESULTS))
        driver = webdriver.Chrome(service=Service(str(gate.DRIVER)), options=options(profile_dir))
        print(json.dumps({"browserStartMs": round((time.perf_counter() - phase) * 1000, 1)}), flush=True)
        try:
            target_handle = driver.current_window_handle
            first = gate_seeds[0]
            first_row = manifest[gate.url_key(first["target"].split("#")[0])]
            driver.get(f"{server.origin}/page/{first_row['file']}")
            driver.switch_to.new_window("tab")
            ax_handle = driver.current_window_handle
            driver.get("chrome://accessibility/")
            print(json.dumps({"axReadyMs": round((time.perf_counter() - started) * 1000, 1)}), flush=True)
            setup_ax(driver)

            tally, disagreements = {}, sum(not row.get("agrees", True) for row in existing)
            for row in existing:
                tally[row["verdict"]] = tally.get(row["verdict"], 0) + 1
            for index, seed in enumerate(gate_seeds, 1):
                phase = time.perf_counter()
                cached = manifest[gate.url_key(seed["target"].split("#")[0])]
                source = gate.CACHE / cached["file"]
                stat = source.stat()
                cache_path = AX_TEXT_CACHE / f"{source.stem}.json"
                ax_cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else None
                cached_names = ax_cache.get("names") if ax_cache and ax_cache.get("names") and ax_cache.get("size") == stat.st_size and ax_cache.get("mtimeNs") == stat.st_mtime_ns else None
                replay = hashlib.sha1(seed["label"].encode()).hexdigest()[:12]
                driver.switch_to.window(target_handle)
                driver.get(f"{server.origin}/page/{cached['file']}?verify={replay}#{seed['target'].partition('#')[2]}")
                driver.execute_async_script(r"""
const done = arguments[0];
const finish = () => requestAnimationFrame(() => requestAnimationFrame(done));
if (document.readyState === 'complete') finish(); else addEventListener('load', finish, {once: true});
""")
                navigation_ms = round((time.perf_counter() - phase) * 1000, 1)
                phase = time.perf_counter()
                driver.switch_to.window(ax_handle)
                allow = "markerTypes markerStarts markerEnds" if cached_names is not None else "name markerTypes markerStarts markerEnds"
                is_pdf = cached["file"].lower().endswith(".pdf")
                ax_result = request_tree(driver, cached["file"], allow, "name" if cached_names is None else "", cached_names is not None)
                if is_pdf and cached_names is None:
                    deadline = time.monotonic() + 4
                    while "staticText" not in ax_result.get("tree", "") and time.monotonic() < deadline:
                        time.sleep(0.08)
                        ax_result = request_tree(driver, cached["file"], allow, "name", False)
                dump_ms = round((time.perf_counter() - phase) * 1000, 1)
                row = analyze(seed, cached, ax_result, cached_names, source, baseline.get(seed["label"]), navigation_ms, dump_ms)
                disagreements += not row["agrees"]
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                tally[row["verdict"]] = tally.get(row["verdict"], 0) + 1
                if index % 25 == 0:
                    print(json.dumps({"progress": index, "of": len(gate_seeds), "disagreements": disagreements}), flush=True)
            print(json.dumps({"inputRows": len(seeds), "verifiedRows": len(gate_seeds), "pdfRows": pdf_count, "rows": len(existing) + len(gate_seeds), "seconds": round(time.perf_counter() - started, 2), "verdicts": tally, "disagreements": disagreements, "reused": len(existing)}), flush=True)
        finally:
            driver.quit()
            shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
