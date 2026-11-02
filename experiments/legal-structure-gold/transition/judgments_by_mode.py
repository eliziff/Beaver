"""Judgments' headline layers in grades side by side, digital-born and OCR'd apart: each layer's F1 pooled over the
judgments of each mode. python judgments_by_mode.py NAME=GRADE_JSON..."""
import json, sys

LAYERS = [("headings", "units_heading"), ("numbered paragraphs", "markers_text"), ("paragraphs", "units_text"), ("list items", "units_list_item"),
          ("quotes", "units_quote"), ("footnote refs", "note_references"), ("footnote pairs", "note"), ("heading levels", "heading_steps"),
          ("body depths", "depth_steps"), ("sequences", "sequence_steps"), ("hierarchy", "hierarchy"), ("order", "order")]
grades = [(arg.split("=", 1)[0], json.load(open(arg.split("=", 1)[1], encoding="utf-8"))["per_run"]) for arg in sys.argv[1:]]
for mode in ("digitalborn", "ocr"):
    runs = [[r for r in per_run if r.get("genre_group") == "judgment" and r.get("mode") == mode] for _, per_run in grades]
    print(f"\njudgments, {mode}: {len(runs[0])} documents")
    print(f"{'layer':22}" + "".join(f"{name:>10}" for name, _ in grades) + f"{'expected':>10}")
    for label, key in LAYERS:
        cells, expected = [], 0
        for chosen in runs:
            e = p = c = 0
            for r in chosen:
                m = r.get("metrics", {}).get(key)
                if m:
                    e, p, c = e + m["expected"], p + m["predicted"], c + m["correct"]
            expected = e
            cells.append(2 * c / (e + p) if e + p else float("nan"))
        print(f"{label:22}" + "".join(f"{v:10.3f}" for v in cells) + f"{expected:10}")
