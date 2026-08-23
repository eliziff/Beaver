#!/usr/bin/env python3
"""Keep Chromium warm and re-run page-wide range proofs when targets change."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fragment_exact_gate", HERE / "webdriver-exact-gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def options():
    value = Options()
    value.page_load_strategy = "eager"
    for argument in (
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions",
        "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
        "--disable-sync", "--metrics-recording-only", "--no-first-run", "--renderer-process-limit=1",
        "--disable-features=MediaRouter,OptimizationHints,Translate", "--window-size=480,400",
        "--force-device-scale-factor=1",
    ):
        value.add_argument(argument)
    value.add_argument(f"--user-data-dir={tempfile.mkdtemp(prefix='fragment-range-watch-')}")
    return value


class Worker:
    def __init__(self, index, manifest, origin):
        started = time.perf_counter()
        self.index = index
        self.manifest = manifest
        self.origin = origin
        self.driver = webdriver.Chrome(service=Service(str(gate.DRIVER)), options=options())
        self.driver.set_window_size(480, 400)
        self.frame_id = self.driver.execute_cdp_cmd("Page.getFrameTree", {})["frameTree"]["frame"]["id"]
        self.loaded = None
        print(json.dumps({"worker": index, "browserStartMs": round((time.perf_counter() - started) * 1000)}), flush=True)

    def close(self):
        self.driver.quit()

    def run(self, seeds, cache_only=False, paint=False):
        rows = []
        for index, seed in enumerate(sorted(seeds, key=lambda item: item.get("target", "").split("#")[0]), 1):
            started = time.perf_counter()
            base = seed.get("target", "").split("#")[0]
            cached = self.manifest.get(gate.url_key(base))
            if not cached:
                rows.append({"label": seed["label"], "verdict": "cache-miss", "target": seed.get("target")})
                continue
            if cached["file"].lower().endswith(".pdf") or gate.PDF_RE.search(base):
                rows.append({"label": seed["label"], "verdict": "pdf-needs-paint-tier", "target": seed.get("target")})
                continue
            if paint:
                fragment = seed.get("target", "").partition("#")[2]
                replay = hashlib.sha1(seed["label"].encode()).hexdigest()[:12]
                local = f"{self.origin}/page/{cached['file']}?seed={replay}" + (f"#{fragment}" if fragment else "")
                try:
                    result, timings = gate.html_paint_proof(self.driver, local, seed, cached["file"])
                    result["timings"] = timings
                    result["elapsedMs"] = round((time.perf_counter() - started) * 1000)
                except Exception as exc:
                    result = {"label": seed["label"], "verdict": "error", "target": seed.get("target"), "error": str(exc)[:300]}
                rows.append(result)
                if index % 25 == 0:
                    print(json.dumps({"worker": self.index, "progress": index, "of": len(seeds), "paint": True}), flush=True)
                continue
            text_file = gate.BROWSER_TEXT_CACHE / f"{Path(cached['file']).stem}.txt"
            if cache_only and text_file.exists():
                rows.append({"label": seed["label"], "verdict": "browser-text-cached", "target": base, "cacheFile": cached["file"]})
                if index % 100 == 0:
                    print(json.dumps({"worker": self.index, "progress": index, "of": len(seeds), "reused": True}), flush=True)
                continue
            if self.loaded != base:
                html = (gate.CACHE / cached["file"]).read_text(encoding="utf-8")
                csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
                html, count = re.subn(r"(?i)(<head\b[^>]*>)", r"\1" + csp, html, count=1)
                self.driver.execute_cdp_cmd("Page.setDocumentContent", {"frameId": self.frame_id, "html": html if count else csp + html})
                gate.BROWSER_TEXT_CACHE.mkdir(exist_ok=True)
                if not text_file.exists():
                    text_file.write_text(self.driver.execute_script("return document.body.innerText"), encoding="utf-8")
                self.loaded = base
            if cache_only:
                rows.append({"label": seed["label"], "verdict": "browser-text-cached", "target": base, "cacheFile": cached["file"]})
                if index % 25 == 0:
                    print(json.dumps({"worker": self.index, "progress": index, "of": len(seeds), "reused": False}), flush=True)
                continue
            probe = self.driver.execute_script(
                gate.RANGE_BATCH_SCRIPT, seed.get("quotes") or [], seed.get("blockText", ""),
                seed.get("anchor", ""), seed.get("target", ""),
            )
            rows.append({
                "label": seed["label"], "verdict": gate.range_probe_verdict(probe["quotes"], probe["ranges"]),
                "target": seed.get("target"), "cacheFile": cached["file"], "quotes": probe["quotes"],
                "findRanges": probe["ranges"], "elapsedMs": round((time.perf_counter() - started) * 1000),
            })
            if index % 25 == 0:
                print(json.dumps({"worker": self.index, "progress": index, "of": len(seeds)}), flush=True)
        return rows


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("targets", type=Path)
    parser.add_argument("--out", type=Path, default=gate.RESULTS / "webdriver-range-watch.jsonl")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--cache-only", action="store_true")
    parser.add_argument("--paint", action="store_true")
    args = parser.parse_args()
    manifest = {}
    files = {}
    for row in read_jsonl(gate.MANIFEST):
        file = gate.CACHE / (row.get("file") or "")
        if row.get("url") and row.get("file") and not row.get("challenged") and file.exists():
            manifest[gate.url_key(row["url"])] = row
            files[row["file"]] = file
    with gate.CacheServer(files) as server, ThreadPoolExecutor(max_workers=args.workers) as pool:
        workers = list(pool.map(lambda index: Worker(index, manifest, server.origin), range(args.workers)))
        previous = None
        try:
            while True:
                stamp = (args.targets.stat().st_mtime_ns, args.targets.stat().st_size)
                if stamp != previous:
                    started = time.perf_counter()
                    seeds = read_jsonl(args.targets)
                    if args.cache_only:
                        seeds = list({seed.get("target", "").split("#")[0]: seed for seed in seeds}.values())
                    shards = [[] for _ in workers]
                    for seed in seeds:
                        base = seed.get("target", "").split("#")[0]
                        shard = int(hashlib.sha256(base.encode()).hexdigest(), 16) % len(workers)
                        shards[shard].append(seed)
                    batches = list(pool.map(lambda pair: pair[0].run(pair[1], args.cache_only, args.paint), zip(workers, shards)))
                    rows = sorted((row for batch in batches for row in batch), key=lambda row: row["label"])
                    args.out.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
                    tally = {}
                    for row in rows:
                        tally[row["verdict"]] = tally.get(row["verdict"], 0) + 1
                    print(json.dumps({"rows": len(rows), "seconds": round(time.perf_counter() - started, 2), "verdicts": tally}), flush=True)
                    previous = stamp
                    if args.once:
                        break
                time.sleep(0.2)
        finally:
            list(pool.map(lambda worker: worker.close(), workers))


if __name__ == "__main__":
    main()
