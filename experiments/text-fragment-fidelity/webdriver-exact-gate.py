#!/usr/bin/env python3
"""Exact cached-page text-fragment gate using real ChromeDriver.

HTML passes only when every requested quote has an unambiguous rendered DOM
range and target-text paint pixels overlap that exact range. A cropped PNG and
geometry record are preserved for every confirmed quote. Results append after
each seed, so interrupted corpus runs retain usable partial proof.
"""
from __future__ import annotations

import argparse
import base64
from bisect import bisect_left, bisect_right
import ctypes
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse, parse_qsl
from urllib.request import HTTPRedirectHandler, Request, build_opener

from PIL import Image, ImageChops, ImageDraw
import pypdfium2 as pdfium
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
import websocket

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
CACHE = RESULTS / "page-html"
LIVE_RENDERED_CACHE = RESULTS / "live-rendered-html"
PDF_TEXT_CACHE = RESULTS / "pdf-text"
BROWSER_TEXT_CACHE = RESULTS / "browser-rendered-text"
SOURCE_CONTRACT_CACHE = RESULTS / "source-contract-cache"
RANGE_PROOF_CACHE = RESULTS / "range-proof-cache"
TARGETS = RESULTS / "targets.jsonl"
DOCTEXT = RESULTS / "doctext.jsonl"
MANIFEST = RESULTS / "page-html-manifest.jsonl"
DEFAULT_OUT = RESULTS / "webdriver-exact.jsonl"
SHOTS = RESULTS / "exact-shots"
DRIVER = Path.home() / ".cache/selenium/chromedriver/win64/151.0.7922.138/chromedriver.exe"
PDF_RE = re.compile(r"(?i)(\.pdf(?:$|[?#])|/document\.do(?:$|[?#]))")
PDF_PAINT_CONTRACT = "pdf-natural-directive-geometry-v13-source-identity"
HTML_PAINT_CONTRACT = "html-exact-island-geometry-v15-source-identity"
SOURCE_CONTRACT_CACHE_VERSION = "canonical-source-contract-result-v4"
RANGE_PROOF_CACHE_VERSION = f"{HTML_PAINT_CONTRACT}:cached-range-proof-v1"
PDF_VIEWER_URL = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"
PROVEN_404_LABEL = "FCA_2026_FC_103_p20_short-exact"
PROVEN_404_URL = (
    "https://decisions.fca-caf.gc.ca/fca-caf/decisions/en/item/521765/index.do"
    "?iframe=true&site_preference=mobile"
)


def use_below_normal_priority():
    if hasattr(ctypes, "windll"):
        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.SetPriorityClass.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        kernel32.SetPriorityClass.restype = ctypes.c_int
        if not kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000):
            raise ctypes.WinError()


use_below_normal_priority()


_termination_requested = False


def install_cleanup_signal_handlers():
    """Let context-manager teardown run for every catchable termination signal."""
    def interrupt(_signal_number, _frame):
        global _termination_requested
        if _termination_requested:
            return
        _termination_requested = True
        raise KeyboardInterrupt

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        termination_signal = getattr(signal, name, None)
        if termination_signal is not None:
            signal.signal(termination_signal, interrupt)


PROFILE_OWNER_ENV = "TEXT_FRAGMENT_PROFILE_OWNER"
PROFILE_ROOT = Path(tempfile.gettempdir()) / "beaver-text-fragment-chrome"


def owned_profile_prefix(prefix: str):
    owner = re.sub(r"[^A-Za-z0-9_.-]+", "-", os.environ.get(PROFILE_OWNER_ENV, "")).strip("-.")
    return f"{prefix}{owner}-" if owner else prefix


def remove_profile_dir(profile_dir: Path):
    for attempt in range(6):
        try:
            shutil.rmtree(profile_dir)
        except FileNotFoundError:
            return
        except OSError:
            if attempt == 5:
                raise
            time.sleep(0.1 * (attempt + 1))
        else:
            if not profile_dir.exists():
                return
            time.sleep(0.1 * (attempt + 1))
    if profile_dir.exists():
        raise RuntimeError(f"owned Chrome profile survived cleanup: {profile_dir}")


def cleanup_owned_profile(profile_dir: Path):
    """Remove an owned profile after the owning process/job has been stopped."""
    errors = []
    try:
        remove_profile_dir(profile_dir)
    except Exception as exc:
        errors.append(exc)
    return errors


@contextmanager
def owned_chrome_profile(prefix: str):
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile_dir = Path(tempfile.mkdtemp(prefix=owned_profile_prefix(prefix), dir=PROFILE_ROOT))
    try:
        yield profile_dir
    finally:
        errors = cleanup_owned_profile(profile_dir)
        if errors:
            print(json.dumps({
                "event": "profile-cleanup-warning", "profile": str(profile_dir),
                "errors": [str(error)[:200] for error in errors],
            }), flush=True)


def stop_process_tree(process):
    if process is None or process.poll() is not None:
        return
    warnings = []
    if hasattr(ctypes, "windll"):
        try:
            killed = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS,
            )
            if killed.returncode:
                warnings.append(RuntimeError(f"taskkill returned {killed.returncode}"))
        except OSError as exc:
            warnings.append(exc)
    else:
        try:
            process.terminate()
        except OSError as exc:
            warnings.append(exc)
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            process.terminate()
        except OSError as exc:
            warnings.append(exc)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except OSError as exc:
                warnings.append(exc)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired as final_exc:
                raise RuntimeError(f"owned process {process.pid} survived cleanup") from final_exc
    if warnings:
        print(json.dumps({
            "event": "owned-process-cleanup-warning", "pid": process.pid,
            "errors": [str(error)[:200] for error in warnings],
        }), flush=True)


class PdfOopifTargetUnavailable(RuntimeError):
    pass


def debugger_version(debugger_address: str):
    parsed = urlparse(f"//{debugger_address}")
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError(f"Chrome debugger is not loopback: {debugger_address}")
    request = Request(f"http://{debugger_address}/json/version", headers={"Accept": "application/json"})
    with build_opener().open(request, timeout=5) as response:
        return json.loads(response.read())


class PdfOopifCdp:
    """Evaluate PDF-viewer API calls in Chrome's extension OOPIF main world."""

    def __init__(self, driver, *, version_loader=debugger_version,
                 websocket_factory=websocket.create_connection):
        chrome_options = driver.capabilities.get("goog:chromeOptions") or {}
        self.debugger_address = chrome_options.get("debuggerAddress")
        if not self.debugger_address:
            raise RuntimeError("ChromeDriver did not expose a debugger address")
        self.version_loader = version_loader
        self.websocket_factory = websocket_factory
        self.socket = None
        self.next_id = 0
        self.target_id = None
        self.session_id = None
        self.closed = False

    def _disconnect(self):
        connection, self.socket = self.socket, None
        self.target_id = None
        self.session_id = None
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass

    def close(self):
        self.closed = True
        self._disconnect()

    def _connect(self):
        if self.closed:
            raise RuntimeError("PDF OOPIF CDP bridge is closed")
        if self.socket is not None:
            return
        version = self.version_loader(self.debugger_address)
        websocket_url = version.get("webSocketDebuggerUrl", "")
        parsed = urlparse(websocket_url)
        if parsed.scheme not in {"ws", "wss"} or parsed.hostname not in {
                "localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("Chrome did not expose a loopback browser WebSocket")
        self.socket = self.websocket_factory(
            websocket_url, timeout=5, suppress_origin=True,
        )

    def _request_once(self, method: str, params: dict | None = None, *, session_id=None):
        self._connect()
        self.next_id += 1
        request_id = self.next_id
        message = {"id": request_id, "method": method, "params": params or {}}
        if session_id:
            message["sessionId"] = session_id
        self.socket.send(json.dumps(message, separators=(",", ":")))
        while True:
            response = json.loads(self.socket.recv())
            # Browser-level events and unrelated responses may be interleaved.
            if response.get("id") != request_id:
                continue
            if response.get("error"):
                error = response["error"]
                raise RuntimeError(
                    f"CDP {method} failed: {error.get('message', error)}"
                )
            return response.get("result") or {}

    def _browser_request(self, method: str, params: dict | None = None):
        try:
            return self._request_once(method, params)
        except Exception:
            self._disconnect()
            return self._request_once(method, params)

    @staticmethod
    def select_target(target_infos: list[dict]):
        matches = [
            target for target in target_infos
            if target.get("type") == "iframe" and
            target.get("url", "").split("?", 1)[0].split("#", 1)[0] == PDF_VIEWER_URL
        ]
        if len(matches) != 1:
            raise PdfOopifTargetUnavailable(
                f"expected one PDF extension iframe target, found {len(matches)}"
            )
        return matches[0]

    def _viewer_session(self):
        targets = self._browser_request("Target.getTargets").get("targetInfos") or []
        target = self.select_target(targets)
        target_id = target.get("targetId")
        if target_id == self.target_id and self.session_id:
            return self.session_id
        attached = self._browser_request("Target.attachToTarget", {
            "targetId": target_id, "flatten": True,
        })
        session_id = attached.get("sessionId")
        if not session_id:
            raise RuntimeError("Chrome did not return a PDF OOPIF session")
        self.target_id = target_id
        self.session_id = session_id
        return session_id

    def evaluate(self, script: str, *arguments):
        expression = (
            "(async function(){\n" + script + "\n}).apply(null," +
            json.dumps(arguments, ensure_ascii=False, separators=(",", ":")) + ")"
        )
        last_error = None
        for attempt in range(2):
            try:
                session_id = self._viewer_session()
                evaluated = self._request_once("Runtime.evaluate", {
                    "expression": expression,
                    "awaitPromise": True,
                    "returnByValue": True,
                }, session_id=session_id)
                if evaluated.get("exceptionDetails"):
                    raise RuntimeError(
                        "PDF viewer evaluation failed: " +
                        str(evaluated["exceptionDetails"].get("text", "JavaScript exception"))
                    )
                return (evaluated.get("result") or {}).get("value")
            except PdfOopifTargetUnavailable:
                raise
            except Exception as exc:
                last_error = exc
                self._disconnect()
                if attempt:
                    raise
        raise last_error


@contextmanager
def chrome_session(options):
    service = Service(str(DRIVER))
    driver = None
    pdf_oopif = None
    timings = {}
    try:
        phase = time.perf_counter()
        driver = webdriver.Chrome(service=service, options=options)
        pdf_oopif = PdfOopifCdp(driver)
        timings["browserStartMs"] = round((time.perf_counter() - phase) * 1000)
        yield driver, timings, pdf_oopif
    finally:
        phase = time.perf_counter()
        warnings = []
        if pdf_oopif is not None:
            try:
                pdf_oopif.close()
            except Exception as exc:
                warnings.append(exc)
        if driver is not None:
            try:
                driver.quit()
            except Exception as exc:
                warnings.append(exc)
        process = service.process
        try:
            service.stop()
        except Exception as exc:
            warnings.append(exc)
        if process is not None and process.poll() is None:
            stop_process_tree(process)
        if process is not None and process.poll() is None:
            raise RuntimeError(f"owned ChromeDriver {process.pid} survived cleanup")
        if warnings:
            print(json.dumps({
                "event": "browser-cleanup-warning",
                "errors": [str(error)[:200] for error in warnings],
            }), flush=True)
        timings["browserQuitMs"] = round((time.perf_counter() - phase) * 1000)


def read_jsonl(path: Path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def discard_incomplete_jsonl_tail(path: Path):
    """Drop a worker record interrupted before its terminating newline."""
    if not path.exists() or not path.stat().st_size:
        return
    with path.open("rb+") as output:
        output.seek(-1, 2)
        if output.read(1) in (b"\n", b"\r"):
            return
        output.seek(0)
        body = output.read()
        output.seek(body.rfind(b"\n") + 1)
        output.truncate()


def compact_reusable_jsonl(path: Path, fingerprints: dict, reusable_row):
    """Atomically retain one current, accepted row per label on resume."""
    discard_incomplete_jsonl_tail(path)
    kept = {}
    for row in read_jsonl(path):
        label = row.get("label")
        if label in fingerprints and row.get("inputHash") == fingerprints[label] and \
                reusable_row(row):
            kept[label] = row
    body = "".join(
        json.dumps(row, ensure_ascii=False) + "\n"
        for row in kept.values()
    ).encode("utf-8")
    atomically_replace(path, body)
    return kept


BROWSER_CRASH_MARKERS = (
    "tab crashed", "page crash", "invalid session id", "session deleted",
    "no such window", "chrome not reachable", "disconnected",
    "not connected to devtools", "target frame detached",
)


def browser_session_failed(driver, error):
    """Distinguish a dead browser from a seed-level verification error."""
    if any(marker in str(error).lower() for marker in BROWSER_CRASH_MARKERS):
        return True
    try:
        _ = driver.current_url
    except Exception:
        return True
    return False


def add_timing(timings: dict, name: str, started: float):
    timings[name] = round(timings.get(name, 0) + (time.perf_counter() - started) * 1000, 1)


def range_probe_verdict(quote_proofs: list[dict], ranges: list[dict]):
    expected = [tuple(interval) for proof in quote_proofs for interval in (
        proof.get("wordIslands") or [(proof.get("wordStart"), proof.get("wordEnd"))]
    )]
    if any(start is None or end is None for start, end in expected):
        return "intended-not-located"
    matched = [candidate for candidate in ranges if candidate.get("status") == "matched"]
    if not matched:
        return "range-unresolved"
    spans = [(candidate["wordStart"], candidate["wordEnd"]) for candidate in matched]
    if any(not any(wanted_start <= start and end <= wanted_end
                   for wanted_start, wanted_end in expected) for start, end in spans):
        return "range-stray"
    for wanted_start, wanted_end in expected:
        cursor = wanted_start
        for start, end in sorted((span for span in spans
                                  if wanted_start <= span[0] and span[1] <= wanted_end)):
            if end <= cursor:
                continue
            if start > cursor:
                break
            cursor = max(cursor, end)
        if cursor < wanted_end:
            return "range-partial"
    return "range-exact"


def one_to_one_range_verdict(quote_proofs: list[dict], ranges: list[dict]):
    if len(quote_proofs) != len(ranges):
        return "range-cardinality-mismatch"
    for proof, selected in zip(quote_proofs, ranges):
        if proof.get("status") != "located":
            return proof.get("status", "intended-not-located")
        if selected.get("status") != "matched":
            return selected.get("status", "range-unresolved")
        if (selected.get("wordStart"), selected.get("wordEnd")) != \
                (proof.get("wordStart"), proof.get("wordEnd")):
            return "range-source-interval-mismatch"
    return "range-exact"


def lexically_exact_edge_paint(quote_proofs: list[dict]):
    """Accept edge punctuation only for one located, gap-free lexical island."""
    return bool(quote_proofs) and all(
        proof.get("status") in {"located", "paint-extraneous"}
        and proof.get("insertedWords") == 0
        and len(proof.get("wordIslands") or []) == 1
        for proof in quote_proofs
    )


def _fold_space(value: str) -> str:
    return re.sub(r"[\s\u00a0\u202f\u2007\u2009\u200b]+", " ", value.lower()).strip()


def _fold_words(value: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", value.lower(), re.UNICODE))


def _starts(text: str, query: str, start: int = 0):
    found = []
    at = text.find(query, start)
    while at >= 0:
        found.append(at)
        at = text.find(query, at + 1)
    return found


WORD_SENTINEL = "\0"


def document_word_index(page: str, words: list):
    words = [tuple(word) for word in words]
    values = [word for word, _, _ in words]
    joined_offsets = []
    joined_at = 0
    for value in values:
        joined_offsets.append(joined_at)
        joined_at += len(value) + 1
    positions = {}
    for word_index, value in enumerate(values):
        positions.setdefault(value, []).append(word_index)
    return {
        "page": page,
        "flat": [(word, 0, start, end) for word, start, end in words],
        "values": values,
        "joinedWords": WORD_SENTINEL.join(values),
        "joinedOffsets": joined_offsets,
        "positions": positions,
        "wordStarts": [start for _, start, _ in words],
        "wordEnds": [end for _, _, end in words],
    }


def rendered_document_index(rendered: str):
    page = search_normalized(rendered)
    return document_word_index(page, word_spans(page))


def cached_text_range_proof(rendered: str | dict, seed: dict):
    index = rendered if isinstance(rendered, dict) else rendered_document_index(rendered)
    page = index["page"]
    proofs = []
    block = _fold_words(seed.get("blockText", ""))
    identities = seed.get("_sourceIdentities") or []
    for quote_index, raw in enumerate(seed.get("paintQuotes") or seed.get("quotes") or []):
        wanted = _fold_words(raw)
        islands = quote_islands(
            [page], seed.get("blockText", ""), raw,
            source_identity=identities[quote_index] if quote_index < len(identities) else None,
            document_index=index,
        ) if wanted else None
        if not islands:
            proofs.append({"status": "quote-not-rendered", "occurrences": 0})
            continue
        word_islands = []
        for _page, start, end in islands:
            word_start = bisect_right(index["wordEnds"], start)
            word_end = bisect_left(index["wordStarts"], end)
            word_islands.append((word_start, word_end))
        proofs.append({
            "status": "located", "occurrences": 1,
            "wordStart": word_islands[0][0], "wordEnd": word_islands[-1][1],
            "wordIslands": word_islands,
            "contained": bool(block and wanted in block),
        })

    target = seed.get("target", "")
    fragment = urlparse(target).fragment
    payload = fragment.split(":~:", 1)[1] if ":~:" in fragment else fragment
    ranges = []
    for encoded in (part[5:] for part in payload.split("&") if part.startswith("text=")):
        matches = directive_matches([page], encoded)
        if not matches:
            ranges.append({"raw": encoded, "status": "unmatched"})
            continue
        _, start_at, end_at = matches[0]
        word_start = bisect_right(index["wordEnds"], start_at)
        word_end = bisect_left(index["wordStarts"], end_at)
        ranges.append({"raw": encoded, "status": "matched", "candidateCount": len(matches),
                       "wordStart": word_start, "wordEnd": word_end})
    return proofs, ranges


def url_key(raw: str) -> str:
    parsed = urlparse(raw)
    query = "&".join(f"{k}={v}" for k, v in sorted(parse_qsl(parsed.query, keep_blank_values=True)))
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{query}".lower()


def is_proven_404_seed(seed: dict):
    return seed.get("label") == PROVEN_404_LABEL and \
        url_key(seed.get("target", "").split("#", 1)[0]) == url_key(PROVEN_404_URL)


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

        class QuietThreadingHTTPServer(ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, _request, _client_address):
                error = sys.exception()
                if isinstance(error, (ConnectionAbortedError, ConnectionResetError)):
                    return
                super().handle_error(_request, _client_address)

        self.httpd = QuietThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.httpd.shutdown()
        self.thread.join()
        self.httpd.server_close()

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.httpd.server_port}"


LOCATE_SCRIPT = r"""
const quote = arguments[0];
const block = arguments[1];
const anchor = arguments[2];
const shared = arguments[3] ?? {};
const measure = arguments[4] ?? false;
const sourceIdentity = arguments[5] ?? {};
const norm = (s) => (s ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const fold = (s) => (s ?? "").toLocaleLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "");
let index = shared.locateIndex;
if (!index && globalThis.__beaverLocateIndex?.body === document.body) {
  index = globalThis.__beaverLocateIndex;
}
if (!index) {
  // Build one sparse linear index. The old implementation repeatedly grew a
  // multi-megabyte string and allocated one DOM-point object per character;
  // that made large statute pages quadratic and could time out the renderer.
  // One object per source word is sufficient because every accepted fragment
  // and expected passage is word-bounded.
  const rawChunks = [];
  const segments = [];
  let rawLength = 0;
  let previousBlock = null;
  let previousNode = null;
  let previousValue = "";
  const blockOf = (n) => n.parentElement?.closest("address,article,aside,blockquote,dd,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,tbody,td,tfoot,th,thead,tr,ul") ?? document.body;
  const characterRect = (n, start, end) => {
    const range = document.createRange();
    range.setStart(n, start);
    range.setEnd(n, end);
    return [...range.getClientRects()].find((rect) => rect.width && rect.height) ?? null;
  };
  const visuallySeparated = (leftNode, leftValue, rightNode, rightValue) => {
    if (!leftNode || leftNode.parentElement === rightNode.parentElement ||
        !/[\p{L}\p{N}]$/u.test(leftValue) || !/^[\p{L}\p{N}]/u.test(rightValue)) return false;
    const left = characterRect(leftNode, leftValue.length - 1, leftValue.length);
    const right = characterRect(rightNode, 0, 1);
    if (!left || !right) return false;
    const verticalOverlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
    const horizontalGap = Math.max(right.left - left.right, left.left - right.right);
    return verticalOverlap < Math.min(left.height, right.height) * 0.5 || horizontalGap > 0.5;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,noscript,template")) continue;
    const currentBlock = blockOf(node);
    const value = node.textContent ?? "";
    if (previousBlock && (currentBlock !== previousBlock ||
        visuallySeparated(previousNode, previousValue, node, value))) {
      rawChunks.push(" ");
      rawLength += 1;
    }
    if (value) {
      segments.push({start: rawLength, end: rawLength + value.length, n: node});
      rawChunks.push(value);
      rawLength += value.length;
    }
    previousBlock = currentBlock;
    previousNode = node;
    previousValue = value;
  }
  const raw = rawChunks.join("");
  const pointAt = (rawOffset) => {
    let low = 0, high = segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (segments[middle].end <= rawOffset) low = middle + 1;
      else high = middle;
    }
    const segment = segments[low];
    if (!segment || rawOffset < segment.start) return null;
    return {n: segment.n, o: rawOffset - segment.start};
  };
  const textChunks = [];
  const wordSpans = [];
  let normalizedLength = 0;
  for (const match of raw.matchAll(/[\p{L}\p{N}]+/gu)) {
    const value = match[0].toLocaleLowerCase();
    if (textChunks.length) {
      textChunks.push(" ");
      normalizedLength += 1;
    }
    const first = pointAt(match.index);
    const last = pointAt(match.index + match[0].length - 1);
    if (!first || !last) continue;
    const start = normalizedLength;
    textChunks.push(value);
    normalizedLength += value.length;
    wordSpans.push({start, end: normalizedLength, first, last: {n:last.n, o:last.o + 1}, value:fold(match[0])});
  }
  index = {body: document.body, text: textChunks.join(""), wordSpans};
  shared.locateIndex = index;
  globalThis.__beaverLocateIndex = index;
}
const {text, wordSpans} = index;
const wanted = norm(quote);
const wantedBlock = norm(block);
if (!wanted) return { status: "empty-quote" };
const wantedValues = ((quote ?? "").match(/[\p{L}\p{N}]+/gu) ?? []).map(fold);
const sourceValues = ((block ?? "").match(/[\p{L}\p{N}]+/gu) ?? []).map(fold);
const occurrencesOf = (query) => {
  const found = [];
  for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + 1)) {
    const end = at + query.length;
    if ((at === 0 || text[at - 1] === " ") &&
        (end === text.length || text[end] === " ")) found.push(at);
  }
  return found;
};
const exactOccurrences = occurrencesOf(wanted);
const blockStarts = wantedBlock ? occurrencesOf(wantedBlock) : [];
const wordAt = (offset) => {
  let low = 0, high = wordSpans.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (wordSpans[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
};
const anchorEl = anchor ? (document.getElementById(anchor) || document.querySelector(`[name="${CSS.escape(anchor)}"]`)) : null;
const anchorWord = anchorEl ? wordSpans.find((span) =>
  anchorEl.contains(span.first.n.parentElement) || anchorEl.contains(span.last.n.parentElement)) : null;
const anchorOffset = anchorWord?.start ?? -1;
const alignEdge = (wanted, available) => {
  let exact = 0;
  while (exact < wanted.length && exact < available.length && wanted[exact] === available[exact]) exact += 1;
  let matched = 0, cursor = 0, inserted = 0;
  for (const value of wanted) {
    const found = available.indexOf(value, cursor);
    if (found < 0) continue;
    inserted += found - cursor;
    matched += 1;
    cursor = found + 1;
  }
  return {exact, matched, inserted};
};
const candidates = exactOccurrences.map((start) => {
  const first = wordAt(start);
  return Array.from({length: wantedValues.length}, (_, offset) => first + offset);
});
if (!candidates.length && wantedValues.length) {
  const values = wordSpans.map((item) => item.value);
  for (let first = 0; first < values.length; first += 1) {
    if (values[first] !== wantedValues[0]) continue;
    const indices = [first];
    let cursor = first + 1;
    for (const value of wantedValues.slice(1)) {
      const found = values.indexOf(value, cursor);
      if (found < 0 || found >= first + wantedValues.length + 4096) break;
      indices.push(found);
      cursor = found + 1;
    }
    if (indices.length !== wantedValues.length) continue;
    cursor = indices.at(-1);
    const tight = [cursor];
    for (const value of wantedValues.slice(0, -1).reverse()) {
      let found = cursor - 1;
      while (found >= first && values[found] !== value) found -= 1;
      if (found < first) break;
      tight.push(found);
      cursor = found;
    }
    if (tight.length === wantedValues.length) candidates.push(tight.reverse());
  }
}
if (!candidates.length) {
  // The fast index may merge visually separated text-node edges. Map source
  // words directly to DOM points, then require one exact, visible Range.
  const nodeWords = [];
  const nodeWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = nodeWalker.nextNode())) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest("script,style,noscript,template")) continue;
    for (const match of (textNode.textContent ?? "").matchAll(/[\p{L}\p{N}]+/gu)) {
      nodeWords.push({value:fold(match[0]), node:textNode,
        start:match.index, end:match.index + match[0].length});
    }
  }
  const mapped = [];
  for (let at = 0; at + wantedValues.length <= nodeWords.length; at += 1) {
    if (!wantedValues.every((value, offset) => nodeWords[at + offset].value === value)) continue;
    const first = nodeWords[at];
    const last = nodeWords[at + wantedValues.length - 1];
    const range = document.createRange();
    range.setStart(first.node, first.start);
    range.setEnd(last.node, last.end);
    if (norm(range.toString()) !== wanted) continue;
    const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
    if (rects.length) mapped.push({at, rects});
  }
  if (mapped.length === 1) {
    const {at:firstWord, rects} = mapped[0];
    const lastWord = firstWord + wantedValues.length - 1;
    return {status:"located", occurrences:1, contained:true, contextExact:0,
      contextMatched:0, contextInserted:0, insertedWords:0, anchorDistance:null,
      normalizedOffset:null, normalizedEnd:null, wordStart:firstWord, wordEnd:lastWord + 1,
      wordIslands:[[firstWord, lastWord]],
      documentTop:rects[0]?.top + window.scrollY,
      documentRects:rects.map((rect) => ({x:rect.x+window.scrollX,y:rect.y+window.scrollY,width:rect.width,height:rect.height})),
      scrollY:window.scrollY, innerHeight:window.innerHeight, locator:"exact-visible-dom-range"};
  }
  return { status: "quote-not-rendered", wanted };
}
const distinctCandidates = [...new Map(candidates.map((indices) => [indices.join(","), indices])).values()];
const sourceStarts = [];
for (let at = 0; at + wantedValues.length <= sourceValues.length; at += 1) {
  if (wantedValues.every((value, offset) => sourceValues[at + offset] === value)) sourceStarts.push(at);
}
let wantedBefore = (sourceIdentity.before ?? []).slice().reverse();
let wantedAfter = sourceIdentity.after ?? [];
if (sourceStarts.length === 1) {
  const at = sourceStarts[0];
  wantedBefore = sourceValues.slice(Math.max(0, at - 96), at).reverse();
  wantedAfter = sourceValues.slice(at + wantedValues.length, at + wantedValues.length + 96);
}
const scored = distinctCandidates.map((indices) => {
  const firstWord = indices[0];
  const lastWord = indices.at(-1);
  const start = wordSpans[firstWord].start;
  const end = wordSpans[lastWord].end;
  const islands = [];
  let islandFirst = firstWord;
  let islandLast = firstWord;
  for (const index of indices.slice(1)) {
    if (index === islandLast + 1) {
      islandLast = index;
    } else {
      islands.push([islandFirst, islandLast]);
      islandFirst = islandLast = index;
    }
  }
  islands.push([islandFirst, islandLast]);
  let geometry = null;
  if (measure) {
    const rects = islands.flatMap(([firstIndex, lastIndex]) => {
      const first = wordSpans[firstIndex]?.first;
      const last = wordSpans[lastIndex]?.last;
      if (!first || !last) return [];
      const range = document.createRange();
      range.setStart(first.n, Math.min(first.o, first.n.length));
      range.setEnd(last.n, Math.min(last.n.length, last.o));
      return [...range.getClientRects()].filter((rect) => rect.width && rect.height);
    });
    if (!rects.length) return null;
    geometry = {
      top: rects[0].top + window.scrollY,
      rects: rects.map((rect) => ({x:rect.x+window.scrollX,y:rect.y+window.scrollY,width:rect.width,height:rect.height})),
    };
  }
  const contained = blockStarts.some((b) => b <= start && end <= b + wantedBlock.length);
  const anchorDistance = anchorOffset < 0 ? null : Math.abs(start - anchorOffset);
  const before = wordSpans.slice(Math.max(0, firstWord - 96), firstWord).map((item) => item.value).reverse();
  const after = wordSpans.slice(lastWord + 1, lastWord + 97).map((item) => item.value);
  const left = alignEdge(wantedBefore, before);
  const right = alignEdge(wantedAfter, after);
  return { start, end, firstWord, lastWord, islands,
    inserted:lastWord - firstWord + 1 - indices.length,
    contained, contextExact:left.exact + right.exact,
    contextMatched:left.matched + right.matched, contextInserted:left.inserted + right.inserted,
    anchorDistance, geometry };
}).filter(Boolean);
scored.sort((a, b) => b.contextExact - a.contextExact || b.contextMatched - a.contextMatched ||
  a.contextInserted - b.contextInserted || a.inserted - b.inserted ||
  Number(b.contained) - Number(a.contained) ||
  (a.anchorDistance ?? 1e15) - (b.anchorDistance ?? 1e15));
if (!scored.length) return { status: "quote-not-laid-out", occurrences: distinctCandidates.length };
const best = scored[0];
const second = scored[1];
const tied = second && best.contextExact === second.contextExact &&
  best.contextMatched === second.contextMatched && best.contextInserted === second.contextInserted &&
  best.inserted === second.inserted &&
  best.contained === second.contained &&
  best.anchorDistance === second.anchorDistance;
if (tied) return { status: "ambiguous-location", occurrences: distinctCandidates.length,
  contextExact:best.contextExact, contextMatched:best.contextMatched };
return { status: "located", occurrences: distinctCandidates.length, contained: best.contained,
  contextExact:best.contextExact, contextMatched:best.contextMatched,
  contextInserted:best.contextInserted, insertedWords:best.inserted,
  anchorDistance: best.anchorDistance, normalizedOffset: best.start, normalizedEnd: best.end,
  wordStart:best.firstWord, wordEnd:best.lastWord + 1, wordIslands:best.islands,
  documentTop: best.geometry?.top, documentRects: best.geometry?.rects ?? [],
  scrollY: window.scrollY, innerHeight: window.innerHeight };
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
const shared = arguments[1] ?? {};
const measure = arguments[2] ?? false;
const hash = target.includes('#') ? target.slice(target.indexOf('#') + 1) : '';
const marker = hash.indexOf(':~:');
const payload = marker >= 0 ? hash.slice(marker + 3) : hash;
const rawDirectives = payload.split('&').filter((part) => part.startsWith('text=')).map((part) => part.slice(5));
const clean = (value) => (value ?? '').toLocaleLowerCase().replace(/[\s\u00a0\u202f\u2007\u2009\u200b]+/gu, ' ').trim();
let text;
let map;
let wordSpans;
if (shared.directiveIndex) {
  ({text, map, wordSpans} = shared.directiveIndex);
} else {
const nodes = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
let node;
while ((node = walker.nextNode())) {
  if (!node.parentElement || node.parentElement.closest('script,style,noscript,template')) continue;
  nodes.push(node);
}
text = '';
map = measure ? [] : null;
let previousBlock = null;
const blockOf = (n) => n.parentElement?.closest('address,article,aside,blockquote,dd,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,tbody,td,tfoot,th,thead,tr,ul') ?? document.body;
const appendSpace = (n, offset) => {
  if (text && !text.endsWith(' ')) {
    text += ' ';
    if (measure) map.push({n, o:offset});
  }
};
for (const n of nodes) {
  const block = blockOf(n);
  if (previousBlock && block !== previousBlock) appendSpace(n, 0);
  const value = n.textContent ?? '';
  for (let offset = 0; offset < value.length; offset += 1) {
    const char = value[offset];
    if (/[\s\u00a0\u202f\u2007\u2009\u200b]/u.test(char)) appendSpace(n, offset);
    else {
      text += char.toLocaleLowerCase();
      if (measure) map.push({n, o:offset});
    }
  }
  previousBlock = block;
}
text = text.trimEnd();
wordSpans = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({start:match.index, end:match.index+match[0].length}));
shared.directiveIndex = {text, map, wordSpans};
}
const wordOffset = (at) => {
  let low = 0, high = wordSpans.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (wordSpans[mid].end <= at) low = mid + 1;
    else high = mid;
  }
  return low;
};
const wordEndOffset = (at) => {
  let low = 0, high = wordSpans.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (wordSpans[mid].start < at) low = mid + 1;
    else high = mid;
  }
  return low;
};
const occurrences = (query, from = 0) => {
  const found = [];
  for (let at = text.indexOf(query, from); at >= 0; at = text.indexOf(query, at + 1)) found.push(at);
  return found;
};
const snapshot = (start, end) => {
  const result = {
    startOffset: start,
    endOffset: end,
    wordStart: wordOffset(start),
    wordEnd: wordEndOffset(end),
  };
  if (!measure) return result;
  const first = map[start];
  const last = map[Math.max(start, end - 1)];
  if (!first || !last) return {...result, text:'', rectCount:0, first:null, last:null};
  const range = document.createRange();
  range.setStart(first.n, Math.min(first.o, first.n.length));
  range.setEnd(last.n, Math.min(last.n.length, last.o + 1));
  const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
  return {
    ...result,
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
  const [startRaw, endRaw = null] = pieces;
  const start = clean(startRaw);
  const end = clean(endRaw);
  prefix = clean(prefix);
  suffix = clean(suffix);
  if (!start) { results.push({raw, status:'empty-start'}); continue; }
  const starts = [];
  if (prefix) {
    for (const prefixAt of occurrences(prefix)) {
      let at = prefixAt + prefix.length;
      while (text[at] === ' ') at += 1;
      if (text.startsWith(start, at)) starts.push(at);
    }
  } else {
    starts.push(...occurrences(start));
  }
  const matches = [];
  for (const startAt of starts) {
    const startEnd = startAt + start.length;
    if (!end) {
      let suffixAt = startEnd;
      while (text[suffixAt] === ' ') suffixAt += 1;
      if (!suffix || text.startsWith(suffix, suffixAt)) matches.push([startAt, startEnd]);
      continue;
    }
    for (const endAt of occurrences(end, startEnd)) {
      const endEnd = endAt + end.length;
      let suffixAt = endEnd;
      while (text[suffixAt] === ' ') suffixAt += 1;
      if (!suffix || text.startsWith(suffix, suffixAt)) { matches.push([startAt, endEnd]); break; }
    }
  }
  if (!matches.length) { results.push({raw, status:'unmatched'}); continue; }
  results.push({raw, status:'matched', prefix, suffix, candidateCount:matches.length, ...snapshot(...matches[0])});
}
return results;
"""

RANGE_BATCH_SCRIPT = (
    "const locate = function() {" + LOCATE_SCRIPT + "};"
    "const resolve = function() {" + WINDOW_FIND_PROBE_SCRIPT + "};"
    "const shared = {};"
    "const quotes = arguments[0] ?? [];"
    "const identities = arguments[4] ?? [];"
    "const proofs = quotes.map((wanted, index) => locate(wanted, arguments[1], arguments[2], shared, true, identities[index]));"
    "return {quotes: proofs, ranges: resolve(arguments[3], shared, true)};"
)

QUOTE_BATCH_SCRIPT = (
    "const locate = function() {" + LOCATE_SCRIPT + "};"
    "const shared = {};"
    "const quotes = arguments[0] ?? [];"
    "const identities = arguments[3] ?? [];"
    "return {quotes: quotes.map((wanted, index) => "
    "locate(wanted, arguments[1], arguments[2], shared, true, identities[index]))};"
)

RANGE_PAGE_BATCH_SCRIPT = (
    "const locate = function() {" + LOCATE_SCRIPT + "};"
    "const resolve = function() {" + WINDOW_FIND_PROBE_SCRIPT + "};"
    "const shared = {};"
    "return (arguments[0] ?? []).map((input) => ({"
    "label: input.label,"
    "quotes: (input.quotes ?? []).map((wanted) => locate(wanted, input.block, input.anchor, shared)),"
    "ranges: resolve(input.target, shared)"
    "}));"
)

def channel_mask(channel, low, high):
    return channel.point([255 if low <= value <= high else 0 for value in range(256)])


def target_mask(image: Image.Image, kind: str):
    red, green, blue = image.split()
    ranges = ((0, 35), (220, 255), (0, 35)) if kind == "html" else ((220, 242), (195, 220), (242, 255))
    masks = tuple(channel_mask(channel, *limits) for channel, limits in zip((red, green, blue), ranges))
    return ImageChops.multiply(ImageChops.multiply(masks[0], masks[1]), masks[2])


def rgb_delta_mask(image: Image.Image, control: Image.Image, threshold=12):
    """Full-colour paint delta; works when PDF text tints the highlight."""
    if image.size != control.size:
        return None
    red, green, blue = ImageChops.difference(image, control).split()
    maximum = ImageChops.lighter(red, ImageChops.lighter(green, blue))
    return maximum.point([255 if value >= threshold else 0 for value in range(256)])


def mask_count(mask):
    return mask.histogram()[255]


def highlight_pixels(png: bytes, rects: list[dict], endpoint_rects: list[dict] | None = None,
                     kind="html"):
    image = Image.open(io.BytesIO(png)).convert("RGB")
    mask = target_mask(image, kind)
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


# Cached HTML is immutable and `driver.get` has already reached
# DOMContentLoaded. This still spans several layout/paint frames without
# turning every genuine miss into six seconds of idle wall time.
HTML_PAINT_RETRY_DELAYS = (0.03, 0.06, 0.12, 0.24, 0.48)
LIVE_PAINT_RETRY_DELAYS = (0.1, 0.2, 0.4, 0.8, 1.6, 3.2)


def html_initial_viewport_proof(quote_proof: dict, viewport: dict | None = None):
    rects = quote_proof.get("documentRects") or []
    viewport = viewport or quote_proof
    scroll_y = viewport.get("scrollY")
    inner_height = viewport.get("innerHeight")
    if quote_proof.get("status") != "located" or not rects or \
            not isinstance(scroll_y, (int, float)) or not isinstance(inner_height, (int, float)):
        return {"status": "initial-viewport-unresolved"}
    top = max(0, scroll_y)
    bottom = top + inner_height
    intersects = any(rect["y"] < bottom and rect["y"] + rect["height"] > top for rect in rects)
    return {
        "status": "initial-viewport-exact" if intersects else "initial-viewport-missed-passage",
        "scrollY": scroll_y, "innerHeight": inner_height,
        "topOfDocument": scroll_y <= 1, "intersectsExpectedPassage": intersects,
    }


def html_real_paint_verdict(proofs: list[dict]):
    """Only observed landing/paint geometry is an acceptance signal."""
    return next((proof["verdict"] for proof in proofs
                 if proof.get("verdict") != "exact-match"), "exact-match")


def screenshot_html_viewport(driver, timings: dict, paint_kind="html"):
    phase = time.perf_counter()
    png = driver.get_screenshot_as_png()
    add_timing(timings, "screenshotMs", phase)
    phase = time.perf_counter()
    viewport = driver.execute_script(
        "return {scrollY: window.scrollY, innerHeight: window.innerHeight}",
    )
    add_timing(timings, "viewportProbeMs", phase)
    image = Image.open(io.BytesIO(png)).convert("RGB")
    return png, viewport, mask_count(target_mask(image, paint_kind))


def initial_html_target_proof(driver, quotes: list[str], seed: dict, timings: dict,
                              retry_delays=HTML_PAINT_RETRY_DELAYS, paint_kind="html"):
    """Yield to async matching and prove landing before any manual scroll."""
    captures = []
    waited = 0.0
    delay_index = 0

    def capture():
        png, viewport, total = screenshot_html_viewport(driver, timings, paint_kind)
        captures.append((png, viewport, total, len(captures) + 1, round(waited * 1000)))

    capture()
    while captures[-1][2] < 10 and delay_index < len(retry_delays):
        delay = retry_delays[delay_index]
        delay_index += 1
        time.sleep(delay)
        waited += delay
        capture()

    phase = time.perf_counter()
    probe = driver.execute_script(
        QUOTE_BATCH_SCRIPT, quotes, seed.get("blockText", ""),
        seed.get("anchor", ""), seed.get("_sourceIdentities") or [],
    )
    add_timing(timings, "paintPrepMs", phase)
    first = (probe.get("quotes") or [{}])[0]

    def assess(captured):
        png, viewport, _total, attempts, wait_ms = captured
        landing = html_initial_viewport_proof(first, viewport)
        rects = [{**rect, "y": rect["y"] - viewport.get("scrollY", 0)}
                 for rect in first.get("documentRects", [])]
        inside, total, endpoints, image = highlight_pixels(
            png, rects, rects, paint_kind,
        )
        landing.update({
            "attempts": attempts, "waitMs": wait_ms,
            "insideHighlightPixels": inside,
            "endpointHighlightPixels": endpoints,
            "outsideHighlightPixels": max(0, total - inside),
            "captureHighlightPixels": total,
            "rects": rects,
            "screenshotSize": [image.width, image.height],
            "screenshotSha256": hashlib.sha256(png).hexdigest(),
        })
        if landing["status"] == "initial-viewport-exact" and inside < 10:
            landing["status"] = "initial-paint-missed-expected-passage"
        return landing, image

    assessed = [assess(captured) for captured in captures]
    successful = next((item for item in assessed
                       if item[0]["status"] == "initial-viewport-exact"), None)
    while successful is None and delay_index < len(retry_delays):
        delay = retry_delays[delay_index]
        delay_index += 1
        time.sleep(delay)
        waited += delay
        capture()
        assessed.append(assess(captures[-1]))
        if assessed[-1][0]["status"] == "initial-viewport-exact":
            successful = assessed[-1]
    landing, image = successful or assessed[-1]
    timings["initialPaintWaitMs"] = round(
        timings.get("initialPaintWaitMs", 0) + landing["waitMs"], 1,
    )
    return probe, landing, image


def capture_html_highlight(driver, union_rects: list[dict], endpoint_rects: list[dict],
                           timings: dict, retry_delays=HTML_PAINT_RETRY_DELAYS,
                           paint_kind="html"):
    waited = 0.0
    last = None
    for attempt in range(len(retry_delays) + 1):
        if attempt:
            delay = retry_delays[attempt - 1]
            time.sleep(delay)
            waited += delay
        phase = time.perf_counter()
        png = driver.get_screenshot_as_png()
        add_timing(timings, "screenshotMs", phase)
        phase = time.perf_counter()
        inside, total, endpoints, image = highlight_pixels(
            png, union_rects, endpoint_rects, paint_kind,
        )
        add_timing(timings, "pixelAnalysisMs", phase)
        last = (png, image, inside, total, endpoints, attempt + 1)
        outside = max(0, total - inside)
        if inside >= 25 and min(endpoints) >= 10 and outside <= max(25, inside * 0.05):
            break
    png, image, inside, total, endpoints, attempts = last
    wait_ms = round(waited * 1000)
    timings["paintWaitMs"] = round(timings.get("paintWaitMs", 0) + wait_ms, 1)
    return png, image, {
        "insideHighlightPixels": inside,
        "endpointHighlightPixels": endpoints,
        "outsideHighlightPixels": max(0, total - inside),
        "captureHighlightPixels": total,
        "paintAttempts": attempts,
        "paintWaitMs": wait_ms,
    }


def html_geometry_status(metrics: dict):
    inside = metrics["insideHighlightPixels"]
    endpoints = metrics["endpointHighlightPixels"]
    outside = metrics["outsideHighlightPixels"]
    if inside < 25:
        return "paint-missed-exact-range"
    if min(endpoints) < 10:
        return "paint-did-not-cover-range"
    if outside > max(25, inside * 0.05):
        return "paint-extraneous"
    return "exact-match"


def load_fresh_document(driver, target: str, proof_id: str):
    """Force a new Document without an avoidable intermediate local navigation."""
    parsed = urlparse(target)
    if parsed.hostname in {"127.0.0.1", "localhost", "::1"}:
        base, marker, fragment = target.partition("#")
        separator = "&" if "?" in base else "?"
        driver.get(f"{base}{separator}proof={quote(proof_id)}{marker}{fragment}")
        return
    driver.get("about:blank")
    driver.get(target)


def html_end_needs_own_capture(document_rects: list[dict], scroll_y: float,
                               inner_height: float):
    last = document_rects[-1]
    top = last["y"] - scroll_y
    return top < 0 or top + last["height"] > inner_height


def html_navigation_paint_proof(driver, navigation_target: str, quotes: list[str],
                                seed: dict, timings: dict,
                                shot_tag: str, save_shots: bool):
    phase = time.perf_counter()
    load_fresh_document(driver, navigation_target, shot_tag)
    add_timing(timings, "navigationMs", phase)
    paint_kind = "html" if urlparse(navigation_target).hostname in {
        "127.0.0.1", "localhost", "::1",
    } else "native"
    retry_delays = HTML_PAINT_RETRY_DELAYS if paint_kind == "html" else LIVE_PAINT_RETRY_DELAYS
    probe, initial_viewport, image = initial_html_target_proof(
        driver, quotes, seed, timings, retry_delays=retry_delays,
        paint_kind=paint_kind,
    )

    quote_proofs = probe["quotes"]
    failures = []
    for proof in quote_proofs:
        if proof.get("status") != "located":
            failures.append(proof.get("status", "location-error"))
    if initial_viewport["status"] != "initial-viewport-exact":
        failures.append(initial_viewport["status"])
    all_document_rects = [rect for proof in quote_proofs for rect in proof.get("documentRects", [])]
    for quote_index, proof in enumerate(quote_proofs):
        if proof.get("status") != "located":
            continue
        document_rects = proof["documentRects"]

        def scroll_to(document_y):
            phase = time.perf_counter()
            scroll_y = driver.execute_script(
                "window.scrollTo(0, Math.max(0, arguments[0] - innerHeight / 2)); return scrollY",
                document_y,
            )
            add_timing(timings, "scrollMs", phase)
            return scroll_y

        def capture(position, scroll_y, endpoint):
            nonlocal image
            rects = [{**rect, "y": rect["y"] - scroll_y} for rect in document_rects]
            union_rects = [{**rect, "y": rect["y"] - scroll_y}
                           for rect in all_document_rects]
            endpoint_rects = rects if endpoint == "both" else \
                [rects[0] if endpoint == "start" else rects[-1]]
            png, image, metrics = capture_html_highlight(
                driver, union_rects, endpoint_rects, timings,
                retry_delays=retry_delays, paint_kind=paint_kind,
            )
            status = html_geometry_status(metrics)
            capture_proof = {
                "position": position, "endpoint": endpoint,
                "verifiedScrollY": scroll_y, "rects": rects, **metrics,
                "screenshotSize": [image.width, image.height],
                "screenshotSha256": hashlib.sha256(png).hexdigest(),
                "status": status,
            }
            if save_shots:
                phase = time.perf_counter()
                shot_name = safe_name(
                    f"{seed['label']}-{shot_tag}-{position}", quote_index,
                )
                image.save(SHOTS / shot_name, compress_level=1, optimize=False)
                capture_proof["screenshot"] = shot_name
                add_timing(timings, "artifactWriteMs", phase)
            return capture_proof

        initial_metrics = {
            name: initial_viewport.get(name, 0 if name != "endpointHighlightPixels" else [0, 0])
            for name in (
                "insideHighlightPixels", "endpointHighlightPixels",
                "outsideHighlightPixels", "captureHighlightPixels",
            )
        }
        reuse_initial = len(quote_proofs) == 1 and \
            initial_viewport.get("status") == "initial-viewport-exact" and \
            not html_end_needs_own_capture(
                document_rects, initial_viewport["scrollY"], proof["innerHeight"],
            ) and html_geometry_status(initial_metrics) == "exact-match"
        if reuse_initial:
            paint_captures = [{
                "position": "initial", "endpoint": "both",
                "verifiedScrollY": initial_viewport["scrollY"],
                "rects": initial_viewport["rects"],
                **initial_metrics,
                "paintAttempts": initial_viewport["attempts"],
                "paintWaitMs": initial_viewport["waitMs"],
                "screenshotSize": initial_viewport["screenshotSize"],
                "screenshotSha256": initial_viewport["screenshotSha256"],
                "status": "exact-match",
            }]
            endpoint_pixels = initial_viewport["endpointHighlightPixels"]
        else:
            start_scroll = scroll_to(document_rects[0]["y"])
            separate_end = html_end_needs_own_capture(
                document_rects, start_scroll, proof["innerHeight"],
            )
            start_capture = capture(
                "start", start_scroll, "start" if separate_end else "both",
            )
            if separate_end:
                paint_captures = [
                    start_capture,
                    capture("end", scroll_to(document_rects[-1]["y"]), "end"),
                ]
                endpoint_pixels = [
                    paint_captures[0]["endpointHighlightPixels"][0],
                    paint_captures[1]["endpointHighlightPixels"][-1],
                ]
            else:
                paint_captures = [start_capture]
                endpoint_pixels = start_capture["endpointHighlightPixels"]

        status = next((item["status"] for item in paint_captures
                       if item["status"] != "exact-match"), "exact-match")
        proof.update({
            "verifiedScrollY": paint_captures[0]["verifiedScrollY"],
            "rects": paint_captures[0]["rects"],
            "insideHighlightPixels": min(item["insideHighlightPixels"]
                                           for item in paint_captures),
            "endpointHighlightPixels": endpoint_pixels,
            "outsideHighlightPixels": max(item["outsideHighlightPixels"]
                                            for item in paint_captures),
            "captureHighlightPixels": max(item["captureHighlightPixels"]
                                            for item in paint_captures),
            "paintAttempts": sum(item["paintAttempts"] for item in paint_captures),
            "paintWaitMs": sum(item["paintWaitMs"] for item in paint_captures),
            "screenshotSize": paint_captures[0]["screenshotSize"],
            "screenshotSha256": paint_captures[0]["screenshotSha256"],
            "paintCaptures": paint_captures,
            "paintVerdict": status,
        })
        screenshots = [item["screenshot"] for item in paint_captures
                       if item.get("screenshot")]
        if screenshots:
            proof["screenshots"] = screenshots
            proof["screenshot"] = screenshots[0]
        if status != "exact-match":
            failures.append(status)
            proof["status"] = status

    geometry_tolerance = None
    if failures and set(failures) == {"paint-extraneous"}:
        if lexically_exact_edge_paint(quote_proofs):
            failures.clear()
            geometry_tolerance = {
                "status": "accepted-edge-punctuation-geometry",
                "rangeVerdict": "located-gap-free-lexical-island",
                "quotes": quote_proofs,
            }
    return {
        "verdict": failures[0] if failures else "exact-match",
        "initialViewport": initial_viewport,
        "quotes": quote_proofs,
        "findRanges": [],
        "rangeVerdict": "diagnostic-skipped-window-find",
        "geometryTolerance": geometry_tolerance,
    }, image


def html_paint_proof(driver, local: str, seed: dict, cache_file: str | None,
                     save_shots=False, mine_oracle=False, live=False):
    """Acceptance proof against the complete cached document and real target paint."""
    timings = {}
    target = seed.get("target", "")
    plan = html_isolation_plan(seed)
    if plan["status"] != "ready":
        return {
            "label": seed["label"], "verdict": plan["status"], "target": target,
            "cacheFile": cache_file, "verificationContract": HTML_PAINT_CONTRACT,
            "isolationPlan": plan,
        }, timings

    items = plan["items"]
    local_isolations = isolated_text_directive_urls(local)
    isolated_proofs = []
    combined = None
    image = None
    if len(items) == 1:
        combined, image = html_navigation_paint_proof(
            driver, local, [items[0]["paintQuote"]], seed, timings,
            "isolated-0", save_shots,
        )
        isolated_proofs.append({
            **items[0], "verdict": combined["verdict"],
            "initialViewport": combined["initialViewport"],
            "quote": combined["quotes"][0] if combined["quotes"] else None,
            "findRange": combined["findRanges"][0] if combined["findRanges"] else None,
            "rangeVerdict": combined["rangeVerdict"],
        })
    else:
        for item, navigation_target in zip(items, local_isolations):
            isolated_seed = {
                **seed,
                "_sourceIdentities": [
                    (seed.get("_sourceIdentities") or [None] * len(items))[item["directiveIndex"]]
                ],
            }
            isolated, image = html_navigation_paint_proof(
                driver, navigation_target, [item["paintQuote"]],
                isolated_seed, timings, f"isolated-{item['directiveIndex']}", save_shots,
            )
            isolated_proofs.append({
                **item, "verdict": isolated["verdict"],
                "initialViewport": isolated["initialViewport"],
                "quote": isolated["quotes"][0] if isolated["quotes"] else None,
                "findRange": isolated["findRanges"][0] if isolated["findRanges"] else None,
                "rangeVerdict": isolated["rangeVerdict"],
            })
        combined, image = html_navigation_paint_proof(
            driver, local, [item["paintQuote"] for item in items],
            seed, timings, "combined", save_shots,
        )

    verdict = html_real_paint_verdict([*isolated_proofs, combined])
    result = {
        "label": seed["label"], "verdict": verdict, "target": target, "cacheFile": cache_file,
        "verificationContract": HTML_PAINT_CONTRACT,
        "paintColor": "native-target-text" if live else "rgb(0,255,0)",
        "isolatedProofs": isolated_proofs,
        "combinedInitialViewport": combined["initialViewport"],
        "quotes": combined["quotes"], "findRanges": combined["findRanges"],
        "rangeVerdict": combined["rangeVerdict"],
    }
    if live:
        rendered = driver.execute_script("return document.documentElement.outerHTML")
        rendered_bytes = rendered.encode("utf-8")
        rendered_name = hashlib.sha1(target.partition("#")[0].encode()).hexdigest() + ".html"
        LIVE_RENDERED_CACHE.mkdir(exist_ok=True)
        (LIVE_RENDERED_CACHE / rendered_name).write_bytes(rendered_bytes)
        result["liveIdentity"] = {
            "url": driver.current_url,
            "file": rendered_name,
            "bytes": len(rendered_bytes),
            "sha256": hashlib.sha256(rendered_bytes).hexdigest(),
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


def search_normalized(text: str):
    """Established cached-PDF fold: simple lowercase plus folded whitespace."""
    return re.sub(r"\s+", " ", text.lower()).strip()


def search_normalized_with_map(text: str):
    chars, raw_map = [], []
    spaced = True
    for index, raw in enumerate(text):
        for char in raw.lower():
            if char.isspace():
                if chars and not spaced:
                    chars.append(" ")
                    raw_map.append(index)
                spaced = True
            else:
                chars.append(char)
                raw_map.append(index)
                spaced = False
    if chars and chars[-1] == " ":
        chars.pop()
        raw_map.pop()
    return "".join(chars), raw_map


def all_occurrences(text: str, wanted: str):
    found = []
    wanted_words = word_spans(wanted)
    if not wanted_words:
        return found
    first_word = wanted_words[0][1]
    last_word = wanted_words[-1][2]
    at = 0
    while wanted and (at := text.find(wanted, at)) >= 0:
        before = at + first_word - 1
        after = at + last_word
        if (before < 0 or not text[before].isalnum()) and \
                (after >= len(text) or not text[after].isalnum()):
            found.append((at, at + len(wanted)))
        at += max(1, len(wanted))
    return found


def raw_directives(target: str):
    fragment = target.partition("#")[2]
    marker = fragment.find(":~:")
    payload = fragment[marker + 3:] if marker >= 0 else fragment
    return [piece[5:] for piece in payload.split("&") if piece.startswith("text=")]


def isolated_text_directive_urls(target: str):
    base = target.partition("#")[0]
    return [f"{base}#:~:text={directive}" for directive in raw_directives(target)]


def html_isolation_plan(seed: dict):
    directives = raw_directives(seed.get("target") or "")
    quotes = seed.get("paintQuotes")
    intervals = seed.get("sourceWordIntervals")
    counts = {
        "directives": len(directives),
        "paintQuotes": len(quotes) if isinstance(quotes, list) else None,
        "sourceWordIntervals": len(intervals) if isinstance(intervals, list) else None,
    }
    if not directives or not isinstance(quotes, list) or not isinstance(intervals, list) or \
            len(set(counts.values())) != 1:
        return {"status": "html-isolation-cardinality-mismatch", "counts": counts}
    targets = isolated_text_directive_urls(seed["target"])
    return {
        "status": "ready",
        "items": [
            {
                "directiveIndex": index, "directive": directive,
                "target": targets[index], "paintQuote": quotes[index],
                "sourceInterval": intervals[index],
            }
            for index, directive in enumerate(directives)
        ],
    }


SOURCE_WORD_RE = re.compile(r"[^\W_]+(?:['\u2019][^\W_]+)*", re.UNICODE)
SOURCE_LINE_LABEL = re.compile(
    r"^(?:(?P<markdown>(?:\*{1,3}|_{1,3})\s*\d{1,4}(?:\.\d{1,4})*\s*"
    r"(?:\*{1,3}|_{1,3})\s*)|"
    r"(?P<pin>\[\s*\d{1,4}\s*\]|\d{1,4}\])\s*|"
    r"(?P<numbered>\d{1,4}\s+(?:[\u2013\u2014]|\u00e2\u20ac[\u201c\u201d])\s+)|"
    r"(?P<provision>\d{1,4}(?:\.\d{1,4})*\s*"
    r"(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)+"
    r"(?:[.;:]\s*(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)*)?)|"
    r"(?P<list>\(\s*[A-Za-z0-9]{1,5}\s*\)\s*))"
)
TRAILING_BILINGUAL_TRANSLATION = re.compile(
    r"\s*\(\s*(?:\u00ab|\u00c2\u00ab|\u00c3\u201a\u00c2\u00ab)\s*[^)]*$", re.IGNORECASE,
)
LEADING_BILINGUAL_TRANSLATION = re.compile(
    r"^\s*\(\s*(?:\u00ab|\u00c2\u00ab|\u00c3\u201a\u00c2\u00ab)\s*[^)]*"
    r"(?:\u00bb|\u00c2\u00bb|\u00c3\u201a\u00c2\u00bb)\s*\)\s*",
    re.IGNORECASE,
)
ACCEPTED_OMISSION_REASONS = {
    "line-start-furniture",
    "decimal-or-subsection-locator",
    "appended-bilingual-translation",
    "bilingual-translation-furniture",
    "duplicate-signature-metadata",
}

SIGNATURE_METADATA = re.compile(
    r"^at\b.+\bthis\s+\d+(?:st|nd|rd|th)\s+day\s+of\s+.+\s+\d{4}\b.+\bj$",
    re.IGNORECASE,
)


def source_document_key(seed: dict):
    label = str(seed.get("label") or "")
    dataset = str(seed.get("dataset") or "")
    rest = label[len(dataset) + 1:] if dataset and label.startswith(f"{dataset}_") else label
    match = re.match(r"^(.*?)_(?:p\d+|sec[^_]*)_", rest)
    return match.group(1) if match else None


def source_word_fold(value: str):
    return "".join(char for char in unicodedata.normalize("NFKD", value.casefold())
                   if not unicodedata.combining(char))


def source_words(value: str):
    words = []
    astral = [match.start() for match in re.finditer(r"[\U00010000-\U0010ffff]", value)]
    for match in SOURCE_WORD_RE.finditer(value):
        utf16_start = match.start() + bisect_left(astral, match.start())
        utf16_end = match.end() + bisect_left(astral, match.end())
        words.append({
            "word": source_word_fold(match.group()),
            "raw": match.group(),
            "start": match.start(),
            "end": match.end(),
            "utf16Start": utf16_start,
            "utf16End": utf16_end,
        })
    return words


def source_token_index(words: list[dict], postings: dict | None = None):
    values = [item["word"] for item in words]
    if postings is None:
        postings = {}
        for index, value in enumerate(values):
            postings.setdefault(value, []).append(index)
    return {"words": words, "values": values, "postings": postings}


def indexed_sequence_starts(index: dict, wanted: list[str]):
    values = index["values"]
    if not wanted:
        return list(range(len(values) + 1))
    anchor = min(range(len(wanted)),
                 key=lambda offset: len(index["postings"].get(wanted[offset], ())))
    starts = []
    for occurrence in index["postings"].get(wanted[anchor], ()):
        start = occurrence - anchor
        if 0 <= start and start + len(wanted) <= len(values) and \
                values[start:start + len(wanted)] == wanted:
            starts.append(start)
    return starts


SOURCE_CONTRACT_INPUT_FIELDS = (
    "target", "paintQuotes", "sourceWordIntervals", "quotes",
    "paintedWords", "sourceSafeComplete", "dataset",
)


def source_contract_cache_identity(seed: dict, document_text: str, is_pdf: bool):
    source_sha = hashlib.sha256(document_text.encode("utf-8")).hexdigest()
    inputs = {field: seed.get(field) for field in SOURCE_CONTRACT_INPUT_FIELDS}
    fingerprint = hashlib.sha256(json.dumps({
        "contract": SOURCE_CONTRACT_CACHE_VERSION,
        "sourceSha256": source_sha,
        "isPdf": is_pdf,
        "inputs": inputs,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {
        "contract": SOURCE_CONTRACT_CACHE_VERSION,
        "sourceSha256": source_sha, "fingerprint": fingerprint,
    }


def read_source_contract_cache(identity: dict,
                               cache_dir: Path = SOURCE_CONTRACT_CACHE):
    cache_file = cache_dir / f"{identity['fingerprint']}.json"
    if not cache_file.exists():
        return None
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        if cached.get("identity") == identity and isinstance(cached.get("result"), dict):
            return cached["result"]
    except (OSError, ValueError, TypeError):
        pass
    return None


def write_source_contract_cache(identity: dict, result: dict,
                                cache_dir: Path = SOURCE_CONTRACT_CACHE):
    cache_dir.mkdir(exist_ok=True)
    cache_file = cache_dir / f"{identity['fingerprint']}.json"
    temporary = cache_file.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps({
        "identity": identity, "result": result,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(cache_file)


def range_proof_cache_identity(seed: dict, rendered_sha256: str):
    inputs = {
        field: seed.get(field) for field in
        ("target", "paintQuotes", "quotes", "blockText", "_sourceIdentities")
    }
    fingerprint = hashlib.sha256(json.dumps({
        "contract": RANGE_PROOF_CACHE_VERSION,
        "renderedSha256": rendered_sha256,
        "inputs": inputs,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {
        "contract": RANGE_PROOF_CACHE_VERSION,
        "renderedSha256": rendered_sha256, "fingerprint": fingerprint,
    }


def read_range_proof_cache(identity: dict, cache_dir: Path = RANGE_PROOF_CACHE):
    cache_file = cache_dir / f"{identity['fingerprint']}.json"
    if not cache_file.exists():
        return None
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        result = cached.get("result")
        if cached.get("identity") == identity and isinstance(result, list) and len(result) == 2:
            return result
    except (OSError, ValueError, TypeError):
        pass
    return None


def write_range_proof_cache(identity: dict, proofs: list, ranges: list,
                            cache_dir: Path = RANGE_PROOF_CACHE):
    cache_dir.mkdir(exist_ok=True)
    cache_file = cache_dir / f"{identity['fingerprint']}.json"
    temporary = cache_file.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps({
        "identity": identity, "result": [proofs, ranges],
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(cache_file)


def load_result_cache_manifest(cache_dir: Path, contract: str):
    """Load one compact warm-run snapshot; individual files remain crash checkpoints."""
    manifest = cache_dir / "manifest.json"
    if not manifest.exists():
        return {}
    try:
        cached = json.loads(manifest.read_text(encoding="utf-8"))
        entries = cached.get("entries")
        if cached.get("contract") == contract and isinstance(entries, dict):
            return entries
    except (OSError, ValueError, TypeError):
        pass
    return {}


def write_result_cache_manifest(cache_dir: Path, contract: str, entries: dict):
    cache_dir.mkdir(exist_ok=True)
    manifest = cache_dir / "manifest.json"
    temporary = manifest.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps({
        "contract": contract, "entries": entries,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(manifest)


def source_line_label_reason(document_text: str, words: list[dict], index: int):
    """Classify only the four line-start label shapes stripped by the builder."""
    token = words[index]
    line_start = max(
        document_text.rfind("\n", 0, token["start"]),
        document_text.rfind("\r", 0, token["start"]),
    ) + 1
    endings = [at for at in (
        document_text.find("\n", token["end"]),
        document_text.find("\r", token["end"]),
    ) if at >= 0]
    line_end = min(endings) if endings else len(document_text)
    indent = re.match(r"[ \t]*", document_text[line_start:line_end]).end()
    content_start = line_start + indent
    content = document_text[content_start:line_end]
    label = SOURCE_LINE_LABEL.match(content)
    if not label or label.end() >= len(content.rstrip()) or token["end"] > content_start + label.end():
        return None
    return "line-start-furniture" if label.group("pin") or label.group("numbered") else \
        "decimal-or-subsection-locator"


def source_quote_label_reason(raw_quote: str, words: list[dict], index: int):
    """Mirror builder edge stripping only when its exact label starts the quote."""
    label = SOURCE_LINE_LABEL.match(raw_quote)
    if not label or label.end() >= len(raw_quote.rstrip()) or words[index]["end"] > label.end():
        return None
    return "line-start-furniture" if label.group("pin") or label.group("numbered") else \
        "decimal-or-subsection-locator"


def source_omission_reason(document_text: str, document_words: list[dict],
                           document_index: int, raw_quote: str,
                           quote_words: list[dict], quote_index: int,
                           is_pdf: bool, allow_bilingual: bool):
    line_reason = source_line_label_reason(document_text, document_words, document_index)
    if line_reason:
        return line_reason
    quote_reason = source_quote_label_reason(raw_quote, quote_words, quote_index)
    if quote_reason:
        return quote_reason
    token = quote_words[quote_index]
    leading_bilingual = LEADING_BILINGUAL_TRANSLATION.match(raw_quote) if allow_bilingual else None
    if leading_bilingual and token["end"] <= leading_bilingual.end():
        return "bilingual-translation-furniture"
    bilingual = TRAILING_BILINGUAL_TRANSLATION.search(raw_quote) if allow_bilingual else None
    if bilingual and bilingual.start() and bilingual.start() <= token["start"]:
        return "appended-bilingual-translation"
    if is_pdf:
        document_token = document_words[document_index]
        before = document_words[document_index - 1]["end"] if document_index else 0
        after = document_words[document_index + 1]["start"] \
            if document_index + 1 < len(document_words) else len(document_text)
        if "\n" in document_text[before:document_token["start"]] or \
                "\r" in document_text[before:document_token["start"]] or \
                "\n" in document_text[document_token["end"]:after] or \
                "\r" in document_text[document_token["end"]:after]:
            # Diagnostic only: extraction newlines never prove that a
            # substantive source word is unsafe to paint.
            return "pdf-extraction-line-seam"
    return None


def canonical_source_contract(seed: dict, document_text: str | None,
                              is_pdf: bool, document_words: list[dict] | None = None,
                              document_token_index: dict | None = None):
    """Prove source coverage from full A2AJ text; paintQuotes are spelling only."""
    directives = raw_directives(seed.get("target") or "")
    paint_quotes = seed.get("paintQuotes")
    intervals = seed.get("sourceWordIntervals")
    if not isinstance(paint_quotes, list) or not isinstance(intervals, list) or not directives:
        return {"status": "source-plan-contract-missing", "accepted": False}
    counts = {"directives": len(directives), "paintQuotes": len(paint_quotes),
              "sourceWordIntervals": len(intervals)}
    if len(set(counts.values())) != 1:
        return {"status": "source-plan-cardinality-mismatch", "accepted": False,
                "counts": counts}
    if document_text is None:
        return {"status": "source-document-missing", "accepted": False}
    document_words = document_words if document_words is not None else source_words(document_text)
    document_token_index = document_token_index or source_token_index(document_words)
    document_values = document_token_index["values"]
    quotes = seed.get("quotes") or []
    assigned: dict[int, list[dict]] = {}
    mapped = []
    painted_word_indices = set()
    previous_first = -1
    for index, (interval, paint_quote) in enumerate(zip(intervals, paint_quotes)):
        if not isinstance(interval, dict) or not all(
                isinstance(interval.get(name), int)
                for name in ("quoteIndex", "start", "end", "firstWord", "lastWord")):
            return {"status": "source-interval-malformed", "accepted": False,
                    "intervalIndex": index}
        quote_index = interval["quoteIndex"]
        first = interval["firstWord"]
        last = interval["lastWord"]
        if not 0 <= quote_index < len(quotes) or not 0 <= first <= last < len(document_words):
            return {"status": "source-interval-out-of-bounds", "accepted": False,
                    "intervalIndex": index, "interval": interval}
        if first < previous_first:
            return {"status": "source-interval-order-mismatch", "accepted": False,
                    "intervalIndex": index}
        previous_first = first
        if interval["start"] != document_words[first]["utf16Start"] or \
                interval["end"] != document_words[last]["utf16End"]:
            return {"status": "source-interval-character-mismatch", "accepted": False,
                    "intervalIndex": index, "interval": interval,
                    "expected": [document_words[first]["utf16Start"],
                                 document_words[last]["utf16End"]]}
        selected_values = document_values[first:last + 1]
        spelling_values = [item["word"] for item in source_words(str(paint_quote))]
        if not spelling_values or spelling_values != selected_values:
            return {"status": "paint-spelling-source-mismatch", "accepted": False,
                    "intervalIndex": index, "sourceWords": selected_values,
                    "paintWords": spelling_values}
        piece = {"intervalIndex": index, "firstWord": first, "lastWord": last}
        assigned.setdefault(quote_index, []).append(piece)
        mapped.append({**piece, "quoteIndex": quote_index})
        painted_word_indices.update(range(first, last + 1))

    painted_words = len(painted_word_indices)

    if seed.get("paintedWords") != painted_words:
        return {"status": "painted-word-count-mismatch", "accepted": False,
                "declared": seed.get("paintedWords"), "counted": painted_words}

    omitted = []
    used_quote_indices = set()
    seen_quotes = set()
    for quote_index, raw_quote in enumerate(quotes):
        quote_word_rows = source_words(str(raw_quote))
        quote_values = tuple(item["word"] for item in quote_word_rows)
        if not quote_values or quote_values in seen_quotes:
            continue
        seen_quotes.add(quote_values)
        pieces = assigned.get(quote_index) or []
        used_quote_indices.add(quote_index)
        candidates = []
        for start in indexed_sequence_starts(document_token_index, list(quote_values)):
            end = start + len(quote_values) - 1
            if all(start <= piece["firstWord"] <= piece["lastWord"] <= end and
                   document_values[piece["firstWord"]:piece["lastWord"] + 1] ==
                   list(quote_values[piece["firstWord"] - start:piece["lastWord"] - start + 1])
                   for piece in pieces):
                candidates.append(start)
        if len(candidates) != 1:
            return {"status": "source-quote-location-unresolved", "accepted": False,
                    "quoteIndex": quote_index, "candidateCount": len(candidates)}
        source_start = candidates[0]
        citation_index = next((index for index, value in enumerate(quote_values)
                               if value == "citation"), None)
        signature_metadata = set()
        if citation_index:
            signature_values = list(quote_values[:citation_index])
            signature = " ".join(signature_values)
            if SIGNATURE_METADATA.match(signature) and \
                    len(indexed_sequence_starts(document_token_index, signature_values)) >= 2:
                formal_citation = " ".join(
                    quote_values[citation_index + 1:citation_index + 4]
                )
                through_heading = citation_index + 1 if re.fullmatch(
                    r"\d{4}\s+[a-z]{2,8}\s+\d+", formal_citation, re.IGNORECASE,
                ) else citation_index
                signature_metadata.update(range(through_heading))
        covered = set()
        for piece in pieces:
            covered.update(range(piece["firstWord"] - source_start,
                                 piece["lastWord"] - source_start + 1))
        for token_index, token in enumerate(quote_word_rows):
            if token_index in covered:
                continue
            reason = "duplicate-signature-metadata" if token_index in signature_metadata else \
                source_omission_reason(
                    document_text, document_words, source_start + token_index,
                    str(raw_quote), quote_word_rows, token_index, is_pdf,
                    seed.get("dataset") == "LEGISLATION-MB",
                )
            omitted.append({"quoteIndex": quote_index, "tokenIndex": token_index,
                            "token": token["raw"],
                            "reason": reason or "unclassified-substantive"})

    unused = sorted(set(assigned) - used_quote_indices)
    if unused:
        return {"status": "source-interval-quote-mismatch", "accepted": False,
                "quoteIndices": unused}
    unaccepted = [item for item in omitted
                  if item["reason"] not in ACCEPTED_OMISSION_REASONS]
    builder_complete = seed.get("sourceSafeComplete") is True
    accepted = builder_complete and not unaccepted
    return {
        "status": "source-builder-incomplete" if not builder_complete else
                  "source-coverage-unaccepted-omission" if unaccepted else
                  "source-coverage-classified" if omitted else "source-coverage-exact",
        "accepted": accepted,
        "paintedWords": painted_words,
        "mappedIntervals": mapped,
        "sourceIdentities": [
            {
                "intervalIndex": item["intervalIndex"],
                "before": document_values[max(0, item["firstWord"] - 32):item["firstWord"]],
                "after": document_values[item["lastWord"] + 1:item["lastWord"] + 33],
            }
            for item in mapped
        ],
        "omitted": omitted,
        "unacceptedOmissions": unaccepted,
    }


def parse_directive(raw: str):
    pieces = raw.split(",")
    prefix = search_normalized(unquote(pieces.pop(0)[:-1])) if pieces and pieces[0].endswith("-") else ""
    suffix = search_normalized(unquote(pieces.pop()[1:])) if pieces and pieces[-1].startswith("-") else ""
    if not 1 <= len(pieces) <= 2:
        return None
    terms = [search_normalized(unquote(piece)) for piece in pieces]
    return prefix, terms[0], terms[1] if len(terms) == 2 else "", suffix


def directive_matches(pages: list[str], raw: str):
    parsed = parse_directive(raw)
    if not parsed:
        return []
    prefix, start_text, end_text, suffix = parsed
    def finish(text, start, start_end):
        if not end_text:
            after = text[start_end:].lstrip()
            return (start, start_end) if not suffix or after.startswith(suffix) else None
        for end_start, end in all_occurrences(text, end_text):
            if end_start < start_end:
                continue
            after = text[end:].lstrip()
            if not suffix or after.startswith(suffix):
                return start, end
        return None

    if not prefix:
        for page_index, text in enumerate(pages):
            for start, start_end in all_occurrences(text, start_text):
                match = finish(text, start, start_end)
                if match:
                    return [(page_index, *match)]
        return []

    # PDFium batches prefixes one page at a time. Once a prefix/start pair is
    # accepted, a failed range end resumes at the next page, not another start
    # on the same prefix page.
    for page_index, text in enumerate(pages):
        prefixes = all_occurrences(text, prefix)
        if not prefixes:
            continue
        for _, prefix_end in prefixes:
            start = prefix_end
            while start < len(text) and text[start].isspace():
                start += 1
            if not text.startswith(start_text, start):
                continue
            start_end = start + len(start_text)
            if not end_text:
                match = finish(text, start, start_end)
                if match:
                    return [(page_index, *match)]
                continue
            match = finish(text, start, start_end)
            if match:
                return [(page_index, *match)]
            break
    return []


def directive_match(pages: list[str], raw: str):
    matches = directive_matches(pages, raw)
    return matches[0] if matches else None


def sequence_starts(words: list[str], wanted: list[str]):
    if not wanted:
        return list(range(len(words) + 1))
    prefix = [0] * len(wanted)
    matched = 0
    for index in range(1, len(wanted)):
        while matched and wanted[index] != wanted[matched]:
            matched = prefix[matched - 1]
        if wanted[index] == wanted[matched]:
            matched += 1
        prefix[index] = matched
    starts = []
    matched = 0
    for index, word in enumerate(words):
        while matched and word != wanted[matched]:
            matched = prefix[matched - 1]
        if word == wanted[matched]:
            matched += 1
            if matched == len(wanted):
                starts.append(index - len(wanted) + 1)
                matched = prefix[matched - 1]
    return starts


def pages_word_index(pages: list[str]):
    flat = []
    for page_index, page_text in enumerate(pages):
        flat.extend((word, page_index, start, end)
                    for word, start, end in word_spans(page_text))
    values = [word for word, _, _, _ in flat]
    joined_offsets = []
    joined_at = 0
    for value in values:
        joined_offsets.append(joined_at)
        joined_at += len(value) + 1
    positions = {}
    for word_index, value in enumerate(values):
        positions.setdefault(value, []).append(word_index)
    return {
        "flat": flat, "values": values,
        "joinedWords": WORD_SENTINEL.join(values),
        "joinedOffsets": joined_offsets,
        "positions": positions,
    }


def exact_word_sequence_starts(index: dict, wanted: list[str]):
    if not wanted:
        return []
    joined = index["joinedWords"]
    needle = WORD_SENTINEL.join(wanted)
    starts = []
    at = joined.find(needle)
    while at >= 0:
        end = at + len(needle)
        if (at == 0 or joined[at - 1] == WORD_SENTINEL) and \
                (end == len(joined) or joined[end] == WORD_SENTINEL):
            starts.append(bisect_left(index["joinedOffsets"], at))
        at = joined.find(needle, at + 1)
    return starts


def subsequence_count(wanted: list[str], available: list[str]):
    at = 0
    for word in available:
        if at < len(wanted) and word == wanted[at]:
            at += 1
    return at


def common_prefix_count(left: list[str], right: list[str]):
    return next((at for at, pair in enumerate(zip(left, right)) if pair[0] != pair[1]),
                min(len(left), len(right)))


def edge_alignment(wanted: list[str], available: list[str]):
    """Prefer adjacent source context, then tolerate publisher-inserted labels."""
    exact = common_prefix_count(wanted, available)
    matched = cursor = inserted = 0
    for word in wanted:
        try:
            found = available.index(word, cursor)
        except ValueError:
            continue
        inserted += found - cursor
        matched += 1
        cursor = found + 1
    return exact, matched, inserted


def indexed_edge_alignment(wanted: list[str], index: dict, cursor: int, limit: int,
                           *, reverse: bool = False):
    values = index["values"]
    ordered = list(reversed(wanted)) if reverse else wanted
    step = -1 if reverse else 1
    exact = 0
    exact_at = cursor
    for word in ordered:
        in_range = exact_at >= limit if reverse else exact_at < limit
        if not in_range or not (0 <= exact_at < len(values)) or values[exact_at] != word:
            break
        exact += 1
        exact_at += step
    matched = inserted = 0
    for word in ordered:
        occurrences = index["positions"].get(word, [])
        if reverse:
            occurrence_at = bisect_right(occurrences, cursor) - 1
            if occurrence_at < 0 or occurrences[occurrence_at] < limit:
                continue
            found = occurrences[occurrence_at]
            inserted += cursor - found
        else:
            occurrence_at = bisect_left(occurrences, cursor)
            if occurrence_at >= len(occurrences) or occurrences[occurrence_at] >= limit:
                continue
            found = occurrences[occurrence_at]
            inserted += found - cursor
        matched += 1
        cursor = found + step
    return exact, matched, inserted


def word_spans(text: str):
    return [(match.group(), match.start(), match.end())
            for match in re.finditer(r"[^\W\d_]+|\d+", text, flags=re.UNICODE)]


def quote_islands(pages: list[str], block_text: str, quote_text: str,
                  preferred_page: int | None = None,
                  source_identity: dict | None = None,
                  document_index: dict | None = None):
    """Locate every quote word, then split only where live PDF order inserts words."""
    quote_words = [word for word, _, _ in word_spans(normalized_with_raw_map(quote_text)[0])]
    block_words = [word for word, _, _ in word_spans(normalized_with_raw_map(block_text)[0])]
    quote_at = sequence_starts(block_words, quote_words)
    if not quote_words:
        return None
    if len(quote_at) == 1:
        source_at = quote_at[0]
        before = block_words[max(0, source_at - 96):source_at]
        after_at = source_at + len(quote_words)
        after = block_words[after_at:after_at + 96]
    elif source_identity:
        before = list(source_identity.get("before") or [])
        after = list(source_identity.get("after") or [])
    else:
        return None
    document_index = document_index or pages_word_index(pages)
    flat = document_index["flat"]
    values = document_index["values"]
    exact_starts = exact_word_sequence_starts(document_index, quote_words)
    candidates = []
    starts = exact_starts or document_index["positions"].get(quote_words[0], [])
    for first in starts:
        if exact_starts:
            indices = list(range(first, first + len(quote_words)))
        else:
            indices = [first]
            cursor = first + 1
            for wanted in quote_words[1:]:
                occurrences = document_index["positions"].get(wanted, [])
                occurrence_at = bisect_left(occurrences, cursor)
                limit = min(len(values), first + len(quote_words) + 4096)
                if occurrence_at >= len(occurrences) or occurrences[occurrence_at] >= limit:
                    break
                found = occurrences[occurrence_at]
                indices.append(found)
                cursor = found + 1
            if len(indices) != len(quote_words):
                continue
            cursor = indices[-1]
            reversed_indices = [cursor]
            for wanted in reversed(quote_words[:-1]):
                occurrences = document_index["positions"].get(wanted, [])
                occurrence_at = bisect_left(occurrences, cursor) - 1
                if occurrence_at < 0 or occurrences[occurrence_at] < first:
                    break
                found = occurrences[occurrence_at]
                reversed_indices.append(found)
                cursor = found
            if len(reversed_indices) != len(quote_words):
                continue
            indices = list(reversed(reversed_indices))
        inserted = indices[-1] - first + 1 - len(indices)
        page_numbers = [flat[index][1] for index in indices]
        page_span = max(page_numbers) - min(page_numbers)
        if preferred_page is not None and preferred_page not in page_numbers:
            continue
        left = indexed_edge_alignment(
            before, document_index, first - 1, max(0, first - 4096), reverse=True,
        )
        right = indexed_edge_alignment(
            after, document_index, indices[-1] + 1,
            min(len(values), indices[-1] + 4097),
        )
        context_exact = left[0] + right[0]
        context_matched = left[1] + right[1]
        context_inserted = left[2] + right[2]
        # Source identity and a source-provided page anchor select the occurrence.
        # Tightness only chooses among occurrences with the same source evidence.
        candidates.append((-context_exact, -context_matched, context_inserted,
                           inserted, page_span, indices))
    if not candidates:
        return None
    candidates = list({tuple(candidate[-1]): candidate for candidate in candidates}.values())
    candidates.sort(key=lambda item: item[:5])
    if len(candidates) > 1 and candidates[0][:5] == candidates[1][:5]:
        return None
    *_, indices = candidates[0]
    islands = []
    run_first = indices[0]
    run_last = indices[0]
    for index in indices[1:]:
        if index == run_last + 1 and flat[index][1] == flat[run_last][1]:
            run_last = index
            continue
        islands.append((flat[run_first][1], flat[run_first][2], flat[run_last][3]))
        run_first = run_last = index
    islands.append((flat[run_first][1], flat[run_first][2], flat[run_last][3]))
    return islands


def spans_cover(wanted: tuple[int, int, int], selected: list[dict], page_text: str = ""):
    page, start, end = wanted
    cursor = start
    for _, span_start, span_end in sorted(
        (item["span"] for item in selected if item["span"][0] == page),
        key=lambda span: span[1],
    ):
        if span_end <= cursor:
            continue
        if span_start > cursor and (not page_text or word_spans(page_text[cursor:span_start])):
            return False
        cursor = max(cursor, span_end)
        if cursor >= end:
            return True
    return cursor >= end or bool(page_text) and not word_spans(page_text[cursor:end])


def span_stays_within_words(span: tuple[int, int, int], wanted: tuple[int, int, int], page_text: str):
    """Allow requested punctuation around an island, never extra live words."""
    page, start, end = span
    if page != wanted[0] or end < wanted[1] or start > wanted[2]:
        return False
    return not word_spans(page_text[min(start, wanted[1]):wanted[1]]) and not word_spans(
        page_text[wanted[2]:max(end, wanted[2])]
    )


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
        pages = [search_normalized(text) for text in pdfium_pages(file)]
        text_cache[file] = pages
    directives = raw_directives(seed["target"])
    selected = []
    for directive in directives:
        match = directive_match(pages, directive)
        if match:
            selected.append({"directive": unquote(directive), "span": match,
                             "parsed": parse_directive(directive)})

    intended = []
    intended_groups = []
    block_text = seed.get("blockText", "")
    page_match = re.search(r"(?:^|[#&])page=(\d+)", seed.get("target") or "", re.IGNORECASE)
    preferred_page = int(page_match.group(1)) - 1 if page_match else None
    proof_quotes = seed["paintQuotes"] if "paintQuotes" in seed else seed.get("quotes") or []
    if not proof_quotes:
        return {"status": "pdf-build-no-core"}
    if len(proof_quotes) != len(directives):
        return {"status": "pdf-plan-cardinality-mismatch", "directives": len(directives),
                "paintQuotes": len(proof_quotes)}
    identities = seed.get("_sourceIdentities") or [None] * len(proof_quotes)
    if len(identities) != len(proof_quotes):
        return {"status": "pdf-source-identity-cardinality-mismatch"}
    for quote_text_raw, identity in zip(proof_quotes, identities):
        islands = quote_islands(
            pages, block_text, quote_text_raw, preferred_page,
            source_identity=identity,
        )
        if not islands:
            return {"status": "pdf-intended-not-located", "quote": quote_text_raw}
        intended_groups.append(islands)
        intended.extend(islands)
    if len(selected) != len(directives):
        return {"status": "pdf-directive-not-located", "selected": selected,
                "directiveCount": len(directives), "intended": intended,
                "intendedGroups": intended_groups}
    extraneous = [item for item, wanted_group in zip(selected, intended_groups)
                  if not any(span_stays_within_words(
                      item["span"], wanted, pages[wanted[0]],
                  ) for wanted in wanted_group)]
    if extraneous:
        return {"status": "pdf-directive-extraneous", "intended": intended,
                "intendedGroups": intended_groups, "selected": selected,
                "extraneous": extraneous}
    uncovered = [wanted for item, wanted_group in zip(selected, intended_groups)
                 for wanted in wanted_group
                 if not spans_cover(wanted, [item], pages[wanted[0]])]
    if uncovered:
        return {"status": "pdf-incomplete-coverage", "intended": intended,
                "intendedGroups": intended_groups, "selected": selected,
                "uncovered": uncovered}
    return {
        "status": "pdf-location-exact",
        "pages": sorted({item["span"][0] + 1 for item in selected}),
        "intended": intended,
        "intendedGroups": intended_groups,
        "selected": selected,
    }


def merge_pdf_line_boxes(boxes):
    lines = []
    for left, bottom, right, top in sorted(boxes, key=lambda box: (-box[3], box[0])):
        height = max(0.1, top - bottom)
        line = next((item for item in lines if
                     min(item[3], top) - max(item[1], bottom) >=
                     min(height, item[3] - item[1]) * 0.35), None)
        if line is None:
            lines.append([left, bottom, right, top])
        else:
            line[0] = min(line[0], left)
            line[1] = min(line[1], bottom)
            line[2] = max(line[2], right)
            line[3] = max(line[3], top)
    return sorted(lines, key=lambda box: (-box[3], box[0]))


def pdf_span_geometries(file: Path, selected: list[dict], cache=None):
    cache = {} if cache is None else cache
    stat = file.stat()
    identity = (str(file), stat.st_size, stat.st_mtime_ns)
    missing = [item for item in selected if (*identity, *item["span"]) not in cache]
    if not missing:
        return {tuple(item["span"]): cache[(*identity, *item["span"])] for item in selected}
    raw_pages = pdfium_pages(file)
    document = pdfium.PdfDocument(str(file))
    try:
        for page_index in sorted({item["span"][0] for item in missing}):
            page = document[page_index]
            text_page = page.get_textpage()
            try:
                _, raw_map = search_normalized_with_map(raw_pages[page_index])
                page_items = [item for item in missing if item["span"][0] == page_index]
                for item in page_items:
                    _, start, end = item["span"]
                    raw_start = raw_map[min(start, len(raw_map) - 1)] if raw_map else 0
                    raw_end = raw_map[min(max(start, end - 1), len(raw_map) - 1)] + 1 if raw_map else 0
                    boxes = []
                    for char_index in range(raw_start, raw_end):
                        try:
                            box = text_page.get_charbox(char_index)
                        except Exception:
                            continue
                        if box and box[2] > box[0] and box[3] > box[1]:
                            boxes.append([float(value) for value in box])
                    if boxes:
                        heights = sorted(box[3] - box[1] for box in boxes)
                        median_height = heights[len(heights) // 2]
                        minimum_height = max(0.25, median_height * 0.15)
                        # PDFium occasionally reports near-zero baseline boxes
                        # for control characters. They have no painted area and
                        # must not invent an expected highlight line.
                        boxes = [box for box in boxes
                                 if box[3] - box[1] >= minimum_height and
                                 box[2] - box[0] >= 0.05]
                    cache[(*identity, *item["span"])] = {
                        "page": page_index + 1,
                        "pageSize": [float(page.get_width()), float(page.get_height())],
                        "lineBounds": merge_pdf_line_boxes(boxes),
                        "rawCharRange": [raw_start, raw_end],
                    }
            finally:
                text_page.close()
                page.close()
    finally:
        document.close()
    return {tuple(item["span"]): cache[(*identity, *item["span"])] for item in selected}


def screenshot_highlight(png: bytes):
    image = Image.open(io.BytesIO(png)).convert("RGB")
    mask = target_mask(image, "pdf")
    pixels = mask_count(mask)
    bounds = mask.getbbox()
    if not bounds:
        return 0, None, image
    x0, y0, x1, y1 = bounds
    return pixels, [x0, y0, x1 - 1, y1 - 1], image


PDF_VIEWER_STATUS_SCRIPT = r"""
const viewer = window.viewer || document.querySelector('pdf-viewer');
if (!viewer) return {status: 'viewer-missing', readyState: document.readyState};
try {
  if (viewer.loaded !== undefined && viewer.loaded !== null) await viewer.loaded;
} catch (error) {
  return {status: 'viewer-load-failed', error: String(error)};
}
let viewport;
try {
  viewport = viewer.viewport;
} catch (error) {
  return {status: 'viewport-not-ready', error: String(error)};
}
const size = viewport?.size;
const documentDimensions = viewport?.documentDimensions ?? viewer.documentDimensions;
if (!size || !(size.width > 0) || !(size.height > 0) ||
    !documentDimensions || !(documentDimensions.width > 0) ||
    !(documentDimensions.height > 0)) {
  return {status: 'viewport-not-ready', size, documentDimensions};
}
return {
  status: 'ready', readyState: document.readyState,
  location: location.href,
  size, documentDimensions,
};
"""


def file_sha256(file: Path):
    digest = hashlib.sha256()
    with file.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decoded_fragment(raw_url: str):
    return unquote(urlparse(raw_url).fragment)


def browser_history_url(driver):
    try:
        history = driver.execute_cdp_cmd("Page.getNavigationHistory", {})
        entries = history.get("entries") or []
        index = history.get("currentIndex", -1)
        return entries[index].get("url", "") if 0 <= index < len(entries) else ""
    except Exception:
        return ""


def final_fragment_proof(driver, wanted_fragment: str):
    current = driver.current_url
    history = browser_history_url(driver)
    wanted = unquote(wanted_fragment)
    observed = [value for value in (current, history) if value]
    matched = next((value for value in observed if decoded_fragment(value) == wanted), None)
    return {
        "status": "preserved" if matched else "lost",
        "wanted": wanted,
        "currentUrl": current,
        "historyUrl": history,
        "matchedUrl": matched,
    }


def wait_pdf_viewer(pdf_oopif, timeout: float, timings: dict):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = pdf_oopif.evaluate(PDF_VIEWER_STATUS_SCRIPT)
            if last.get("status") == "ready":
                return last
        except Exception as exc:
            last = {"error": str(exc)[:160]}
        phase = time.perf_counter()
        time.sleep(0.1)
        add_timing(timings, "viewerWaitMs", phase)
    return {"status": "not-ready", "last": last}


def performance_events(driver):
    events = []
    try:
        entries = driver.get_log("performance")
    except Exception:
        return events
    for entry in entries:
        try:
            message = json.loads(entry["message"])["message"]
            if message.get("method", "").startswith("Network."):
                events.append(message)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
    return events


def header_value(headers: dict, name: str):
    wanted = name.lower()
    return next((str(value) for key, value in (headers or {}).items()
                 if key.lower() == wanted), "")


def delivery_proof(events: list[dict], requested_base: str):
    redirects = []
    responses = []
    failures = []
    for event in events:
        method = event.get("method")
        params = event.get("params") or {}
        if method == "Network.requestWillBeSent" and params.get("redirectResponse"):
            redirected = params["redirectResponse"]
            redirects.append({
                "from": redirected.get("url"),
                "status": redirected.get("status"),
                "mimeType": redirected.get("mimeType"),
                "location": header_value(redirected.get("headers") or {}, "location"),
                "to": (params.get("request") or {}).get("url"),
            })
        elif method == "Network.responseReceived":
            response = params.get("response") or {}
            headers = response.get("headers") or {}
            mime = str(response.get("mimeType") or header_value(headers, "content-type")).lower()
            url = response.get("url", "")
            if "pdf" in mime or url.split("?", 1)[0].lower().endswith(".pdf") or \
                    urlparse(url).path.lower().endswith("/document.do"):
                responses.append({
                    "requestId": params.get("requestId"),
                    "url": url,
                    "status": response.get("status"),
                    "mimeType": mime,
                    "headers": headers,
                    "fromDiskCache": bool(response.get("fromDiskCache")),
                    "fromServiceWorker": bool(response.get("fromServiceWorker")),
                })
        elif method == "Network.loadingFailed":
            failures.append({
                "requestId": params.get("requestId"),
                "errorText": params.get("errorText"),
                "canceled": params.get("canceled"),
            })
    response = next((item for item in reversed(responses)
                     if int(item.get("status") or 0) == 200 and
                     not header_value(item.get("headers") or {}, "content-range")),
                    responses[-1] if responses else None)
    if not response:
        return {"status": "pdf-delivery-unverified", "requestedBase": requested_base,
                "redirects": redirects, "failures": failures}
    status = int(response.get("status") or 0)
    mime = response.get("mimeType", "").split(";", 1)[0]
    if not 200 <= status < 300:
        verdict = "pdf-delivery-http"
    elif mime != "application/pdf":
        verdict = "pdf-delivery-mime"
    else:
        verdict = "pdf-delivery-exact"
    return {
        "status": verdict,
        "requestedBase": requested_base,
        "finalUrl": response.get("url"),
        "httpStatus": status,
        "mimeType": response.get("mimeType"),
        "requestId": response.get("requestId"),
        "fromDiskCache": response.get("fromDiskCache"),
        "fromServiceWorker": response.get("fromServiceWorker"),
        "etag": header_value(response.get("headers") or {}, "etag"),
        "lastModified": header_value(response.get("headers") or {}, "last-modified"),
        "contentLength": header_value(response.get("headers") or {}, "content-length"),
        "contentRange": header_value(response.get("headers") or {}, "content-range"),
        "redirects": redirects,
        "failures": failures,
    }


def cdp_pdf_body(driver, delivery: dict):
    request_id = delivery.get("requestId")
    if not request_id or delivery.get("contentRange"):
        return None, "ranged-response" if delivery.get("contentRange") else "missing-request-id"
    try:
        result = driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": request_id})
        raw = result.get("body", "")
        body = base64.b64decode(raw) if result.get("base64Encoded") else raw.encode("latin1")
    except Exception as exc:
        return None, f"cdp-body: {str(exc)[:140]}"
    if len(body) < 500 or not body.startswith(b"%PDF-"):
        return None, f"cdp-not-pdf:{len(body)}"
    return body, None


def cookie_header(cookies: list[dict], raw_url: str):
    parsed = urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    path = parsed.path or "/"
    secure = parsed.scheme.lower() == "https"
    selected = []
    for cookie in cookies:
        domain = str(cookie.get("domain") or "").lstrip(".").lower()
        cookie_path = str(cookie.get("path") or "/")
        if domain and host != domain and not host.endswith(f".{domain}"):
            continue
        if not path.startswith(cookie_path) or cookie.get("secure") and not secure:
            continue
        selected.append(f"{cookie.get('name')}={cookie.get('value')}")
    return "; ".join(selected)


class RecordingRedirectHandler(HTTPRedirectHandler):
    def __init__(self, cookies: list[dict]):
        super().__init__()
        self.cookies = cookies
        self.redirects = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        self.redirects.append({"from": req.full_url, "status": code, "to": newurl})
        if redirected:
            redirected.remove_header("Cookie")
            cookies = cookie_header(self.cookies, newurl)
            if cookies:
                redirected.add_unredirected_header("Cookie", cookies)
        return redirected


def authenticated_pdf_get(driver, base: str, timeout: float):
    cookies = driver.get_cookies()
    user_agent = driver.execute_script("return navigator.userAgent")
    redirects = RecordingRedirectHandler(cookies)
    opener = build_opener(redirects)
    request = Request(base, headers={
        "Accept": "application/pdf,*/*",
        "Accept-Encoding": "identity",
        "User-Agent": user_agent,
    })
    cookie = cookie_header(cookies, base)
    if cookie:
        request.add_unredirected_header("Cookie", cookie)
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read()
            status = int(getattr(response, "status", 0) or response.getcode() or 0)
            mime = response.headers.get_content_type().lower()
            metadata = {
                "status": status,
                "mimeType": mime,
                "finalUrl": response.geturl(),
                "etag": response.headers.get("ETag", ""),
                "lastModified": response.headers.get("Last-Modified", ""),
                "contentLength": response.headers.get("Content-Length", ""),
                "redirects": redirects.redirects,
            }
    except Exception as exc:
        return None, {"status": "live-byte-unbound", "error": str(exc)[:200],
                      "redirects": redirects.redirects}
    if not 200 <= status < 300 or mime != "application/pdf" or \
            len(body) < 500 or not body.startswith(b"%PDF-"):
        return None, {"status": "live-byte-unbound", **metadata, "bytes": len(body)}
    return body, {"status": "bound", **metadata, "bytes": len(body),
                  "sha256": hashlib.sha256(body).hexdigest()}


def atomically_replace(file: Path, body: bytes):
    with tempfile.NamedTemporaryFile(dir=file.parent, prefix=f".{file.name}.", suffix=".tmp",
                                     delete=False) as temporary:
        temporary.write(body)
        temporary.flush()
        temporary_path = Path(temporary.name)
    try:
        for attempt in range(6):
            try:
                temporary_path.replace(file)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        temporary_path.unlink(missing_ok=True)


def live_byte_binding(driver, base: str, file: Path, delivery: dict, timeout: float):
    body, cdp_error = cdp_pdf_body(driver, delivery)
    method = "cdp-response-body"
    fetch = None
    if body is None:
        body, fetch = authenticated_pdf_get(driver, base, timeout)
        method = "authenticated-full-get"
    if body is None:
        return {"status": "live-byte-unbound", "method": method,
                "cdpError": cdp_error, "fetch": fetch}
    digest = hashlib.sha256(body).hexdigest()
    prior = file_sha256(file)
    if digest != prior:
        atomically_replace(file, body)
    return {
        "status": "bound",
        "method": method,
        "sha256": digest,
        "cachedSha256Before": prior,
        "cacheRefreshed": digest != prior,
        "bytes": len(body),
        "cdpError": cdp_error,
        **({"fetch": fetch} if fetch else {}),
    }


def same_url_without_fragment(left: str, right: str):
    left_url = urlparse(left)
    right_url = urlparse(right)
    return (left_url.scheme.lower(), left_url.netloc.lower(), left_url.path,
            left_url.params, left_url.query) == (
        right_url.scheme.lower(), right_url.netloc.lower(), right_url.path,
        right_url.params, right_url.query)


def navigation_byte_proof(driver, delivery: dict, binding: dict):
    if not same_url_without_fragment(delivery.get("finalUrl", ""), binding.get("finalUrl", "")):
        return {"status": "live-byte-unbound", "reason": "final-url-changed"}
    body, body_error = cdp_pdf_body(driver, delivery)
    if body is not None:
        digest = hashlib.sha256(body).hexdigest()
        return {"status": "bound" if digest == binding.get("sha256") else "live-byte-changed",
                "method": "cdp-response-body", "sha256": digest, "bytes": len(body)}
    if delivery.get("fromDiskCache"):
        return {"status": "bound", "method": "browser-disk-cache",
                "sha256": binding.get("sha256"), "cdpError": body_error}
    etag = delivery.get("etag", "")
    if etag and not etag.lstrip().startswith("W/") and etag == binding.get("etag"):
        return {"status": "bound", "method": "strong-etag",
                "sha256": binding.get("sha256"), "etag": etag, "cdpError": body_error}
    return {"status": "live-byte-unbound", "reason": "response-body-unavailable",
            "cdpError": body_error, "etag": etag,
            "lastModified": delivery.get("lastModified"),
            "contentLength": delivery.get("contentLength")}


def navigate_clean(driver, url: str, timings: dict, live: bool):
    if live:
        phase = time.perf_counter()
        driver.get("about:blank")
        add_timing(timings, "navigationMs", phase)
        performance_events(driver)
    phase = time.perf_counter()
    driver.get(url)
    add_timing(timings, "navigationMs", phase)


def mask_components(mask: Image.Image):
    bounds = mask.getbbox()
    if not bounds:
        return []
    x0, y0, x1, y1 = bounds
    crop = mask.crop(bounds)
    width, height = crop.size
    values = bytearray(crop.tobytes())
    components = []
    for origin, value in enumerate(values):
        if not value:
            continue
        values[origin] = 0
        stack = [origin]
        count = 0
        left = right = origin % width
        top = bottom = origin // width
        while stack:
            position = stack.pop()
            x = position % width
            y = position // width
            count += 1
            left = min(left, x)
            right = max(right, x)
            top = min(top, y)
            bottom = max(bottom, y)
            for next_y in range(max(0, y - 1), min(height, y + 2)):
                row = next_y * width
                for next_x in range(max(0, x - 1), min(width, x + 2)):
                    candidate = row + next_x
                    if values[candidate]:
                        values[candidate] = 0
                        stack.append(candidate)
        component = {
            "pixels": count,
            "bounds": [x0 + left, y0 + top, x0 + right, y0 + bottom],
        }
        components.append(component)
    return sorted(components, key=lambda item: item["pixels"], reverse=True)


def largest_mask_component(mask: Image.Image):
    components = mask_components(mask)
    return components[0] if components else None


def screenshot_line_components(components):
    lines = []
    for component in sorted(components, key=lambda item: (item["bounds"][1], item["bounds"][0])):
        left, top, right, bottom = component["bounds"]
        height = bottom - top + 1
        def same_line(item):
            item_left, item_top, item_right, item_bottom = item["bounds"]
            vertical_overlap = min(item_bottom, bottom) - max(item_top, top) + 1
            horizontal_overlap = min(item_right, right) - max(item_left, left) + 1
            vertical_gap = max(top, item_top) - min(bottom, item_bottom) - 1
            return vertical_overlap >= min(
                height, item_bottom - item_top + 1,
            ) * 0.35 or horizontal_overlap > 0 and 0 <= vertical_gap <= 1
        line = next((item for item in lines if same_line(item)), None)
        if line is None:
            lines.append({"bounds": [left, top, right, bottom], "pixels": component["pixels"],
                          "components": [component]})
        else:
            bounds = line["bounds"]
            line["bounds"] = [min(bounds[0], left), min(bounds[1], top),
                              max(bounds[2], right), max(bounds[3], bottom)]
            line["pixels"] += component["pixels"]
            line["components"].append(component)
    return sorted(lines, key=lambda item: (item["bounds"][1], item["bounds"][0]))


def visible_pdf_page_bounds(image: Image.Image):
    red, green, blue = image.split()
    page_mask = ImageChops.multiply(
        ImageChops.multiply(channel_mask(red, 235, 255), channel_mask(green, 235, 255)),
        channel_mask(blue, 235, 255),
    )
    return largest_mask_component(page_mask)


def pdf_line_viewer_rect(line, page_size, page_rect):
    pdf_width, pdf_height = page_size
    scale_x = page_rect["width"] / max(1.0, pdf_width)
    scale_y = page_rect["height"] / max(1.0, pdf_height)
    left, bottom, right, top = line
    return [
        page_rect["x"] + left * scale_x,
        page_rect["y"] + (pdf_height - top) * scale_y,
        page_rect["x"] + right * scale_x,
        page_rect["y"] + (pdf_height - bottom) * scale_y,
    ], scale_x, scale_y


def pdf_paint_geometry_proof(paint: dict, image: Image.Image | None,
                             expected: dict | None,
                             observed_mask: Image.Image | None = None):
    components = paint.get("components") or []
    if image is None or not expected or not expected.get("lineBounds"):
        return {"status": "pdf-paint-geometry-unverified", "components": components,
                "expected": expected}
    if observed_mask is None:
        # Synthetic/unit callers may provide only component bounds. Production
        # always supplies the full RGB control delta so coverage and extras are
        # assessed pixel-for-pixel rather than by fragile component counts.
        observed_mask = Image.new("L", image.size, 0)
        draw = ImageDraw.Draw(observed_mask)
        for component in components:
            draw.rectangle(component["bounds"], fill=255)
    components = mask_components(observed_mask)
    if not components:
        return {"status": "pdf-paint-geometry-unverified", "components": [],
                "expected": expected}
    observed = screenshot_line_components(components)
    page = visible_pdf_page_bounds(image)
    if not page:
        return {"status": "pdf-paint-page-geometry-missing", "components": components,
                "observedLines": observed, "expected": expected}
    page_left, page_top, page_right, page_bottom = page["bounds"]
    page_rect = {
        "x": page_left, "y": page_top,
        "width": max(1, page_right - page_left + 1),
        "height": max(1, page_bottom - page_top + 1),
    }
    projected = []
    allowed = Image.new("L", image.size, 0)
    allowed_draw = ImageDraw.Draw(allowed)
    for line_index, line in enumerate(expected["lineBounds"]):
        rect, scale_x, scale_y = pdf_line_viewer_rect(
            line, expected["pageSize"], page_rect,
        )
        tolerance = max(3.0, 1.5 * max(scale_x, scale_y))
        clipped = [
            max(0.0, rect[0]), max(0.0, rect[1]),
            min(float(image.width - 1), rect[2]),
            min(float(image.height - 1), rect[3]),
        ]
        if clipped[0] > clipped[2] or clipped[1] > clipped[3]:
            continue
        padded = [
            max(0, int(clipped[0] - tolerance)),
            max(0, int(clipped[1] - tolerance)),
            min(image.width - 1, int(clipped[2] + tolerance + 0.999)),
            min(image.height - 1, int(clipped[3] + tolerance + 0.999)),
        ]
        allowed_draw.rectangle(padded, fill=255)
        projected.append({
            "line": line_index, "rect": clipped, "padded": padded,
            "tolerance": tolerance, "scale": [scale_x, scale_y],
        })
    if len(projected) != len(expected["lineBounds"]):
        return {"status": "pdf-paint-geometry-mismatch", "components": components,
                "observedLines": observed, "expected": expected,
                "projectedLines": projected}

    comparisons = []
    for item in projected:
        left = max(0, int(item["rect"][0]))
        top = max(0, int(item["rect"][1]))
        right = min(image.width, int(item["rect"][2] + 1.999))
        bottom = min(image.height, int(item["rect"][3] + 1.999))
        width = max(1, right - left)
        height = max(1, bottom - top)
        inside = mask_count(observed_mask.crop((left, top, right, bottom)))
        edge_width = max(1, min(width, int(width * 0.35 + 0.999)))
        left_pixels = mask_count(observed_mask.crop(
            (left, top, min(right, left + edge_width), bottom),
        ))
        right_pixels = mask_count(observed_mask.crop(
            (max(left, right - edge_width), top, right, bottom),
        ))
        minimum = max(2, min(20, round(width * height * 0.02)))
        comparisons.append({
            "expectedLine": item["line"],
            "expectedRect": [round(value, 2) for value in item["rect"]],
            "tolerance": round(item["tolerance"], 2),
            "insidePixels": inside,
            "endpointPixels": [left_pixels, right_pixels],
            "mapped": inside >= minimum and min(left_pixels, right_pixels) >= 1,
        })
    total = mask_count(observed_mask)
    outside = mask_count(ImageChops.multiply(observed_mask, ImageChops.invert(allowed)))
    outside_limit = max(8, round(total * 0.02))
    if not all(item["mapped"] for item in comparisons):
        status = "pdf-paint-geometry-mismatch"
    elif outside > outside_limit:
        status = "pdf-paint-geometry-extraneous"
    else:
        status = "pdf-paint-geometry-exact"
    return {
        "status": status,
        "components": components, "observedLines": observed,
        "pageBounds": page["bounds"],
        "pageScale": projected[0]["scale"],
        "expected": expected, "comparisons": comparisons,
        "deltaPixels": total, "outsidePixels": outside,
        "outsidePixelLimit": outside_limit,
        "deltaMethod": paint.get("deltaMethod", "component-bounds"),
    }


def pdf_natural_landing_geometry_proof(paint: dict, image: Image.Image | None,
                                       expected_by_page: dict, viewport: dict,
                                       required_page: int, required: dict | None):
    """Match every initially visible highlight to its PDF page/Y without moving it."""
    if image is None or not expected_by_page or not required:
        return {"status": "pdf-natural-paint-geometry-unverified"}
    natural_mask = target_mask(image, "pdf")
    components = mask_components(natural_mask)
    if not components:
        return {"status": "pdf-natural-paint-geometry-unverified"}
    page_rects = viewport.get("pageRects") or {}
    viewport_size = viewport.get("size") or {}
    # getPageScreenRect() is relative to the PDF OOPIF, whereas WebDriver's
    # screenshot includes Chrome's left sidebar and top toolbar. The OOPIF is
    # bottom/right aligned in the captured content viewport.
    origin_x = max(0.0, image.width - float(viewport_size.get("width") or image.width))
    origin_y = max(0.0, image.height - float(viewport_size.get("height") or image.height))
    projected = []
    allowed = Image.new("L", image.size, 0)
    allowed_draw = ImageDraw.Draw(allowed)
    for page, expected in expected_by_page.items():
        page_rect = page_rects.get(str(page)) or page_rects.get(page)
        if not page_rect or page_rect.get("width", 0) <= 0 or page_rect.get("height", 0) <= 0:
            continue
        page_rect = {**page_rect, "x": page_rect["x"] + origin_x,
                     "y": page_rect["y"] + origin_y}
        for line_index, line in enumerate(expected.get("lineBounds") or []):
            rect, scale_x, scale_y = pdf_line_viewer_rect(
                line, expected["pageSize"], page_rect,
            )
            clipped = [
                max(0.0, rect[0]), max(0.0, rect[1]),
                min(float(image.width - 1), rect[2]),
                min(float(image.height - 1), rect[3]),
            ]
            if clipped[0] <= clipped[2] and clipped[1] <= clipped[3]:
                tolerance = max(3.0, 1.5 * max(scale_x, scale_y))
                padded = [
                    max(0, int(clipped[0] - tolerance)),
                    max(0, int(clipped[1] - tolerance)),
                    min(image.width - 1, int(clipped[2] + tolerance + 0.999)),
                    min(image.height - 1, int(clipped[3] + tolerance + 0.999)),
                ]
                allowed_draw.rectangle(padded, fill=255)
                projected.append({
                    "page": page, "line": line_index, "rect": clipped,
                    "tolerance": tolerance, "padded": padded,
                })
    comparisons = []
    for item in projected:
        left, top, right, bottom = item["padded"]
        pixels = mask_count(natural_mask.crop((left, top, right + 1, bottom + 1)))
        comparisons.append({
            "page": item["page"], "expectedLine": item["line"],
            "expectedRect": [round(value, 2) for value in item["rect"]],
            "tolerance": round(item["tolerance"], 2), "pixels": pixels,
        })
    required_lines = [item for item in comparisons
                      if item["page"] == required_page]
    if not required_lines:
        return {"status": "pdf-natural-target-outside-viewport",
                "comparisons": comparisons}
    if any(item["pixels"] < 2 for item in required_lines):
        return {"status": "pdf-natural-target-geometry-mismatch",
                "comparisons": comparisons}
    total = mask_count(natural_mask)
    outside = mask_count(ImageChops.multiply(natural_mask, ImageChops.invert(allowed)))
    outside_limit = max(8, round(total * 0.02))
    if outside > outside_limit:
        return {"status": "pdf-natural-paint-geometry-extraneous",
                "comparisons": comparisons, "outsidePixels": outside,
                "outsidePixelLimit": outside_limit}
    return {
        "status": "pdf-natural-landing-geometry-exact",
        "observedLines": screenshot_line_components(components),
        "projectedLines": projected,
        "comparisons": comparisons,
        "requiredRects": [item["expectedRect"] for item in required_lines],
        "outsidePixels": outside, "outsidePixelLimit": outside_limit,
        "viewportOrigin": [origin_x, origin_y],
    }


def combined_pdf_geometries(selected: list[dict], geometries: dict):
    combined = {}
    for page_index in sorted({item["span"][0] for item in selected}):
        page_geometries = [geometries.get(tuple(item["span"])) for item in selected
                           if item["span"][0] == page_index]
        page_geometries = [item for item in page_geometries if item]
        if not page_geometries:
            continue
        combined[page_index + 1] = {
            "page": page_index + 1,
            "pageSize": page_geometries[0]["pageSize"],
            "lineBounds": merge_pdf_line_boxes([
                line for item in page_geometries for line in item["lineBounds"]
            ]),
            "directivesOnPage": len(page_geometries),
        }
    return combined


def components_agree(left: dict | None, right: dict | None):
    if not left or not right:
        return False
    width = right["bounds"][2] - right["bounds"][0] + 1
    height = right["bounds"][3] - right["bounds"][1] + 1
    if right["pixels"] < 3 or width < 2 or height < 2:
        return False
    if any(abs(a - b) > 1 for a, b in zip(left["bounds"], right["bounds"])):
        return False
    tolerance = max(2, round(max(left["pixels"], right["pixels"]) * 0.02))
    return abs(left["pixels"] - right["pixels"]) <= tolerance


def component_sets_agree(left: list[dict] | None, right: list[dict] | None):
    if not left or not right or len(left) != len(right):
        return False
    ordered_left = sorted(left, key=lambda item: item["bounds"])
    ordered_right = sorted(right, key=lambda item: item["bounds"])
    return all(components_agree(one, two) for one, two in zip(ordered_left, ordered_right))


def pdf_page_visible(image: Image.Image):
    # Chrome's empty PDF canvas is dark gray; a rendered legal-document page
    # contains a substantial near-white area even before text is inspected.
    red, green, blue = image.split()
    light = ImageChops.multiply(
        ImageChops.multiply(channel_mask(red, 235, 255), channel_mask(green, 235, 255)),
        channel_mask(blue, 235, 255),
    )
    return mask_count(light) >= image.width * image.height * 0.05


PDF_NATURAL_VIEWPORT_SCRIPT = r"""
const pages = (arguments[0] || []).map(Number);
const viewer = window.viewer || document.querySelector('pdf-viewer');
if (!viewer) return {status: 'viewer-missing'};
if (viewer.loaded !== undefined && viewer.loaded !== null) await viewer.loaded;
let viewport;
try {
  viewport = viewer.viewport;
} catch (error) {
  return {status: 'viewport-not-ready', error: String(error)};
}
if (!viewport || typeof viewport.getMostVisiblePage !== 'function' ||
    typeof viewport.getPageScreenRect !== 'function') {
  return {status: 'viewport-not-ready'};
}
try {
  const size = viewport.size;
  const documentDimensions = viewport.documentDimensions ?? viewer.documentDimensions;
  if (!size || !(size.width > 0) || !(size.height > 0) ||
      !documentDimensions || !(documentDimensions.width > 0) ||
      !(documentDimensions.height > 0)) {
    return {status: 'viewport-not-ready', size, documentDimensions};
  }
  const pageRects = {};
  for (const page of pages) pageRects[page] = viewport.getPageScreenRect(page - 1);
  return {
    status: 'ready', currentPage: viewport.getMostVisiblePage() + 1,
    position: {x: viewport.position?.x ?? null, y: viewport.position?.y ?? null},
    size: {width: size.width, height: size.height}, documentDimensions, pageRects,
  };
} catch (error) {
  return {status: 'viewport-not-ready', error: String(error)};
}
"""


def stable_natural_pdf_highlight(driver, pdf_oopif, page: int, pages: list[int],
                                 timeout: float, timings: dict):
    """Capture the untouched text-fragment landing; this helper never fits or scrolls."""
    deadline = time.time() + timeout
    previous = None
    last_state = None
    last_paint = None
    last_image = None
    polls = 0
    stable_empty_since = None
    previous_empty = None
    while time.time() < deadline:
        state = pdf_oopif.evaluate(PDF_NATURAL_VIEWPORT_SCRIPT, pages)
        phase = time.perf_counter()
        png = driver.get_screenshot_as_png()
        add_timing(timings, "screenshotMs", phase)
        phase = time.perf_counter()
        image = Image.open(io.BytesIO(png)).convert("RGB")
        mask = target_mask(image, "pdf")
        components = mask_components(mask)
        add_timing(timings, "pixelAnalysisMs", phase)
        polls += 1
        paint = {
            "status": "captured", "polls": polls,
            "highlightPixels": mask_count(mask), "components": components,
            "deltaPixels": mask_count(mask),
            "screenshotSha256": hashlib.sha256(png).hexdigest(),
            "viewport": state,
        }
        stable_key = json.dumps({
            "screenshot": paint["screenshotSha256"], "viewport": state,
        }, sort_keys=True, separators=(",", ":"))
        empty_key = json.dumps({
            "mask": hashlib.sha256(mask.tobytes()).hexdigest(), "viewport": state,
        }, sort_keys=True, separators=(",", ":"))
        if state.get("status") == "ready" and state.get("currentPage") == page and \
                components and previous == stable_key:
            paint["status"] = "stable-highlight"
            return paint, png, image
        ready_empty = state.get("status") == "ready" and \
            state.get("currentPage") == page and not components
        if ready_empty and previous_empty == empty_key:
            stable_empty_since = stable_empty_since or time.time()
            if time.time() - stable_empty_since >= 0.75:
                paint["status"] = "stable-no-highlight"
                return paint, png, image
        else:
            stable_empty_since = None
        previous_empty = empty_key if ready_empty else None
        previous = stable_key if state.get("status") == "ready" else None
        last_state, last_paint, last_image = state, paint, image
        phase = time.perf_counter()
        time.sleep(0.08)
        add_timing(timings, "pollSleepMs", phase)
    return {
        **(last_paint or {"highlightPixels": 0, "components": [], "deltaPixels": 0}),
        "status": "pdf-natural-landing-unstable", "polls": polls,
        "expectedPage": page, "viewport": last_state,
    }, b"", last_image


PDF_PAGE_STATE_SCRIPT = r"""
const wantedPage = Number(arguments[0]);
const prepare = Boolean(arguments[1]);
const navigate = Boolean(arguments[2]);
const viewer = window.viewer || document.querySelector('pdf-viewer');
if (!viewer) return {status: 'viewer-missing'};
if (viewer.loaded !== undefined && viewer.loaded !== null) await viewer.loaded;
let viewport;
try {
  viewport = viewer.viewport;
} catch (error) {
  return {status: 'viewport-not-ready', error: String(error)};
}
if (!viewport || typeof viewport.getMostVisiblePage !== 'function' ||
    typeof viewport.fitToPage !== 'function' ||
    (navigate && typeof viewport.goToPage !== 'function')) {
  return {status: 'viewport-not-ready'};
}
try {
  const size = viewport.size;
  const documentDimensions = viewport.documentDimensions ?? viewer.documentDimensions;
  if (!size || !(size.width > 0) || !(size.height > 0) ||
      !documentDimensions || !(documentDimensions.width > 0) ||
      !(documentDimensions.height > 0)) {
    return {status: 'viewport-not-ready', size, documentDimensions};
  }
  if (prepare) {
    viewport.fitToPage();
    if (navigate) viewport.goToPage(wantedPage - 1);
  }
  return {
    status: 'ready', currentPage: viewport.getMostVisiblePage() + 1,
    size, documentDimensions,
  };
} catch (error) {
  return {status: 'viewport-not-ready', error: String(error)};
}
"""


def wait_pdf_page(pdf_oopif, page: int, timeout: float, timings: dict, *, navigate: bool):
    deadline = time.time() + timeout
    started = time.perf_counter()
    requested = False
    last = None
    polls = 0
    try:
        while time.time() < deadline:
            last = pdf_oopif.evaluate(PDF_PAGE_STATE_SCRIPT, page, not requested, navigate)
            polls += 1
            if last.get("status") == "ready":
                requested = True
                if last.get("currentPage") == page:
                    return {"status": "ready", "page": page, "polls": polls}
            phase = time.perf_counter()
            time.sleep(0.05)
            add_timing(timings, "pollSleepMs", phase)
        return {
            "status": "pdf-page-not-reached", "page": page, "polls": polls,
            "currentPage": (last or {}).get("currentPage"),
            "viewerStatus": (last or {}).get("status"),
        }
    finally:
        add_timing(timings, "pdfPageNavigationMs", started)


def stable_control_screenshot(driver, timeout: float, timings: dict):
    deadline = time.time() + timeout
    previous = None
    polls = 0
    while time.time() < deadline:
        phase = time.perf_counter()
        png = driver.get_screenshot_as_png()
        add_timing(timings, "screenshotMs", phase)
        digest = hashlib.sha256(png).hexdigest()
        image = Image.open(io.BytesIO(png)).convert("RGB")
        visible = pdf_page_visible(image)
        polls += 1
        if visible and previous and previous[0] == digest:
            mask = target_mask(image, "pdf")
            return mask, image, {
                "status": "stable", "polls": polls, "screenshotSha256": digest,
                "highlightPixels": mask_count(mask), "highlightBounds": mask.getbbox(),
            }
        previous = (digest, png) if visible else None
        phase = time.perf_counter()
        time.sleep(0.1)
        add_timing(timings, "pollSleepMs", phase)
    return None, None, {"status": "unstable", "polls": polls,
                        "screenshotSha256": previous[0] if previous else None}


def stable_highlight_delta(driver, control_mask: Image.Image,
                           control_image: Image.Image, timeout: float, timings: dict):
    deadline = time.time() + timeout
    previous = None
    last = None
    polls = 0
    while time.time() < deadline:
        phase = time.perf_counter()
        png = driver.get_screenshot_as_png()
        add_timing(timings, "screenshotMs", phase)
        phase = time.perf_counter()
        image = Image.open(io.BytesIO(png)).convert("RGB")
        target_delta = ImageChops.subtract(target_mask(image, "pdf"), control_mask)
        target_pixels = mask_count(target_delta)
        delta = target_delta if target_pixels else rgb_delta_mask(image, control_image)
        if delta is None:
            delta = target_delta
        delta_method = "target-color-delta" if target_pixels else "rgb-control-delta"
        components = mask_components(delta)
        add_timing(timings, "pixelAnalysisMs", phase)
        polls += 1
        last = (png, image, delta, components)
        if component_sets_agree(previous, components):
            largest = components[0]
            return {
                "status": "stable-delta",
                "polls": polls,
                "highlightPixels": sum(item["pixels"] for item in components),
                "highlightBounds": largest["bounds"],
                "components": components,
                "deltaPixels": mask_count(delta),
                "targetColorDeltaPixels": target_pixels,
                "deltaMethod": delta_method,
                "deltaSha256": hashlib.sha256(delta.tobytes()).hexdigest(),
                "screenshotSha256": hashlib.sha256(png).hexdigest(),
            }, png, image, delta
        previous = components
        phase = time.perf_counter()
        time.sleep(0.08)
        add_timing(timings, "pollSleepMs", phase)
    png, image, delta, components = last if last else (b"", None, None, [])
    return {
        "status": "no-stable-delta",
        "polls": polls,
        "highlightPixels": sum(item["pixels"] for item in components),
        "highlightBounds": components[0]["bounds"] if components else None,
        "components": components,
        "deltaPixels": mask_count(delta) if delta else 0,
        "screenshotSha256": hashlib.sha256(png).hexdigest() if png else None,
    }, png, image, delta


def pdf_combined_verdict(combined_status: str, location_status: str):
    if combined_status != "exact":
        return combined_status
    return "exact-match" if location_status == "pdf-location-exact" else location_status


def pdf_single_page_intended_groups(proof: dict):
    groups = proof.get("intendedGroups") or []
    if not groups or any(len({span[0] for span in group}) != 1 for group in groups):
        return None
    return groups


def pdf_directive_union_verdict(intended_groups: list[list[tuple]], directive_proofs: list[dict]):
    if len(directive_proofs) != len(intended_groups):
        return "pdf-directive-cardinality-mismatch"
    failed = next((item for item in directive_proofs if item.get("status") != "exact"), None)
    if failed:
        return failed.get("status", "pdf-directive-proof-failed")
    intended = sorted(tuple(span) for group in intended_groups for span in group)
    proved = sorted(tuple(span) for item in directive_proofs
                    for span in item.get("provedSpans", []))
    return "exact-match" if proved == intended else "pdf-directive-union-mismatch"


def pdf_reuses_combined_navigation(directive_count: int, combined_status: str):
    return directive_count == 1 and combined_status == "exact"


def pdf_seed_paint_proof(
    driver,
    pdf_oopif,
    server_origin: str,
    file: Path,
    cache_name: str,
    seed: dict,
    base: str,
    fragment: str,
    replay_id: str,
    cached_sha256: str,
    pdf_text_cache: dict,
    pdf_geometry_cache: dict,
    live_bindings: dict,
    timings: dict,
    *,
    live: bool,
    headed: bool,
    save_shots: bool,
):
    diagnosable_location_statuses = {
        "pdf-location-exact",
        "pdf-directive-extraneous",
        "pdf-directive-not-located",
        "pdf-incomplete-coverage",
    }
    anchor = fragment.split(":~:", 1)[0]
    viewer_timeout = 300.0 if live and headed else 60.0 if live else 15.0
    control_timeout = 20.0 if live else 8.0
    paint_timeout = 30.0 if live else 12.0
    control_fragment = f"#{anchor}" if anchor else ""
    proof = None
    if not live:
        phase = time.perf_counter()
        proof = pdf_proof(file, seed, pdf_text_cache)
        add_timing(timings, "pdfProofMs", phase)
        if proof.get("status") not in diagnosable_location_statuses:
            return {"verdict": proof.get("status", "pdf-proof-failed"), "proof": proof}

    # A single PDF text directive resolves one range. For groups contained on
    # one page, let Chrome reveal that range by its untouched landing, fit that
    # page without changing it, and compare the complete paint to PDFium. This
    # proves every directive without verifier scrolling. Page-spanning groups
    # retain the older page-wise proof below.
    single_page_groups = pdf_single_page_intended_groups(proof) if proof else None
    if live or single_page_groups is not None:
        combined_url = f"{base}#{fragment}" if live else (
            f"{server_origin}/page/{quote(cache_name)}?seed={replay_id}-combined#{fragment}"
        )
        navigate_clean(driver, combined_url, timings, live)
        combined_viewer = wait_pdf_viewer(pdf_oopif, viewer_timeout, timings)
        combined_fragment = final_fragment_proof(driver, fragment)
        combined_events = performance_events(driver) if live else []
        combined_delivery = delivery_proof(combined_events, base) if live else {
            "status": "cached-bytes", "finalUrl": combined_url,
        }
        binding = {"status": "bound", "method": "cached-file", "sha256": cached_sha256}
        combined_binding = None
        if live and combined_viewer.get("status") == "ready" and \
                combined_delivery.get("status") == "pdf-delivery-exact":
            binding = live_bindings.get(base)
            if binding is None:
                binding = live_byte_binding(driver, base, file, combined_delivery, viewer_timeout)
                binding["finalUrl"] = combined_delivery.get("finalUrl")
                binding["etag"] = combined_delivery.get("etag")
                binding["lastModified"] = combined_delivery.get("lastModified")
                binding["contentLength"] = combined_delivery.get("contentLength")
                fetched_url = ((binding.get("fetch") or {}).get("finalUrl"))
                if binding.get("status") == "bound" and fetched_url and not \
                        same_url_without_fragment(fetched_url, combined_delivery.get("finalUrl", "")):
                    binding = {**binding, "status": "live-byte-unbound",
                               "reason": "authenticated-fetch-final-url-differs"}
                if binding.get("status") == "bound":
                    live_bindings[base] = binding
                    pdf_text_cache.pop(file, None)
            combined_binding = navigation_byte_proof(driver, combined_delivery, binding)

        if combined_viewer.get("status") != "ready":
            combined_status = "pdf-combined-viewer-not-ready"
        elif combined_fragment.get("status") != "preserved":
            combined_status = "pdf-combined-fragment-lost"
        elif live and combined_delivery.get("status") != "pdf-delivery-exact":
            combined_status = combined_delivery.get("status", "pdf-delivery-unverified")
        elif live and (not combined_binding or combined_binding.get("status") != "bound"):
            combined_status = (combined_binding or binding).get("status", "live-byte-unbound")
        else:
            combined_status = "exact"

        if proof is None and binding.get("status") == "bound":
            phase = time.perf_counter()
            proof = pdf_proof(file, seed, pdf_text_cache)
            add_timing(timings, "pdfProofMs", phase)
            if proof.get("status") not in diagnosable_location_statuses:
                return {
                    "verdict": proof.get("status", "pdf-proof-failed"), "proof": proof,
                    "combinedProof": {
                        "status": combined_status, "url": combined_url,
                        "viewer": combined_viewer, "fragment": combined_fragment,
                        "delivery": combined_delivery,
                    },
                    "byteBinding": binding,
                }
            single_page_groups = pdf_single_page_intended_groups(proof)

        if single_page_groups is not None:
            intended_items = [
                {"span": span} for group in single_page_groups for span in group
            ]
            phase = time.perf_counter()
            geometries = pdf_span_geometries(file, intended_items, pdf_geometry_cache)
            add_timing(timings, "pdfGeometryMs", phase)
            group_expectations = []
            for group in single_page_groups:
                items = [{"span": span} for span in group]
                expected_by_page = combined_pdf_geometries(items, geometries)
                group_expectations.append(expected_by_page)

            directive_proofs = []
            directives = raw_directives(seed["target"])
            for directive_index, (directive, group, expected_by_page) in enumerate(zip(
                    directives, single_page_groups, group_expectations)):
                expected_page = group[0][0] + 1
                individual_fragment = f"{anchor}:~:text={directive}"
                reuse_combined = pdf_reuses_combined_navigation(
                    len(directives), combined_status,
                )
                if reuse_combined:
                    navigation_url = combined_url
                    directive_viewer = combined_viewer
                    directive_fragment = combined_fragment
                    directive_delivery = combined_delivery
                    directive_binding = combined_binding
                else:
                    navigation_url = f"{base}#{individual_fragment}" if live else (
                        f"{server_origin}/page/{quote(cache_name)}?seed={replay_id}-{directive_index}"
                        f"#{individual_fragment}"
                    )
                    navigate_clean(driver, navigation_url, timings, live)
                    directive_viewer = wait_pdf_viewer(pdf_oopif, viewer_timeout, timings)
                    directive_fragment = final_fragment_proof(driver, individual_fragment)
                page_landing = wait_pdf_page(
                    pdf_oopif, expected_page, paint_timeout, timings, navigate=False,
                ) if directive_viewer.get("status") == "ready" else {
                    "status": "viewer-not-ready", "page": expected_page, "polls": 0,
                }
                paint, png, image = stable_natural_pdf_highlight(
                    driver, pdf_oopif, expected_page, [expected_page],
                    paint_timeout, timings,
                ) if page_landing.get("status") == "ready" else (
                    {"status": "not-captured", "components": [], "polls": 0}, b"", None,
                )
                expected = expected_by_page.get(expected_page)
                paint_geometry = pdf_natural_landing_geometry_proof(
                    paint, image, expected_by_page, paint.get("viewport") or {},
                    expected_page, expected,
                )
                if not reuse_combined:
                    directive_events = performance_events(driver) if live else []
                    directive_delivery = delivery_proof(directive_events, base) if live else {
                        "status": "cached-bytes", "finalUrl": navigation_url,
                    }
                    directive_binding = navigation_byte_proof(
                        driver, directive_delivery, binding,
                    ) if live and directive_delivery.get("status") == "pdf-delivery-exact" else None
                if directive_viewer.get("status") != "ready":
                    status = "pdf-viewer-not-ready"
                elif directive_fragment.get("status") != "preserved":
                    status = "pdf-fragment-lost"
                elif live and directive_delivery.get("status") != "pdf-delivery-exact":
                    status = directive_delivery.get("status", "pdf-delivery-unverified")
                elif live and (not directive_binding or directive_binding.get("status") != "bound"):
                    status = (directive_binding or {}).get("status", "live-byte-unbound")
                elif page_landing.get("status") != "ready":
                    status = "pdf-page-landing-mismatch"
                elif paint.get("status") != "stable-highlight":
                    status = "pdf-no-paint"
                elif paint_geometry.get("status") != "pdf-natural-landing-geometry-exact":
                    status = paint_geometry.get("status", "pdf-natural-paint-geometry-unverified")
                else:
                    status = "exact"
                directive_proof = {
                    "status": status, "directive": unquote(directive),
                    "url": navigation_url, "viewer": directive_viewer,
                    "fragment": directive_fragment, "delivery": directive_delivery,
                    "pageLanding": page_landing, "paint": paint,
                    "paintGeometry": paint_geometry, "intendedGroup": group,
                    "provedSpans": group if status == "exact" else [],
                    "reusedCombinedNavigation": reuse_combined,
                    **({"byteBinding": directive_binding} if directive_binding else {}),
                }
                if save_shots and status == "exact" and image is not None and \
                        paint.get("components"):
                    phase = time.perf_counter()
                    shot_name = safe_name(seed["label"], directive_index)
                    x0, y0, x1, y1 = paint["components"][0]["bounds"]
                    image.crop((max(0, x0 - 12), max(0, y0 - 12),
                                min(image.width, x1 + 13), min(image.height, y1 + 13))).save(
                                    SHOTS / shot_name, compress_level=1, optimize=False)
                    directive_proof["screenshot"] = shot_name
                    add_timing(timings, "artifactWriteMs", phase)
                directive_proofs.append(directive_proof)

            union_verdict = pdf_directive_union_verdict(
                single_page_groups, directive_proofs,
            )
            verdict = union_verdict if combined_status == "exact" else combined_status
            timings["polls"] = sum(
                item.get("pageLanding", {}).get("polls", 0) +
                item.get("paint", {}).get("polls", 0)
                for item in directive_proofs
            )
            return {
                "verdict": verdict, "verificationContract": PDF_PAINT_CONTRACT,
                "proof": proof, "combinedProof": {
                    "status": combined_status, "url": combined_url,
                    "viewer": combined_viewer, "fragment": combined_fragment,
                    "delivery": combined_delivery,
                    **({"byteBinding": combined_binding} if combined_binding else {}),
                },
                "directiveProofs": directive_proofs, "byteBinding": binding,
                "directiveUnion": {
                    "status": union_verdict,
                    "intended": [span for group in single_page_groups for span in group],
                    "proved": [span for item in directive_proofs
                               for span in item.get("provedSpans", [])],
                },
            }

    control_url = f"{base}{control_fragment}" if live else (
        f"{server_origin}/page/{quote(cache_name)}?seed={replay_id}-control{control_fragment}"
    )
    navigate_clean(driver, control_url, timings, live)
    viewer = wait_pdf_viewer(pdf_oopif, viewer_timeout, timings)
    fragment_proof = final_fragment_proof(driver, anchor) if live else {
        "status": "cached-local", "wanted": anchor, "currentUrl": driver.current_url,
    }
    control_mask, _control_image, control = stable_control_screenshot(
        driver, control_timeout, timings,
    ) if viewer.get("status") == "ready" else (
        None, None, {"status": "not-captured"},
    )
    events = performance_events(driver) if live else []
    delivery = delivery_proof(events, base) if live else {
        "status": "cached-bytes", "finalUrl": control_url,
    }
    control_bundle = {
        "url": control_url,
        "viewer": viewer,
        "fragment": fragment_proof,
        "delivery": delivery,
        "screenshot": control,
    }
    if viewer.get("status") != "ready":
        return {"verdict": "pdf-viewer-not-ready", "controlProof": control_bundle}
    if live and fragment_proof.get("status") != "preserved":
        return {"verdict": "pdf-fragment-lost", "controlProof": control_bundle}
    if live and delivery.get("status") != "pdf-delivery-exact":
        return {"verdict": delivery.get("status", "pdf-delivery-unverified"),
                "controlProof": control_bundle}
    if control_mask is None or control.get("status") != "stable":
        return {"verdict": "pdf-control-unstable", "controlProof": control_bundle}

    binding = {"status": "bound", "method": "cached-file", "sha256": cached_sha256}
    if live:
        binding = live_bindings.get(base)
        if binding is None:
            binding = live_byte_binding(driver, base, file, delivery, viewer_timeout)
            binding["finalUrl"] = delivery.get("finalUrl")
            binding["etag"] = delivery.get("etag")
            binding["lastModified"] = delivery.get("lastModified")
            binding["contentLength"] = delivery.get("contentLength")
            fetched_url = ((binding.get("fetch") or {}).get("finalUrl"))
            if binding.get("status") == "bound" and fetched_url and not same_url_without_fragment(
                    fetched_url, delivery.get("finalUrl", "")):
                binding = {**binding, "status": "live-byte-unbound",
                           "reason": "authenticated-fetch-final-url-differs"}
            if binding.get("status") == "bound":
                live_bindings[base] = binding
                pdf_text_cache.pop(file, None)
        else:
            navigation_binding = navigation_byte_proof(driver, delivery, binding)
            if navigation_binding.get("status") != "bound":
                return {"verdict": navigation_binding["status"], "controlProof": control_bundle,
                        "byteBinding": binding, "navigationByteBinding": navigation_binding}
            control_bundle["navigationByteBinding"] = navigation_binding
        if binding.get("status") != "bound":
            return {"verdict": "live-byte-unbound", "controlProof": control_bundle,
                    "byteBinding": binding}

    if proof is None:
        phase = time.perf_counter()
        proof = pdf_proof(file, seed, pdf_text_cache)
        add_timing(timings, "pdfProofMs", phase)
    if proof.get("status") not in diagnosable_location_statuses:
        return {"verdict": proof.get("status", "pdf-proof-failed"), "proof": proof,
                "controlProof": control_bundle, "byteBinding": binding}

    location_exact = proof.get("status") == "pdf-location-exact"
    expected_items = proof.get("selected", []) if location_exact else [
        {"span": span} for span in proof.get("intended", [])
    ]
    phase = time.perf_counter()
    geometries = pdf_span_geometries(file, expected_items, pdf_geometry_cache)
    add_timing(timings, "pdfGeometryMs", phase)
    for item in expected_items:
        item["geometry"] = geometries.get(tuple(item["span"]))
    if location_exact:
        for selected in proof.get("selected", []):
            selected["geometry"] = geometries.get(tuple(selected["span"]))
    combined_expectations = combined_pdf_geometries(expected_items, geometries)
    expected_pages = {item["span"][0] + 1 for item in expected_items}
    if set(combined_expectations) != expected_pages:
        return {
            "verdict": "pdf-geometry-missing", "proof": proof,
            "controlProof": control_bundle, "byteBinding": binding,
        }

    control_page_masks = {}
    control_page_images = {}
    control_page_proofs = []
    for page, expected in combined_expectations.items():
        page_navigation = wait_pdf_page(
            pdf_oopif, page, control_timeout, timings, navigate=True,
        )
        page_mask, page_image, page_screenshot = stable_control_screenshot(
            driver, control_timeout, timings,
        ) if page_navigation.get("status") == "ready" else (
            None, None, {"status": "not-captured", "polls": 0},
        )
        if page_navigation.get("status") != "ready":
            page_status = "pdf-control-page-not-reached"
        elif page_mask is None or page_screenshot.get("status") != "stable":
            page_status = "pdf-control-page-unstable"
        else:
            page_status = "exact"
            control_page_masks[page] = page_mask
            control_page_images[page] = page_image
        control_page_proofs.append({
            "status": page_status, "page": page, "navigation": page_navigation,
            "screenshot": page_screenshot, "expected": expected,
        })
    control_bundle["pages"] = control_page_proofs
    failed_control_pages = [item for item in control_page_proofs if item["status"] != "exact"]
    if failed_control_pages:
        return {
            "verdict": failed_control_pages[0]["status"], "proof": proof,
            "controlProof": control_bundle, "byteBinding": binding,
        }

    combined_url = f"{base}#{fragment}" if live else (
        f"{server_origin}/page/{quote(cache_name)}?seed={replay_id}-combined#{fragment}"
    )
    navigate_clean(driver, combined_url, timings, live)
    combined_viewer = wait_pdf_viewer(pdf_oopif, viewer_timeout, timings)
    combined_fragment = final_fragment_proof(driver, fragment) if live else {
        "status": "cached-local", "wanted": unquote(fragment), "currentUrl": driver.current_url,
    }
    natural_page = expected_items[0]["span"][0] + 1
    natural_paint, _natural_png, natural_image = stable_natural_pdf_highlight(
        driver, pdf_oopif, natural_page, list(combined_expectations), paint_timeout, timings,
    ) if combined_viewer.get("status") == "ready" else (
        {"status": "viewer-not-ready", "polls": 0, "components": []}, b"", None,
    )
    natural_geometry = pdf_natural_landing_geometry_proof(
        natural_paint, natural_image, combined_expectations,
        natural_paint.get("viewport") or {}, natural_page,
        expected_items[0].get("geometry"),
    )
    natural_status = natural_paint.get("status")
    if natural_status == "stable-highlight":
        natural_status = natural_geometry.get("status")
    natural_landing = {
        "status": "exact" if natural_status == "pdf-natural-landing-geometry-exact"
                  else natural_status,
        "page": natural_page, "paint": natural_paint,
        "paintGeometry": natural_geometry,
    }
    combined_page_proofs = []
    if natural_landing.get("status") == "exact":
        for page, expected in combined_expectations.items():
            if page == natural_page:
                combined_page_proofs.append({
                    "status": "exact", "page": page,
                    "navigation": {"status": "natural-landing", "page": page, "polls": 0},
                    "paint": natural_paint, "paintGeometry": natural_geometry,
                    "expected": expected,
                })
                continue
            page_navigation = wait_pdf_page(
                pdf_oopif, page, paint_timeout, timings, navigate=True,
            )
            delta, _png, image, observed_mask = stable_highlight_delta(
                driver, control_page_masks[page], control_page_images[page],
                paint_timeout, timings,
            ) if page_navigation.get("status") == "ready" else (
                {"status": "not-captured", "polls": 0, "highlightPixels": 0,
                 "highlightBounds": None, "components": []}, b"", None, None,
            )
            paint_geometry = pdf_paint_geometry_proof(
                delta, image, expected, observed_mask,
            )
            if page_navigation.get("status") != "ready":
                page_status = "pdf-combined-page-not-reached"
            elif paint_geometry.get("status") == "pdf-paint-geometry-exact":
                page_status = "exact"
            elif delta.get("status") != "stable-delta":
                page_status = "pdf-combined-no-paint"
            else:
                page_status = paint_geometry["status"]
            combined_page_proofs.append({
                "status": page_status, "page": page, "navigation": page_navigation,
                "paint": delta, "paintGeometry": paint_geometry, "expected": expected,
            })
    combined_events = performance_events(driver) if live else []
    combined_delivery = delivery_proof(combined_events, base) if live else {
        "status": "cached-bytes", "finalUrl": combined_url,
    }
    combined_binding = navigation_byte_proof(driver, combined_delivery, binding) if live and \
        combined_delivery.get("status") == "pdf-delivery-exact" else None
    failed_combined_pages = [item for item in combined_page_proofs
                             if item["status"] != "exact"]
    if combined_viewer.get("status") != "ready":
        combined_status = "pdf-combined-viewer-not-ready"
    elif natural_landing.get("status") != "exact":
        combined_status = "pdf-combined-natural-landing-mismatch"
    elif live and combined_fragment.get("status") != "preserved":
        combined_status = "pdf-combined-fragment-lost"
    elif live and combined_delivery.get("status") != "pdf-delivery-exact":
        combined_status = combined_delivery.get("status", "pdf-delivery-unverified")
    elif live and combined_binding.get("status") != "bound":
        combined_status = combined_binding.get("status", "live-byte-unbound")
    elif failed_combined_pages:
        combined_status = failed_combined_pages[0]["status"]
    else:
        combined_status = "exact"
    combined_proof = {
        "status": combined_status, "url": combined_url, "viewer": combined_viewer,
        "fragment": combined_fragment, "delivery": combined_delivery,
        "naturalLanding": natural_landing, "pages": combined_page_proofs,
        **({"byteBinding": combined_binding} if combined_binding else {}),
    }

    # The combined production URL is the contract. Once it paints every
    # intended page exactly, isolated reloads cannot strengthen that proof.
    if combined_status == "exact" and location_exact:
        return {
            "verdict": "exact-match",
            "verificationContract": PDF_PAINT_CONTRACT,
            "proof": proof,
            **({"pdfReplayDiagnostic": proof.get("status")} if not location_exact else {}),
            "controlProof": control_bundle,
            "combinedProof": combined_proof,
            "directiveProofs": [],
            "byteBinding": binding,
        }

    # PDFium replay is a fast diagnostic, not the browser oracle. When its
    # range reconstruction disagrees with the intended source span, the real
    # combined Chrome navigation above is authoritative and is compared
    # directly with the intended PDF geometry.
    if not location_exact:
        return {
            "verdict": pdf_combined_verdict(combined_status, proof.get("status")),
            "verificationContract": PDF_PAINT_CONTRACT,
            "proof": proof,
            "pdfReplayDiagnostic": proof.get("status"),
            "controlProof": control_bundle,
            "combinedProof": combined_proof,
            "directiveProofs": [],
            "byteBinding": binding,
        }

    directive_proofs = []
    for directive_index, directive in enumerate(raw_directives(seed["target"])):
        individual_fragment = f"{anchor}:~:text={directive}"
        navigation_url = f"{base}#{individual_fragment}" if live else (
            f"{server_origin}/page/{quote(cache_name)}?seed={replay_id}-{directive_index}"
            f"#{individual_fragment}"
        )
        navigate_clean(driver, navigation_url, timings, live)
        directive_viewer = wait_pdf_viewer(pdf_oopif, viewer_timeout, timings)
        directive_fragment = final_fragment_proof(driver, individual_fragment) if live else {
            "status": "cached-local", "wanted": unquote(individual_fragment),
            "currentUrl": driver.current_url,
        }
        expected_location = next((item for item in proof.get("selected", [])
                                  if item.get("directive") == unquote(directive)), None)
        expected_page = expected_location["span"][0] + 1 if expected_location else None
        page_landing = wait_pdf_page(
            pdf_oopif, expected_page, paint_timeout, timings, navigate=False,
        ) if directive_viewer.get("status") == "ready" and expected_page else {
            "status": "expected-location-missing", "page": expected_page, "polls": 0,
        }
        expected_geometry = expected_location.get("geometry") if expected_location else None
        directive_natural, _natural_png, directive_natural_image = \
            stable_natural_pdf_highlight(
                driver, pdf_oopif, expected_page, [expected_page],
                paint_timeout, timings,
            ) if page_landing.get("status") == "ready" else (
                {"status": "not-captured", "components": [], "polls": 0}, b"", None,
            )
        directive_natural_geometry = pdf_natural_landing_geometry_proof(
            directive_natural,
            directive_natural_image,
            {expected_page: expected_geometry} if expected_page and expected_geometry else {},
            directive_natural.get("viewport") or {},
            expected_page,
            expected_geometry,
        )
        directive_natural_status = directive_natural.get("status")
        if directive_natural_status == "stable-highlight":
            directive_natural_status = directive_natural_geometry.get("status")
        page_geometry_navigation = wait_pdf_page(
            pdf_oopif, expected_page, paint_timeout, timings, navigate=True,
        ) if directive_natural_status == "pdf-natural-landing-geometry-exact" else {
            "status": "natural-landing-not-proved", "page": expected_page, "polls": 0,
        }
        delta, png, image, observed_mask = stable_highlight_delta(
            driver, control_page_masks[expected_page],
            control_page_images[expected_page], paint_timeout, timings,
        ) if page_geometry_navigation.get("status") == "ready" else (
            {"status": "not-captured", "polls": 0, "highlightPixels": 0,
             "highlightBounds": None}, b"", None, None)
        directive_events = performance_events(driver) if live else []
        directive_delivery = delivery_proof(directive_events, base) if live else {
            "status": "cached-bytes", "finalUrl": navigation_url,
        }
        directive_binding = navigation_byte_proof(driver, directive_delivery, binding) if live and \
            directive_delivery.get("status") == "pdf-delivery-exact" else None
        paint_geometry = pdf_paint_geometry_proof(
            delta, image, expected_geometry,
            observed_mask,
        )
        if directive_viewer.get("status") != "ready":
            status = "pdf-viewer-not-ready"
        elif live and directive_fragment.get("status") != "preserved":
            status = "pdf-fragment-lost"
        elif live and directive_delivery.get("status") != "pdf-delivery-exact":
            status = directive_delivery.get("status", "pdf-delivery-unverified")
        elif live and directive_binding.get("status") != "bound":
            status = directive_binding.get("status", "live-byte-unbound")
        elif expected_location is None:
            status = "pdf-directive-not-located"
        elif page_landing.get("status") != "ready":
            status = "pdf-page-landing-mismatch"
        elif directive_natural_status != "pdf-natural-landing-geometry-exact":
            status = directive_natural_status
        elif page_geometry_navigation.get("status") != "ready":
            status = "pdf-page-geometry-navigation-mismatch"
        elif paint_geometry.get("status") == "pdf-paint-geometry-exact":
            status = "exact"
        elif delta.get("status") != "stable-delta":
            status = "pdf-no-paint"
        else:
            status = paint_geometry["status"]
        directive_proof = {
            "status": status,
            "directive": unquote(directive),
            "url": navigation_url,
            "viewer": directive_viewer,
            "fragment": directive_fragment,
            "delivery": directive_delivery,
            "paint": delta,
            "paintGeometry": paint_geometry,
            "expectedLocation": expected_location,
            "pageLanding": page_landing,
            "naturalLanding": {
                "status": "exact" if directive_natural_status ==
                "pdf-natural-landing-geometry-exact" else directive_natural_status,
                "paint": directive_natural,
                "paintGeometry": directive_natural_geometry,
            },
            "geometryNavigation": page_geometry_navigation,
            **({"byteBinding": directive_binding} if directive_binding else {}),
        }
        if save_shots and status == "exact" and image is not None:
            phase = time.perf_counter()
            shot_name = safe_name(seed["label"], directive_index)
            x0, y0, x1, y1 = delta["highlightBounds"]
            image.crop((max(0, x0 - 12), max(0, y0 - 12),
                        min(image.width, x1 + 13), min(image.height, y1 + 13))).save(
                            SHOTS / shot_name, compress_level=1, optimize=False)
            directive_proof["screenshot"] = shot_name
            add_timing(timings, "artifactWriteMs", phase)
        directive_proofs.append(directive_proof)

    timings["polls"] = control.get("polls", 0) + sum(
        item.get("screenshot", {}).get("polls", 0) for item in control_page_proofs
    ) + sum(
        item.get("paint", {}).get("polls", 0) for item in combined_page_proofs
    ) + sum(item.get("paint", {}).get("polls", 0) for item in directive_proofs)
    failed = [item for item in directive_proofs if item["status"] != "exact"]
    # Users open the combined production URL. Isolated directive reloads are
    # retained as diagnostics, but cannot overturn an exact combined paint.
    verdict = "exact-match" if combined_status == "exact" else combined_status
    return {
        "verdict": verdict,
        "verificationContract": PDF_PAINT_CONTRACT,
        "proof": proof,
        "controlProof": control_bundle,
        "combinedProof": combined_proof,
        "directiveProofs": directive_proofs,
        "byteBinding": binding,
        **({"failedDirectives": failed} if failed else {}),
    }


def run():
    install_cleanup_signal_handlers()
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int)
    parser.add_argument("--labels")
    parser.add_argument("--targets", type=Path, default=TARGETS)
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument(
        "--resume-terminal", action="store_true",
        help="reuse every fingerprint-current terminal verdict after an orchestrator restart",
    )
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--only", choices=("all", "html", "pdf"), default="all")
    parser.add_argument("--mine-oracle", action="store_true")
    parser.add_argument("--save-shots", action="store_true")
    parser.add_argument("--find-probe", action="store_true")
    parser.add_argument("--range-only", action="store_true")
    parser.add_argument("--range-cache-only", action="store_true")
    parser.add_argument("--refresh-rendered-cache", action="store_true")
    parser.add_argument("--pdf-proof-only", action="store_true")
    parser.add_argument("--live", action="store_true",
                        help="navigate live target URLs instead of cached pages")
    parser.add_argument("--headed", action="store_true",
                        help="show Chrome so challenges can be completed interactively")
    parser.add_argument("--exclude-proven-404", action="store_true")
    args = parser.parse_args()
    if not 0 <= args.shard_index < args.shard_count:
        raise ValueError("shard-index must be in [0, shard-count)")
    if args.live and (args.range_only or args.range_cache_only or args.pdf_proof_only):
        raise ValueError("--live is a final paint tier")
    corpus_targets = read_jsonl(args.targets)
    source_documents = {row["key"]: row["text"] for row in read_jsonl(DOCTEXT)
                        if row.get("key") and isinstance(row.get("text"), str)}
    source_contract_entries = load_result_cache_manifest(
        SOURCE_CONTRACT_CACHE, SOURCE_CONTRACT_CACHE_VERSION,
    )
    source_word_key = None
    source_index = None
    source_digest_cache = {}
    def source_contract(seed, is_pdf):
        nonlocal source_word_key, source_index
        key = source_document_key(seed)
        text = source_documents.get(key)
        if text is None:
            return canonical_source_contract(seed, None, is_pdf)
        identity = source_contract_cache_identity(seed, text, is_pdf)
        cached_entry = source_contract_entries.get(identity["fingerprint"])
        cached = (cached_entry.get("result") if isinstance(cached_entry, dict)
                  and cached_entry.get("identity") == identity else None)
        if cached is None:
            cached = read_source_contract_cache(identity)
        if cached is not None:
            source_contract_entries[identity["fingerprint"]] = {
                "identity": identity, "result": cached,
            }
            return cached
        if text is not None and source_word_key != key:
            source_index = source_token_index(source_words(text))
            source_word_key = key
        result = canonical_source_contract(
            seed, text, is_pdf,
            source_index["words"] if source_word_key == key else None,
            source_index if source_word_key == key else None,
        )
        write_source_contract_cache(identity, result)
        source_contract_entries[identity["fingerprint"]] = {
            "identity": identity, "result": result,
        }
        return result
    def source_digest(seed):
        key = source_document_key(seed)
        if key not in source_digest_cache:
            text = source_documents.get(key)
            source_digest_cache[key] = hashlib.sha256(text.encode()).hexdigest() if text else None
        return source_digest_cache[key]
    excluded_404 = [seed for seed in corpus_targets if is_proven_404_seed(seed)] \
        if args.exclude_proven_404 else []
    if args.exclude_proven_404 and len(excluded_404) != 1:
        raise RuntimeError(f"expected exactly one proven label+URL 404, found {len(excluded_404)}")
    gettable_targets = [seed for seed in corpus_targets if not is_proven_404_seed(seed)] \
        if excluded_404 else corpus_targets
    targets = [
        seed for seed in gettable_targets
        if int(hashlib.sha256(seed.get("target", "").split("#")[0].encode()).hexdigest(), 16) % args.shard_count == args.shard_index
    ]
    if args.labels:
        labels_path = Path(args.labels)
        accepted_label_verdict = "range-exact" if args.range_only else "exact-match"
        wanted = ({row["label"] for row in read_jsonl(labels_path)
                   if row.get("verdict") != accepted_label_verdict}
                  if labels_path.suffix == ".jsonl"
                  else set(labels_path.read_text(encoding="utf-8").splitlines()))
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
    for seed in gettable_targets:
        base = seed.get("target", "").split("#", 1)[0]
        name = hashlib.sha1(base.encode()).hexdigest() + ".html"
        file = LIVE_RENDERED_CACHE / name
        if file.is_file():
            row = {"url": base, "file": name, "liveRendered": True}
            manifest[url_key(base)] = row
            files[name] = file

    def cached_file(row):
        root = LIVE_RENDERED_CACHE if row.get("liveRendered") else CACHE
        return root / row["file"]
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
    discard_incomplete_jsonl_tail(out_path)
    digest_cache = {}
    def cached_digest(file: Path):
        stat = file.stat()
        identity = (str(file), stat.st_size, stat.st_mtime_ns)
        digest = digest_cache.get(identity)
        if digest is None:
            digest = file_sha256(file)
            digest_cache[identity] = digest
        return digest
    def cache_identity(file: Path):
        stat = file.stat()
        return {
            "file": file.name,
            "bytes": stat.st_size,
            "sha256": cached_digest(file),
        }
    def input_hash(seed):
        base = seed.get("target", "").split("#")[0]
        cached = manifest.get(url_key(base))
        file = cached_file(cached) if cached else None
        cache_identity = None
        if file and file.exists():
            stat = file.stat()
            cache_identity = [cached["file"], stat.st_size, stat.st_mtime_ns, cached_digest(file)]
        is_pdf = bool(PDF_RE.search(base) or file and file.suffix.lower() == ".pdf")
        mode = "pdfium-proof-v5-source-identity" if args.pdf_proof_only else "range-v2" if args.range_only \
            else "pdf-paint-v10-source-identity-live" if args.live and is_pdf \
            else "html-paint-v9-source-identity-live" if args.live \
            else "pdf-paint-v10-source-identity-cache" if is_pdf \
            else "paint-v9-source-identity"
        payload = {"seed": seed, "cache": cache_identity, "mode": mode,
                   "sourceDocument": None if args.range_only else source_digest(seed)}
        return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]

    fingerprints = {seed["label"]: input_hash(seed) for seed in targets}
    accepted = {"range-exact"} if args.range_only else {"exact-match"}
    def reusable_row(row):
        if row.get("verdict") not in accepted and not args.resume_terminal:
            return False
        if args.range_only:
            return True
        identity = row.get("cacheIdentity") or {}
        expected_contract = PDF_PAINT_CONTRACT if str(row.get("cacheFile", "")).lower().endswith(".pdf") \
            else HTML_PAINT_CONTRACT
        contract = row.get("verificationContract")
        if args.live and not row.get("cacheFile"):
            identity = row.get("liveIdentity") or {}
            if row.get("verdict") == "error" and args.resume_terminal and not identity:
                return row.get("sourceMode") == "live" and row.get("headed") is args.headed
            file = LIVE_RENDERED_CACHE / str(identity.get("file", ""))
            return contract == expected_contract and row.get("sourceMode") == "live" and \
                row.get("headed") is args.headed and file.is_file() and \
                file.stat().st_size == identity.get("bytes") and \
                len(identity.get("sha256", "")) == 64 and \
                cached_digest(file) == identity["sha256"]
        return (contract is None and args.resume_terminal or contract == expected_contract) and \
            row.get("sourceMode") == ("live" if args.live else "cache") and \
            row.get("headed") is args.headed and \
            identity.get("file") == row.get("cacheFile") and \
            len(identity.get("sha256", "")) == 64
    reusable = compact_reusable_jsonl(out_path, fingerprints, reusable_row)
    done = {label: row["inputHash"] for label, row in reusable.items()}
    pending = [
        seed for seed in targets if done.get(seed["label"]) != fingerprints[seed["label"]]
    ]
    if args.limit:
        pending = pending[:args.limit]
    pending.sort(key=lambda seed: seed.get("target", "").split("#")[0])
    if not pending:
        print(json.dumps({"workerSummary": {
            "inputRows": len(corpus_targets), "gettableRows": len(gettable_targets),
            "excluded404": len(excluded_404), "reused": len(targets), "pending": 0, "lifecycleMs": 0,
        }}), flush=True)
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
                contract = source_contract(seed, True)
                proof_seed = {**seed, "_sourceIdentities": contract.get("sourceIdentities") or []}
                proof = pdf_proof(CACHE / row["file"], proof_seed, text_cache) \
                    if row and contract["accepted"] else {
                        "status": contract["status"] if row else "cache-miss",
                    }
                result = {"label": seed["label"], "verdict": proof["status"], "target": seed["target"],
                          "cacheFile": row["file"] if row else None, "proof": proof,
                          "sourceContract": contract,
                          "inputHash": fingerprints[seed["label"]]}
                output.write(json.dumps(result, ensure_ascii=False) + "\n")
                output.flush()
                tally[result["verdict"]] = tally.get(result["verdict"], 0) + 1
                if index % 25 == 0:
                    print(json.dumps({"progress": index, "of": len(pending)}), flush=True)
        print(json.dumps({"rows": len(pending), "seconds": round(time.perf_counter() - started, 2), "verdicts": tally}), flush=True)
        return
    if args.range_cache_only:
        if not args.range_only or args.only != "html":
            raise ValueError("--range-cache-only requires --range-only --only html")
        started = time.perf_counter()
        tally = {}
        indexed_file = None
        rendered_raw = None
        rendered_sha256 = None
        document_index = None
        range_proof_entries = load_result_cache_manifest(
            RANGE_PROOF_CACHE, RANGE_PROOF_CACHE_VERSION,
        )
        with out_path.open("a", encoding="utf-8") as output:
            for index, seed in enumerate(pending, 1):
                base = seed["target"].split("#", 1)[0]
                row = manifest.get(url_key(base))
                rendered_file = BROWSER_TEXT_CACHE / f"{Path(row['file']).stem}.txt" if row else None
                if not rendered_file or not rendered_file.exists():
                    result = {"label": seed["label"], "verdict": "rendered-cache-miss", "target": seed["target"]}
                else:
                    contract = source_contract(seed, False)
                    proof_seed = {
                        **seed,
                        "_sourceIdentities": contract.get("sourceIdentities") or [],
                    }
                    if indexed_file != row["file"]:
                        rendered_raw = rendered_file.read_bytes()
                        rendered_sha256 = hashlib.sha256(rendered_raw).hexdigest()
                        document_index = None
                        indexed_file = row["file"]
                    identity = range_proof_cache_identity(proof_seed, rendered_sha256)
                    cached_entry = range_proof_entries.get(identity["fingerprint"])
                    cached_proof = (cached_entry.get("result") if isinstance(cached_entry, dict)
                                    and cached_entry.get("identity") == identity else None)
                    if cached_proof is None:
                        cached_proof = read_range_proof_cache(identity)
                    if cached_proof is None:
                        if document_index is None:
                            document_index = rendered_document_index(
                                rendered_raw.decode("utf-8"),
                            )
                        proofs, ranges = cached_text_range_proof(document_index, proof_seed)
                        write_range_proof_cache(identity, proofs, ranges)
                    else:
                        proofs, ranges = cached_proof
                    range_proof_entries[identity["fingerprint"]] = {
                        "identity": identity, "result": [proofs, ranges],
                    }
                    result = {"label": seed["label"], "verdict": range_probe_verdict(proofs, ranges),
                              "target": seed["target"], "cacheFile": row["file"], "quotes": proofs, "findRanges": ranges}
                result["inputHash"] = fingerprints[seed["label"]]
                output.write(json.dumps(result, ensure_ascii=False) + "\n")
                tally[result["verdict"]] = tally.get(result["verdict"], 0) + 1
                if index % 250 == 0:
                    print(json.dumps({"progress": index, "of": len(pending)}), flush=True)
        write_result_cache_manifest(
            SOURCE_CONTRACT_CACHE, SOURCE_CONTRACT_CACHE_VERSION, source_contract_entries,
        )
        write_result_cache_manifest(
            RANGE_PROOF_CACHE, RANGE_PROOF_CACHE_VERSION, range_proof_entries,
        )
        print(json.dumps({"rows": len(pending), "seconds": round(time.perf_counter() - started, 2), "verdicts": tally}), flush=True)
        return
    SHOTS.mkdir(exist_ok=True)
    options = Options()
    # DOMContentLoaded is sufficient for static cached documents and avoids
    # waiting on irrelevant publisher images, analytics, and dead remote assets.
    options.page_load_strategy = "eager"
    if not args.headed:
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
    window_width, window_height = (1000, 800) if args.headed else (480, 520)
    options.add_argument(f"--window-size={window_width},{window_height}")
    if args.live:
        options.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    lifecycle_started = time.perf_counter()
    with ExitStack() as lifecycle:
        profile_dir = lifecycle.enter_context(owned_chrome_profile("browser-exact-profile-"))
        options.add_argument(f"--user-data-dir={profile_dir}")
        options.add_argument("--force-device-scale-factor=1")
        server = lifecycle.enter_context(CacheServer(files))
        output = lifecycle.enter_context(out_path.open("a", encoding="utf-8"))
        driver, browser_timings, pdf_oopif = lifecycle.enter_context(chrome_session(options))
        browser_start_ms = browser_timings["browserStartMs"]
        driver.set_window_size(window_width, window_height)
        driver.set_page_load_timeout(180 if args.live and args.headed else 60 if args.live else 30)
        if args.live:
            driver.execute_cdp_cmd("Network.enable", {
                "maxTotalBufferSize": 128 * 1024 * 1024,
                "maxResourceBufferSize": 64 * 1024 * 1024,
            })
        frame_id = driver.execute_cdp_cmd("Page.getFrameTree", {})["frameTree"]["frame"]["id"]
        pdf_text_cache = {}
        pdf_geometry_cache = {}
        live_pdf_bindings = {}
        loaded_range_base = None
        loaded_range_probes = {}
        range_page_inputs = {}
        if args.range_only:
            for pending_seed in pending:
                pending_base = pending_seed.get("target", "").split("#", 1)[0]
                range_page_inputs.setdefault(pending_base, []).append({
                    "label": pending_seed["label"],
                    "quotes": pending_seed.get("paintQuotes") or pending_seed.get("quotes") or [],
                    "block": pending_seed.get("blockText", ""),
                    "anchor": pending_seed.get("anchor", ""),
                    "target": pending_seed.get("target", ""),
                })
        work_started = time.perf_counter()
        try:
            for index, seed in enumerate(pending, 1):
                started = time.time()
                timings = {}
                target = seed.get("target")
                base, _, fragment = target.partition("#")
                replay_id = hashlib.sha1(seed["label"].encode()).hexdigest()[:12]
                row = manifest.get(url_key(base))
                is_pdf = bool(row and (PDF_RE.search(base) or row["file"].lower().endswith(".pdf")))
                contract = source_contract(seed, is_pdf) if (row or args.live) and not args.range_only else None
                proof_seed = {
                    **seed,
                    "_sourceIdentities": (contract or {}).get("sourceIdentities") or [],
                }
                if not row and not args.live:
                    result = {"label": seed["label"], "verdict": "cache-miss", "target": target}
                elif contract is not None and not contract["accepted"]:
                    result = {"label": seed["label"], "verdict": contract["status"],
                              "target": target, "cacheFile": row["file"]}
                elif is_pdf:
                    if not row:
                        raise ValueError("live PDF verification requires a cached byte identity")
                    file = cached_file(row)
                    try:
                        pdf_result = pdf_seed_paint_proof(
                            driver, pdf_oopif, server.origin, file, row["file"], proof_seed, base, fragment,
                            replay_id, cached_digest(file), pdf_text_cache, pdf_geometry_cache,
                            live_pdf_bindings, timings,
                            live=args.live, headed=args.headed, save_shots=args.save_shots,
                        )
                        result = {"label": seed["label"], "target": target,
                                  "cacheFile": row["file"], **pdf_result}
                    except Exception as exc:
                        if browser_session_failed(driver, exc):
                            raise
                        result = {"label": seed["label"], "verdict": "error", "target": target, "cacheFile": row["file"], "error": str(exc)[:300]}
                else:
                    local_base = target.partition("#")[0] if args.live else \
                        f"{server.origin}/page/{quote(row['file'])}"
                    local = target if args.live else \
                        f"{local_base}?seed={replay_id}" + (f"#{fragment}" if fragment else "")
                    try:
                        if args.range_only:
                            phase = time.perf_counter()
                            if loaded_range_base != base:
                                html = cached_file(row).read_text(encoding="utf-8")
                                csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
                                html, replacements = re.subn(r"(?i)(<head\b[^>]*>)", r"\1" + csp, html, count=1)
                                if not replacements:
                                    html = csp + html
                                driver.execute_cdp_cmd("Page.setDocumentContent", {"frameId": frame_id, "html": html})
                                BROWSER_TEXT_CACHE.mkdir(exist_ok=True)
                                rendered_text_file = BROWSER_TEXT_CACHE / f"{Path(row['file']).stem}.txt"
                                if args.refresh_rendered_cache:
                                    rendered_text_file.write_text(driver.execute_script("return document.body.innerText"), encoding="utf-8")
                                loaded_range_base = base
                                if not args.refresh_rendered_cache:
                                    loaded_range_probes = {
                                        item["label"]: item for item in driver.execute_script(
                                            RANGE_PAGE_BATCH_SCRIPT, range_page_inputs[base]
                                        )
                                    }
                            add_timing(timings, "navigationMs", phase)
                            if args.refresh_rendered_cache:
                                result = {"label": seed["label"], "verdict": "rendered-cache-refreshed",
                                          "target": target, "cacheFile": row["file"]}
                                raise StopIteration
                            phase = time.perf_counter()
                            probe = loaded_range_probes[seed["label"]]
                            add_timing(timings, "rangeProbeMs", phase)
                            quote_proofs = probe["quotes"]
                            find_ranges = probe["ranges"]
                            result = {
                                "label": seed["label"], "verdict": range_probe_verdict(quote_proofs, find_ranges),
                                "target": target, "cacheFile": row["file"], "quotes": quote_proofs, "findRanges": find_ranges,
                            }
                            raise StopIteration
                        result, paint_timings = html_paint_proof(
                            driver, local, proof_seed, row["file"] if row else None,
                            args.save_shots, args.mine_oracle, args.live,
                        )
                        for name, value in paint_timings.items():
                            timings[name] = round(timings.get(name, 0) + value, 1)
                    except StopIteration:
                        pass
                    except Exception as exc:  # retain partial corpus evidence
                        if browser_session_failed(driver, exc):
                            result = {
                                "label": seed["label"], "verdict": "error", "target": target,
                                "error": str(exc)[:300], "elapsedMs": round((time.time() - started) * 1000),
                                "timings": timings, "sourceMode": "live" if args.live else "cache",
                                "headed": args.headed, "inputHash": fingerprints[seed["label"]],
                            }
                            if contract is not None:
                                result["sourceContract"] = contract
                            output.write(json.dumps(result, ensure_ascii=False) + "\n")
                            output.flush()
                            raise
                        result = {"label": seed["label"], "verdict": "error", "target": target, "error": str(exc)[:300]}
                result["elapsedMs"] = round((time.time() - started) * 1000)
                result["timings"] = timings
                if contract is not None:
                    result["sourceContract"] = contract
                result["sourceMode"] = "live" if args.live else "cache"
                result["headed"] = args.headed
                if row:
                    identity_file = cached_file(row)
                    if identity_file.exists():
                        result["cacheIdentity"] = cache_identity(identity_file)
                if args.live and row:
                    fingerprints[seed["label"]] = input_hash(seed)
                result["inputHash"] = fingerprints[seed["label"]]
                output.write(json.dumps(result, ensure_ascii=False) + "\n")
                output.flush()
                if index % 25 == 0 or not args.range_only and result["verdict"] != "exact-match":
                    print(json.dumps({"progress": index, "of": len(pending), "label": seed["label"], "verdict": result["verdict"]}), flush=True)
        finally:
            work_ms = round((time.perf_counter() - work_started) * 1000)
    browser_quit_ms = browser_timings["browserQuitMs"]
    print(json.dumps({"workerSummary": {
        "inputRows": len(corpus_targets), "gettableRows": len(gettable_targets),
        "excluded404": len(excluded_404), "browserStartMs": browser_start_ms,
        "workMs": work_ms, "browserQuitMs": browser_quit_ms,
        "lifecycleMs": round((time.perf_counter() - lifecycle_started) * 1000),
    }}), flush=True)


if __name__ == "__main__":
    run()
