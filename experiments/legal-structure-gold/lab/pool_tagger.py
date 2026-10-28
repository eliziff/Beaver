"""Pool the tagger-all grades (dev split, b5-b8) against tier 0 on the same documents."""
import json
import sys

root = sys.argv[1]
layers = ["units_heading", "heading_steps", "markers_heading", "units_body", "markers_body", "units_list_item", "units_quote",
          "units_note", "units_table", "hierarchy", "contents_lines", "continuations", "joins"]
for arm in ("tier0", "model"):
    totals = {l: [0, 0, 0] for l in layers}
    docs = 0
    for b in ("b5", "b6", "b7", "b8"):
        try:
            g = json.load(open(rf"{root}\grade-{b}-{arm}.json", encoding="utf-8"))
        except FileNotFoundError:
            continue
        for run in g["per_run"]:
            docs += 1
            for l in layers:
                m = run["metrics"].get(l)
                if m:
                    t = totals[l]
                    t[0] += m["expected"]; t[1] += m["predicted"]; t[2] += m["correct"]
    print(f"{arm:6} {docs} dev docs")
    for l, (e, p, c) in totals.items():
        print(f"    {l:18} {2 * c / max(e + p, 1):.3f}  (P {c / max(p, 1):.2f} R {c / max(e, 1):.2f}, n {e})")
