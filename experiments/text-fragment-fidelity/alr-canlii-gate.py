#!/usr/bin/env python3
"""CanLII tier of the exact gate, for links that are compared across builders.

Reuses webdriver-exact-gate.py's cache server, Chrome lifecycle, quote
locator and paint geometry. A target names a link and an arm-neutral
expectation, so different builders' links for one row are judged against the
same expected place:

- role "quote": `quote` is the source words and `blockText`/`anchor` is where
  they should be highlighted. The verdict is the gate's own (exact-match,
  paint-did-not-cover-range, paint-extraneous, initial-paint-missed-expected-
  passage, ...), plus the paint seen in the landing viewport.
- role "citation": `anchor` is the cited paragraph/section (or null for the
  whole document). The verdict is whether that element is in the landing
  viewport.

Pages come from saved CanLII pages (Pinpointer corpus and the ALR Quote
Verifier cache), served locally; no publisher traffic.

  python alr-canlii-gate.py --targets <targets.jsonl> --out <results.jsonl> [--save-shots <dir>]
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import time
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import quote

from selenium.webdriver.chrome.options import Options

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("exact_gate", HERE / "webdriver-exact-gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

LOCAL = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
PINPOINTER = LOCAL / "OpenLegalData" / "pinpointer-corpus"


def matching_driver():
    """The cached ChromeDriver whose major version matches the installed Chrome."""
    root = Path.home() / ".cache" / "selenium" / "chromedriver" / "win64"
    chrome = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application"
    majors = sorted((p.name for p in chrome.iterdir() if re.match(r"^\d+\.", p.name)), reverse=True)
    major = majors[0].split(".")[0] if majors else None
    for folder in sorted(root.iterdir(), reverse=True):
        if major and folder.name.split(".")[0] == major and (folder / "chromedriver.exe").exists():
            return folder / "chromedriver.exe"
    return gate.DRIVER


def page_store(extra_caches: list[Path]):
    pages = {}
    index = PINPOINTER / "index.jsonl"
    if index.exists():
        for line in index.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("provider") != "canlii":
                continue
            folder = PINPOINTER / row["dir"]
            file = folder / "rendered.html" if (folder / "rendered.html").exists() else folder / "raw.html"
            if file.exists():
                pages.setdefault(row["url"].split("#")[0].split("?")[0], file)
    for cache in extra_caches:
        for url, entry in json.loads((cache / "index.json").read_text(encoding="utf-8")).items():
            base = url.split("#")[0].split("?")[0]
            file = cache / entry["html_path"].replace("\\", "/")
            if not base.endswith(".pdf") and file.exists():
                pages.setdefault(base, file)
    return pages


ANCHOR_SCRIPT = r"""
const name = arguments[0];
const el = name ? (document.getElementById(name) || document.querySelector(`[name="${CSS.escape(name)}"]`)) : null;
const r = el ? el.getBoundingClientRect() : null;
return {scrollY: window.scrollY, innerHeight: window.innerHeight,
        exists: !!el, top: r ? r.top : null};
"""


BLOCK_EXTENT_SCRIPT = r"""
const name = arguments[0];
const el = name ? (document.getElementById(name) || document.querySelector(`[name="${CSS.escape(name)}"]`)) : null;
if (!el) return null;
const markers = [...document.querySelectorAll('a[name^="par"], a[name^="sec"], [id^="sec"]')]
  .filter((m) => /^(par|sec)\d/.test(m.getAttribute("name") ?? m.id));
const at = markers.indexOf(el);
const next = markers.slice(at + 1).find((m) => m.getBoundingClientRect().top > el.getBoundingClientRect().top);
return {top: el.getBoundingClientRect().top,
        bottom: next ? next.getBoundingClientRect().top : document.body.scrollHeight - window.scrollY,
        scrollY: window.scrollY};
"""


def citation_proof(driver, local: str, target: dict):
    gate.load_fresh_document(driver, local, "citation")
    time.sleep(0.3)
    probe = driver.execute_script(ANCHOR_SCRIPT, target.get("anchor"))
    if not target.get("anchor"):
        return {"verdict": "document", **probe}
    if not probe["exists"]:
        return {"verdict": "anchor-missing", **probe}
    in_view = -8 <= probe["top"] < probe["innerHeight"] * 0.9
    return {"verdict": "pinpoint-in-view" if in_view else "pinpoint-not-in-view", **probe}


def quote_proof(driver, local: str, target: dict, save_shots: bool):
    timings = {}
    seed = {"label": target["label"], "blockText": target.get("blockText", ""),
            "anchor": target.get("anchor", "")}
    result, image = gate.html_navigation_paint_proof(
        driver, local, [target["quote"]], seed, timings, "alr", save_shots,
    )
    viewport = result.get("initialViewport") or {}
    locate = (result.get("quotes") or [{}])[0]
    # The gate overwrites a located quote's status with its paint status.
    located = locate.get("status") not in {"ambiguous-location", "quote-not-rendered", "quote-not-laid-out",
                                           "empty-quote", None}
    if locate.get("status") == "ambiguous-location" and image is not None:
        # The words recur inside the expected block: judge only whether the
        # paint sits inside that block's extent.
        extent = driver.execute_script(BLOCK_EXTENT_SCRIPT, target.get("anchor"))
        box = gate.target_mask(image, "html").getbbox()
        paint = "no-paint" if box is None else "paint-in-expected-block" if extent and \
            extent["top"] - 4 <= box[1] <= extent["bottom"] + 4 else "paint-outside-expected-block"
        return {"locateStatus": "ambiguous-location", "occurrences": locate.get("occurrences"),
                "verdict": f"ambiguous:{paint}", "scrollY": extent and extent["scrollY"]}, image
    return {
        "locateStatus": locate.get("status"), "occurrences": locate.get("occurrences"),
        "verdict": result["verdict"] if located else "expected-quote-not-rendered",
        "landing": viewport.get("status"),
        "insidePixels": viewport.get("insideHighlightPixels"),
        "viewportPaintPixels": viewport.get("captureHighlightPixels"),
        "endpointPixels": viewport.get("endpointHighlightPixels"),
        "scrollY": viewport.get("scrollY"),
        "geometryTolerance": (result.get("geometryTolerance") or {}).get("status"),
    }, image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--canlii-cache", type=Path, action="append", default=[])
    parser.add_argument("--save-shots", type=Path)
    args = parser.parse_args()
    gate.DRIVER = matching_driver()
    if args.save_shots:
        args.save_shots.mkdir(parents=True, exist_ok=True)
        gate.SHOTS = args.save_shots
    pages = page_store(args.canlii_cache)
    targets = [json.loads(line) for line in args.targets.read_text(encoding="utf-8").splitlines() if line.strip()]
    measurable = [t for t in targets if t["base"] in pages and
                  (t["role"] == "citation" or t.get("expect") == "located")]
    files = {hashlib.sha1(base.encode()).hexdigest() + ".html": pages[base]
             for base in {t["base"] for t in measurable}}
    # One measurement per distinct (link, expectation); rows sharing it reuse the result.
    def key(t):
        return json.dumps([t["target"], t["role"], t.get("anchor"), t.get("quote"),
                           hashlib.sha1(t.get("blockText", "").encode()).hexdigest()])
    unique = {}
    for t in measurable:
        unique.setdefault(key(t), t)
    order = sorted(unique.values(), key=lambda t: t["base"])
    options = Options()
    options.page_load_strategy = "eager"
    for flag in ("--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions",
                 "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
                 "--disable-sync", "--no-first-run", "--renderer-process-limit=1",
                 "--window-size=480,520", "--force-device-scale-factor=1"):
        options.add_argument(flag)
    results = {}
    started = time.perf_counter()
    with ExitStack() as stack:
        profile = stack.enter_context(gate.owned_chrome_profile("alr-canlii-gate-"))
        options.add_argument(f"--user-data-dir={profile}")
        server = stack.enter_context(gate.CacheServer(files))
        driver, _timings, _pdf = stack.enter_context(gate.chrome_session(options))
        driver.set_window_size(480, 520)
        driver.set_page_load_timeout(60)
        for index, t in enumerate(order, 1):
            base, _, fragment = t["target"].partition("#")
            name = hashlib.sha1(t["base"].encode()).hexdigest() + ".html"
            local = f"{server.origin}/page/{quote(name)}?seed={hashlib.sha1(t['label'].encode()).hexdigest()[:12]}" + \
                (f"#{fragment}" if fragment else "")
            try:
                if t["role"] == "citation":
                    proof = citation_proof(driver, local, t)
                else:
                    proof, image = quote_proof(driver, local, t, bool(args.save_shots))
                    if args.save_shots and image is not None:
                        image.save(args.save_shots / f"{t['label']}.png", compress_level=1)
            except Exception as exc:  # keep partial evidence
                if gate.browser_session_failed(driver, exc):
                    raise
                proof = {"verdict": "error", "error": str(exc)[:300]}
            results[key(t)] = proof
            if index % 50 == 0:
                print(json.dumps({"progress": index, "of": len(order),
                                  "seconds": round(time.perf_counter() - started)}), flush=True)
    with args.out.open("w", encoding="utf-8") as output:
        for t in targets:
            row = {k: t.get(k) for k in ("label", "row", "arm", "role", "target", "identity", "supra",
                                         "pinpoint", "anchor", "expect", "citedHolds")}
            if t["base"] not in pages:
                row["verdict"] = "page-not-cached"
            elif t["role"] == "quote" and t.get("expect") != "located":
                row["verdict"] = t.get("expect")
            else:
                row.update(results[key(t)])
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"targets": len(targets), "measured": len(order),
                      "seconds": round(time.perf_counter() - started)}), flush=True)


if __name__ == "__main__":
    main()
