"""Mine reserved local texts into a prediction-blind final-evaluation inventory."""
import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack, closing
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import urllib.request

from base_batch import PRIVATE, read, save, sha
from base_targets import qualify
from evidence import clean_alias, usable_alias
from mine import Engine, Scanner, data_root, normalize, readonly
from prepare import court_forms, declaration_origin, owner
from shortform import caption_profile, core
from training_data import attach_citation_metadata


def family(left, right):
    return tuple(sorted(normalize(core(party)) for party in (left, right))) if left and right else None


def bulk_rows(path):
    import pyarrow.parquet as pq

    columns = ["unofficial_text_en", "unofficial_text_fr"]
    number = 0
    for batch in pq.ParquetFile(path).iter_batches(batch_size=128, columns=columns):
        for row in batch.to_pylist():
            yield number, row
            number += 1


def fetch_reserved_file(file, repository, revision):
    target, expected = data_root() / file["relative_path"], file["sha256"]
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(".parquet.part")
        if partial.exists():
            raise FileExistsError(f"preserve an existing provider download: {partial}")
        try:
            url = f"https://huggingface.co/datasets/{repository}/resolve/{revision}/{file['upstream_path']}"
            with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as destination:
                while block := response.read(1024 * 1024):
                    destination.write(block)
            assert partial.stat().st_size == file["bytes"]
            with partial.open("rb") as content:
                assert hashlib.file_digest(content, "sha256").hexdigest() == expected
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
    assert target.stat().st_size == file["bytes"]
    with target.open("rb") as content:
        assert hashlib.file_digest(content, "sha256").hexdigest() == expected
    return target


def reserve_bulk():
    """Use the provider's canonical Parquet location, including unindexed rows."""
    name = "base-final-bulk-source-manifest.json"
    if (PRIVATE / name).exists():
        raise FileExistsError("preserve the existing bulk source reservation")
    repository = "a2aj/canadian-case-law"
    with urllib.request.urlopen(f"https://huggingface.co/api/datasets/{repository}/revision/main?blobs=true", timeout=60) as response:
        remote = json.load(response)
    selected = [item for item in remote["siblings"] if item["rfilename"].endswith(".parquet")
                and item["rfilename"].split("/")[0] in {"CITT", "RAD", "RPD", "ONCA"}]
    assert len(selected) == 4
    with closing(readonly(data_root() / "cache/case-shortforms/shortforms.sqlite")) as index:
        used_hashes = {value for value, in index.execute("SELECT sha256 FROM source")}
        paths = json.loads(index.execute("SELECT value FROM meta WHERE key='sources'").fetchone()[0])
    used_hashes.update(d["sha256"] for d in read("base-final-source-manifest.json")["documents"])
    with closing(readonly(Path(paths["a2aj"]))) as source:
        metadata = dict(source.execute("SELECT key,value FROM meta"))
    files, documents = [], []
    for item in selected:
        court = item["rfilename"].split("/")[0]
        relative = f"providers/a2aj/parquet/cases/{court}/train.parquet"
        file = {"court": court, "relative_path": relative, "sha256": item["lfs"]["sha256"],
                "bytes": item["lfs"]["size"], "upstream_path": item["rfilename"]}
        target = fetch_reserved_file(file, repository, remote["sha"])
        files.append(file)
        count = 0
        for number, row in bulk_rows(target):
            for language in ("en", "fr"):
                text = row["unofficial_text_" + language]
                if not text:
                    continue
                value = hashlib.sha256(text.encode()).hexdigest()
                if value in used_hashes:
                    continue
                used_hashes.add(value)
                documents.append({"provider": "a2aj_parquet", "local_id": f"{court}:{file['sha256'][:12]}:{number}",
                    "row": number, "dataset": court, "language": language, "sha256": value, "chars": len(text)})
                count += 1
        print(f"{court}: reserved {count} unused texts", flush=True)
    save(name, {"status": "source_hashes_frozen_before_mining_or_prediction_inspection",
        "repository": repository, "revision": remote["sha"], "provider_metadata": metadata,
        "files": files, "documents": documents, "recipe_sha256": sha(Path(__file__)),
        "limits": ["Unused full texts are sources, not yet eligible independent target cases.",
                   "Provider partitions omitted by citation-key indexing are read without modifying the installed store."]})
    print(json.dumps({"reserved_texts": len(documents), "chars": sum(d["chars"] for d in documents),
                      "manifest_sha256": sha(PRIVATE / name)}), flush=True)


def source_texts(source, documents, manifest):
    if "files" not in manifest:
        for document in documents:
            text = source.execute("SELECT unofficial_text_" + document["language"] + " FROM document WHERE id=?",
                                  (document["local_id"],)).fetchone()[0]
            yield document, text
        return
    selected = {(d["dataset"], d["row"], d["language"]): d for d in documents}
    for file in manifest["files"]:
        path = data_root() / file["relative_path"]
        with path.open("rb") as content:
            assert hashlib.file_digest(content, "sha256").hexdigest() == file["sha256"]
        for number, row in bulk_rows(path):
            for language in ("en", "fr"):
                document = selected.get((file["court"], number, language))
                if document:
                    yield document, row["unofficial_text_" + language]


def main(manifest_name="base-final-source-manifest.json", output_name="base-final-candidates.json",
         index_path=None, provider_path=None):
    if (PRIVATE / output_name).exists():
        raise FileExistsError("preserve the frozen final candidates; do not remine after viewing predictions")
    started = time.monotonic()
    manifest = read(manifest_name)
    prior_rows = read("gold-original.json")["records"] + read("clean-refit-inputs.json")["records"]
    prior_ids = {r["id"] for r in prior_rows}
    prior_identities = {r["identity"] for r in prior_rows}
    prior_pairs = {family(r["left"], r["right"]) for r in prior_rows if r["left"] and r["right"]}
    counts, records, witnesses, history_edges = Counter(), {}, [], set()
    engine = None
    with ExitStack() as stack:
        index = stack.enter_context(closing(readonly(index_path or data_root() / "cache/case-shortforms/shortforms.sqlite")))
        paths = json.loads(index.execute("SELECT value FROM meta WHERE key='sources'").fetchone()[0])
        old_docs = {(p, id) for p, id in index.execute("SELECT DISTINCT provider,local_id FROM source")}
        old_keys, prior_keys = set(), set(prior_identities)
        old_provider_ids = {id for id, in index.execute("SELECT provider_id FROM case_record WHERE provider_id IS NOT NULL")}
        for key, case_id in index.execute("SELECT key,case_id FROM case_key"):
            old_keys.add(key)
            if case_id in prior_ids:
                prior_keys.add(key)
        for case_id, left, right in index.execute("SELECT case_id,plaintiff,defendant FROM case_profile"):
            if case_id in prior_ids and left and right:
                prior_pairs.add(family(left, right))
        documents = [r for r in manifest["documents"] if (r["provider"], r["local_id"]) not in old_docs]
        counts["reserved_texts"] = len(manifest["documents"])
        counts["strictly_new_document_texts"] = len(documents)
        source = stack.enter_context(closing(readonly(provider_path or Path(paths["a2aj"]))))
        assert dict(source.execute("SELECT key,value FROM meta")) == manifest["provider_metadata"]
        providers = {r[0]: r[1:] for r in source.execute("SELECT id,name_en,name_fr,citation_en,citation_fr,citation2_en,citation2_fr"
                                                       " FROM document WHERE doc_type='cases'")}
        by_key = defaultdict(set)
        for key, id in source.execute("SELECT citation_key,document_id FROM citation_lookup"):
            if id in providers:
                by_key[key].add(id)
        unique = {key: next(iter(ids)) for key, ids in by_key.items() if len(ids) == 1}
        inverse = defaultdict(list)
        for key, id in unique.items():
            inverse[id].append(key)
        canonical = {id: min(keys, key=lambda key: (":neutral:" not in key, key)) for id, keys in inverse.items()}
        provider_for_identity = {identity: id for id, identity in canonical.items()}
        keys = {key: (canonical[id], id) for key, id in unique.items()}
        blocked = prior_keys | {canonical[id] for id, values in inverse.items() if set(values) & prior_keys}
        forms = defaultdict(set)
        for id, row in providers.items():
            if id in canonical:
                for citation in row[2:]:
                    if citation:
                        forms[citation].add(canonical[id])
        try:
            engine = Engine()
            assert engine.metadata["version"]["keyVersion"] == manifest["provider_metadata"]["citation_key_version"]
            courts = court_forms(engine)
            scanner = Scanner(engine, ((form, next(iter(values))) for form, values in forms.items() if len(values) == 1))
            pending, seen = [], set()

            def flush():
                if not pending:
                    return
                responses = engine.call("batch", [{"method": "extract", "request": {"text": body,
                    "offsetUnit": "char", "options": {"resolve": False, "parallel": False}}}
                    for _, _, _, body in pending])
                for (document, declaration, origin, body), response in zip(pending, responses):
                    if "error" in response:
                        counts["native_error"] += 1
                        continue
                    citations = response["citations"]
                    full = [c for c in citations if c["form"] == "full" and c["authority"] == "case"]
                    for citation in full:
                        key = citation.get("key")
                        if key and key not in by_key and ":reporter:unknown:" not in key:
                            keys.setdefault(key, (key, None))
                    indexed = {c["index"]: c for c in full}
                    for citation in full:
                        first = keys.get(citation.get("key"), (None, None))[0]
                        for history in citation.get("history", []):
                            target = indexed.get(history.get("target"), {})
                            second = keys.get(target.get("key"), (None, None))[0]
                            if first and second:
                                history_edges.add((first, second))
                    identity, status = owner(citations, declaration["start"] - origin,
                        declaration["end"] - origin, declaration["name"], keys, body, courts)
                    counts[status] += 1
                    if status != "accepted":
                        continue
                    if identity in blocked:
                        counts["previously_supervised_case_declarations"] += 1
                        continue
                    provider_id = provider_for_identity.get(identity)
                    matching = [c for c in full if keys.get(c.get("key"), (None,))[0] == identity]
                    selected = matching[-1] if matching else {}
                    provider = providers.get(provider_id, (None,) * 6)
                    language = document["language"]
                    style = provider[language == "fr"] or provider[language != "fr"] or (selected.get("style") or {}).get("text")
                    citation = provider[2 + (language == "fr")] or provider[2 + (language != "fr")] or (selected.get("core") or {}).get("text", "")
                    style, left, right = caption_profile(style, citation=citation)
                    record = records.setdefault((identity, language), {"id": identity, "identity": identity,
                        "language": language, "citation": citation, "style": style, "left": left, "right": right,
                        "provider_id": provider_id, "aliases": {}, "case_keys": inverse.get(provider_id, [identity]),
                        "previous_unlabeled_metadata": provider_id in old_provider_ids or
                            bool(set(inverse.get(provider_id, [identity])) & old_keys),
                        "split": "reserved_final", "split_group": identity})
                    norm = normalize(declaration["name"])
                    alias = record["aliases"].setdefault(norm, {"text": declaration["name"], "document_ids": set()})
                    alias["document_ids"].add((document["provider"], document["local_id"]))
                    witnesses.append({"identity": identity, "language": language, "normalized": norm,
                        **document, **declaration})
                pending.clear()

            for number, (document, text) in enumerate(source_texts(source, documents, manifest), 1):
                assert hashlib.sha256(text.encode()).hexdigest() == document["sha256"]
                if document["sha256"] in seen:
                    counts["duplicate_new_text"] += 1
                    continue
                seen.add(document["sha256"])
                result = scanner.scan(text)
                counts["screen_verification_errors"] += len(result["errors"])
                for citation in result["citations"]:
                    name = clean_alias(citation.get("explicit") or "")
                    span = citation.get("explicitSpan")
                    if not span or not name or not usable_alias(name):
                        continue
                    origin = max(0, declaration_origin(text, span["start"]) - 350)
                    declaration = {"name": name, "start": span["start"], "end": span["end"],
                        "context": text[max(0, span["start"] - 700):min(len(text), span["end"] + 180)]}
                    pending.append((document, declaration, origin, text[origin:span["end"]]))
                    if len(pending) >= 128:
                        flush()
                if number % 100 == 0:
                    print(f"reserved sources: {number}/{len(documents)} texts, {len(records)} new target candidates", flush=True)
            flush()
            engine_metadata = engine.metadata
        finally:
            if engine:
                engine.close()
        # Reuse the owning metadata recovery on a small in-memory key inventory.
        with closing(sqlite3.connect(":memory:")) as metadata_index:
            metadata_index.execute("CREATE TABLE case_key(key TEXT,case_id TEXT)")
            metadata_index.executemany("INSERT INTO case_key VALUES (?,?)", ((key, identity)
                for (identity, _), record in records.items() for key in record["case_keys"]))
            attach_citation_metadata(metadata_index, list(records.values()))
    blocked_family = set()
    for first, second in history_edges:
        if first in blocked or second in blocked:
            blocked_family.update((first, second))
    changed = True
    while changed:
        changed = False
        for first, second in history_edges:
            if (first in blocked_family) != (second in blocked_family):
                blocked_family.update((first, second))
                changed = True
    eligible, excluded = [], []
    for record in records.values():
        for alias in record["aliases"].values():
            alias["document_ids"] = sorted(alias["document_ids"])
            alias["votes"] = len(alias["document_ids"])
        reason = ("previous_litigation_family" if record["identity"] in blocked_family or
                  family(record["left"], record["right"]) in prior_pairs else
                  "missing_party_inputs" if not record["left"] or not record["right"] else None)
        value = qualify(record)
        if reason or not value["aliases"]:
            excluded.append({**value, "exclusion": reason or "no_eligible_base_target"})
        else:
            eligible.append(value)
    save(output_name, {"status": "fresh_targets_frozen_without_predictions",
        "source_manifest_sha256": sha(PRIVATE / manifest_name),
        "recipe_sha256": sha(Path(__file__)), "engine": engine_metadata,
        "frozen_metadata_sha256": {name: sha(path) for name, path in
            (("index", index_path), ("provider", provider_path)) if path},
        "counts": dict(counts), "records": eligible, "excluded": excluded, "witnesses": witnesses,
        "seconds": round(time.monotonic() - started, 2),
        "limits": ["This is a prediction-blind candidate inventory; fixed source review and source/family grouping remain before final scoring.",
            "Previously supervised cases and known litigation families are excluded.",
            "Cases with prior unlabeled metadata require exclusion from background statistics before final training; never-seen-metadata cases provide a stricter subset.",
            "The final sample may be insufficient for the claimed residual-gap precision."]})
    print(json.dumps({"counts": dict(counts), "eligible_case_language_rows": len(eligible),
        "eligible_identities": len({r['identity'] for r in eligible}),
        "never_seen_metadata_rows": sum(not r['previous_unlabeled_metadata'] for r in eligible),
        "exclusions": dict(Counter(r['exclusion'] for r in excluded)), "seconds": round(time.monotonic() - started, 2)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--reserve-bulk", action="store_true")
    action.add_argument("--fetch-reserved", action="store_true", help="materialize frozen source files on the compute host")
    parser.add_argument("--manifest", default="base-final-source-manifest.json")
    parser.add_argument("--output", default="base-final-candidates.json")
    parser.add_argument("--index", type=Path, help="frozen metadata-only index for remote corpus work")
    parser.add_argument("--provider", type=Path, help="frozen metadata-only provider store for remote corpus work")
    args = parser.parse_args()
    if args.reserve_bulk:
        reserve_bulk()
    elif args.fetch_reserved:
        manifest = read(args.manifest)
        for file in manifest["files"]:
            fetch_reserved_file(file, manifest["repository"], manifest["revision"])
            print(f"Verified {file['court']} source file", flush=True)
    else:
        main(args.manifest, args.output, args.index, args.provider)
