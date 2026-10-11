"""CourtListener fetching stack: on-disk HTML cache, stealth browser, and the
cached URL resolver, extracted from alr_quote_verifier.py.

Shared low-level helpers (_ts_print, _split_url, ...) intentionally stay in
alr_quote_verifier and are accessed late-bound through the module object. This
module must not read app config at import time.
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import random
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit, urlunsplit

try:
    import undetected_chromedriver as uc
except Exception as e:  # pragma: no cover - optional dependency
    print(f"  undetected_chromedriver import failed: {e}", flush=True)
    uc = None


try:
    from selenium.common.exceptions import WebDriverException  # type: ignore
except Exception as e:  # pragma: no cover
    print(f"  selenium import failed: {e}", flush=True)
    WebDriverException = Exception


class _AppProxy:
    """Late-bound access to the app module (shared helpers + mutable config).

    Resolved on every attribute access instead of a module-level
    ``import courtlistener_runtime`` so that (a) importing this module while
    alr_quote_verifier runs as a script (``__main__``) does not re-execute
    the app file, and (b) bench monkeypatching of app globals (USE_A2AJ,
    ...) stays visible here.
    """

    def __getattr__(self, name: str):
        import courtlistener_runtime

        return getattr(courtlistener_runtime, name)


_app = _AppProxy()


def _gated_sleep(seconds: float) -> None:
    """Sleep in short slices, honoring a GUI pause between slices so the
    pause button doesn't have to wait out a long retry/challenge delay.
    Time spent paused counts toward the delay."""
    deadline = time.monotonic() + max(0.0, seconds)
    while True:
        try:
            _app._pause_gate()
        except Exception:
            pass
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.25, remaining))


@dataclass(frozen=True)
class CacheEntry:
    url_base: str
    canonical_url_base: str
    html_path: str
    status_code: int
    stored_at_epoch: int


class HtmlCache:
    """
    Persistent on-disk cache:
      - key: input URL base (no fragment)
      - value: canonical URL base + path to cached HTML + status
    """
    def __init__(self, cache_dir: str | Path):
        self.cache_dir = Path(cache_dir).expanduser().resolve()
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self.html_dir = self.cache_dir / "html"
        self.html_dir.mkdir(parents=True, exist_ok=True)

        self.index_path = self.cache_dir / "index.json"
        self._index: Dict[str, Dict[str, Any]] = self._load_index()

    def _load_index(self) -> Dict[str, Dict[str, Any]]:
        if not self.index_path.exists():
            return {}
        try:
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        except Exception:
            # If the index is corrupt, do not brick the run—start fresh.
            return {}

    def _save_index(self) -> None:
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._index, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.index_path)

    def get_entry(self, url: str) -> Optional[CacheEntry]:
        url_base, _ = _app._split_url(url)
        if not url_base:
            return None
        raw = self._index.get(url_base)
        if not raw:
            return None
        try:
            return CacheEntry(
                url_base=url_base,
                canonical_url_base=str(raw["canonical_url_base"]),
                html_path=str(raw["html_path"]),
                status_code=int(raw["status_code"]),
                stored_at_epoch=int(raw["stored_at_epoch"]),
            )
        except Exception:
            return None

    def get_cached_html(self, url: str) -> Optional[str]:
        entry = self.get_entry(url)
        if not entry:
            return None
        html_file = self.cache_dir / entry.html_path
        if not html_file.exists():
            return None
        try:
            return html_file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None

    def put(self, alias_url_base: str, canonical_url_base: str, html: str, status_code: int) -> CacheEntry:
        """
        Stores the HTML once under canonical_url_base hash, then maps alias_url_base -> that same file.
        Also maps canonical_url_base -> itself, so future queries by either URL hit the cache.
        """
        now = int(time.time())
        canonical_key = _app._sha256_hex(canonical_url_base)
        rel_path = str(Path("html") / f"{canonical_key}.html")
        abs_path = self.cache_dir / rel_path

        abs_path.write_text(html or "", encoding="utf-8", errors="replace")

        payload = {
            "canonical_url_base": canonical_url_base,
            "html_path": rel_path,
            "status_code": int(status_code),
            "stored_at_epoch": now,
        }

        self._index[alias_url_base] = payload
        self._index[canonical_url_base] = payload
        self._save_index()

        return CacheEntry(
            url_base=alias_url_base,
            canonical_url_base=canonical_url_base,
            html_path=rel_path,
            status_code=int(status_code),
            stored_at_epoch=now,
        )




def _parse_window_size(value: str, fallback: Tuple[int, int]) -> Tuple[int, int]:
    m = re.match(r"^\s*(\d+)\s*[xX]\s*(\d+)\s*$", (value or "").strip())
    if not m:
        return fallback
    try:
        return (int(m.group(1)), int(m.group(2)))
    except Exception:
        return fallback


def _safe_float(value: str, fallback: float) -> float:
    try:
        return float(value)
    except Exception:
        return fallback


class StealthBrowser:
    """
    Wrapper around undetected_chromedriver using your known-good robust settings
    (no-sandbox, disable-dev-shm-usage, window-size, use_subprocess=True). 
    """
    def __init__(
        self,
        *,
        chrome_version_main: Optional[int] = None,
        window_size_range: Tuple[Tuple[int, int], Tuple[int, int]] = ((1200, 800), (1600, 1000)),
        user_data_dir: Optional[str | Path] = None,
        referrer_url: Optional[str] = None,
        post_load_wait_range: Tuple[float, float] = (1.5, 4.0),
        enable_humanization: bool = True,
    ):
        self.chrome_version_main = chrome_version_main or _detect_chrome_version()
        self.window_size_range = window_size_range
        self.user_data_dir = Path(user_data_dir).expanduser().resolve() if user_data_dir else None
        self.referrer_url = (referrer_url or "").strip() or None
        self.post_load_wait_range = post_load_wait_range
        self.enable_humanization = bool(enable_humanization)
        self.driver = None

    def _random_window_size(self) -> Tuple[int, int]:
        (min_w, min_h), (max_w, max_h) = self.window_size_range
        min_w, max_w = sorted((int(min_w), int(max_w)))
        min_h, max_h = sorted((int(min_h), int(max_h)))
        return random.randint(min_w, max_w), random.randint(min_h, max_h)

    def _maybe_set_window_size(self) -> None:
        if not self.driver:
            return
        try:
            w, h = self._random_window_size()
            self.driver.set_window_size(w, h)
        except Exception:
            return

    def _maybe_set_referrer(self, url_base: str, referrer_url: Optional[str] = None) -> None:
        if not self.driver:
            return
        ref = (referrer_url or self.referrer_url or "").strip()
        if not ref:
            return
        try:
            target_host = urlsplit(url_base).netloc.lower()
            ref_host = urlsplit(ref).netloc.lower()
            if ref_host and target_host and not target_host.endswith(ref_host):
                return
            self.driver.get(ref)
            time.sleep(random.uniform(0.5, 1.5))
        except Exception:
            return

    def _humanize_after_load(self) -> None:
        if not self.driver or not self.enable_humanization:
            return
        try:
            min_w, max_w = self.post_load_wait_range
            min_w = max(0.0, float(min_w))
            max_w = max(min_w, float(max_w))
            time.sleep(random.uniform(min_w, max_w))
        except Exception:
            pass

        try:
            height = self.driver.execute_script(
                "return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);"
            )
        except Exception:
            height = None
        if not height or height <= 0:
            return

        try:
            steps = random.randint(2, 5)
            for i in range(steps):
                frac = (i + 1) / float(steps)
                target = int(height * frac * random.uniform(0.7, 1.0))
                self.driver.execute_script("window.scrollTo(0, arguments[0]);", target)
                time.sleep(random.uniform(0.3, 0.9))
            if random.random() < 0.5:
                self.driver.execute_script("window.scrollTo(0, 0);")
        except Exception:
            return

    def start(self) -> bool:
        if self.driver is not None:
            return True

        if uc is None:
            return False

        try:
            options = uc.ChromeOptions()
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--disable-blink-features=AutomationControlled")
            w, h = self._random_window_size()
            options.add_argument(f"--window-size={w},{h}")
            if self.user_data_dir:
                options.add_argument(f"--user-data-dir={self.user_data_dir}")

            # Enable performance logs so we can infer HTTP status codes.
            options.set_capability("goog:loggingPrefs", {"performance": "ALL"})

            kwargs: Dict[str, Any] = {
                "options": options,
                "use_subprocess": True,
            }
            if self.chrome_version_main:
                kwargs["version_main"] = int(self.chrome_version_main)

            self.driver = uc.Chrome(**kwargs)
        except Exception as e:
            _app._ts_print(f"  StealthBrowser: Chrome startup failed: {e}")
            self.driver = None
            return False

        try:
            self.driver.execute_cdp_cmd(
                "Page.addScriptToEvaluateOnNewDocument",
                {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"},
            )
        except Exception:
            pass

        # Best-effort enable Network domain
        try:
            self.driver.execute_cdp_cmd("Network.enable", {})
        except Exception:
            pass
        return True

    def close(self) -> None:
        if self.driver is None:
            return
        try:
            self.driver.quit()
        except Exception:
            pass
        self.driver = None

    def restart(self) -> bool:
        self.close()
        return self.start()

    def _drain_performance_logs(self) -> None:
        try:
            _ = self.driver.get_log("performance")
        except Exception:
            return

    def _infer_main_status(self, expected_url_base: str) -> Optional[int]:
        """
        Infer HTTP status for main document request using Chrome performance logs.
        """
        if not self.driver:
            return None
        try:
            logs = self.driver.get_log("performance")
        except Exception:
            return None

        fallback_status: Optional[int] = None

        for entry in logs:
            try:
                msg = json.loads(entry.get("message", "{}")).get("message", {})
            except Exception:
                continue
            if msg.get("method") != "Network.responseReceived":
                continue
            params = msg.get("params") or {}
            if params.get("type") != "Document":
                continue

            resp = params.get("response") or {}
            url = str(resp.get("url") or "")
            url_base, _ = _app._split_url(url)
            try:
                st = int(resp.get("status"))
            except Exception:
                st = None

            if st is None:
                continue

            if url_base == expected_url_base:
                return st

            if fallback_status is None:
                fallback_status = st

        return fallback_status

    @staticmethod
    def _looks_blocked(title: str, html: str) -> bool:
        t = (title or "").lower()
        if "just a moment" in t or "captcha" in t:
            return True
        h = (html or "").lower()
        if "datadome" in h and "captcha" in h:
            return True
        return False

    @staticmethod
    def _looks_404(title: str, html: str) -> bool:
        t = (title or "").lower()
        if "404" in t or "not found" in t:
            return True
        h = (html or "").lower()
        if "document not found" in h:
            return True
        return False

    @staticmethod
    def _looks_server_error(title: str, html: str) -> bool:
        t = (title or "").lower().strip()
        error_titles = {"500", "502", "503", "504", "500 internal server error",
            "502 bad gateway", "503 service unavailable", "504 gateway timeout",
            "internal server error", "service unavailable", "server error",
            "bad gateway", "gateway timeout"}
        if t and t in error_titles:
            return True
        h = (html or "").lower()[:1000]
        # Check for common server error patterns in the HTML
        for pat in ("500 internal server error", "502 bad gateway",
                    "503 service unavailable", "504 gateway timeout",
                    "<h1>500</h1>", "<h1>502</h1>", "<h1>503</h1>", "<h1>504</h1>"):
            if pat in h:
                return True
        return False

    @staticmethod
    def _looks_server_error(title: str, html: str) -> bool:
        t = (title or "").lower()
        for phrase in ("500", "502", "503", "504", "502 bad gateway",
                       "503 service unavailable", "504 gateway timeout",
                       "internal server error", "service unavailable",
                       "server error", "bad gateway"):
            if phrase in t:
                return True
        h = (html or "").lower()[:500]
        for code in ("500", "502", "503", "504"):
            if code in h:
                return True
        return False

    def fetch_html(
        self,
        url: str,
        *,
        challenge_wait_s: float = 10.0,
        referrer_url: Optional[str] = None,
    ) -> Tuple[str, str, Optional[int], str]:
        """
        Returns (final_url_base, html, status_code, title).
        status_code may be None if the browser didn't emit logs.
        """
        if not self.start() or self.driver is None:
            _app._ts_print("  StealthBrowser: start() returned no driver")
            return "", "", None, ""

        # Clear old logs so status attribution is less noisy
        self._drain_performance_logs()

        url = _app._sanitize_url_candidate(url)
        url_base, _ = _app._split_url(url)
        if not url_base:
            return "", "", None, ""
        try:
            self._maybe_set_window_size()
            self._maybe_set_referrer(url_base, referrer_url=referrer_url)
            self.driver.get(url_base)
        except Exception as e:
            _app._ts_print(f"  StealthBrowser: driver.get() failed: {e}")
            return "", "", None, ""

        # Keep your validated “sleep for DataDome” behaviour. :contentReference[oaicite:2]{index=2}
        if challenge_wait_s > 0:
            _gated_sleep(max(0.0, challenge_wait_s + random.uniform(-0.5, 2)))

        self._humanize_after_load()

        title = ""
        try:
            title = self.driver.title or ""
        except Exception:
            pass

        html = ""
        try:
            html = self.driver.page_source or ""
        except Exception:
            pass

        final_url = ""
        try:
            final_url = self.driver.current_url or ""
        except Exception:
            pass

        final_base, _ = _app._split_url(final_url)

        status = self._infer_main_status(final_base) if final_base else None

        # Heuristics if logs are missing or interstitials occur
        if self._looks_blocked(title, html):
            status = 403
        elif self._looks_404(title, html) and (status is None or status < 400):
            status = 404
        elif self._looks_server_error(title, html) and (status is None or status < 400):
            status = 500

        # If status could not be inferred from logs but we got real HTML, assume success
        if status is None and html.strip():
            status = 200
            _app._ts_print(f"  Inferred status=200 from non-empty HTML ({len(html)} chars)")

        return final_base, html, status, title


def _detect_chrome_version() -> Optional[int]:
    """Detect the installed Chrome major version from Windows registry."""
    try:
        import winreg
        for key_path in [
            r"Software\Google\Chrome\BLBeacon",
            r"Software\Wow6432Node\Google\Chrome\BLBeacon",
        ]:
            try:
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path)
                version = winreg.QueryValueEx(key, "version")[0]
                major = int(version.split(".")[0])
                _app._ts_print(f"  Detected Chrome version: {major}")
                return major
            except (OSError, ValueError):
                continue
        # Fallback: check Chrome.exe file version
        for path in [
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        ]:
            if os.path.exists(path):
                try:
                    import struct
                    size = 40
                    with open(path, "rb") as f:
                        f.seek(0x3C)
                        off = struct.unpack("I", f.read(4))[0]
                        f.seek(off + 0xA8)
                        ver = f.read(4)
                        major = ver[0]
                        _app._ts_print(f"  Detected Chrome version (PE): {major + 100}")
                        return major + 100  # approximate
                except Exception:
                    pass
    except Exception:
        pass
    _app._ts_print("  Could not detect Chrome version")
    return None


def _learn_resolved_case(url_base: str, page_title: str) -> None:
    """Feed successfully resolved case pages to the self-healing supplement
    db (cases newer than the baseline snapshot). Must never raise into the
    resolution path."""
    try:
        from . import supplement

        supplement.learn_from_resolution(url_base, page_title)
    except Exception:
        pass


def _should_try_courtlistener_fr_variant(url_base: str) -> bool:
    parts = urlsplit(url_base or "")
    segs = [s for s in (parts.path or "").split("/") if s]
    if len(segs) >= 4 and segs[0] == "en" and segs[2] == "laws":
        return segs[1].lower() in {"qc", "nb"}
    return True


class CachedHtmlResolver:
    """
    Resolve a candidate URL to a working URL, with:
      - cache keyed by URL sans fragment
      - HTML persisted to disk
      - 404 -> try /en/ -> /fr/ where that fallback is useful
      - other error -> 2 retries with exponential backoff
    """
    def __init__(
        self,
        *,
        cache_dir: str | Path = "webpage_cache",
        chrome_version_main: Optional[int] = None,
        challenge_wait_s: float = 10.0,
        log_path: Optional[str | Path] = None,
        user_data_dir: Optional[str | Path] = None,
        referrer_url: Optional[str] = None,
        window_size_range: Optional[Tuple[Tuple[int, int], Tuple[int, int]]] = None,
        post_load_wait_range: Optional[Tuple[float, float]] = None,
        enable_humanization: bool = True,
    ):
        self.cache = HtmlCache(cache_dir)
        if user_data_dir is None:
            env_profile = os.environ.get("COURTLISTENER_PROFILE_DIR", "").strip()
            user_data_dir = env_profile or str(Path(cache_dir) / "chrome_profile")
        else:
            user_data_dir = str(user_data_dir).strip() or None

        if referrer_url is None:
            referrer_url = os.environ.get("COURTLISTENER_REFERRER_URL", "https://www.courtlistener.com/").strip()
        referrer_url = referrer_url or None
        self.default_referrer_url = referrer_url

        if window_size_range is None:
            min_raw = os.environ.get("COURTLISTENER_WINDOW_MIN", "1200x800")
            max_raw = os.environ.get("COURTLISTENER_WINDOW_MAX", "1600x1000")
            min_ws = _parse_window_size(min_raw, (1200, 800))
            max_ws = _parse_window_size(max_raw, (1600, 1000))
            window_size_range = (min_ws, max_ws)

        if post_load_wait_range is None:
            min_wait = float(os.environ.get("COURTLISTENER_POST_LOAD_WAIT_MIN", "1.5"))
            max_wait = float(os.environ.get("COURTLISTENER_POST_LOAD_WAIT_MAX", "4.0"))
            post_load_wait_range = (min_wait, max_wait)

        self.browser = StealthBrowser(
            chrome_version_main=chrome_version_main,
            window_size_range=window_size_range,
            user_data_dir=user_data_dir,
            referrer_url=referrer_url,
            post_load_wait_range=post_load_wait_range,
            enable_humanization=enable_humanization,
        )
        self.challenge_wait_s = float(challenge_wait_s)
        # One Chrome instance serves the whole process; when several
        # documents verify in parallel their fetches take turns here (which
        # also keeps the request rate CourtListener sees identical to a single run).
        self._resolve_lock = threading.RLock()
        self.retry_base_delay_s = _safe_float(os.environ.get("COURTLISTENER_RETRY_BASE_DELAY_S", "4.0"), 4.0)
        self.retry_jitter_min_s = _safe_float(os.environ.get("COURTLISTENER_RETRY_JITTER_MIN_S", "10.0"), 10.0)
        self.retry_jitter_max_s = _safe_float(os.environ.get("COURTLISTENER_RETRY_JITTER_MAX_S", "30.0"), 30.0)

        self.logger = logging.getLogger("CachedHtmlResolver")
        self.logger.setLevel(logging.INFO)
        self.logger.propagate = False

        if not self.logger.handlers:
            lp = Path(log_path) if log_path else (Path(cache_dir) / "failed_urls.log")
            handler = logging.FileHandler(lp, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(asctime)s\t%(message)s"))
            self.logger.addHandler(handler)

        atexit.register(self.close)

    def close(self) -> None:
        self.browser.close()

    def get_cached_html(self, url: str) -> Optional[str]:
        with self._resolve_lock:
            return self.cache.get_cached_html(url)

    def resolve_url(self, url: str) -> str:
        """
        Returns a working URL (preserving original fragment) or "" on failure.
        """
        with self._resolve_lock:
            return self._resolve_url_locked(url)

    def _resolve_url_locked(self, url: str) -> str:
        candidate = _app._sanitize_url_candidate(url)
        if not candidate or candidate.lower() == "other":
            return ""

        _app._ts_print(f"Processing URL: {candidate}")

        base, frag = _app._split_url(candidate)
        if not base:
            return ""

        # Non-CourtListener URLs (perma.cc, etc.) don't need the browser — return as-is
        if "courtlistener.com" not in base:
            return _app._recombine_url(base, frag)

        # Cache hit?
        entry = self.cache.get_entry(base)
        if entry and (self.cache.cache_dir / entry.html_path).exists():
            if entry.status_code < 400:
                _app._ts_print("  CourtListener cache hit")
                return _app._recombine_url(entry.canonical_url_base, frag)
            return ""

        # Attempt resolution + caching
        return self._attempt_and_cache(
            base,
            frag,
            allow_en_to_fr=_should_try_courtlistener_fr_variant(base),
        )

    def _derive_referrer_for_url(self, url_base: str) -> Optional[str]:
        """
        Derive a CourtListener referrer based on URL structure.
        - Cases: https://www.courtlistener.com/{jurisdiction}/{court}/doc/
        - Legislation: https://www.courtlistener.com/ca/laws/{legislation_type}/
        """
        if not url_base:
            return None
        parts = urlsplit(url_base)
        if not parts.scheme or not parts.netloc:
            return None
        segs = [s for s in (parts.path or "").split("/") if s]
        if len(segs) >= 4 and segs[0] == "en" and segs[1] == "ca" and segs[2] == "laws":
            path = "/" + "/".join(segs[:4]) + "/"
            return urlunsplit((parts.scheme, parts.netloc, path, "", ""))
        if len(segs) >= 4 and segs[0] == "en" and segs[3] == "doc":
            path = "/" + "/".join(segs[:4]) + "/"
            return urlunsplit((parts.scheme, parts.netloc, path, "", ""))
        return None

    def _referrer_for_base(self, url_base: str) -> Optional[str]:
        return self._derive_referrer_for_url(url_base) or self.default_referrer_url

    def _attempt_and_cache(self, base: str, frag: str, *, allow_en_to_fr: bool) -> str:
        attempt_url = _app._recombine_url(base, frag)
        last_status: Optional[int] = None

        max_attempts = 3  # 1 initial + 2 retries
        for attempt in range(max_attempts):
            _app._pause_gate()  # honor a GUI pause before each fetch attempt
            _app._ts_print(f"Fetching URL: {attempt_url}")
            final_base, html, status, page_title = self.browser.fetch_html(
                attempt_url,
                challenge_wait_s=self.challenge_wait_s,
                referrer_url=self._referrer_for_base(base),
            )
            last_status = status

            # Unknown status: treat as transient error and keep retrying
            if status is None:
                if attempt < max_attempts - 1:
                    # Skip retries for non-CourtListener URLs (perma.cc, etc.)
                    if "courtlistener.com" not in base:
                        _app._ts_print("  Non-CourtListener URL, skipping retries")
                        break

                    # Keep browser retries for courtlistener.com URLs (browser might work next time)
                    self.browser.restart()
                    self._retry_with_delay(
                        attempt_url,
                        status,
                        attempt,
                        max_attempts,
                        reason="status=None (no status from browser)",
                    )
                    continue
                break

            # 404 special case: try /fr/ once if /en/ exists
            if status == 404 and allow_en_to_fr and "/en/" in base:
                base_fr = base.replace("/en/", "/fr/", 1)
                attempt_url_fr = _app._recombine_url(base_fr, frag)

                _app._ts_print(f"Fetching URL: {attempt_url_fr}")
                final_base_fr, html_fr, status_fr, page_title_fr = self.browser.fetch_html(
                    attempt_url_fr,
                    challenge_wait_s=self.challenge_wait_s,
                    referrer_url=self._referrer_for_base(base_fr),
                )

                if status_fr is not None and status_fr < 400 and final_base_fr:
                    self.cache.put(base, final_base_fr, html_fr, status_fr)
                    _learn_resolved_case(final_base_fr, page_title_fr)
                    return _app._recombine_url(final_base_fr, frag)

                # If /fr/ is a non-404 error, apply normal retry logic against /fr/
                if status_fr is None or status_fr != 404:
                    base = base_fr
                    attempt_url = attempt_url_fr
                    allow_en_to_fr = False
                    last_status = status_fr
                    if attempt < max_attempts - 1:
                        self._retry_with_delay(
                            attempt_url,
                            status_fr,
                            attempt,
                            max_attempts,
                            reason=self._describe_retry_reason(status_fr, prefix="after /fr/"),
                        )
                        continue
                    break

                # Both 404: fail
                self._log_failure(base, status_fr)
                return ""

            # Success
            if status < 400 and final_base:
                self.cache.put(base, final_base, html, status)
                _learn_resolved_case(final_base, page_title)
                return _app._recombine_url(final_base, frag)

            # Non-404 error: retry (we already loop)
            if status != 404:
                if attempt < max_attempts - 1:
                    self._retry_with_delay(
                        attempt_url,
                        status,
                        attempt,
                        max_attempts,
                        reason=self._describe_retry_reason(status),
                    )
                    continue
                break

            # 404 without /en/->/fr/ path replacement available
            self._log_failure(base, status)
            return ""

        # Exhausted retries
        self._log_failure(base, last_status)
        return ""

    def _describe_retry_reason(self, status: Optional[int], *, prefix: str = "") -> str:
        if status is None:
            reason = "status=None (no status from browser)"
        elif status == 403:
            reason = "forbidden/blocked (403)"
        elif status == 429:
            reason = "rate limited (429)"
        elif status >= 500:
            reason = f"server error ({status})"
        elif status >= 400:
            reason = f"client error ({status})"
        else:
            reason = f"unexpected status ({status})"
        return f"{prefix} {reason}".strip()

    def _retry_with_delay(
        self,
        url: str,
        status: Optional[int],
        attempt_index: int,
        max_attempts: int,
        *,
        reason: str,
    ) -> None:
        retry_index = attempt_index + 1
        delay = self._retry_delay(retry_index)
        next_attempt_num = retry_index + 1
        st = "None" if status is None else str(status)
        msg = (
            f"Retrying fetch in {delay:.2f}s before attempt {next_attempt_num}/{max_attempts}: "
            f"status={st}; reason={reason}; url={url}"
        )
        _app._ts_print(msg)
        self.logger.info(msg)
        _gated_sleep(delay)

    def _retry_delay(self, retry_index: int) -> float:
        base = max(0.0, float(self.retry_base_delay_s)) * (2 ** (max(1, retry_index) - 1))
        jitter_min = max(0.0, min(self.retry_jitter_min_s, self.retry_jitter_max_s))
        jitter_max = max(jitter_min, max(self.retry_jitter_min_s, self.retry_jitter_max_s))
        return base + random.uniform(jitter_min, jitter_max)

    def _log_failure(self, url_base: str, status: Optional[int]) -> None:
        st = "" if status is None else str(status)
        self.logger.info(f"{url_base}\t{st}")


# NoopHtmlResolver moved to verifier_core.protocols (it is the public-build
# default and must not depend on this adapter); re-exported for callers that
# import it from here.
from courtlistener_runtime import NoopHtmlResolver  # noqa: E402,F401
