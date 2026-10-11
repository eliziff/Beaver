#!/usr/bin/env python3
"""Lossless CourtListener rendition audit; no source selection or semantic pruning.

Python 3.13+, standard library (CSV NULL semantics are checked at startup). The optional zstd codec needs `zstandard`.
All SQL inputs are opened read-only. The pack preserves decoded field values,
including field presence, empty strings, NULL, metadata and all renditions.
It is not a byte-for-byte archive of the original CSV serialization.
"""
from __future__ import annotations

import argparse
import bz2
import csv
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import zlib
from collections import Counter, defaultdict
from contextlib import contextmanager, nullcontext
from typing import Any, Iterator

VERSION = 1
REND = ('html_with_citations', 'xml_harvard', 'html_columbia', 'html_lawbox',
        'html_anon_2020', 'html', 'plain_text', 'xml_scan')
# These are different policies in the inspected code. Do not merge them.
BEAVER_MARKUP = REND[:6]
CL_ANNOTATION_SOURCE = ('xml_harvard', 'html_anon_2020', 'html_columbia',
                        'html_lawbox', 'html', 'plain_text')
CLUSTER_WEB_FIELDS = ('source', 'headmatter', 'correction', 'attorneys', 'headnotes',
                     'syllabus', 'summary', 'history', 'disposition', 'arguments',
                     'filepath_json_harvard', 'filepath_pdf_harvard',
                     'filepath_xml_scan', 'filepath_pdf_scan')
OPINION_CONTEXT_FIELDS = ('ordering_key', 'main_version_id', 'extracted_by_ocr',
                         'download_url', 'local_path', 'page_count')
VOID = set('area base br col embed hr img input link meta param source track wbr'.split())


def wire(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value: Any) -> str:
    return hashlib.sha256(wire(value)).hexdigest()


class WrapperSpans(HTMLParser):
    """Find *candidate* CL annotation wrappers without reserializing HTML.

    Nothing this parser concludes authorizes deletion. Exact equality against
    the independently supplied original field is the sole admission test.
    Consequently an unfamiliar/malformed wrapper only reduces compression.
    """
    def __init__(self, text: str, remove_pre: bool = False):
        super().__init__(convert_charrefs=False)
        self.text, self.remove_pre = text, remove_pre
        self.lines = [0] + [m.end() for m in re.finditer('\n', text)]
        self.stack: list[tuple[str, bool, bool]] = []
        self.spans: list[tuple[int, int]] = []

    def at(self) -> int:
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        attrs = dict(attrs)
        classes = set((attrs.get('class') or '').split())
        citation = tag == 'span' and 'citation' in classes
        # Only the immediate anchor child of a citation wrapper is a candidate.
        remove = citation or (tag == 'a' and bool(self.stack) and self.stack[-1][2])
        remove |= self.remove_pre and tag == 'pre' and classes == {'inline'}
        at = self.at()
        if remove:
            self.spans.append((at, at + len(self.get_starttag_text())))
        if tag not in VOID:
            self.stack.append((tag, bool(remove), citation))

    def handle_startendtag(self, tag, attrs):
        # No known generated wrapper uses this form; retain it exactly.
        pass

    def handle_endtag(self, tag: str):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                remove = self.stack[i][1]
                del self.stack[i:]
                if remove:
                    at = self.at()
                    end = self.text.find('>', at)
                    if end >= at:
                        self.spans.append((at, end + 1))
                return


def inverse_plan(text: str, method: str) -> dict:
    """Compute edits ONCE; replay applies slices without parsing HTML again."""
    if method not in ('cl-unwrapped-v1', 'cl-plain-v1'):
        raise ValueError(f'Unknown inverse method: {method}')
    parser = WrapperSpans(text, remove_pre=method == 'cl-plain-v1')
    parser.feed(text)
    parser.close()
    return {'drop': sorted(parser.spans), 'unescape': method == 'cl-plain-v1'}


def apply_plan(text: str, plan: dict) -> str:
    out, last = [], 0
    for start, end in plan['drop']:
        if not (last <= start <= end <= len(text)):
            raise ValueError('Invalid/overlapping source edit spans')
        out.append(text[last:start])
        last = end
    out.append(text[last:])
    value = ''.join(out)
    if plan['unescape']:
        # Exact inverse of Python html.escape, not a general HTML text extractor.
        # Decode &amp; last, so a literal &lt; in the source is not decoded twice.
        for entity, char in [('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'),
                             ('&#x27;', "'"), ('&amp;', '&')]:
            value = value.replace(entity, char)
    return value


def project(text: str, method: str) -> str:
    return text if method == 'alias' else apply_plan(text, inverse_plan(text, method))


def first_nonblank(row: dict, fields: tuple[str, ...]) -> str | None:
    return next((f for f in fields if isinstance(row.get(f), str) and row[f].strip()), None)


def pack_row(row: dict) -> tuple[dict, dict[str, dict]]:
    """Replace a value only with a recipe proven to reproduce that exact value.

    Keep html_with_citations verbatim. It carries the externally visible markup.
    Recipes reference a retained raw field, so there are no dependency chains.
    Field names and metadata always survive, even for identical field values.
    """
    raw, recipes = dict(row), {}
    roots: dict[str, str] = {}
    cited = row.get('html_with_citations')
    projections: dict[str, str] = {}
    plans: dict[str, dict] = {}
    if isinstance(cited, str) and cited:
        # Most records do not need both inverses. Never parse a sole rendition.
        methods = []
        if any(isinstance(row.get(f), str) and row[f] and row[f] != cited
               for f in REND if f not in ('html_with_citations', 'plain_text')):
            methods.append('cl-unwrapped-v1')
        if isinstance(row.get('plain_text'), str) and row['plain_text'] and row['plain_text'] != cited:
            methods.append('cl-plain-v1')
        for method in methods:
            try:
                plans[method] = inverse_plan(cited, method)
                projections[method] = apply_plan(cited, plans[method])
            except (ValueError, AssertionError, RecursionError):
                pass  # retain the original on every failed inverse candidate
    for field in REND:
        value = row.get(field)
        if not isinstance(value, str) or not value:
            continue
        recipe = None
        if value in roots:
            recipe = {'from': roots[value], 'via': 'alias'}
        elif field != 'html_with_citations':
            methods = ('cl-plain-v1',) if field == 'plain_text' else ('cl-unwrapped-v1',)
            for method in methods:
                if projections.get(method) == value:  # exact, not text/DOM equivalence
                    recipe = {'from': 'html_with_citations', 'via': method}
                    break
        if recipe and len(wire(recipe)) < len(wire(value)):
            recipes[field] = recipe
            del raw[field]
        else:
            roots.setdefault(value, field)
    packed = {'v': VERSION, 'raw': raw, 'recipes': recipes,
              'plans': {method: plan for method, plan in plans.items()
                        if any(r['via'] == method for r in recipes.values())}}
    if unpack_row(packed) != row:
        raise ValueError('Lossless reconstruction check failed')
    return packed, recipes


def unpack_row(packed: dict) -> dict:
    if packed.get('v') != VERSION:
        raise ValueError('Unsupported pack version')
    row = dict(packed['raw'])
    cache = {}
    for field, recipe in packed['recipes'].items():
        source, method = recipe['from'], recipe['via']
        if field in row or source not in packed['raw']:
            raise ValueError('Invalid/cyclic reconstruction recipe')
        key = source, method
        if key not in cache:
            cache[key] = (packed['raw'][source] if method == 'alias' else
                          apply_plan(packed['raw'][source], packed['plans'][method]))
        row[field] = cache[key]
    return row


@contextmanager
def readonly(path: Path):
    path = path.expanduser().resolve(strict=True)
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    try:
        connection.execute('BEGIN')  # consistent read snapshot, including WAL
        yield connection
    finally:
        connection.close()


def csv_rows(path: Path) -> Iterator[dict]:
    # CourtListener uses PostgreSQL FORCE_QUOTE *, ESCAPE '\\'. Unquoted
    # empties are SQL NULL; quoted empties are ''. Ordinary DictReader collapses
    # these. Do not carry that information loss from Beaver's importer forward.
    if not hasattr(csv, 'QUOTE_NOTNULL') or next(csv.reader(
            [',""'], quoting=csv.QUOTE_NOTNULL)) != [None, '']:
        raise ValueError('CSV input requires Python 3.13+ with working QUOTE_NOTNULL')
    opener = bz2.open if path.name.endswith('.bz2') else open
    with opener(path, 'rt', encoding='utf-8-sig', newline='') as handle:
        reader = csv.reader(handle, escapechar='\\', doublequote=False,
                            quoting=csv.QUOTE_NOTNULL, strict=True)
        columns = next(reader, None)
        if not columns or 'id' not in columns or any(not c for c in columns):
            raise ValueError(f'{path.name}: missing id/header')
        if len(set(columns)) != len(columns):
            raise ValueError(f'{path.name}: duplicate columns')
        for values in reader:
            if len(values) != len(columns):
                raise ValueError(f'{path.name}: ragged/truncated CSV record')
            yield dict(zip(columns, values))


class Codec:
    def __init__(self, name: str):
        self.name = name
        if name not in ('zlib', 'zstd'):
            raise ValueError(f'Unsupported codec: {name}')
        if name == 'zstd':
            try:
                import zstandard
            except ImportError as exc:
                raise ValueError('zstd needs: python -m pip install zstandard') from exc
            self.enc = zstandard.ZstdCompressor(level=9)
            self.dec = zstandard.ZstdDecompressor()

    def compress(self, data: bytes) -> bytes:
        return zlib.compress(data, 9) if self.name == 'zlib' else self.enc.compress(data)

    def decompress(self, data: bytes) -> bytes:
        return zlib.decompress(data) if self.name == 'zlib' else self.dec.decompress(data)


class Census:
    def __init__(self, markup_order=BEAVER_MARKUP):
        self.markup_order = markup_order
        self.kinds = Counter()
        self.fields = defaultdict(Counter)
        self.combinations = Counter()
        self.selection = Counter()
        self.relationships = Counter()
        self.examples = defaultdict(list)
        self.sizes = Counter()
        self.root = hashlib.sha256()
        self.columns: dict[str, set[str]] = defaultdict(set)

    def example(self, category: str, row: dict, **extra):
        if len(self.examples[category]) < 5:
            # No source text, filenames/paths, user prompts, or raw URLs in reports.
            self.examples[category].append({'opinion_id': row['id'], **extra})

    def observe(self, kind: str, row: dict, recipes: dict, raw: bytes,
                baseline_bytes: int, stored_bytes: int, encoding: str):
        self.kinds[kind] += 1
        self.columns[kind].update(row)
        framed = wire([kind, row['id'], hashlib.sha256(raw).hexdigest()])
        self.root.update(len(framed).to_bytes(8, 'big') + framed)
        for key, amount in [('decoded_json_bytes', len(raw)),
                            ('same_codec_unpruned_payload_bytes', baseline_bytes),
                            ('stored_payload_bytes', stored_bytes)]:
            self.sizes[key] += amount
        if kind != 'opinion':
            return
        selected = first_nonblank(row, self.markup_order) or first_nonblank(row, ('plain_text',))
        source = next((f for f in CL_ANNOTATION_SOURCE if row.get(f)), None)
        self.selection[f'beaver:{selected or "none"}'] += 1
        self.selection[f'annotation-source:{source or "none"}'] += 1
        populated = [f for f in REND if isinstance(row.get(f), str) and row[f]]
        self.combinations['+'.join(populated) or '(none)'] += 1
        for field in REND:
            value = row.get(field)
            status = ('absent' if field not in row else 'null' if value is None else
                      'empty' if value == '' else 'nonempty')
            self.fields[field][status] += 1
            if isinstance(value, str):
                self.fields[field]['utf8_bytes'] += len(value.encode('utf-8'))
            if field in recipes:
                recipe = recipes[field]
                key = f'{field} <- {recipe["from"]} [{recipe["via"]}]'
                self.relationships[key] += 1
                self.fields[field]['proven_reconstructible_bytes'] += len(value.encode('utf-8'))
                self.example(key, row)
                if encoding == 'recipes':
                    self.fields[field]['recipe_rows_stored'] += 1
        if row.get('xml_scan') and 'xml_scan' not in self.markup_order:
            self.example('xml_scan_not_in_beaver_selector', row, selected=selected)
            self.selection['xml_scan_present_but_not_selectable'] += 1
        if source and row.get('html_with_citations') and source not in recipes:
            if row[source] != row['html_with_citations']:
                self.example('annotation_source_not_proven_redundant', row, field=source,
                             source_sha256=digest(row[source]),
                             cited_sha256=digest(row['html_with_citations']))

    def report(self) -> dict:
        return {
            'schema': 'beaver.courtlistener-rendition-audit.v1',
            'completed_requested_scope': True,
            'record_counts': dict(self.kinds), 'ordered_input_root_sha256': self.root.hexdigest(),
            'sizes': dict(self.sizes), 'fields': dict(self.fields),
            'representation_combinations': dict(self.combinations),
            'selectors': dict(self.selection), 'proven_relationships': dict(self.relationships),
            'examples': dict(self.examples),
            'missing_columns': {
                'opinion': sorted(set(OPINION_CONTEXT_FIELDS) - self.columns['opinion']),
                'cluster': sorted(set(CLUSTER_WEB_FIELDS) - self.columns['cluster']),
            },
            'limits': [
                'Complete for input does not mean complete CourtListener coverage.',
                'Compression comparison uses the same codec per row, not the upstream bz2 stream.',
                'A failed inverse test means unproven, not uniquely valuable.',
                'A successful test replaces storage, never the field or its provenance.',
                'No semantic/structural-output equality authorizes deletion.',
                'No native-parser or live-browser success is claimed by this audit.',
                'Cluster/source fields missing from an installed DB cannot be recovered here.',
                'SQLite input preserves its values; previous importer NULL/empty collapse is irreversible.',
            ],
        }


def positive_id(row: dict) -> int:
    value = row.get('id')
    if isinstance(value, bool):
        raise ValueError('Boolean record id')
    if isinstance(value, float) or not str(value).isdigit() or int(value) <= 0:
        raise ValueError(f'Invalid record id: {value!r}')
    return int(value)


def schema_columns(connection, table: str) -> list[str]:
    return [r[1] for r in connection.execute(f'PRAGMA table_info("{table}")')]


def inspect_beaver(root: Path) -> dict:
    paths = ['backend/src/lib/legalSources/courtlistener.ts',
             'backend/src/lib/legalSources/nativeDocumentPassages.ts',
             'backend/src/lib/legalSourceLinks.ts', 'backend/src/lib/structureNative.ts',
             'backend/src/lib/value.ts', 'backend/scripts/import_courtlistener_bulk.py']
    sources = {p: (root/p).read_bytes() for p in paths}
    source = sources[paths[0]].decode('utf-8')
    found = re.search(r'const rawMarkup = firstString\(\s*opinion,([\s\S]*?)\);', source)
    if not found:
        raise ValueError('Cannot inspect compactOpinion rawMarkup policy; audit needs review')
    names = re.findall(r'"([A-Za-z0-9_]+)"', found.group(1))
    order = []
    for name in names:
        normalized = ('html_anon_2020' if name == 'htmlAnon2020' else
                      re.sub(r'([A-Z])', lambda m: '_' + m[1].lower(), name))
        if normalized not in order:
            order.append(normalized)
    if any(name not in REND for name in order):
        raise ValueError('Unrecognized new rendition in Beaver: update audit field catalogue')
    return {'source_sha256': {p: hashlib.sha256(v).hexdigest() for p, v in sources.items()},
            'markup_order_read_from_checkout': order,
            'scope': 'source inspection only; native integration results are separate'}


def build(args):
    codec = Codec(args.codec)
    checkout = inspect_beaver(Path(args.beaver_root)) if args.beaver_root else None
    out = Path(args.out).expanduser().resolve()
    if out.exists():
        raise ValueError(f'Refusing to overwrite {out}; choose a new output directory')
    out.mkdir(parents=True)
    dbpath = out / 'corpus.sqlite'
    dest = sqlite3.connect(dbpath)
    dest.executescript('''
        PRAGMA journal_mode=DELETE;
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE record(kind TEXT NOT NULL, id INTEGER NOT NULL, cluster_id INTEGER,
          original_sha256 TEXT NOT NULL, encoding TEXT NOT NULL, payload BLOB NOT NULL,
          sequence INTEGER NOT NULL UNIQUE,
          PRIMARY KEY(kind,id)) WITHOUT ROWID;
    ''')
    census = Census(tuple(checkout['markup_order_read_from_checkout']) if checkout else BEAVER_MARKUP)
    dest.execute('INSERT INTO meta VALUES (?,?)', ('codec', args.codec))
    dest.execute('INSERT INTO meta VALUES (?,?)', ('status', 'incomplete'))
    dest.commit()
    started = time.monotonic()
    input_inventory = {}

    def ingest(kind: str, iterator: Iterator[dict], maximum: int = 0):
        for ordinal, row in enumerate(iterator, 1):
            if maximum and ordinal > maximum:
                break
            record_id = positive_id(row)
            raw = wire(row)
            packed, recipes = pack_row(row) if kind == 'opinion' else ({}, {})
            baseline = codec.compress(raw)
            compressed = codec.compress(wire(packed)) if recipes else baseline
            encoding = 'recipes' if recipes and len(compressed) < len(baseline) else 'raw'
            chosen = compressed if encoding == 'recipes' else baseline
            # Verify the actual compressed bytes, not just the pre-compression object.
            decoded = json.loads(codec.decompress(chosen))
            restored = unpack_row(decoded) if encoding == 'recipes' else decoded
            if wire(restored) != raw:
                raise ValueError(f'Round-trip mismatch: {kind} {record_id}')
            cluster_id = row.get('cluster_id') if kind == 'opinion' else None
            dest.execute('INSERT INTO record VALUES (?,?,?,?,?,?,?)',
                         (kind, record_id, int(cluster_id) if cluster_id not in (None, '') else None,
                          hashlib.sha256(raw).hexdigest(), encoding, chosen, sum(census.kinds.values()) + 1))
            census.observe(kind, row, recipes, raw, len(baseline), len(chosen), encoding)
            if ordinal % 1000 == 0:
                dest.commit()
                print(f'{kind}: {ordinal:,} rows; {time.monotonic()-started:.1f}s', file=sys.stderr)
        dest.commit()

    try:
        if args.db:
            if args.db == 'auto':
                root = Path(args.beaver_root or Path(__file__).resolve().parents[2]).resolve()
                scripts = root / 'backend' / 'scripts'
                sys.path.insert(0, str(scripts))
                try:
                    from import_courtlistener_bulk import default_output
                    db_input = default_output()
                finally:
                    sys.path.remove(str(scripts))
            else:
                db_input = Path(args.db)
            with readonly(db_input) as source:
                for table in ('opinion', 'cluster', 'citation'):
                    columns = schema_columns(source, table)
                    input_inventory[table] = columns
                    if not columns:
                        if table == 'opinion':
                            raise ValueError('Not a Beaver CourtListener DB: no opinion table')
                        continue
                    # Restrict companion tables to selected opinion clusters without
                    # loading a corpus-sized IN list or changing the source database.
                    if table == 'opinion':
                        sql = 'SELECT * FROM opinion ORDER BY id'
                    else:
                        target = 'id' if table == 'cluster' else 'cluster_id'
                        limit_sql = f' LIMIT {int(args.limit)}' if args.limit else ''
                        sql = (f'SELECT * FROM {table} WHERE {target} IN '
                               f'(SELECT cluster_id FROM opinion ORDER BY id{limit_sql}) ORDER BY id')
                    ingest(table, (dict(r) for r in source.execute(sql)), args.limit if table == 'opinion' else 0)
        else:
            for table, filename in [('opinion', args.opinions), ('cluster', args.clusters), ('citation', args.citations)]:
                if filename:
                    ingest(table, csv_rows(Path(filename)), args.limit if table == 'opinion' else 0)
        dest.execute('CREATE INDEX record_cluster ON record(kind,cluster_id,id)')
        result = census.report()
        result['input_columns'] = input_inventory or {k: sorted(v) for k, v in census.columns.items()}
        result['scope'] = {'source': 'installed-db' if args.db else 'supplied-csv',
                           'opinion_limit': args.limit or None,
                           'companion_scope': 'selected-clusters' if args.db else 'complete-supplied-files'}
        result['codec'] = args.codec
        result['elapsed_seconds'] = round(time.monotonic() - started, 3)
        result['audit_program_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        result['beaver_checkout'] = checkout or {'scope': 'not supplied; diagnostic order is the inspected reference policy'}
        dest.execute('INSERT INTO meta VALUES (?,?)', ('report', json.dumps(result)))
        dest.execute("UPDATE meta SET value='complete' WHERE key='status'")
        dest.commit()
        result['sizes']['sqlite_file_bytes'] = dbpath.stat().st_size
        result['disk_free_bytes'] = __import__('shutil').disk_usage(out).free
        (out/'report.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'output': str(out), 'counts': result['record_counts'],
                          'sizes': result['sizes']}, indent=2))
    except BaseException:
        dest.rollback()
        # Keep the explicitly named incomplete pack for diagnosis; no reader
        # accepts it as complete. Never remove or overwrite source data.
        raise
    finally:
        dest.close()


def read_record(row: sqlite3.Row, codec: Codec) -> dict:
    if row['encoding'] not in ('raw', 'recipes'):
        raise ValueError('Unknown record encoding')
    payload = json.loads(codec.decompress(row['payload']))
    value = unpack_row(payload) if row['encoding'] == 'recipes' else payload
    if positive_id(value) != row['id'] or digest(value) != row['original_sha256']:
        raise ValueError(f'Corrupt record: {row["kind"]} {row["id"]}')
    return value


@contextmanager
def open_pack(path: str):
    with readonly(Path(path)) as connection:
        meta = dict(connection.execute('SELECT key,value FROM meta').fetchall())
        if meta.get('status') != 'complete':
            raise ValueError('Pack is incomplete; not eligible for replay')
        yield connection, Codec(meta['codec']), json.loads(meta['report'])


def verify(args):
    counts = Counter()
    root = hashlib.sha256()
    with open_pack(args.pack) as (db, codec, report):
        for row in db.execute('SELECT * FROM record ORDER BY sequence'):
            value = read_record(row, codec)
            framed = wire([row['kind'], value['id'], digest(value)])
            root.update(len(framed).to_bytes(8, 'big') + framed)
            counts[row['kind']] += 1
        if dict(counts) != report['record_counts'] or root.hexdigest() != report['ordered_input_root_sha256']:
            raise ValueError('Whole-input manifest mismatch (missing/reordered/changed records)')
    print(json.dumps({'verified_records': dict(counts), 'status': 'all-digests-match'}, indent=2))


def export(args):
    """Reconstruct all original values, or produce jobs for the real native worker."""
    original_path = getattr(args, 'original_db', None)
    with open_pack(args.pack) as (db, codec, report), \
         (readonly(Path(original_path)) if original_path else nullcontext(None)) as original:
        count = 0
        sql = 'SELECT * FROM record WHERE kind=?'
        params: list = [args.kind]
        if args.id:
            sql += ' AND id=?'
            params.append(args.id)
        for stored in db.execute(sql + ' ORDER BY id', params):
            if args.limit and count >= args.limit:
                break
            row = read_record(stored, codec)
            if args.jobs:
                if args.kind != 'opinion':
                    raise ValueError('--jobs requires --kind opinion')
                cid = stored['cluster_id']
                companion = db.execute("SELECT * FROM record WHERE kind='cluster' AND id=?", (cid,)).fetchone()
                cluster = read_record(companion, codec) if companion else None
                cap = None
                if args.cap_json_dir:
                    cap_path = Path(args.cap_json_dir) / f'{cid}.json'
                    if cap_path.is_file():
                        cap = json.loads(cap_path.read_text(encoding='utf-8'))
                original_row = None
                if original is not None:
                    found = original.execute('SELECT * FROM opinion WHERE id=?', (stored['id'],)).fetchone()
                    if found is None:
                        raise ValueError(f'Original DB missing opinion {stored["id"]}')
                    original_row = dict(found)
                    if wire(original_row) != wire(row):
                        raise ValueError('Original DB changed since pack build; refusing parity test')
                row = {'opinion': row, 'original_opinion': original_row, 'cluster': cluster, 'cap_metadata': cap,
                       'corpus_scope': report['scope'],
                       'source_digest': stored['original_sha256']}
            sys.stdout.buffer.write(wire(row) + b'\n')
            count += 1


def main():
    # Large judicial opinions exceed Python's default CSV field-size limit.
    size = sys.maxsize
    while True:
        try:
            csv.field_size_limit(size)
            break
        except OverflowError:
            size //= 10
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    b = commands.add_parser('build', help='audit and write a lossless local pack')
    src = b.add_mutually_exclusive_group(required=True)
    src.add_argument('--db', help="Existing Beaver courtlistener.sqlite, or auto for Beaver's own path resolver")
    src.add_argument('--opinions', help='Official opinions CSV or CSV.BZ2')
    b.add_argument('--clusters', help='Official cluster CSV; preserve all source columns')
    b.add_argument('--citations', help='Official citation CSV')
    b.add_argument('--out', required=True, help='New output directory; never overwritten')
    b.add_argument('--limit', type=int, default=0, help='Opinion prefix only; 0 = all input')
    b.add_argument('--codec', choices=['zlib','zstd'], default='zlib')
    b.add_argument('--beaver-root', help='Record hashes of the actual production consumers')
    b.set_defaults(run=build)
    v = commands.add_parser('verify', help='Reconstruct and verify EVERY stored record')
    v.add_argument('pack'); v.set_defaults(run=verify)
    e = commands.add_parser('export', help='Reconstruct source rows as JSONL')
    e.add_argument('pack'); e.add_argument('--kind', choices=['opinion','cluster','citation'], default='opinion')
    e.add_argument('--id', type=int); e.add_argument('--limit', type=int, default=0)
    e.add_argument('--original-db', help='For production-proof jobs: independently read original opinion rows')
    e.add_argument('--jobs', action='store_true', help='Emit native-worker jobs with companion metadata')
    e.add_argument('--cap-json-dir', help='Offline CAP metadata files named <cluster_id>.json')
    e.set_defaults(run=export)
    args = parser.parse_args()
    if getattr(args, 'limit', 0) < 0:
        parser.error('--limit cannot be negative')
    if getattr(args, 'db', None) and (args.clusters or args.citations):
        parser.error('--clusters/--citations accompany --opinions, not --db')
    if getattr(args, 'original_db', None) and not args.jobs:
        parser.error('--original-db requires --jobs')
    try:
        args.run(args)
    except BrokenPipeError:
        sys.exit(1)
    except (ValueError, OSError, sqlite3.Error, csv.Error) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
