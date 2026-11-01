"""Development lines read by the local scores alone, a forest's against another tier's: each line's best class
against the gold's (move accuracy), heading openings' precision, recall and F1, and the other tier's heading
level on the gold's heading openings. python compare_local.py DUMP_DIR STORE FOREST SCORES_DIR"""
import json, os, sys
import numpy as np
import lightgbm as lgb
folder, store, forest, scores = sys.argv[1:5]
model = lgb.Booster(model_file=forest)
HEADING_OPEN = 3 * 2 + 1
tally = {"forest": [0, 0, 0, 0, 0], "tier": [0, 0, 0, 0, 0]}  # right, lines, tp, predicted, gold
levels = [0, 0]


def gold_levels(gold):
    out, current = np.full(len(gold), -1), 0
    for k, g in enumerate(gold):
        if g[2] == 1:
            current = 0
        if g[0] == 3 and g[1] == 1:
            if g[4] < 0:
                current = 0
                continue
            current = int(np.clip(max(current, 1) + g[4] - 10, 1, 9))
            out[k] = current
    return out


for name in sorted(os.listdir(folder)):
    if not name.endswith(".json") or name.endswith(".labels.json"):
        continue
    meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
    sha = meta["sha256"]
    try:
        if json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))["partition"] != "development":
            continue
    except (OSError, KeyError, ValueError):
        continue
    path = os.path.join(scores, f"{sha}.local.f32")
    if not os.path.exists(path):
        continue
    gold = np.asarray(meta["gold"], dtype=np.int64).reshape(-1, 8)
    target = np.where((gold[:, 0] >= 0) & (gold[:, 0] < 17), gold[:, 0] * 2 + (gold[:, 1] == 1), -1)
    x = np.fromfile(os.path.join(folder, f"{sha}.lines.f32"), dtype="<f4").reshape(meta["lines"], meta["line_width"])
    if not len(x):
        continue
    reads = {"forest": np.asarray(model.predict(x)).reshape(len(x), -1).argmax(1),
             "tier": np.fromfile(path, dtype="<f4").reshape(len(x), -1).argmax(1)}
    keep = target >= 0
    for key, p in reads.items():
        t = tally[key]
        t[0] += int((p[keep] == target[keep]).sum())
        t[1] += int(keep.sum())
        t[2] += int(((p == HEADING_OPEN) & (target == HEADING_OPEN)).sum())
        t[3] += int(((p == HEADING_OPEN) & keep).sum())
        t[4] += int((target == HEADING_OPEN).sum())
    lp = os.path.join(scores, f"{sha}.levels.f32")
    if os.path.exists(lp):
        lv = np.fromfile(lp, dtype="<f4").reshape(len(x), -1).argmax(1)
        g = gold_levels(gold)
        known = g > 0
        levels[0] += int((lv[known] == g[known]).sum())
        levels[1] += int(known.sum())
for key, (right, lines, tp, predicted, gold_n) in tally.items():
    p, r = tp / max(predicted, 1), tp / max(gold_n, 1)
    print(f"{key:7} move accuracy {right / max(lines, 1):.4f} over {lines} lines | heading openings P {p:.3f} R {r:.3f} F1 {2 * p * r / max(p + r, 1e-9):.3f} ({gold_n} gold)")
print(f"tier heading level accuracy on the gold's heading openings {levels[0] / max(levels[1], 1):.4f} over {levels[1]}")
