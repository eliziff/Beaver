"""Existing golds' notes paired again by the structure parser's pairer (author.pair_notes), from the
transcription alone or with the model's listed reference marks, each into a store of its own, for
truth_notes.py to compare.

  python repair_notes.py STORE MANIFEST PARSED OUT_PREFIX
"""
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import author  # noqa: E402
import blocks  # noqa: E402

store, manifest, parsed, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
rows = {r["sha256"]: r for r in json.loads(manifest.read_text(encoding="utf-8"))["documents"]}
for path in sorted(store.glob("v4/*/gold.json.gz")):
    row = rows.get(path.parent.name)
    if not row: continue
    extracted, sizes, _ = author.extract(Path(row["path"]), row["mode"], parsed, 3600)
    facts = {l["id"]: l for l in extracted}
    for arm, listed in (("text", False), ("listed", True)):
        gold = json.loads(gzip.decompress(path.read_bytes()))
        lines = [{**l, "bbox": facts[l["id"]]["bbox"], "superscripts": facts[l["id"]]["superscripts"]} for l in gold["lines"]]
        # Each unit's printed marker read again off its first line, by the current reader.
        final = {l["id"]: l.get("corrected", l["text"]) for l in lines}
        for unit in gold["units"]:
            first = gold["typed"][unit["lines"][0]]
            if first["region"] == "table" or not first["spans"]: continue
            items = [([{**s, "n": s["line_id"]} for s in first["spans"]], None)]
            first["markers"] = [blocks.strip([span]) for _, span in blocks.place_markers({}, items, final)]
        gold["notes"] = author.pair_notes(gold["typed"], [u["lines"] for u in gold["units"]], lines, sizes, row["mode"], listed)
        target = Path(f"{out}-{arm}") / "v4" / path.parent.name
        target.mkdir(parents=True, exist_ok=True)
        (target / "gold.json.gz").write_bytes(gzip.compress(json.dumps(gold).encode()))
        (target / "receipt.json").write_text((path.parent / "receipt.json").read_text(encoding="utf-8"), encoding="utf-8")
    print(path.parent.name[:10], "paired", flush=True)
