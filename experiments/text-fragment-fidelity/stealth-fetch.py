#!/usr/bin/env python3
"""Stealth Decisia crawl via undetected_chromedriver (the ALR-proven setup):
no --no-sandbox, no CI flags; uc strips automation fingerprints and matches
the installed Chrome version. Headed + persistent profile so a solved
"Validation" captcha clears the wall for the rest of the run. On a challenge
the window stays open and this script waits for a human solve."""
import hashlib
import json
import random
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import undetected_chromedriver as uc

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
SEEDS = RESULTS / "seeds.jsonl"
MANIFEST = RESULTS / "page-html-manifest.jsonl"
CACHE = RESULTS / "page-html"
PROFILE = RESULTS / "captcha-profile"
CACHE.mkdir(exist_ok=True)

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

pending = [u for u in urls if normalize_key(u) not in have or have.get(normalize_key(u), {}).get("challenged")]
print(json.dumps({"pending": len(pending)}), flush=True)

opts = uc.ChromeOptions()
opts.add_argument("--disable-blink-features=AutomationControlled")
opts.add_argument(f"--user-data-dir={PROFILE}")
driver = uc.Chrome(options=opts, use_subprocess=True, version_main=151)
try:
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"},
    )
except Exception:
    pass

manifest_fh = MANIFEST.open("a", encoding="utf-8")
solved = 0
try:
    for url in pending:
        try:
            driver.get(url)
            time.sleep(random.uniform(2.0, 3.0))
            html = driver.page_source
            if is_challenge(html):
                print("\n>>> CAPTCHA: solve the 'Validation' page in the Chrome window. Polling...\n", flush=True)
                for _ in range(300):
                    time.sleep(2)
                    try:
                        html = driver.page_source
                        if not is_challenge(html):
                            solved += 1
                            break
                    except Exception:
                        pass
                time.sleep(random.uniform(2.0, 3.0))
                html = driver.page_source
            challenged = is_challenge(html)
            key = hashlib.sha1(url.encode("utf-8")).hexdigest()
            fname = f"{key}.html"
            (CACHE / fname).write_text(html, encoding="utf-8")
            manifest_fh.write(json.dumps({"url": url, "file": fname, "bytes": len(html), "challenged": challenged}) + "\n")
            manifest_fh.flush()
            print(json.dumps({"event": "cached", "solved": solved, "url": url[:70], "bytes": len(html), "challenged": challenged}), flush=True)
        except Exception as exc:
            manifest_fh.write(json.dumps({"url": url, "file": None, "error": str(exc)[:80]}) + "\n")
            manifest_fh.flush()
        time.sleep(random.uniform(1.2, 2.0))
finally:
    manifest_fh.close()
    try:
        driver.quit()
    except Exception:
        pass
    print(json.dumps({"event": "done", "solved": solved}), flush=True)
