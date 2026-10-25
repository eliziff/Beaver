"""A copy of a store with the document pass's region changes undone (each gold's report lists
them), so the regions can be scored with and without them.

  python undo_document_pass.py STORE OUT_STORE
"""
import gzip
import json
import sys
from pathlib import Path

store, out = Path(sys.argv[1]), Path(sys.argv[2])
counts = []
for path in sorted(store.glob("v4/*/gold.json.gz")):
    gold = json.loads(gzip.decompress(path.read_bytes()))
    changes = gold["report"].get("document_pass_changes", [])
    for change in changes:
        for t in gold["units"][change["unit"]]["lines"]:
            gold["typed"][t]["region"] = change["from"]
    counts.append((path.parent.name[:10], len(gold["units"]), [f"{c['from']}->{c['to']}" for c in changes]))
    target = out / "v4" / path.parent.name
    target.mkdir(parents=True, exist_ok=True)
    (target / "gold.json.gz").write_bytes(gzip.compress(json.dumps(gold).encode()))
    (target / "receipt.json").write_text((path.parent / "receipt.json").read_text(encoding="utf-8"), encoding="utf-8")
for sha, units, changed in counts:
    print(f"{sha}  {len(changed)} of {units} units changed  {changed[:6]}")
print(f"total: {sum(len(c) for _, _, c in counts)} changes over {sum(u for _, u, _ in counts)} units in {len(counts)} documents")
