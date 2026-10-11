"""Standalone host for the copied ALR browser pathway (Apache-2.0).

The URL/log helpers retain the source pathway's contracts. Legal HTML lives in
the existing content-addressed OpenLegalData corpus, never in the browser cache.
"""
from __future__ import annotations

import atexit
import hashlib
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'legal_pdf_corpus'))
import corpus_store

URL_RE = re.compile(r'https?://\S+', re.IGNORECASE)
TRAILING_URL_PUNCT = '.,;:!?)]}>\"\'“”’‘'
_database = None


def _split_url(url: str) -> tuple[str, str]:
    parts = urlsplit((url or '').strip())
    return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, '')), parts.fragment or ''


def _recombine_url(base_url: str, fragment: str) -> str:
    frag = (fragment or '').lstrip('#')
    return f'{base_url}#{frag}' if base_url and frag else base_url or ''


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _sanitize_url_candidate(raw: str) -> str:
    value = (raw or '').strip()
    if not value:
        return ''
    match = URL_RE.search(value)
    value = (match.group(0) if match else value.split()[0]).rstrip(TRAILING_URL_PUNCT)
    parts = urlsplit(value)
    if parts.scheme != 'https' or parts.hostname not in ('www.courtlistener.com', 'courtlistener.com') or parts.port not in (None, 443) or parts.username or parts.password:
        raise ValueError('This corpus pathway accepts public CourtListener HTTPS URLs only')
    return value


def _ts_print(message: str = '') -> None:
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {message}', flush=True)


def _pause_gate() -> None:
    pass


def _corpus_file(relative: str) -> Path:
    return corpus_store.HOME / relative


def _store_html(html: str, url: str, final_url: str, status: int, *, representation: str = 'selenium.page_source') -> str:
    global _database
    if _database is None:
        _database = corpus_store.connect()
        atexit.register(_database.close)
    collection = 'courtlistener-web' if representation == 'selenium.page_source' else 'courtlistener-http'
    meta = {'collection': collection, 'kind': 'opinion' if '/opinion/' in final_url else 'index-page',
            'jurisdiction': 'us', 'label': final_url,
            'provenance': json.dumps({'source': 'CourtListener', 'representation': representation, 'http_status': status})}
    sha = corpus_store.add_file(_database, html.encode('utf-8'), 'text/html; charset=utf-8', corpus_store.place(meta), text=False)
    corpus_store.note(_database, sha, meta, url, final_url)
    _database.commit()
    return _database.execute('SELECT path FROM files WHERE sha256=?', (sha,)).fetchone()[0]


class NoopHtmlResolver:
    """Copied no-op contract from ALR verifier_core/protocols.py."""
    def __init__(self, *args, **kwargs):
        pass

    def resolve_url(self, url: str) -> str:
        return (url or '').strip()

    def get_cached_html(self, url: str):
        return None

    def close(self):
        pass
