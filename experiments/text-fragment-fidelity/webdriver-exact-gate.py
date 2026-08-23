#!/usr/bin/env python3
"""Exact cached-page text-fragment gate using real ChromeDriver.

HTML passes only when every requested quote has an unambiguous rendered DOM
range and target-text paint pixels overlap that exact range. A cropped PNG and
geometry record are preserved for every confirmed quote. Results append after
each seed, so interrupted corpus runs retain usable partial proof.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import io
import json
import mimetypes
import re
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse, parse_qsl

from PIL import Image, ImageChops, ImageDraw
import pypdfium2 as pdfium
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
CACHE = RESULTS / "page-html"
PDF_TEXT_CACHE = RESULTS / "pdf-text"
BROWSER_TEXT_CACHE = RESULTS / "browser-rendered-text"
TARGETS = RESULTS / "targets.jsonl"
MANIFEST = RESULTS / "page-html-manifest.jsonl"
DEFAULT_OUT = RESULTS / "webdriver-exact.jsonl"
SHOTS = RESULTS / "exact-shots"
DRIVER = Path.home() / ".cache/selenium/chromedriver/win64/151.0.7922.138/chromedriver.exe"
PDF_RE = re.compile(r"(?i)(\.pdf(?:$|[?#])|/document\.do(?:$|[?#]))")


def use_below_normal_priority():
    if hasattr(ctypes, "windll"):
        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.SetPriorityClass.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        kernel32.SetPriorityClass.restype = ctypes.c_int
        if not kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000):
            raise ctypes.WinError()


use_below_normal_priority()


def read_jsonl(path: Path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def add_timing(timings: dict, name: str, started: float):
    timings[name] = round(timings.get(name, 0) + (time.perf_counter() - started) * 1000, 1)


def range_probe_verdict(quote_proofs: list[dict], ranges: list[dict]):
    expected = [proof.get("documentRects", []) for proof in quote_proofs]
    if any(not rects for rects in expected):
        return "intended-not-located"
    def point(rect, end=False):
        return (rect["y"], rect["x"] + (rect["width"] if end else 0))
    def order(left, right):
        return left[0] - right[0] if abs(left[0] - right[0]) > 2 else left[1] - right[1]
    def same(left, right):
        return abs(left[0] - right[0]) <= 2 and abs(left[1] - right[1]) <= 6
    intended = [(point(rects[0]), point(rects[-1], True)) for rects in expected]
    if not ranges or any(candidate.get("status") != "matched" or not candidate.get("first") or not candidate.get("last") for candidate in ranges):
        return "range-unresolved"
    matched = ranges
    if not matched:
        return "range-no-match"
    spans = [(point(candidate["first"]), point(candidate["last"], True)) for candidate in matched]
    if any(not any(order(start, wanted_start) >= -6 and order(end, wanted_end) <= 6 for wanted_start, wanted_end in intended) for start, end in spans):
        return "range-stray"
    for wanted_start, wanted_end in intended:
        contained = [(start, end) for start, end in spans if order(start, wanted_start) >= -6 and order(end, wanted_end) <= 6]
        if not any(same(start, wanted_start) for start, _ in contained) or not any(same(end, wanted_end) for _, end in contained):
            return "range-partial"
    return "range-exact"


def url_key(raw: str) -> str:
    parsed = urlparse(raw)
    path = parsed.path[:-4] if parsed.hostname and parsed.hostname.endswith("bclaws.gov.bc.ca") and parsed.path.endswith("/xml") else parsed.path
    query = "&".join(f"{k}={v}" for k, v in sorted(parse_qsl(parsed.query, keep_blank_values=True)))
    return f"{parsed.scheme}://{parsed.netloc}{path}?{query}".lower()


class CacheServer:
    def __init__(self, files: dict[str, Path]):
        self.files = files
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                name = unquote(urlparse(self.path).path.removeprefix("/page/"))
                file = outer.files.get(name)
                if not file or not file.exists():
                    self.send_error(404)
                    return
                body = file.read_bytes()
                # HTML cache files are page.content() DOM snapshots. That API
                # serializes the already-decoded DOM as UTF-8, regardless of a
                # legacy charset meta tag retained from the original response.
                content_type = "application/pdf" if file.suffix.lower() == ".pdf" else "text/html; charset=utf-8"
                if file.suffix.lower() != ".pdf":
                    paint_style = b'<style id="fragment-proof-style">::target-text{background:rgb(0,255,0)!important;color:rgb(0,0,0)!important}</style>'
                    body, count = re.subn(br"(<head\b[^>]*>)", br"\1" + paint_style, body, count=1, flags=re.IGNORECASE)
                    if not count:
                        body = paint_style + body
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                if file.suffix.lower() != ".pdf":
                    self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *_args):
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.httpd.shutdown()
        self.thread.join()

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.httpd.server_port}"


LOCATE_SCRIPT = r"""
const quote = arguments[0];
const block = arguments[1];
const anchor = arguments[2];
const norm = (s) => (s ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const nodes = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
let node;
while ((node = walker.nextNode())) {
  const parent = node.parentElement;
  if (!parent || parent.closest("script,style,noscript,template")) continue;
  nodes.push(node);
}
let text = "";
const map = [];
let spaced = true;
for (const n of nodes) {
  const value = n.textContent ?? "";
  for (let i = 0; i < value.length; i += 1) {
    const folded = norm(value[i]);
    if (folded) {
      text += folded;
      map.push({ n, o: i });
      spaced = false;
    } else if (!spaced && text.length) {
      text += " ";
      map.push({ n, o: i });
      spaced = true;
    }
  }
  if (!spaced && text.length) {
    text += " ";
    map.push({ n, o: Math.max(0, value.length - 1) });
    spaced = true;
  }
}
text = text.trimEnd();
const wanted = norm(quote);
const wantedBlock = norm(block);
if (!wanted) return { status: "empty-quote" };
const occurrences = [];
let at = 0;
while ((at = text.indexOf(wanted, at)) >= 0) {
  occurrences.push(at);
  at += Math.max(1, wanted.length);
}
if (!occurrences.length) return { status: "quote-not-rendered", wanted };
const blockStarts = [];
if (wantedBlock) {
  let b = 0;
  while ((b = text.indexOf(wantedBlock, b)) >= 0) {
    blockStarts.push(b);
    b += Math.max(1, wantedBlock.length);
  }
}
const anchorEl = anchor ? (document.getElementById(anchor) || document.querySelector(`[name="${CSS.escape(anchor)}"]`)) : null;
const anchorRect = anchorEl?.getBoundingClientRect();
const makeRange = (start) => {
  const first = map[start];
  const last = map[Math.min(map.length - 1, start + wanted.length - 1)];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.n, Math.min(first.o, first.n.length));
  range.setEnd(last.n, Math.min(last.n.length, last.o + 1));
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  return { range, rects };
};
const scored = occurrences.map((start) => {
  const made = makeRange(start);
  if (!made || !made.rects.length) return null;
  const contained = blockStarts.some((b) => b <= start && start + wanted.length <= b + wantedBlock.length);
  const top = made.rects[0].top + window.scrollY;
  const anchorTop = anchorRect ? anchorRect.top + window.scrollY : null;
  const anchorDistance = anchorTop == null ? null : Math.abs(top - anchorTop);
  // Context agreement disambiguates when publisher markup prevents an exact
  // full-block match. Compare up to 120 normalized characters on each side.
  const qInBlock = wantedBlock.indexOf(wanted);
  let context = 0;
  if (qInBlock >= 0) {
    const before = wantedBlock.slice(Math.max(0, qInBlock - 120), qInBlock);
    const after = wantedBlock.slice(qInBlock + wanted.length, qInBlock + wanted.length + 120);
    for (let n = before.length; n >= 12; n -= 1) {
      if (text.slice(Math.max(0, start - n), start) === before.slice(-n)) { context += n; break; }
    }
    for (let n = after.length; n >= 12; n -= 1) {
      if (text.slice(start + wanted.length, start + wanted.length + n) === after.slice(0, n)) { context += n; break; }
    }
  }
  return { start, made, contained, context, anchorDistance, top };
}).filter(Boolean);
scored.sort((a, b) => Number(b.contained) - Number(a.contained) || b.context - a.context || (a.anchorDistance ?? 1e15) - (b.anchorDistance ?? 1e15));
if (!scored.length) return { status: "quote-not-laid-out", occurrences: occurrences.length };
const best = scored[0];
const second = scored[1];
const tied = second && best.contained === second.contained && best.context === second.context && best.anchorDistance == null && second.anchorDistance == null;
if (tied) return { status: "ambiguous-location", occurrences: occurrences.length, context: best.context };
const documentRects = best.made.rects.map((r) => ({x:r.x+window.scrollX,y:r.y+window.scrollY,width:r.width,height:r.height}));
window.scrollTo(0, Math.max(0, best.top - window.innerHeight / 2));
return { status: "located", occurrences: occurrences.length, contained: best.contained, context: best.context, anchorDistance: best.anchorDistance, documentTop: best.top, normalizedOffset: best.start, documentRects, scrollY: window.scrollY, innerHeight: window.innerHeight };
"""

MINE_DIRECTIVE_SCRIPT = r"""
const wantedWords = (arguments[0] ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const clean = (s) => (s ?? '').replace(/[\s\u00a0\u202f\u2007\u2009\u200b]+/gu, ' ').trim();
let rendered = '';
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
let node;
while ((node = walker.nextNode())) {
  if (!node.parentElement || node.parentElement.closest('script,style,noscript,template')) continue;
  rendered += `${node.textContent ?? ''} `;
}
const tokens = [];
const re = /[\p{L}\p{N}]+/gu;
let match;
while ((match = re.exec(rendered))) tokens.push({word:match[0].toLocaleLowerCase(), start:match.index, end:match.index+match[0].length});
const occurrences = (needle) => {
  const hits = [];
  outer: for (let at = 0; at + needle.length <= tokens.length; at += 1) {
    for (let i = 0; i < needle.length; i += 1) if (tokens[at+i].word !== needle[i]) continue outer;
    hits.push(at);
  }
  return hits;
};
const intended = occurrences(wantedWords);
if (intended.length !== 1 || wantedWords.length < 2) return null;
const startAt = intended[0];
const endAt = startAt + wantedWords.length;
const exact = clean(rendered.slice(tokens[startAt].start, tokens[endAt - 1].end));
if (exact) return {exact};
const rawWords = (at, size) => clean(rendered.slice(tokens[at].start, tokens[at + size - 1].end));
const boundarySize = Math.min(4, wantedWords.length);
const start = rawWords(startAt, boundarySize);
const endBoundaryAt = endAt - boundarySize;
const end = rawWords(endBoundaryAt, boundarySize);
let prefix = null;
if (occurrences(tokens.slice(startAt, startAt + boundarySize).map((token) => token.word)).length !== 1) {
  for (let size = 2; size <= Math.min(48, startAt); size += 1) {
    const at = startAt - size;
    const words = tokens.slice(at, startAt + boundarySize).map((token) => token.word);
    if (occurrences(words).length === 1) { prefix = rawWords(at, size); break; }
  }
  if (!prefix) return null;
}
let suffix = null;
if (occurrences(tokens.slice(endBoundaryAt, endAt).map((token) => token.word)).length !== 1) {
  for (let size = 2; size <= Math.min(48, tokens.length - endAt); size += 1) {
    const words = tokens.slice(endBoundaryAt, endAt + size).map((token) => token.word);
    if (occurrences(words).length === 1) { suffix = rawWords(endAt, size); break; }
  }
  if (!suffix) return null;
}
return {start, end, prefix, suffix};
"""

WINDOW_FIND_PROBE_SCRIPT = r"""
const target = arguments[0] ?? '';
const hash = target.includes('#') ? target.slice(target.indexOf('#') + 1) : '';
const marker = hash.indexOf(':~:');
const payload = marker >= 0 ? hash.slice(marker + 3) : hash;
const rawDirectives = payload.split('&').filter((part) => part.startsWith('text=')).map((part) => part.slice(5));
const selection = getSelection();
const reset = () => {
  const range = document.createRange();
  range.selectNodeContents(document.body);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};
const find = (text) => window.find(text, false, false, false, false, false, false);
const snapshot = (range) => {
  const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
  return {
    text: range.toString(),
    rectCount: rects.length,
    first: rects.length ? {x:rects[0].x+scrollX,y:rects[0].y+scrollY,width:rects[0].width,height:rects[0].height} : null,
    last: rects.length ? {x:rects.at(-1).x+scrollX,y:rects.at(-1).y+scrollY,width:rects.at(-1).width,height:rects.at(-1).height} : null,
  };
};
const results = [];
for (const raw of rawDirectives) {
  let pieces;
  try { pieces = raw.split(',').map(decodeURIComponent); }
  catch { results.push({raw, status:'decode-error'}); continue; }
  let prefix = null, suffix = null;
  if (pieces[0]?.endsWith('-')) prefix = pieces.shift().slice(0, -1);
  if (pieces.at(-1)?.startsWith('-')) suffix = pieces.pop().slice(1);
  const [start, end = null] = pieces;
  reset();
  if (!start || !find(start)) { results.push({raw, status:'start-not-found'}); continue; }
  const startRange = selection.getRangeAt(0).cloneRange();
  let matched = startRange;
  if (end) {
    if (!find(end)) { results.push({raw, status:'end-not-found', start:snapshot(startRange)}); continue; }
    const endRange = selection.getRangeAt(0).cloneRange();
    matched = document.createRange();
    matched.setStart(startRange.startContainer, startRange.startOffset);
    matched.setEnd(endRange.endContainer, endRange.endOffset);
  }
  results.push({raw, status:'matched', prefix, suffix, ...snapshot(matched)});
}
selection.removeAllRanges();
return results;
"""

RANGE_BATCH_SCRIPT = (
    "const locate = function() {" + LOCATE_SCRIPT + "};"
    "const resolve = function() {" + WINDOW_FIND_PROBE_SCRIPT + "};"
    "const quotes = arguments[0] ?? [];"
    "const proofs = quotes.map((wanted) => locate(wanted, arguments[1], arguments[2]));"
    "return {quotes: proofs, ranges: resolve(arguments[3])};"
)

def channel_mask(channel, low, high):
    return channel.point([255 if low <= value <= high else 0 for value in range(256)])


def target_mask(image: Image.Image, kind: str):
    red, green, blue = image.split()
    ranges = ((0, 35), (220, 255), (0, 35)) if kind == "html" else ((220, 242), (195, 220), (242, 255))
    masks = tuple(channel_mask(channel, *limits) for channel, limits in zip((red, green, blue), ranges))
    return ImageChops.multiply(ImageChops.multiply(masks[0], masks[1]), masks[2])


def mask_count(mask):
    return mask.histogram()[255]


def highlight_pixels(png: bytes, rects: list[dict], endpoint_rects: list[dict] | None = None):
    image = Image.open(io.BytesIO(png)).convert("RGB")
    mask = target_mask(image, "html")
    def count_in(selected, padding):
        region = Image.new("L", image.size, 0)
        draw = ImageDraw.Draw(region)
        for rect in selected:
            draw.rectangle((rect["x"] - padding, rect["y"] - padding, rect["x"] + rect["width"] + padding, rect["y"] + rect["height"] + padding), fill=255)
        return mask_count(ImageChops.multiply(mask, region))
    inside = count_in(rects, 4)
    endpoint_rects = endpoint_rects if endpoint_rects is not None else rects
    endpoints = [count_in(endpoint_rects[:1], 2), count_in(endpoint_rects[-1:], 2)] if endpoint_rects else [0, 0]
    return inside, mask_count(mask), endpoints, image


def html_paint_proof(driver, local: str, seed: dict, cache_file: str, save_shots=False, mine_oracle=False):
    """Acceptance proof against the complete cached document and real target paint."""
    timings = {}
    target = seed.get("target", "")
    phase = time.perf_counter()
    driver.get(local)
    add_timing(timings, "navigationMs", phase)
    phase = time.perf_counter()
    probe = driver.execute_script(
        RANGE_BATCH_SCRIPT, seed.get("quotes") or [], seed.get("blockText", ""), seed.get("anchor", ""), target,
    )
    add_timing(timings, "paintPrepMs", phase)
    quote_proofs = probe["quotes"]
    find_ranges = probe["ranges"]
    verdict = "exact-match"
    image = None
    for proof in quote_proofs:
        if proof.get("status") != "located":
            verdict = proof.get("status", "location-error")
            break
    all_document_rects = [rect for proof in quote_proofs for rect in proof.get("documentRects", [])]
    if verdict == "exact-match":
        for quote_index, proof in enumerate(quote_proofs):
            document_rects = proof["documentRects"]
            phase = time.perf_counter()
            scroll_y = driver.execute_script("window.scrollTo(0, Math.max(0, arguments[0] - innerHeight / 2)); return scrollY", proof["documentTop"])
            add_timing(timings, "scrollMs", phase)
            phase = time.perf_counter()
            png = driver.get_screenshot_as_png()
            add_timing(timings, "screenshotMs", phase)
            rects = [{**rect, "y": rect["y"] - scroll_y} for rect in document_rects]
            union_rects = [{**rect, "y": rect["y"] - scroll_y} for rect in all_document_rects]
            phase = time.perf_counter()
            inside, total, endpoints, image = highlight_pixels(png, union_rects, rects)
            add_timing(timings, "pixelAnalysisMs", phase)
            outside = max(0, total - inside)
            proof.update({
                "verifiedScrollY": scroll_y, "rects": rects, "insideHighlightPixels": inside,
                "endpointHighlightPixels": endpoints, "outsideHighlightPixels": outside,
                "captureHighlightPixels": total, "screenshotSize": [image.width, image.height],
            })
            if inside < 25:
                proof["status"] = "paint-missed-exact-range"
                verdict = "paint-missed-exact-range"
            elif min(endpoints) < 10:
                proof["status"] = "paint-did-not-cover-range"
                verdict = "paint-did-not-cover-range"
            elif outside > max(25, inside * 0.05):
                proof["status"] = "paint-extraneous"
                verdict = "paint-extraneous"
            else:
                proof["screenshotSha256"] = hashlib.sha256(png).hexdigest()
                if save_shots:
                    phase = time.perf_counter()
                    shot_name = safe_name(seed["label"], quote_index)
                    image.save(SHOTS / shot_name, compress_level=1, optimize=False)
                    proof["screenshot"] = shot_name
                    add_timing(timings, "artifactWriteMs", phase)
    range_verdict = range_probe_verdict(quote_proofs, find_ranges)
    if verdict == "exact-match" and range_verdict != "range-exact":
        verdict = range_verdict
    result = {
        "label": seed["label"], "verdict": verdict, "target": target, "cacheFile": cache_file,
        "paintColor": "rgb(0,255,0)", "quotes": quote_proofs, "findRanges": find_ranges,
        "rangeVerdict": range_verdict,
    }
    if save_shots and verdict != "exact-match" and image is not None:
        full_name = safe_name(seed["label"] + "-full", 0)
        image.save(SHOTS / full_name, compress_level=1, optimize=False)
        result["failureScreenshot"] = full_name
    if mine_oracle and verdict != "exact-match":
        phase = time.perf_counter()
        candidate = driver.execute_script(MINE_DIRECTIVE_SCRIPT, (seed.get("quotes") or [""])[0])
        add_timing(timings, "oracleMineMs", phase)
        if candidate:
            result["oracleDirective"] = candidate
    return result, timings


def safe_name(label: str, quote_index: int):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", label)[:170] + f"-q{quote_index}.png"


def normalized_with_raw_map(text: str):
    chars = []
    raw_map = []
    spaced = True
    for index, char in enumerate(text.lower()):
        if char.isalnum():
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


def all_occurrences(text: str, wanted: str):
    found = []
    at = 0
    while wanted and (at := text.find(wanted, at)) >= 0:
        found.append((at, at + len(wanted)))
        at += max(1, len(wanted))
    return found


def raw_directives(target: str):
    fragment = target.partition("#")[2]
    marker = fragment.find(":~:")
    payload = fragment[marker + 3:] if marker >= 0 else fragment
    return [piece[5:] for piece in payload.split("&") if piece.startswith("text=")]


def parse_directive(raw: str):
    pieces = raw.split(",")
    prefix = normalized_with_raw_map(unquote(pieces.pop(0)[:-1]))[0] if pieces and pieces[0].endswith("-") else ""
    suffix = normalized_with_raw_map(unquote(pieces.pop()[1:]))[0] if pieces and pieces[-1].startswith("-") else ""
    if not 1 <= len(pieces) <= 2:
        return None
    terms = [normalized_with_raw_map(unquote(piece))[0] for piece in pieces]
    return prefix, terms[0], terms[1] if len(terms) == 2 else "", suffix


def directive_matches(pages: list[str], raw: str):
    parsed = parse_directive(raw)
    if not parsed:
        return []
    prefix, start_text, end_text, suffix = parsed
    matches = []
    for page_index, text in enumerate(pages):
        for start, start_end in all_occurrences(text, start_text):
            before = text[:start].rstrip()
            if prefix and not before.endswith(prefix):
                continue
            if not end_text:
                after = text[start_end:].lstrip()
                if not suffix or after.startswith(suffix):
                    matches.append((page_index, start, start_end))
                continue
            for end_start, end in all_occurrences(text, end_text):
                if end_start < start_end:
                    continue
                after = text[end:].lstrip()
                if not suffix or after.startswith(suffix):
                    matches.append((page_index, start, end))
                    break
    return matches


def directive_match(pages: list[str], raw: str):
    matches = directive_matches(pages, raw)
    return matches[0] if matches else None


def sequence_starts(words: list[str], wanted: list[str]):
    return [at for at in range(len(words) - len(wanted) + 1)
            if words[at:at + len(wanted)] == wanted]


def subsequence_count(wanted: list[str], available: list[str]):
    at = 0
    for word in available:
        if at < len(wanted) and word == wanted[at]:
            at += 1
    return at


def anchored_core_matches(page_text: str, span: tuple[int, int, int], block_text: str, quote_text: str):
    _, start, end = span
    block_words = block_text.split()
    quote_words = quote_text.split()
    page_words = [(match.group(), match.start(), match.end()) for match in re.finditer(r"\S+", page_text)]
    core = [word for word, word_start, word_end in page_words if word_start >= start and word_end <= end]
    quote_starts = sequence_starts(block_words, quote_words)
    if len(quote_starts) != 1 or not core:
        return False
    core_offsets = sequence_starts(quote_words, core)
    if len(core_offsets) != 1:
        return False
    block_core = quote_starts[0] + core_offsets[0]
    page_core = next((index for index, (_, word_start, _) in enumerate(page_words) if word_start == start), None)
    if page_core is None:
        return False
    before = block_words[max(0, block_core - 32):block_core]
    after_at = block_core + len(core)
    after = block_words[after_at:min(len(block_words), after_at + 32)]
    page_before = [word for word, _, _ in page_words[max(0, page_core - 384):page_core]]
    page_after = [word for word, _, _ in page_words[page_core + len(core):page_core + len(core) + 384]]
    before_count = subsequence_count(list(reversed(before)), list(reversed(page_before)))
    after_count = subsequence_count(after, page_after)
    evidence = len(before) + len(after)
    one_side = before_count >= min(12, len(before)) or after_count >= min(12, len(after))
    two_sides = (before_count + after_count >= min(16, evidence)
                 and before_count >= min(4, len(before)) and after_count >= min(4, len(after)))
    return evidence >= 8 and (one_side or two_sides)


def pdfium_pages(file: Path):
    stat = file.stat()
    PDF_TEXT_CACHE.mkdir(exist_ok=True)
    persisted = PDF_TEXT_CACHE / f"{file.stem}.pdfium.json"
    if persisted.exists():
        cached = json.loads(persisted.read_text(encoding="utf-8"))
        if cached.get("size") == stat.st_size and cached.get("mtimeNs") == stat.st_mtime_ns:
            return cached["pages"]
    document = pdfium.PdfDocument(str(file))
    try:
        pages = []
        for page in document:
            text_page = page.get_textpage()
            try:
                pages.append(text_page.get_text_range())
            finally:
                text_page.close()
                page.close()
    finally:
        document.close()
    persisted.write_text(json.dumps({"size": stat.st_size, "mtimeNs": stat.st_mtime_ns, "pages": pages}, ensure_ascii=False), encoding="utf-8")
    return pages


def pdf_proof(file: Path, seed: dict, text_cache: dict[Path, list[str]]):
    pages = text_cache.get(file)
    if pages is None:
        pages = [normalized_with_raw_map(text)[0] for text in pdfium_pages(file)]
        text_cache[file] = pages
    selected = []
    ambiguous = []
    for directive in raw_directives(seed["target"]):
        matches = directive_matches(pages, directive)
        if len(matches) > 1:
            ambiguous.append({"directive": unquote(directive), "spans": matches})
        elif matches:
            selected.append({"directive": unquote(directive), "span": matches[0], "parsed": parse_directive(directive)})
    if ambiguous:
        return {"status": "pdf-directive-ambiguous", "selected": selected, "ambiguous": ambiguous}

    intended = []
    core_only = False
    block_text = normalized_with_raw_map(seed.get("blockText", ""))[0]
    for quote_text_raw in seed.get("quotes") or []:
        quote_text = normalized_with_raw_map(quote_text_raw)[0]
        hits = [(page, start, end) for page, text in enumerate(pages) for start, end in all_occurrences(text, quote_text)]
        if block_text:
            block_hits = {(page, start, end) for page, text in enumerate(pages) for start, end in all_occurrences(text, block_text)}
            contained = [hit for hit in hits if any(
                hit[0] == block_page and block_start <= hit[1] and hit[2] <= block_end
                for block_page, block_start, block_end in block_hits
            )]
            if contained:
                hits = contained
        if len(hits) == 1:
            intended.append(hits[0])
            continue
        cores = [item["span"] for item in selected
                 if item["parsed"] and not item["parsed"][0] and not item["parsed"][2] and not item["parsed"][3]
                 and anchored_core_matches(pages[item["span"][0]], item["span"], block_text, quote_text)]
        if not cores:
            projected = []
            for directive in raw_directives(seed["target"]):
                parsed = parse_directive(directive)
                if not parsed or parsed[2] or not (parsed[0] or parsed[3]):
                    continue
                for page, text in enumerate(pages):
                    for start, end in all_occurrences(text, parsed[1]):
                        span = (page, start, end)
                        if anchored_core_matches(text, span, block_text, quote_text):
                            projected.append({"directive": unquote(directive), "span": span,
                                              "parsed": parsed, "contextProjected": True})
            if len(projected) == 1:
                selected.extend(projected)
                cores = [projected[0]["span"]]
        if not cores:
            return {"status": "pdf-quote-not-unique", "quote": quote_text_raw, "quoteOccurrences": len(hits)}
        intended.extend(cores)
        core_only = True
    extraneous = [item for item in selected if not any(
        item["span"][0] == wanted[0] and wanted[1] <= item["span"][1] and item["span"][2] <= wanted[2]
        for wanted in intended
    )]
    if extraneous:
        return {"status": "pdf-directive-extraneous", "intended": intended, "selected": selected, "extraneous": extraneous}
    if not selected or any(not any(
        item["span"][0] == wanted[0] and wanted[1] <= item["span"][1] and item["span"][2] <= wanted[2]
        for item in selected
    ) for wanted in intended):
        return {"status": "pdf-no-compatible-directive", "intended": intended, "selected": selected}
    exact = not core_only and sorted(item["span"] for item in selected) == sorted(intended)
    return {
        "status": "pdf-location-exact" if exact else "pdf-location-safe-core",
        "pages": sorted({item["span"][0] + 1 for item in selected}),
        "intended": intended,
        "selected": selected,
    }


def screenshot_highlight(png: bytes):
    image = Image.open(io.BytesIO(png)).convert("RGB")
    mask = target_mask(image, "pdf")
    pixels = mask_count(mask)
    bounds = mask.getbbox()
    if not bounds:
        return 0, None, image
    x0, y0, x1, y1 = bounds
    return pixels, [x0, y0, x1 - 1, y1 - 1], image


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int)
    parser.add_argument("--labels")
    parser.add_argument("--targets", type=Path, default=TARGETS)
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--only", choices=("all", "html", "pdf"), default="all")
    parser.add_argument("--mine-oracle", action="store_true")
    parser.add_argument("--save-shots", action="store_true")
    parser.add_argument("--find-probe", action="store_true")
    parser.add_argument("--range-only", action="store_true")
    parser.add_argument("--pdf-proof-only", action="store_true")
    args = parser.parse_args()
    if not 0 <= args.shard_index < args.shard_count:
        raise ValueError("shard-index must be in [0, shard-count)")
    targets = [
        seed for seed in read_jsonl(args.targets)
        if int(hashlib.sha256(seed.get("target", "").split("#")[0].encode()).hexdigest(), 16) % args.shard_count == args.shard_index
    ]
    if args.labels:
        wanted = set(Path(args.labels).read_text(encoding="utf-8").splitlines())
        targets = [seed for seed in targets if seed["label"] in wanted]
    manifest = {}
    files = {}
    for row in read_jsonl(MANIFEST):
        if not row.get("url") or not row.get("file") or row.get("challenged"):
            continue
        file = CACHE / row["file"]
        if file.exists() and file.stat().st_size >= 500:
            manifest[url_key(row["url"])] = row
            files[row["file"]] = file
    if args.only != "all":
        want_pdf = args.only == "pdf"
        def cached_as_pdf(seed):
            base = seed.get("target", "").split("#")[0]
            row = manifest.get(url_key(base))
            return bool(PDF_RE.search(base) or row and row["file"].lower().endswith(".pdf"))
        targets = [seed for seed in targets if cached_as_pdf(seed) == want_pdf]
    out_path = args.out if args.out.is_absolute() else Path.cwd() / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if args.fresh:
        out_path.unlink(missing_ok=True)
    def input_hash(seed):
        base = seed.get("target", "").split("#")[0]
        cached = manifest.get(url_key(base))
        file = CACHE / cached["file"] if cached else None
        cache_identity = None
        if file and file.exists():
            stat = file.stat()
            cache_identity = [cached["file"], stat.st_size, stat.st_mtime_ns]
        mode = "pdfium-proof-v1" if args.pdf_proof_only else "range-v2" if args.range_only else "paint-v3"
        payload = {"seed": seed, "cache": cache_identity, "mode": mode}
        return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]

    fingerprints = {seed["label"]: input_hash(seed) for seed in targets}
    done = {row["label"]: row.get("inputHash") for row in read_jsonl(out_path)}
    pending = [seed for seed in targets if done.get(seed["label"]) != fingerprints[seed["label"]]]
    if args.limit:
        pending = pending[:args.limit]
    pending.sort(key=lambda seed: seed.get("target", "").split("#")[0])
    if not pending:
        print(json.dumps({"workerSummary": {"reused": len(targets), "pending": 0, "lifecycleMs": 0}}), flush=True)
        return
    if args.pdf_proof_only:
        if args.only != "pdf":
            raise ValueError("--pdf-proof-only requires --only pdf")
        started = time.perf_counter()
        text_cache = {}
        with out_path.open("a", encoding="utf-8") as output:
            tally = {}
            for index, seed in enumerate(pending, 1):
                base = seed["target"].split("#", 1)[0]
                row = manifest.get(url_key(base))
                proof = pdf_proof(CACHE / row["file"], seed, text_cache) if row else {"status": "cache-miss"}
                result = {"label": seed["label"], "verdict": proof["status"], "target": seed["target"],
                          "cacheFile": row["file"] if row else None, "proof": proof,
                          "inputHash": fingerprints[seed["label"]]}
                output.write(json.dumps(result, ensure_ascii=False) + "\n")
                output.flush()
                tally[result["verdict"]] = tally.get(result["verdict"], 0) + 1
                if index % 25 == 0:
                    print(json.dumps({"progress": index, "of": len(pending)}), flush=True)
        print(json.dumps({"rows": len(pending), "seconds": round(time.perf_counter() - started, 2), "verdicts": tally}), flush=True)
        return
    SHOTS.mkdir(exist_ok=True)
    options = Options()
    # DOMContentLoaded is sufficient for static cached documents and avoids
    # waiting on irrelevant publisher images, analytics, and dead remote assets.
    options.page_load_strategy = "eager"
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-background-networking")
    options.add_argument("--disable-component-update")
    options.add_argument("--disable-default-apps")
    options.add_argument("--disable-sync")
    options.add_argument("--metrics-recording-only")
    options.add_argument("--no-first-run")
    options.add_argument("--renderer-process-limit=1")
    options.add_argument("--disable-features=MediaRouter,OptimizationHints,Translate")
    options.add_argument("--window-size=480,520")
    profile_dir = Path(tempfile.mkdtemp(prefix="browser-exact-profile-", dir=RESULTS))
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_argument("--force-device-scale-factor=1")
    lifecycle_started = time.perf_counter()
    with CacheServer(files) as server, out_path.open("a", encoding="utf-8") as output:
        phase = time.perf_counter()
        driver = webdriver.Chrome(service=Service(str(DRIVER)), options=options)
        browser_start_ms = round((time.perf_counter() - phase) * 1000)
        driver.set_window_size(480, 520)
        frame_id = driver.execute_cdp_cmd("Page.getFrameTree", {})["frameTree"]["frame"]["id"]
        pdf_text_cache = {}
        loaded_range_base = None
        work_started = time.perf_counter()
        try:
            for index, seed in enumerate(pending, 1):
                started = time.time()
                timings = {}
                target = seed.get("target")
                base, _, fragment = target.partition("#")
                replay_id = hashlib.sha1(seed["label"].encode()).hexdigest()[:12]
                row = manifest.get(url_key(base))
                if not row:
                    result = {"label": seed["label"], "verdict": "cache-miss", "target": target}
                elif PDF_RE.search(base) or row["file"].lower().endswith(".pdf"):
                    file = CACHE / row["file"]
                    try:
                        phase = time.perf_counter()
                        proof = pdf_proof(file, seed, pdf_text_cache)
                        add_timing(timings, "pdfProofMs", phase)
                        if proof["status"] not in ("pdf-location-exact", "pdf-location-safe-core"):
                            result = {"label": seed["label"], "verdict": proof["status"], "target": target, "cacheFile": row["file"], "proof": proof}
                        else:
                            local = f"{server.origin}/page/{quote(row['file'])}?seed={replay_id}" + (f"#{fragment}" if fragment else "")
                            phase = time.perf_counter()
                            driver.get(local)
                            add_timing(timings, "navigationMs", phase)
                            # PDFium is asynchronous. Poll for paint instead of
                            # imposing the old fixed serial delay; independent
                            # browser processes keep every PDF tab active.
                            pixels = 0
                            bounds = None
                            image = None
                            polls = 0
                            deadline = time.time() + 4.0
                            while time.time() < deadline and pixels < 25:
                                phase = time.perf_counter()
                                time.sleep(0.08)
                                add_timing(timings, "pollSleepMs", phase)
                                phase = time.perf_counter()
                                png = driver.get_screenshot_as_png()
                                add_timing(timings, "screenshotMs", phase)
                                phase = time.perf_counter()
                                pixels, bounds, image = screenshot_highlight(png)
                                add_timing(timings, "pixelAnalysisMs", phase)
                                polls += 1
                            timings["polls"] = polls
                            if pixels < 25:
                                result = {"label": seed["label"], "verdict": "pdf-no-paint", "target": target, "cacheFile": row["file"], "proof": proof, "highlightPixels": pixels}
                            else:
                                result = {
                                    "label": seed["label"],
                                    "verdict": "exact-match" if proof["status"] == "pdf-location-exact" else "safe-core-match",
                                    "target": target, "cacheFile": row["file"], "proof": proof,
                                    "highlightPixels": pixels, "highlightBounds": bounds,
                                    "screenshotSha256": hashlib.sha256(png).hexdigest(),
                                }
                                if args.save_shots:
                                    phase = time.perf_counter()
                                    shot_name = safe_name(seed["label"], 0)
                                    shot_path = SHOTS / shot_name
                                    x0, y0, x1, y1 = bounds
                                    image.crop((max(0, x0 - 12), max(0, y0 - 12), min(image.width, x1 + 13), min(image.height, y1 + 13))).save(shot_path, compress_level=1, optimize=False)
                                    result["screenshot"] = shot_name
                                    add_timing(timings, "artifactWriteMs", phase)
                    except Exception as exc:
                        result = {"label": seed["label"], "verdict": "error", "target": target, "cacheFile": row["file"], "error": str(exc)[:300]}
                else:
                    local_base = f"{server.origin}/page/{quote(row['file'])}"
                    local = f"{local_base}?seed={replay_id}" + (f"#{fragment}" if fragment else "")
                    try:
                        if args.range_only:
                            phase = time.perf_counter()
                            if loaded_range_base != base:
                                html = (CACHE / row["file"]).read_text(encoding="utf-8")
                                csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
                                html, replacements = re.subn(r"(?i)(<head\b[^>]*>)", r"\1" + csp, html, count=1)
                                if not replacements:
                                    html = csp + html
                                driver.execute_cdp_cmd("Page.setDocumentContent", {"frameId": frame_id, "html": html})
                                BROWSER_TEXT_CACHE.mkdir(exist_ok=True)
                                rendered_text_file = BROWSER_TEXT_CACHE / f"{Path(row['file']).stem}.txt"
                                if not rendered_text_file.exists():
                                    rendered_text_file.write_text(driver.execute_script("return document.body.innerText"), encoding="utf-8")
                                loaded_range_base = base
                            add_timing(timings, "navigationMs", phase)
                            phase = time.perf_counter()
                            probe = driver.execute_script(RANGE_BATCH_SCRIPT, seed.get("quotes") or [], seed.get("blockText", ""), seed.get("anchor", ""), target)
                            add_timing(timings, "rangeProbeMs", phase)
                            quote_proofs = probe["quotes"]
                            find_ranges = probe["ranges"]
                            result = {
                                "label": seed["label"], "verdict": range_probe_verdict(quote_proofs, find_ranges),
                                "target": target, "cacheFile": row["file"], "quotes": quote_proofs, "findRanges": find_ranges,
                            }
                            raise StopIteration
                        result, paint_timings = html_paint_proof(
                            driver, local, seed, row["file"], args.save_shots, args.mine_oracle,
                        )
                        for name, value in paint_timings.items():
                            timings[name] = round(timings.get(name, 0) + value, 1)
                    except StopIteration:
                        pass
                    except Exception as exc:  # retain partial corpus evidence
                        result = {"label": seed["label"], "verdict": "error", "target": target, "error": str(exc)[:300]}
                result["elapsedMs"] = round((time.time() - started) * 1000)
                result["timings"] = timings
                result["inputHash"] = fingerprints[seed["label"]]
                output.write(json.dumps(result, ensure_ascii=False) + "\n")
                output.flush()
                if index % 25 == 0 or not args.range_only and result["verdict"] != "exact-match":
                    print(json.dumps({"progress": index, "of": len(pending), "label": seed["label"], "verdict": result["verdict"]}), flush=True)
        finally:
            work_ms = round((time.perf_counter() - work_started) * 1000)
            phase = time.perf_counter()
            try:
                driver.quit()
            finally:
                shutil.rmtree(profile_dir, ignore_errors=True)
            browser_quit_ms = round((time.perf_counter() - phase) * 1000)
    print(json.dumps({"workerSummary": {"browserStartMs": browser_start_ms, "workMs": work_ms, "browserQuitMs": browser_quit_ms, "lifecycleMs": round((time.perf_counter() - lifecycle_started) * 1000)}}), flush=True)


if __name__ == "__main__":
    run()
