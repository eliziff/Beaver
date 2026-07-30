"""Build the tokengrams suffix-array attestation index (H13, base-repo
implementation per the standing directive — EleutherAI tokengrams, MIT,
exact counts, memory-mapped).

Pipeline: stratified corpus sample (same sampling contract as the
interim sqlite builder) -> GPT-2 BPE tokens (vocab 50,257 <= u16) ->
flat .bin -> MemmapIndex.build. Token-level n-gram counts are the
QUIP/infini-gram-standard attestation primitive; the word-trigram
sqlite interim stays until Stage 7 calibration compares both signals.

    python -X utf8 scripts/build_tokengrams_index.py --per-court 200 --per-set 100

Output (default): %LOCALAPPDATA%/ALR Quote Verifier/alienness/
    tokengrams-<language>.bin / .idx + tokengrams-<language>.meta.json
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import duckdb
import numpy as np
from tokengrams import MemmapIndex
from transformers import AutoTokenizer

SCHEMA_VERSION = "1"


def default_corpus_root() -> Path:
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / "ALR Quote Verifier" / "a2aj_corpus"


def default_output_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / "ALR Quote Verifier" / "alienness"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-court", type=int, default=200)
    parser.add_argument("--per-set", type=int, default=100)
    parser.add_argument("--language", choices=["en", "fr"], default="en")
    parser.add_argument("--seed", type=int, default=47)
    parser.add_argument("--corpus-root", default=str(default_corpus_root()))
    parser.add_argument("--output-dir", default=str(default_output_dir()))
    args = parser.parse_args()

    tokenizer = AutoTokenizer.from_pretrained("gpt2")
    assert tokenizer.vocab_size <= 0xFFFF, "u16 vocab required"

    root = Path(args.corpus_root)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = out_dir / f"tokengrams-{args.language}.bin"
    idx_path = out_dir / f"tokengrams-{args.language}.idx"
    meta_path = out_dir / f"tokengrams-{args.language}.meta.json"

    con = duckdb.connect()
    con.execute("set threads=2")
    manifest: dict[str, int] = {}
    docs = 0
    chars = 0
    tokens_total = 0
    started = time.time()
    column = f"unofficial_text_{args.language}"

    with open(bin_path, "wb") as out:
        def ingest(pq: Path, source: str, cap: int) -> None:
            nonlocal docs, chars, tokens_total
            try:
                rows = con.execute(
                    f"""
                    select {column} from read_parquet('{pq.as_posix()}')
                    where {column} is not null
                    using sample reservoir({cap} rows) repeatable ({args.seed})
                    """
                ).fetchall()
            except Exception as error:
                print(f"[skip] {source}: {error}", flush=True)
                return
            taken = 0
            for (text,) in rows:
                ids = tokenizer(text, add_special_tokens=False)["input_ids"]
                np.asarray(ids, dtype=np.uint16).tofile(out)
                # EOS separates documents so n-grams never span them.
                np.asarray([tokenizer.eos_token_id], dtype=np.uint16).tofile(out)
                docs += 1
                taken += 1
                chars += len(text)
                tokens_total += len(ids) + 1
            manifest[source] = taken
            print(f"[{source}] docs={taken} tokens={tokens_total}", flush=True)

        for pq in sorted(root.glob("cases/*/train.parquet")):
            ingest(pq, f"cases/{pq.parent.name}", args.per_court)
        for pq in sorted(root.glob("laws/*/train.parquet")):
            ingest(pq, f"laws/{pq.parent.name}", args.per_set)

    print(f"tokenized: {docs} docs, {tokens_total} tokens; building suffix array...",
          flush=True)
    MemmapIndex.build(str(bin_path), str(idx_path), verbose=True)
    meta_path.write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "engine": "tokengrams",
                "tokenizer": "gpt2",
                "language": args.language,
                "seed": args.seed,
                "per_court": args.per_court,
                "per_set": args.per_set,
                "doc_count": docs,
                "char_count": chars,
                "token_count": tokens_total,
                "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "manifest": manifest,
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    print(
        f"built {idx_path}: {docs} docs, {tokens_total} tokens, "
        f"{time.time() - started:.0f}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
