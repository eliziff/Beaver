"""The headline layers of grade files side by side. python headline.py GRADE_JSON..."""
import json, os, sys
LAYERS = [("headings", "units_heading"), ("numbered paragraphs", "markers_text"), ("paragraphs", "units_text"), ("provisions", "units_provision"),
          ("list items", "units_list_item"), ("footnote refs", "note_references"), ("footnote pairs", "note"), ("heading levels", "heading_steps"),
          ("body depths", "depth_steps"), ("sequences", "sequence_steps"), ("hierarchy", "hierarchy"), ("tables", "table"), ("documents", "document"),
          ("line numbers", "line_numbers"), ("speakers", "speakers"), ("contents", "contents_lines"), ("order", "order")]
grades = []
for path in sys.argv[1:]:
    try:
        totals = json.load(open(path, encoding="utf-8"))["totals"]
    except (OSError, ValueError, KeyError) as error:
        print(path, error)
        continue
    grades.append((os.path.basename(path).replace("grade-", "").replace(".json", ""), totals))
print(f"{'layer':22}" + "".join(f"{name[:18]:>19}" for name, _ in grades))
for label, key in LAYERS:
    cells = []
    for _, totals in grades:
        m = totals.get(key) or {}
        cells.append(f"{m.get('f1', float('nan')):19.3f}" if isinstance(m, dict) else f"{'?':>19}")
    print(f"{label:22}" + "".join(cells))
