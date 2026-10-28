"""Pool grades by split over b5-b8 for several arms: the development split alone (where a model
fitted on train reads honestly) and train, every headline layer.

  python pool_dev.py ARM [ARM ...]       arms are grade-<arm>.json names, e.g. qt1-default cf1-tagger
"""
import json
import sys

layers = ["units_heading", "heading_steps", "markers_heading", "units_body", "markers_body", "units_list_item", "units_quote",
          "units_note", "note_references", "units_table", "hierarchy", "contents_lines", "continuations", "joins", "document"]
arms = sys.argv[1:]
for split in ("development", "train"):
    print(f"\n== {split}")
    print(f"  {'layer':18} " + " ".join(f"{arm:>14}" for arm in arms))
    pooled = {}
    for arm in arms:
        totals = {l: [0, 0, 0] for l in layers}
        docs = 0
        for b in ("b5", "b6", "b7", "b8"):
            try:
                g = json.load(open(rf"C:\Users\elias\fable\{b}\a\grade-{arm}.json", encoding="utf-8"))
            except FileNotFoundError:
                continue
            for run in g["per_run"]:
                if run.get("split") != split:
                    continue
                docs += 1
                for l in layers:
                    m = run["metrics"].get(l)
                    if m:
                        t = totals[l]
                        t[0] += m["expected"]; t[1] += m["predicted"]; t[2] += m["correct"]
        pooled[arm] = (docs, totals)
    print(f"  {'docs':18} " + " ".join(f"{pooled[arm][0]:>14}" for arm in arms))
    for l in layers:
        print(f"  {l:18} " + " ".join(f"{2 * pooled[arm][1][l][2] / max(pooled[arm][1][l][0] + pooled[arm][1][l][1], 1):>14.3f}" for arm in arms))
