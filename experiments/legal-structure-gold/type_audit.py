"""Apply a document-type audit to the gold store: each decision that changes a part's type (high or
medium confidence, not held for a ruling) is written into the source's current structure gold as
that document's `document_type`, recorded in the gold's `postcorrections` (rule `type_audit`, with
the type it replaces, the reason and the audit file), and the gold's receipt takes the new hash. The
decisions file is kept in the store (gold/batches/audits/). Then register the store again.

A decision: {sha256, part (1-based, the part's place among the gold's documents), gold_type, type,
confidence, reason, note}. Notes listed in --hold (default practice_direction) keep the gold's type.

  python experiments/legal-structure-gold/type_audit.py DECISIONS.json [--hold practice_direction] [--dry-run]
"""
import argparse
import collections
import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "legal_pdf_corpus"))
import gold_store  # noqa: E402


def write_gzip(path, value):
    """As the runner writes its artifacts: sorted compact JSON, gzip without a timestamp, atomically."""
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(gzip.compress(data, mtime=0))
    temporary.replace(path)


def openings(gold):
    """The unit index that opens each of the gold's documents, in order."""
    return [0] + [u for u, unit in enumerate(gold["units"]) if u and unit.get("starts_document")]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("decisions", type=Path)
    parser.add_argument("--hold", default="practice_direction", help="comma-separated note words whose decisions are held")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    hold = {w for w in args.hold.split(",") if w}
    decisions = json.loads(args.decisions.read_text(encoding="utf-8"))["decisions"]
    current = dict(gold_store.sources(gold_store.STRUCTURE))
    kept = gold_store.ROOT / "batches" / "audits" / args.decisions.name
    count = collections.Counter()
    by_source = collections.defaultdict(list)
    for d in decisions:
        if d["type"] == d["gold_type"]:
            count["agrees"] += 1
        elif d["confidence"] == "low" or any(w in (d.get("note") or "") for w in hold):
            count["held"] += 1
        else:
            by_source[d["sha256"]].append(d)
    for sha, changes in by_source.items():
        path = current.get(sha)
        if path is None:
            count["no current gold"] += len(changes)
            continue
        gold = gold_store.read(path)
        opened = openings(gold)
        done = []
        for d in changes:
            unit = gold["units"][opened[d["part"] - 1]] if d["part"] <= len(opened) else None
            if unit is None or unit.get("document_type") != d["gold_type"]:
                count["gold differs from the audited label"] += 1
                continue
            unit["document_type"] = d["type"]
            done.append({"rule": "type_audit", "part": d["part"], "from": d["gold_type"], "to": d["type"],
                         "reason": d["reason"], "audit": f"batches/audits/{args.decisions.name}"})
            count[f"{d['gold_type']} -> {d['type']}"] += 1
        if done and not args.dry_run:
            gold.setdefault("postcorrections", []).extend(done)
            write_gzip(path, gold)
            receipt = path.with_name("receipt.json")
            if receipt.is_file():
                value = json.loads(receipt.read_text(encoding="utf-8-sig"))
                value["gold_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                value["postcorrections"] = len(gold["postcorrections"])
                receipt.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    if not args.dry_run:
        kept.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.decisions, kept)
    print(json.dumps(dict(sorted(count.items(), key=lambda x: -x[1])), indent=1), "(dry run)" if args.dry_run else "")


if __name__ == "__main__":
    main()
