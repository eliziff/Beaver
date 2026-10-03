#!/usr/bin/env python3
"""Fetch each registered court's official filing rules and real filed examples.

`court_practice.json` lists, per court, where its rules live (direct URLs, or
landing pages with a link pattern so reissued documents are found on the next
run) and public example filings. `fetch` stores every distinct version under
pdfs/ca/court-practice/ and indexes metadata and per-page text in
court_practice.sqlite; `search` finds a passage by page for citation.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

import fitz  # PyMuPDF

HERE = Path(__file__).resolve().parent
REGISTRY = HERE / "court_practice.json"
DB = HERE / "court_practice.sqlite"
ROOT = HERE / "pdfs" / "ca" / "court-practice"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 BeaverCourtPractice/1.0 (official court guidance research)"
DELAY, RETRIES, MAX_BYTES = 2.0, 2, 100_000_000
LINK = re.compile(r"""<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>(.*?)</a>""", re.S | re.I)
SCHEMA = """
create table if not exists documents(court text, doc_id text, role text, title text, url text, source text,
  primary key(court, doc_id));
create table if not exists fetches(id integer primary key, url text, fetched_at text, http_status integer,
  final_url text, content_type text, bytes integer, sha256 text, error text);
create table if not exists versions(id integer primary key, url text, sha256 text, text_sha256 text, path text,
  final_url text, content_type text, bytes integer, pages integer, first_fetched_at text, last_seen_at text);
create table if not exists pages(version_id integer, page integer, text text, primary key(version_id, page));
create virtual table if not exists pages_fts using fts5(text, content='pages', tokenize='porter unicode61');
create trigger if not exists pages_ai after insert on pages begin
  insert into pages_fts(rowid, text) values (new.rowid, new.text); end;
"""
_last_hit: dict[str, float] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_url(url: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, quote(p.path, safe="/%:@()'!,;=+-_.~"), p.query, ""))


def get(url: str) -> tuple[int, str, str, bytes]:
    host = urlsplit(url).hostname or ""
    if host.endswith(("canlii.org", "canlii.ca")):
        raise ValueError("CanLII is never fetched")
    for attempt in range(RETRIES + 1):
        time.sleep(max(0.0, _last_hit.get(host, 0) + DELAY - time.time()))
        _last_hit[host] = time.time()
        try:
            request = Request(clean_url(url), headers={"User-Agent": UA, "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.5"})
            with urlopen(request, timeout=90) as r:
                body = r.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise ValueError(f"larger than {MAX_BYTES} bytes")
                return r.status, r.geturl(), r.headers.get("content-type", "").lower(), body
        except HTTPError as e:
            if e.code < 500 and e.code != 429 or attempt == RETRIES:
                return e.code, url, "", b""
        except (URLError, TimeoutError, ConnectionError):
            if attempt == RETRIES:
                raise
        time.sleep(5 * (attempt + 1))
    raise AssertionError


def html_text(body: bytes) -> str:
    text = body.decode("utf-8", "replace")
    text = re.sub(r"(?is)<(script|style|noscript|svg|header|footer|nav|aside)\b.*?</\1>", " ", text)
    text = re.sub(r"(?is)(<li\b[^>]*>)\s*<a\b[^>]*>[^<]{0,150}</a>", r"\1", text)  # menu entries
    text = re.sub(r"(?i)<(br|/p|/div|/li|/h\d|/tr|/td|/th)\b[^>]*>", "\n", text)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return "\n".join(line for line in (re.sub(r"[ \t\xa0]+", " ", l).strip() for l in text.splitlines()) if line)


def page_texts(body: bytes, content_type: str) -> list[str]:
    if body[:5] == b"%PDF-":
        with fitz.open(stream=body, filetype="pdf") as pdf:
            return [page.get_text() for page in pdf]
    if "html" in content_type or body.lstrip()[:1] == b"<":
        return [html_text(body)]
    return []


def discover(entry: dict) -> list[tuple[str, str, str]]:
    """Return (doc_id, url, title) for a registry entry: one direct URL or the landing page's matching links."""
    if "url" in entry:
        return [(entry["id"], entry["url"], entry.get("title", ""))]
    try:
        status, final, _, body = get(entry["landing"])
    except Exception as e:  # keep going; the landing's documents keep their stored versions
        status, final, body = str(e), "", b""
    if status != 200:
        print(f"  landing {entry['landing']} -> {status}; its documents were not re-checked", file=sys.stderr)
        return []
    pattern, found = re.compile(entry["pattern"], re.I), {}
    for m in LINK.finditer(body.decode("utf-8", "replace")):
        url = urljoin(final, html.unescape(m.group(2))).split("#")[0]
        title = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group(3)))).strip()
        if pattern.search(url) and url not in found:
            found[url] = title
    out = []
    for url, title in list(found.items())[: entry.get("max", 10)]:
        stem = Path(unquote(urlsplit(url).path)).stem
        out.append((f"{entry['id']}--{re.sub(r'[^a-z0-9]+', '-', stem.lower()).strip('-')[:70]}", url, title or entry.get("title", "")))
    return out


def store(db: sqlite3.Connection, court: str, role: str, doc_id: str, url: str, expect: str | None) -> str:
    try:
        status, final, ctype, body = get(url)
    except Exception as e:  # network failure after retries
        db.execute("insert into fetches(url, fetched_at, error) values (?,?,?)", (url, now(), str(e)))
        return f"error {e}"
    sha = hashlib.sha256(body).hexdigest() if body else None
    db.execute("insert into fetches(url, fetched_at, http_status, final_url, content_type, bytes, sha256) values (?,?,?,?,?,?,?)",
               (url, now(), status, final, ctype, len(body), sha))
    if status != 200 or not body:
        return f"HTTP {status}"
    texts = page_texts(body, ctype)
    is_pdf = body[:5] == b"%PDF-"
    text_sha = hashlib.sha256("\f".join(texts).encode()).hexdigest()
    latest = db.execute("select id, sha256, text_sha256 from versions where url=? order by id desc limit 1", (url,)).fetchone()
    if latest and (latest[1] == sha or (not is_pdf and latest[2] == text_sha)):
        db.execute("update versions set last_seen_at=? where id=?", (now(), latest[0]))
        result = "unchanged"
    else:
        same = db.execute("select path from versions where sha256=? limit 1", (sha,)).fetchone()
        if same:
            rel = same[0]
        else:
            ext = ".pdf" if is_pdf else ".html" if texts else Path(urlsplit(final).path).suffix or ".bin"
            path = ROOT / court / role / doc_id / f"{sha[:16]}{ext}"
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_bytes(body)
            rel = path.relative_to(HERE).as_posix()
        vid = db.execute("insert into versions(url, sha256, text_sha256, path, final_url, content_type, bytes, pages, first_fetched_at, last_seen_at)"
                         " values (?,?,?,?,?,?,?,?,?,?)", (url, sha, text_sha, rel, final, ctype, len(body), len(texts), now(), now())).lastrowid
        db.executemany("insert into pages(version_id, page, text) values (?,?,?)", [(vid, i + 1, t) for i, t in enumerate(texts)])
        result = "new" if not latest else "changed (previous version kept)"
    if expect:
        norm = lambda s: re.sub(r"\s+", " ", s.replace("’", "'")).lower()
        if norm(expect) not in norm(" ".join(texts[:3])):
            result += f"; cover lacks {expect!r}"
    return result


def fetch(args: argparse.Namespace) -> None:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    db = sqlite3.connect(DB)
    db.executescript(SCHEMA)
    for court, spec in registry["courts"].items():
        if args.court and court not in args.court:
            continue
        print(f"[{court}]")
        for role in ("rules", "examples"):
            for entry in spec.get(role, []):
                for doc_id, url, title in discover(entry):
                    db.execute("insert or replace into documents values (?,?,?,?,?,?)",
                               (court, doc_id, role, title or entry.get("description", ""), url, entry.get("landing", "direct")))
                    print(f"  {role[:-1]} {doc_id}: {store(db, court, role, doc_id, url, entry.get('cover'))}")
                    db.commit()
    for court, docs, versions, size in db.execute(
            "select d.court, count(distinct d.doc_id), count(v.id), coalesce(sum(v.bytes), 0) from documents d"
            " left join versions v on v.url=d.url group by d.court"):
        print(f"{court}: {docs} documents, {versions} stored versions, {size / 1e6:.1f} MB")
    db.close()


def search(args: argparse.Namespace) -> None:
    db = sqlite3.connect(DB)
    rows = db.execute(
        "select d.court, d.doc_id, v.sha256, p.page, snippet(pages_fts, 0, '[', ']', ' ... ', 24), v.url from pages_fts"
        " join pages p on p.rowid=pages_fts.rowid join versions v on v.id=p.version_id join documents d on d.url=v.url"
        " where pages_fts match ? and (? is null or d.court=?) order by d.court, d.doc_id, v.id desc, p.page limit ?",
        (args.query, args.court, args.court, args.limit))
    for court, doc_id, sha, page, snip, url in rows:
        print(f"{court} | {doc_id} | sha256 {sha[:12]} | p {page}\n  {' '.join(snip.split())}\n  {url}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    f = sub.add_parser("fetch", help="fetch every registered rule source and example")
    f.add_argument("--court", nargs="*", help="limit to these registry court ids")
    s = sub.add_parser("search", help="full-text search stored pages (FTS5 query syntax)")
    s.add_argument("query")
    s.add_argument("--court")
    s.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    {"fetch": fetch, "search": search}[args.command](args)


if __name__ == "__main__":
    main()
