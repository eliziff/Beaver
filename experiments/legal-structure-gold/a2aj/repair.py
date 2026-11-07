"""The store's A2AJ-aligned golds put right against their own pages: postcorrect.py's PRINTED rules, then its margin_numbers
(a margin number just given goes to both columns), over each gold as it stands, so a repair already made stays and every
line keeps its id and text. Each gold changed is listed, rule by rule, in REPAIRS.

  python repair.py [--sha PREFIX ...] [--write]     dry run unless --write; the dry run prints every change's count
"""
import argparse
import collections
import copy
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent), str(HERE.parents[1] / "legal_pdf_corpus")]
import gold_store  # noqa: E402
import postcorrect  # noqa: E402

REPAIRS = Path("E:/OpenLegalData/a2aj-gold-next/repairs.jsonl")


def corpus_busy():
    """A running pinpoint-corpus reads the store: no gold is written under it."""
    listing = subprocess.run(["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
    return "pinpoint-corpus" in listing


def numbered(gold):
    lines = {line["id"]: line for line in gold["lines"]}
    found = set()
    for entry in gold["typed"]:
        if entry["region"] == "text":
            for mark in entry["markers"]:
                span = mark[0] if isinstance(mark, list) else mark
                line = lines.get(span["line_id"])
                if line and re.search(r"\d", line["text"][span["start"]:span["end"]]):
                    found.add(re.sub(r"\D", "", line["text"][span["start"]:span["end"]]))
    return found


def repaired(gold):
    """The corrected copy of a gold and its corrections."""
    value = copy.deepcopy(gold)
    pages = [{"lines": [line for line in value["lines"] if line["page"] == page]} for page in sorted({line["page"] for line in value["lines"]})]
    done = [c for rule in postcorrect.PRINTED for c in rule(value, pages)]
    if done:
        done += postcorrect.margin_numbers(value)
        value.setdefault("postcorrections", []).extend(done)
    return value, done


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sha", nargs="*", default=[])
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    rules, sources, large = collections.Counter(), collections.Counter(), []
    paths = sorted(gold_store.ROOT.glob("*/structure/a2aj-a/gold.json.gz"))
    REPAIRS.parent.mkdir(parents=True, exist_ok=True)
    with REPAIRS.open("a", encoding="utf-8") as ledger:
        for path in paths:
            sha = path.parts[-4]
            if args.sha and not any(sha.startswith(s) for s in args.sha):
                continue
            gold = gold_store.read(path)
            value, done = repaired(gold)
            if not done:
                continue
            before, after = numbered(gold), numbered(value)
            changed = sum(1 for c in done if c["rule"] in ("number_at_margin", "number_printed"))
            share = changed / max(1, len(before))
            citation = gold.get("authoring", {}).get("citation")
            for rule, n in collections.Counter(c["rule"] for c in done).items():
                rules[rule] += n
                sources[rule] += 1
            if share > 0.05 and changed:
                large.append((sha[:8], citation, changed, len(before)))
            print(f"{sha[:8]} {citation}: {dict(collections.Counter(c['rule'] for c in done))} numbers {len(before)} -> {len(after)}", flush=True)
            if args.write:
                while corpus_busy():
                    subprocess.run(["powershell", "-NoProfile", "-Command", "Start-Sleep 60"])
                postcorrect.write(path, value)
                receipt_path = path.with_name("receipt.json")
                receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
                receipt.update(gold_sha256=hashlib.sha256(path.read_bytes()).hexdigest(), postcorrections=len(value["postcorrections"]))
                postcorrect.write(receipt_path, receipt)
                for rule, group in collections.Counter(c["rule"] for c in done).items():
                    first = next(c for c in done if c["rule"] == rule)
                    ledger.write(json.dumps({"sha256": sha, "citation": citation, "rule": rule, "count": group, "reason": first.get("reason", rule)}, ensure_ascii=False) + "\n")
                ledger.flush()
    print("corrections", dict(rules))
    print("golds", dict(sources))
    print("over 5% of a gold's numbers:", large)


if __name__ == "__main__":
    main()
