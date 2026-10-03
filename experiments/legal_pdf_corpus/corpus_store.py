#!/usr/bin/env python3
"""The machine's durable home for real-world legal documents, at %LOCALAPPDATA%/OpenLegalData/corpus.

Files are stored once by sha256, laid out <collection>/<jurisdiction>/<kind>/, and indexed
in corpus.sqlite with collection, jurisdiction, kind, label, source URL, fetch times,
provenance and per-page text (FTS5), so any page can be cited by sha256 and page.
Collections: legal-pdf (the 3,000-PDF harvest; ledger.jsonl + pdfs/ kept in place),
court-practice (court_practice.json: official filing rules, filed books of authorities
and their briefs), legislation, and court-record-exhibits (indexed in place from
OpenLegalData/benchmarks; never moved). A stored URL is not downloaded again unless
--refresh is given and the server reports a change.

  add <url|file> [--kind K] [--jurisdiction J] [--label L] [--collection C] [--url ORIGIN] [--refresh]
  path [<url|sha prefix>] [--collection C] [--kind K] [--jurisdiction J]
  search "<fts query>" [--collection C] [--kind K] [--court COURT]
  sync [--court COURT ...]      fetch court_practice.json
  index [--no-text]             (re)index legal-pdf and court-record-exhibits in place
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen


HOME = Path(os.environ.get("OPEN_LEGAL_DATA_HOME") or Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "OpenLegalData")
ROOT = HOME / "corpus"
DB = ROOT / "corpus.sqlite"
LEGAL_PDF = ROOT / "legal-pdf"
COURT_RECORDS = HOME / "benchmarks" / "court-record-exhibits"
REGISTRY = Path(__file__).resolve().parent / "court_practice.json"
COLLECTION_OF = {"legislation": "legislation", "court-rules": "court-practice", "book-of-authorities": "court-practice", "brief": "court-practice"}
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
           "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.5", "Accept-Language": "en-CA,en;q=0.9"}
DELAY, RETRIES, MAX_BYTES = 2.0, 2, 100_000_000
LINK = re.compile(r"""<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>(.*?)</a>""", re.S | re.I)
SCHEMA = """
create table if not exists files(sha256 text primary key, path text, bytes integer, content_type text, pages integer,
  text_sha256 text, indexed_at text);
create table if not exists documents(id integer primary key, sha256 text, collection text, jurisdiction text, kind text,
  label text, url text, final_url text, fetched_at text, last_seen_at text, provenance text, etag text, last_modified text,
  unique(url, collection));
create index if not exists documents_sha on documents(sha256);
create table if not exists fetches(id integer primary key, url text, fetched_at text, http_status integer,
  final_url text, bytes integer, sha256 text, error text);
create table if not exists court_documents(court text, doc_id text, role text, title text, url text, source text,
  brief_for text, primary key(court, doc_id));
create table if not exists pages(sha256 text, page integer, text text, primary key(sha256, page));
create virtual table if not exists pages_fts using fts5(text, content='pages', tokenize='porter unicode61');
create trigger if not exists pages_ai after insert on pages begin
  insert into pages_fts(rowid, text) values (new.rowid, new.text); end;
"""
_last_hit: dict[str, float] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    ROOT.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB, timeout=60)
    db.execute("pragma journal_mode=wal")
    db.executescript(SCHEMA)
    return db


def get(url: str, extra: dict | None = None) -> tuple[int, str, str, bytes, dict]:
    p = urlsplit(url)
    host = p.hostname or ""
    if host.endswith(("canlii.org", "canlii.ca")):
        raise ValueError("CanLII is never fetched")
    clean = urlunsplit((p.scheme, p.netloc, quote(p.path, safe="/%:@()'!,;=+-_.~"), p.query, ""))
    for attempt in range(RETRIES + 1):
        time.sleep(max(0.0, _last_hit.get(host, 0) + DELAY - time.time()))
        _last_hit[host] = time.time()
        try:
            with urlopen(Request(clean, headers={**HEADERS, **(extra or {})}), timeout=90) as r:
                body = r.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise ValueError(f"larger than {MAX_BYTES} bytes")
                return r.status, r.geturl(), r.headers.get("content-type", "").lower(), body, dict(r.headers)
        except HTTPError as e:
            if e.code < 500 and e.code != 429 or attempt == RETRIES:
                return e.code, url, "", b"", {}
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


def page_texts(body: bytes) -> list[str]:
    if body[:5] == b"%PDF-":
        import fitz  # PyMuPDF
        try:
            with fitz.open(stream=body, filetype="pdf") as pdf:
                return [page.get_text() for page in pdf]
        except Exception:  # unreadable PDF: keep the bytes, index no text
            return []
    return [html_text(body)] if body.lstrip()[:1] == b"<" else []


def add_file(db, body: bytes, ctype: str, where: Path | None, text: bool = True) -> str:
    """Record bytes once by sha256: at `where` when the file already lives under HOME, else copied into ROOT/`where`."""
    sha = hashlib.sha256(body).hexdigest()
    if db.execute("select 1 from files where sha256=?", (sha,)).fetchone():
        return sha
    texts = page_texts(body) if text else []
    if not where.is_relative_to(HOME):
        ext = ".pdf" if body[:5] == b"%PDF-" else ".html" if body.lstrip()[:1] == b"<" else ".bin"
        where = ROOT / where / f"{sha}{ext}"
        where.parent.mkdir(parents=True, exist_ok=True)
        if not where.exists():
            where.write_bytes(body)
    db.execute("insert into files values (?,?,?,?,?,?,?)", (sha, where.relative_to(HOME).as_posix(), len(body), ctype, len(texts) if text else None,
                                                          hashlib.sha256("\f".join(texts).encode()).hexdigest() if text else None, now()))
    db.executemany("insert into pages(sha256, page, text) values (?,?,?)", [(sha, i + 1, t) for i, t in enumerate(texts)])
    return sha


def note(db, sha: str, meta: dict, url: str | None = None, final: str | None = None, headers: dict | None = None) -> None:
    """Upsert the document row that says what these bytes are and where they came from."""
    headers, row = headers or {}, (sha, meta.get("collection"), jurisdiction(meta), meta.get("kind"), meta.get("label"))
    if url:
        db.execute("insert into documents(sha256, collection, jurisdiction, kind, label, url, final_url, fetched_at, last_seen_at, provenance, etag, last_modified)"
                   " values (?,?,?,?,?,?,?,?,?,?,?,?) on conflict(url, collection) do update set sha256=excluded.sha256, final_url=excluded.final_url,"
                   " last_seen_at=excluded.last_seen_at, etag=excluded.etag, last_modified=excluded.last_modified,"
                   " collection=coalesce(excluded.collection, collection), jurisdiction=coalesce(excluded.jurisdiction, jurisdiction),"
                   " kind=coalesce(excluded.kind, kind), label=coalesce(excluded.label, label), provenance=coalesce(excluded.provenance, provenance)",
                   (*row, url, final, meta.get("fetched_at") or now(), now(), meta.get("provenance"), headers.get("ETag"), headers.get("Last-Modified")))
    elif not db.execute("select 1 from documents where url is null and sha256=? and collection is ?", (sha, meta.get("collection"))).fetchone():
        db.execute("insert into documents(sha256, collection, jurisdiction, kind, label, fetched_at, last_seen_at, provenance) values (?,?,?,?,?,?,?,?)",
                   (*row, meta.get("fetched_at"), now(), meta.get("provenance")))


def jurisdiction(meta: dict) -> str | None:
    """Lower-case codes: provinces and territories (ab, mb, ...), ca for federal Canada, countries otherwise."""
    code = (meta.get("jurisdiction") or "").strip().lower() or None
    return "ca" if code in ("fed", "federal", "can", "canada") else code


def place(meta: dict) -> Path:
    return Path(meta["collection"]) / (jurisdiction(meta) or "unknown") / (meta.get("kind") or "document")


def fetch(db, url: str, meta: dict, refresh: bool = True) -> tuple[str | None, str]:
    """Fetch a URL into the store; a known URL is re-checked (conditionally) only when refresh is set."""
    known = db.execute("select d.sha256, d.etag, d.last_modified, f.text_sha256 from documents d left join files f on f.sha256=d.sha256"
                       " where d.url=? order by d.collection is ? desc limit 1", (url, meta.get("collection"))).fetchone()
    if known and not refresh:
        note(db, known[0], meta, url)
        db.commit()
        return known[0], "already stored"
    extra = {k: v for k, v in (("If-None-Match", known and known[1]), ("If-Modified-Since", known and known[2])) if v}
    try:
        status, final, ctype, body, headers = get(url, extra)
    except Exception as e:  # network failure after retries
        db.execute("insert into fetches(url, fetched_at, error) values (?,?,?)", (url, now(), str(e)))
        return (known[0] if known else None), f"error {e}"
    sha = hashlib.sha256(body).hexdigest() if body else None
    db.execute("insert into fetches(url, fetched_at, http_status, final_url, bytes, sha256) values (?,?,?,?,?,?)", (url, now(), status, final, len(body), sha))
    if status == 304 and known:
        db.execute("update documents set last_seen_at=? where url=?", (now(), url))
        return known[0], "unchanged"
    if status != 200 or not body:
        return (known[0] if known else None), f"HTTP {status}"
    if known and body[:5] != b"%PDF-" and known[3] == hashlib.sha256("\f".join(page_texts(body)).encode()).hexdigest():
        sha = known[0]  # HTML whose markup changed but whose text did not
    else:
        sha = add_file(db, body, ctype, place(meta))
    status = "unchanged" if known and known[0] == sha else "changed (previous version kept)" if known else "new"
    note(db, sha, meta, url, final, headers)
    db.commit()
    return sha, status


def discover(entry: dict) -> list[tuple[str, str, str]]:
    """(doc_id, url, title) for a registry entry: one direct URL or the landing page's matching links."""
    if "url" in entry:
        return [(entry["id"], entry["url"], entry.get("title", ""))]
    try:
        status, final, _, body, _ = get(entry["landing"])
    except Exception as e:  # keep going; the landing's documents keep their stored versions
        status, final, body = str(e), "", b""
    if status != 200:
        print(f"  landing {entry['landing']} -> {status}; its documents were not re-checked", file=sys.stderr)
        return []
    pattern, found = re.compile(entry["pattern"], re.I), {}
    for m in LINK.finditer(body.decode("utf-8", "replace")):
        url = urljoin(final, html.unescape(m.group(2))).split("#")[0]
        if pattern.search(url) and url not in found:
            found[url] = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group(3)))).strip()
    return [(f"{entry['id']}--{re.sub(r'[^a-z0-9]+', '-', Path(unquote(urlsplit(u).path)).stem.lower()).strip('-')[:70]}", u, t or entry.get("title", ""))
            for u, t in list(found.items())[: entry.get("max", 10)]]


def sync(args) -> None:
    registry, db = json.loads(REGISTRY.read_text(encoding="utf-8")), connect()
    norm = lambda s: re.sub(r"\s+", " ", s.replace("’", "'")).lower()
    for court, spec in registry["courts"].items():
        if args.court and court not in args.court:
            continue
        print(f"[{court}]")
        for role in ("rules", "examples"):
            for entry in spec.get(role, []):
                for doc_id, url, title in discover(entry):
                    docs = [(doc_id, url, title or entry.get("description", ""), None, "court-rules" if role == "rules" else "book-of-authorities")]
                    if entry.get("brief"):  # the brief filed with this book, kept as its pair
                        docs.append((f"{doc_id}--brief", entry["brief"], f"Brief filed with {doc_id}", doc_id, "brief"))
                    for did, u, t, pair, kind in docs:
                        db.execute("insert or replace into court_documents values (?,?,?,?,?,?,?)", (court, did, role, t, u, entry.get("landing", "direct"), pair))
                        meta = {"collection": "court-practice", "kind": kind, "jurisdiction": spec["jurisdiction"], "label": f"{court}: {t}"[:300],
                                "provenance": f"court_practice.json {court}/{did}"}
                        sha, status = fetch(db, u, meta)
                        if sha and entry.get("cover"):
                            head = " ".join(r[0] for r in db.execute("select text from pages where sha256=? and page<=3", (sha,)))
                            status += "" if norm(entry["cover"]) in norm(head) else f"; cover lacks {entry['cover']!r}"
                        print(f"  {kind} {did}: {status}")
                        db.commit()
    for court, docs, size in db.execute("select court, count(*), sum(bytes) from (select distinct d.court, f.sha256, f.bytes from court_documents d"
                                        " join documents e on e.url=d.url join files f on f.sha256=e.sha256) group by court"):
        print(f"{court}: {docs} stored documents, {size / 1e6:.1f} MB")


def index(args) -> None:
    """Index the in-place collections: legal-pdf from its ledger, court-record-exhibits raw sources from their provenance."""
    db, known = connect(), {r[0]: r[1] for r in connect().execute("select path, bytes from files")}
    todo = []
    latest = {}
    for line in (LEGAL_PDF / "ledger.jsonl").open(encoding="utf-8"):
        row = json.loads(line)
        latest[row["candidate_id"]] = row
    for row in latest.values():
        if row.get("status") == "accepted":
            todo.append((LEGAL_PDF / row["relative_path"], {"collection": "legal-pdf", "jurisdiction": row.get("jurisdiction"), "kind": row.get("kind"),
                         "label": row.get("title") or Path(row["relative_path"]).stem, "fetched_at": row.get("attempted_at"),
                         "provenance": f"legal-pdf ledger {row['candidate_id']} ({row.get('source')}; landing {row.get('landing_url')})"}, row.get("url")))
    ledger = COURT_RECORDS / "provenance" / "tooling-recovery-20261003" / "sources-ledger.jsonl"
    by_sha = {r["sha256"]: r for r in map(json.loads, ledger.open(encoding="utf-8")) if r.get("sha256")} if ledger.exists() else {}
    for pdf in sorted((COURT_RECORDS / "raw").glob("*.pdf")):
        side = pdf.with_suffix(".meta.json")
        todo.append((pdf, {"collection": "court-record-exhibits", "kind": "court-record", "sidecar": json.loads(side.read_text(encoding="utf-8")) if side.exists() else {}}, None))
    for n, (path, meta, url) in enumerate(todo, 1):
        rel = path.relative_to(HOME).as_posix()
        if not path.is_file() or known.get(rel) == path.stat().st_size:
            continue
        body = path.read_bytes()
        sha = add_file(db, body, "application/pdf", path, text=not args.no_text)
        if meta["collection"] == "court-record-exhibits":  # provenance by sha from the sources ledger, else the sidecar
            src, side = by_sha.get(sha, {}), meta.pop("sidecar")
            url = src.get("url") or side.get("url")
            meta.update(jurisdiction=(src.get("jurisdiction") or side.get("jurisdiction") or "").lower() or None,
                        label=src.get("title") or side.get("document_title") or path.stem, fetched_at=src.get("retrieved") or side.get("retrieved"),
                        provenance=f"court-record-exhibits {src.get('record') or path.name}; {src.get('court') or side.get('court') or ''}".strip("; "))
        note(db, sha, meta, url)
        db.commit()  # per file, so other writers are never blocked for long
        if n % 50 == 0:
            print(f"{n}/{len(todo)}", flush=True)
    db.commit()
    summary()


def summary() -> None:
    for coll, docs, size in connect().execute("select d.collection, count(distinct d.sha256), sum(f.bytes) from (select distinct collection, sha256 from documents) d"
                                              " join files f on f.sha256=d.sha256 group by d.collection"):
        print(f"{coll}: {docs} files, {size / 1e9:.2f} GB")


def add(args) -> None:
    kind = args.kind
    meta = {"collection": args.collection or COLLECTION_OF.get(kind or "", "misc"), "kind": kind, "jurisdiction": args.jurisdiction,
            "label": args.label, "provenance": args.provenance}
    db, local = connect(), Path(args.target)
    if local.is_file():
        body = local.read_bytes()
        sha = add_file(db, body, "application/pdf" if body[:5] == b"%PDF-" else "", local.resolve() if local.resolve().is_relative_to(HOME) else place(meta))
        note(db, sha, {**meta, "provenance": meta["provenance"] or f"added from {local.resolve()}"}, args.url)
        db.commit()
        status = "stored"
    else:
        sha, status = fetch(db, args.target, meta, refresh=args.refresh)
    row = db.execute("select path from files where sha256=?", (sha,)).fetchone() if sha else None
    print(f"{status}\t{sha or '-'}\t{(HOME / row[0]) if row else '-'}")


def path(args) -> None:
    rows = connect().execute(
        "select f.path, f.sha256, d.collection, d.kind, d.jurisdiction, d.label, d.url from documents d join files f on f.sha256=d.sha256"
        " where (? is null or d.url=? or f.sha256 like ?) and (? is null or d.collection=?) and (? is null or d.kind=?) and (? is null or d.jurisdiction=?)"
        " order by d.collection, d.jurisdiction, d.kind, d.label",
        (args.target, args.target, f"{args.target}%", args.collection, args.collection, args.kind, args.kind, args.jurisdiction, args.jurisdiction))
    for rel, sha, *rest in rows:
        print("\t".join([str(HOME / rel), sha[:12], *[str(v or "-") for v in rest]]))


def search(args) -> None:
    rows = connect().execute(
        "select distinct coalesce(c.doc_id, d.label), f.sha256, p.page, snippet(pages_fts, 0, '[', ']', ' ... ', 24), coalesce(d.url, f.path) from pages_fts"
        " join pages p on p.rowid=pages_fts.rowid join files f on f.sha256=p.sha256 join documents d on d.sha256=f.sha256"
        " left join court_documents c on c.url=d.url where pages_fts match ? and (? is null or d.collection=?) and (? is null or d.kind=?)"
        " and (? is null or c.court=?) order by 1, p.page limit ?",
        (args.query, args.collection, args.collection, args.kind, args.kind, args.court, args.court, args.limit))
    for name, sha, page, snip, where in rows:
        print(f"{name} | sha256 {sha[:12]} | p {page}\n  {' '.join(snip.split())}\n  {where}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("add", help="store a URL or local file")
    a.add_argument("target")
    for flag in ("--kind", "--jurisdiction", "--label", "--collection", "--url", "--provenance"):
        a.add_argument(flag)
    a.add_argument("--refresh", action="store_true", help="re-check a stored URL (conditional request)")
    p = sub.add_parser("path", help="print local paths of stored documents")
    p.add_argument("target", nargs="?")
    for flag in ("--collection", "--kind", "--jurisdiction"):
        p.add_argument(flag)
    s = sub.add_parser("search", help="full-text search stored pages (FTS5 query syntax)")
    s.add_argument("query")
    for flag in ("--collection", "--kind", "--court"):
        s.add_argument(flag)
    s.add_argument("--limit", type=int, default=20)
    y = sub.add_parser("sync", help="fetch every court in court_practice.json")
    y.add_argument("--court", nargs="*")
    i = sub.add_parser("index", help="index legal-pdf and court-record-exhibits in place")
    i.add_argument("--no-text", action="store_true")
    sub.add_parser("summary", help="files and GB per collection")
    args = parser.parse_args()
    {"add": add, "path": path, "search": search, "sync": sync, "index": index, "summary": lambda _: summary()}[args.command](args)


if __name__ == "__main__":
    main()
