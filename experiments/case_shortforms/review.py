"""Prepare fixed random source witnesses for reading and recording quality judgments."""
import argparse
from contextlib import closing, ExitStack
import hashlib
import json
from pathlib import Path
import random

from mine import data_root, readonly
from evidence import annotation_flag


def annotation_audit(database, output):
    from analyze import gold, assign_splits
    from collections import Counter
    counts = Counter()
    flagged = []
    with closing(readonly(database)) as index:
        rows = gold(index)
        assign_splits(rows, reserve_audit=True)
        for record in rows:
            if record["split"] not in {"train", "development"} or not record["left"] or not record["right"]:
                continue
            counts[record["split"]+"_rows"] += 1
            flags = [{"normalized": norm, "text": alias["text"], "flag": annotation_flag(alias["text"])}
                     for norm, alias in record["aliases"].items() if annotation_flag(alias["text"])]
            if not flags:
                continue
            counts[record["split"]+"_flagged_rows"] += 1
            counts[record["split"]+"_all_aliases_flagged_rows"] += len(flags) == len(record["aliases"])
            for flag in flags:
                counts[record["split"]+"_"+flag["flag"]+"_aliases"] += 1
            flagged.append({"identity": record["identity"], "language": record["language"],
                            "split": record["split"], "flags": flags, "alias_count": len(record["aliases"])})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"scope": "reduced training and development only; review flags, not gold edits or rejected labels",
        "counts": dict(counts), "items": flagged}, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(dict(counts)), flush=True)


def prepare_gold_sample(database, output, count=120):
    """Sample case/language rows before looking at predictions or label contents."""
    if output.exists():
        prior = json.loads(output.read_text(encoding="utf-8"))
        if any(item.get("judgment") is not None for item in prior.get("items", [])):
            raise ValueError("reviewed gold packet already exists; preserve it and choose an explicit different --output")
    from analyze import gold, assign_splits
    prefix = "shortforms-blind-gold-v1:"
    digest = lambda text: hashlib.sha256(text.encode("utf-8")).digest()
    packet = []
    with ExitStack() as stack:
        index = stack.enter_context(closing(readonly(database)))
        rows = gold(index)
        assign_splits(rows, reserve_audit=True)
        eligible = [r for r in rows if r["split"] == "development" and r["left"] and r["right"]]
        selected = sorted(eligible, key=lambda r: digest(prefix+r["identity"]+":"+r["language"]))[:count]
        paths = json.loads(index.execute("SELECT value FROM meta WHERE key='sources'").fetchone()[0])
        sources = {provider: stack.enter_context(closing(readonly(Path(path)))) for provider, path in paths.items()}
        for number, record in enumerate(selected):
            # One alias per sampled case/language, chosen by a separate hash.
            # This estimates case-weighted alias validity, not all-label row validity.
            norm = min(record["aliases"], key=lambda value: digest(prefix+"alias:"+record["identity"]+":"+value))
            witnesses = index.execute("SELECT s.provider,s.local_id,s.language,s.sha256,o.start,o.end,x.spelling"
                " FROM clean_observation x JOIN observation o ON o.case_id=x.original_case_id"
                " AND o.alias_id=x.original_alias_id AND o.source_id=x.source_id AND o.kind=x.kind"
                " JOIN source s ON s.id=x.source_id WHERE x.case_id=? AND x.normalized=?"
                " AND s.language=? AND x.kind='definition' AND x.status='accepted' AND s.duplicate_of IS NULL",
                (record["id"], norm, record["language"])).fetchall()
            if not witnesses:
                raise ValueError("accepted gold alias has no source witness")
            provider, local_id, language, sha, start, end, spelling = min(witnesses,
                key=lambda value: digest(prefix+"witness:"+str(value[:3])))
            query = "SELECT text FROM articles WHERE article_id=?" if provider == "journal" else (
                "SELECT unofficial_text_"+language+" FROM document WHERE id=?")
            text = sources[provider].execute(query, (local_id,)).fetchone()[0]
            if hashlib.sha256(text.encode("utf-8")).hexdigest() != sha:
                raise ValueError("gold-audit source changed since mining")
            packet.append({"number": number, "identity": record["identity"], "language": language,
                "alias": spelling, "provider": provider, "local_id": local_id, "sha256": sha,
                "start": start, "end": end, "context": text[max(0,start-300):min(len(text),end+140)],
                "judgment": None, "note": ""})
    assert len({(item["identity"], item["language"]) for item in packet}) == len(packet)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"scope": "development only; blind to predictions and captions; one independently hash-chosen alias per sampled case/language",
        "selection_prefix": prefix, "population": len(eligible), "requested_count": count,
        "judgment_contract": "valid_declared_name, not_a_declared_name, or uncertain; judge source evidence, not predictability from caption",
        "limits": "one source witness per alias; case-weighted alias validity is not the proportion of cases with no valid label",
        "reviewer": None, "items": packet}, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(f"Prepared {len(packet)} prediction-blind development witnesses in {output}")


def prepare(database, output, count=40):
    packet = []
    rng = random.Random(60281)
    with closing(readonly(database)) as index:
        paths = json.loads(index.execute("SELECT value FROM meta WHERE key='sources'").fetchone()[0])
        for provider, filename in paths.items():
            rows = index.execute("SELECT c.identity,c.citation,x.spelling,s.local_id,s.language,s.sha256,o.start,o.end"
                " FROM clean_observation x JOIN observation o ON o.case_id=x.original_case_id"
                " AND o.alias_id=x.original_alias_id AND o.source_id=x.source_id AND o.kind=x.kind"
                " JOIN case_record c ON c.id=x.case_id JOIN source s ON s.id=x.source_id"
                " WHERE x.kind='definition' AND x.status='accepted'"
                " AND c.ambiguous=0 AND s.duplicate_of IS NULL AND s.provider=?"
                " ORDER BY c.identity,o.alias_id,o.source_id", (provider,)).fetchall()
            with closing(readonly(Path(filename))) as source:
                for identity, citation, alias, local_id, language, sha, start, end in rng.sample(rows, min(count, len(rows))):
                    query = "SELECT text FROM articles WHERE article_id=?" if provider == "journal" else (
                        "SELECT unofficial_text_" + language + " FROM document WHERE id=?")
                    text = source.execute(query, (local_id,)).fetchone()[0]
                    if hashlib.sha256(text.encode("utf-8")).hexdigest() != sha:
                        raise ValueError("review witness changed since mining")
                    packet.append({"provider": provider, "local_id": local_id, "language": language,
                        "sha256": sha, "identity": identity, "citation": citation, "alias": alias,
                        "start": start, "end": end, "context": text[max(0,start-500):min(len(text),end+80)],
                        "judgment": None, "note": ""})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"seed": 60281, "reviewer": None, "items": packet}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Prepared {len(packet)} private witnesses in {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=data_root() / "cache/case-shortforms/shortforms.sqlite")
    parser.add_argument("--output", type=Path, default=Path("benchmarks/local-data/case-shortforms/manual-review.json"))
    parser.add_argument("--count", type=int, default=40, help="witnesses per provider")
    parser.add_argument("--gold-development", action="store_true", help="fixed hash sample of case/language rows; count is total")
    parser.add_argument("--annotation-audit", action="store_true", help="count suspected non-name annotations; no data changes")
    args = parser.parse_args()
    if args.annotation_audit:
        annotation_audit(args.database, args.output)
    else:
        (prepare_gold_sample if args.gold_development else prepare)(args.database, args.output, args.count)
