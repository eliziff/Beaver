"""In a dump: per document, the gold's document starts, the lines offering a start, and the oracle's moves that
open one; and that each line carries its text and look. python dump_starts.py DUMP_DIR"""
import json, os, sys
import numpy as np
folder = sys.argv[1]
for name in sorted(os.listdir(folder)):
    if not name.endswith(".json"):
        continue
    meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
    rows = np.fromfile(os.path.join(folder, f"{meta['sha256']}.moves.f32"), dtype="<f4").reshape(-1, meta["move_width"])
    starts_at = 2 + meta["candidate_features"].index("starts")
    lines = np.asarray(meta["move_lines"])
    oracle = np.asarray(meta["move_oracle"], dtype=bool)
    gold = [k for k, g in enumerate(meta["gold"]) if g[2] == 1]
    offered = sorted(set(lines[rows[:, starts_at] == 1].tolist()))
    taken = sorted(set(lines[oracle & (rows[:, starts_at] == 1)].tolist()))
    print(meta["sha256"][:8], "lines", meta["lines"], "texts", len(meta["texts"]), "looks", len(meta["looks"]),
          "| gold starts", gold[:6], "offered", len(offered), "of them gold", len(set(gold) & set(offered)), "oracle opens", taken[:6])
    kind_at, place_at = 2 + meta["candidate_features"].index("start_kind"), 2 + meta["candidate_features"].index("page_place")
    for k in gold:
        row = rows[lines == k][0]
        print("   gold start", k, "page place", int(row[place_at]), "reader's kind", int(row[kind_at]), repr(meta["texts"][k][:60]))
