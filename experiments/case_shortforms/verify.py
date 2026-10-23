"""Recheck every installed full text before reusing an unchanged shortform index."""
from contextlib import closing
import argparse
import hashlib
import json
from pathlib import Path
import time

from mine import Engine, data_root, readonly


def verify(database, output, check_engine=True):
    started = time.monotonic()
    with closing(readonly(database)) as index:
        meta = {key: json.loads(value) for key, value in index.execute("SELECT * FROM meta")}
    if meta["schema"] != "case-shortforms.v1" or meta["sampling"] != {"every": 1, "limit_per_provider": 0}:
        raise ValueError("verification requires a complete index of the current schema")
    expected_code = dict(meta["code_sha256"])
    prepared = meta.get("prepared")
    if prepared:
        expected_code.update({name: sha for name, sha in prepared["code_sha256"].items()
                              if name in ("parser.mjs", "evidence.py")})
        expected_code.update({name: sha for name, sha in prepared.get("recommendation_code_sha256", {}).items()
                              if name != "mine.py"})
    for name, expected in expected_code.items():
        if hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"index code changed: {name}; rebuild the affected stage")
    if check_engine:
        engine = Engine()
        try:
            if engine.metadata != meta["engine"]:
                raise ValueError("citation engine changed; rebuild the index")
        finally:
            engine.close()
    stats, hashes = {}, {}
    for provider, filename in meta["sources"].items():
        provider_started = time.monotonic()
        with closing(readonly(Path(filename))) as source:
            table = "export_metadata" if provider == "journal" else "meta"
            if dict(source.execute(f"SELECT * FROM {table}")) != meta["corpus_metadata"][provider]:
                raise ValueError(f"{provider} export metadata changed; rebuild the index")
            rows = (source.execute("SELECT article_id,'en',text FROM articles WHERE length(text)>0 ORDER BY article_id")
                    if provider == "journal" else
                    ((local_id, language, text) for local_id, en, fr in source.execute(
                        "SELECT id,unofficial_text_en,unofficial_text_fr FROM document NOT INDEXED"
                        " WHERE doc_type='cases' ORDER BY id")
                     for language, text in (("en", en), ("fr", fr)) if text))
            digest = hashlib.sha256()
            texts = chars = 0
            last_progress = time.monotonic()
            for local_id, language, text in rows:
                sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
                digest.update(f"{local_id}:{language}:{sha}\n".encode())
                texts += 1
                chars += len(text)
                if time.monotonic() - last_progress >= 10:
                    last_progress = time.monotonic()
                    print(f"{provider}: verified {texts} texts, {chars/1e6:.1f}M chars", flush=True)
            hashes[provider] = digest.hexdigest()
            stats[provider] = {"texts": texts, "chars": chars,
                               "elapsed_seconds": round(time.monotonic() - provider_started, 2)}
        if hashes[provider] != meta["text_stream_sha256"][provider]:
            raise ValueError(f"{provider} full text changed; rebuild the index")
        print(f"{provider}: all {texts} full texts unchanged ({stats[provider]['elapsed_seconds']}s)", flush=True)
    receipt = {"status": "verified_index_reused" if check_engine else "verified_source_content_and_code",
               "extraction_engine_native_sha256": meta["engine"]["nativeSha256"],
               "current_engine_matches": True if check_engine else None, "scope": "every installed nonempty full text",
               "retained_extraction_errors": {"excerpt": meta["stats"].get("verification_errors", 0),
                                              "provider_caption": meta["stats"].get("metadata_verification_errors", 0)},
               "text_stream_sha256": hashes, "sources": stats,
               "elapsed_seconds": round(time.monotonic() - started, 2)}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2), flush=True)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=data_root() / "cache/case-shortforms/shortforms.sqlite")
    parser.add_argument("--output", type=Path, default=Path("benchmarks/local-data/case-shortforms/verification.json"))
    parser.add_argument("--sources-only", action="store_true", help="check content and compiled code/model fingerprints; does not certify current native-engine equivalence")
    args = parser.parse_args()
    verify(args.database, args.output, check_engine=not args.sources_only)
