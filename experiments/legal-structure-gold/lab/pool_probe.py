"""Pool the OCR probe grades (fable\\probe\\grade-ocr-<pack>-<arm>-<batch>.json) over b5, b7 and b8:
stock against the fine-tuned recognizer, tier 0 and the tagger, every headline layer and the
recognition text score."""
import json

layers = ["units_heading", "heading_steps", "markers_heading", "units_body", "markers_body", "units_list_item", "units_quote",
          "units_note", "note_references", "units_table", "hierarchy", "contents_lines", "continuations", "joins"]
arms = [(pack, arm) for pack in ("stock", "finetuned") for arm in ("default", "tagger")]
pooled = {}
for pack, arm in arms:
    totals = {l: [0, 0, 0] for l in layers}
    text = [0, 0]
    docs = 0
    for b in ("b5", "b7", "b8"):
        try:
            g = json.load(open(rf"C:\Users\elias\fable\probe\grade-ocr-{pack}-{arm}-{b}.json", encoding="utf-8"))
        except FileNotFoundError:
            continue
        for run in g["per_run"]:
            docs += 1
            for l in layers:
                m = run["metrics"].get(l)
                if m:
                    t = totals[l]; t[0] += m["expected"]; t[1] += m["predicted"]; t[2] += m["correct"]
            t = run.get("text") or {}
            text[0] += t.get("characters", 0); text[1] += t.get("matched_characters", 0)
    pooled[(pack, arm)] = (docs, totals, text)
print(f"  {'layer':18} " + " ".join(f"{pack[:5]}/{arm[:7]:>7}" for pack, arm in arms))
print(f"  {'docs':18} " + " ".join(f"{pooled[k][0]:>13}" for k in arms))
for l in layers:
    print(f"  {l:18} " + " ".join(f"{2 * pooled[k][1][l][2] / max(pooled[k][1][l][0] + pooled[k][1][l][1], 1):>13.3f}" for k in arms))
print(f"  {'text matched':18} " + " ".join(f"{pooled[k][2][1] / max(pooled[k][2][0], 1):>13.3f}" for k in arms))
