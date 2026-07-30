"""Build the corpus-alienness trigram reference index (H13).

INTERIM IMPLEMENTATION, marked for base-repo migration: the standing
preference is to build on an established base (infini-gram suffix-array
counts or Data Portraits Bloom membership — evaluation in flight)
rather than hand-rolled indexing. This sqlite build exists to unblock
calibration experiments; the legalClaimLint reader isolates the index
behind corpusAlienness() so the backing store can swap without touching
consumers.

A stratified sample of the local A2AJ corpus (cases per court + laws per
set) is tokenized into lowercase word trigrams; counts land in sqlite
keyed by a 64-bit FNV-1a hash of the joined trigram. The reference is a
DISTRIBUTION, not an exhaustive registry — a representative sample is
sufficient and keeps the index small; the receipt records exactly what
went in.

    python -X utf8 scripts/build_alienness_index.py \
        --per-court 200 --per-set 100 --language en

Output (default): %LOCALAPPDATA%/ALR Quote Verifier/alienness/
    trigrams-<language>.sqlite   table trigram(hash INTEGER PRIMARY KEY,
                                              n INTEGER)
    meta: schema_version, language, seed, per_court, per_set, doc_count,
    char_count, built_at, corpus manifest (per-source doc counts).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import time
from collections import Counter
from pathlib import Path

import duckdb

WORD_RE = re.compile(r"[a-z0-9']+")
SCHEMA_VERSION = "1"


def default_corpus_root() -> Path:
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / "ALR Quote Verifier" / "a2aj_corpus"


def default_output_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / "ALR Quote Verifier" / "alienness"


def fnv1a64(value: str) -> int:
    digest = 0xCBF29CE484222325
    for byte in value.encode("utf-8"):
        digest ^= byte
        digest = (digest * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    # sqlite INTEGER is signed 64-bit.
    return digest - 0x10000000000000000 if digest >= 0x8000000000000000 else digest


def trigram_hashes(text: str) -> list[int]:
    words = WORD_RE.findall(text.lower())
    return [
        fnv1a64(" ".join(words[i : i + 3]))
        for i in range(len(words) - 2)
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-court", type=int, default=200)
    parser.add_argument("--per-set", type=int, default=100)
    parser.add_argument("--language", choices=["en", "fr"], default="en")
    parser.add_argument("--seed", type=int, default=47)
    parser.add_argument("--corpus-root", default=str(default_corpus_root()))
    parser.add_argument("--output-dir", default=str(default_output_dir()))
    parser.add_argument(
        "--jsonl",
        default=None,
        help="build from a jsonl of {'text', ...} rows (e.g. the US "
        "reference from build_us_reference.py) instead of the A2AJ corpus",
    )
    parser.add_argument(
        "--suffix",
        default="",
        help="output name suffix: trigrams-<language><suffix>.sqlite "
        "(e.g. '-us' for the jurisdiction-matched US reference)",
    )
    args = parser.parse_args()

    root = Path(args.corpus_root)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"trigrams-{args.language}{args.suffix}.sqlite"
    temporary = out_dir / f"trigrams-{args.language}{args.suffix}.building.sqlite"
    if temporary.exists():
        temporary.unlink()

    con = duckdb.connect()
    con.execute("set threads=2")
    counts: Counter[int] = Counter()
    manifest: dict[str, int] = {}
    docs = 0
    chars = 0
    started = time.time()

    def ingest(pq: Path, source: str, cap: int, column: str) -> None:
        nonlocal docs, chars
        try:
            rows = con.execute(
                f"""
                select {column} from read_parquet('{pq.as_posix()}')
                where {column} is not null
                using sample reservoir({cap} rows) repeatable ({args.seed})
                """
            ).fetchall()
        except Exception as error:  # column absent for this language etc.
            print(f"[skip] {source}: {error}", flush=True)
            return
        taken = 0
        for (text,) in rows:
            counts.update(trigram_hashes(text))
            docs += 1
            taken += 1
            chars += len(text)
        manifest[source] = taken
        print(f"[{source}] docs={taken} distinct={len(counts)}", flush=True)

    if args.jsonl:
        for line in open(args.jsonl, encoding="utf-8"):
            if not line.strip():
                continue
            row = json.loads(line)
            text = row.get("text") or ""
            if not text:
                continue
            counts.update(trigram_hashes(text))
            docs += 1
            chars += len(text)
            source = f"jsonl/{row.get('reporter') or 'unknown'}"
            manifest[source] = manifest.get(source, 0) + 1
        print(f"[jsonl] docs={docs} distinct={len(counts)}", flush=True)
    else:
        for pq in sorted(root.glob("cases/*/train.parquet")):
            ingest(pq, f"cases/{pq.parent.name}", args.per_court,
                   f"unofficial_text_{args.language}")
        for pq in sorted(root.glob("laws/*/train.parquet")):
            ingest(pq, f"laws/{pq.parent.name}", args.per_set,
                   f"unofficial_text_{args.language}")

    db = sqlite3.connect(temporary)
    db.execute("pragma journal_mode=off")
    db.execute("pragma synchronous=off")
    db.execute(
        "create table trigram (hash integer primary key, n integer not null) without rowid"
    )
    db.execute("create table meta (key text primary key, value text not null)")
    db.executemany(
        "insert into trigram (hash, n) values (?, ?)",
        counts.items(),
    )
    meta = {
        "schema_version": SCHEMA_VERSION,
        "input": args.jsonl or "a2aj_corpus",
        "language": args.language,
        "seed": str(args.seed),
        "per_court": str(args.per_court),
        "per_set": str(args.per_set),
        "doc_count": str(docs),
        "char_count": str(chars),
        "distinct_trigrams": str(len(counts)),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "manifest": json.dumps(manifest, sort_keys=True),
    }
    db.executemany("insert into meta (key, value) values (?, ?)", meta.items())
    db.commit()
    db.close()
    if out_path.exists():
        out_path.unlink()
    temporary.rename(out_path)
    print(
        f"built {out_path}: {docs} docs, {chars / 1e6:.0f}M chars, "
        f"{len(counts)} distinct trigrams, {time.time() - started:.0f}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
