"""What changed between two grades of one reader, document by document: every document whose counts moved on any layer,
each layer's (expected, predicted, correct) before and after, then each layer's documents gained and lost.
python doc_diff.py BEFORE_JSON AFTER_JSON [LAYER...]"""
import json, sys

LAYERS = ["units_heading", "markers_text", "units_text", "units_provision", "units_list_item", "units_quote", "note_references", "note",
          "heading_steps", "depth_steps", "sequence_steps", "hierarchy"]
before, after = (json.load(open(path, encoding="utf-8")) for path in sys.argv[1:3])
layers = sys.argv[3:] or LAYERS
key = lambda run: (run.get("source_sha256"), run.get("run"), run.get("part"))
runs = {key(run): run for run in before["per_run"]}
changed, gained, lost, same = [], {name: 0 for name in layers}, {name: 0 for name in layers}, 0
for run in after["per_run"]:
    other = runs.get(key(run))
    if other is None:
        print("only after", key(run))
        continue
    moved = []
    for name in layers:
        a, b = other.get("metrics", {}).get(name), run.get("metrics", {}).get(name)
        if a != b and a and b:
            moved.append(f"{name} {a['predicted']}/{a['correct']}->{b['predicted']}/{b['correct']}")
            gained[name] += b["correct"] > a["correct"]
            lost[name] += b["correct"] < a["correct"]
    if moved:
        changed.append((str(run.get("source_sha256"))[:12], run.get("genre_group"), run.get("mode"), moved))
    else:
        same += 1
print(f"{len(changed)} documents changed, {same} unchanged (of {len(after['per_run'])}; layer predicted/correct, of the same expected)")
for sha, genre, mode, moved in changed:
    print(sha, genre, mode, "; ".join(moved))
print(f"{'layer':20}{'docs gained':>12}{'docs lost':>11}")
for name in layers:
    print(f"{name:20}{gained[name]:12}{lost[name]:11}")
