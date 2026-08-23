#!/usr/bin/env python3
"""Parallel stealth crawl: N headed undetected_chromedriver workers, each with
its own profile, round-robinning pending Decisia pages. A challenge in any
window waits for a human solve while the other workers keep fetching."""
import hashlib
import json
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import undetected_chromedriver as uc

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
SEEDS = RESULTS / "seeds.jsonl"
MANIFEST = RESULTS / "page-html-manifest.jsonl"
CACHE = RESULTS / "page-html"
CACHE.mkdir(exist_ok=True)

WORKERS = int(__import__("os").environ.get("STEALTH_WORKERS", "4"))
DECISIA = ("decisia.lexum.com", "decisions.", "coadecisions.", "decision.tcc-cci")


def fetch_url_for(raw):
    try:
        u = urlparse(raw)
        if any(host in (u.hostname or "") for host in DECISIA):
            q = dict(parse_qsl(u.query))
            q["iframe"] = "true"
            q["site_preference"] = "mobile"
            return urlunparse((u.scheme, u.netloc, u.path, u.params, urlencode(q), u.fragment))
    except Exception:
        pass
    return raw


def normalize_key(raw):
    try:
        u = urlparse(raw)
        q = sorted(parse_qsl(u.query))
        return u.scheme + "://" + u.netloc + u.path + "?" + urlencode(q)
    except Exception:
        return raw.split("#")[0]


def is_challenge(html):
    return "<title>Validation</title>" in html.lower()


seeds = [json.loads(line) for line in SEEDS.read_text(encoding="utf-8").splitlines() if line.strip()]
urls = list(dict.fromkeys(fetch_url_for(s["url"].split("#")[0]) for s in seeds))

have = {}
if MANIFEST.exists():
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        have[normalize_key(row["url"])] = row

pending = [u for u in urls if normalize_key(u) not in have or have.get(normalize_key(u), {}).get("challenged") or have.get(normalize_key(u), {}).get("bytes", 0) < 20000]
print(json.dumps({"pending": len(pending), "workers": WORKERS}), flush=True)

manifest_lock = threading.Lock()
solved_count = 0
solved_lock = threading.Lock()
queue = list(pending)
queue_lock = threading.Lock()


def next_url():
    with queue_lock:
        return queue.pop(0) if queue else None


def worker(index):
    global solved_count
    profile = RESULTS / f"captcha-profile-{index}"
    opts = uc.ChromeOptions()
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument(f"--user-data-dir={profile}")
    try:
        driver = uc.Chrome(options=opts, use_subprocess=True, version_main=151)
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"},
        )
    except Exception as exc:
        print(json.dumps({"event": "launch-failed", "worker": index, "error": str(exc)[:100]}), flush=True)
        return
    try:
        while True:
            url = next_url()
            if url is None:
                break
            try:
                driver.get(url)
                time.sleep(random.uniform(2.0, 3.0))
                html = driver.page_source
                if is_challenge(html):
                    print(f"\n>>> worker {index}: solve the 'Validation' page in the Chrome window. Polling...\n", flush=True)
                    cleared = False
                    for _ in range(300):
                        time.sleep(2)
                        try:
                            html = driver.page_source
                            if not is_challenge(html):
                                with solved_lock:
                                    solved_count += 1
                                cleared = True
                                break
                        except Exception:
                            pass
                    if not cleared:
                        print(json.dumps({"event": "gave-up", "worker": index, "url": url[:60]}), flush=True)
                    time.sleep(random.uniform(2.0, 3.0))
                    html = driver.page_source
                challenged = is_challenge(html)
                key = hashlib.sha1(url.encode("utf-8")).hexdigest()
                fname = f"{key}.html"
                (CACHE / fname).write_text(html, encoding="utf-8")
                with manifest_lock:
                    with MANIFEST.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps({"url": url, "file": fname, "bytes": len(html), "challenged": challenged}) + "\n")
                print(json.dumps({"event": "cached", "worker": index, "url": url[:70], "bytes": len(html), "challenged": challenged}), flush=True)
            except Exception as exc:
                with manifest_lock:
                    with MANIFEST.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps({"url": url, "file": None, "error": str(exc)[:80]}) + "\n")
            time.sleep(random.uniform(1.0, 1.8))
    finally:
        try:
            driver.quit()
        except Exception:
            pass


with ThreadPoolExecutor(max_workers=WORKERS) as pool:
    list(pool.map(worker, range(WORKERS)))

print(json.dumps({"event": "done", "solved": solved_count}), flush=True)
