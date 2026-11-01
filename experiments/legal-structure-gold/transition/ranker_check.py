"""A ranker on a dump's own rows: per line, whether the move scored best (local log-probability plus the
ranker's correction) is the oracle's, beside the local scores alone; and what the corrections look like for the
oracle's moves and the others. python ranker_check.py RANKER DUMP_DIR [DOCS]"""
import json, os, sys
import numpy as np
import lightgbm as lgb
ranker, folder = sys.argv[1:3]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 20
model = lgb.Booster(model_file=ranker)
print("ranker features", model.num_feature())
names = [n for n in sorted(os.listdir(folder)) if n.endswith(".json") and not n.endswith(".labels.json")][:limit]
right_local = right_ranked = lines = 0
oracle_corr, other_corr = [], []
for name in names:
    meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
    rows = np.fromfile(os.path.join(folder, f"{meta['sha256']}.moves.f32"), dtype="<f4").reshape(-1, meta["move_width"])
    if rows.shape[1] != model.num_feature():
        print("width", rows.shape[1], "against", model.num_feature())
        break
    line = np.asarray(meta["move_lines"])
    oracle = np.asarray(meta["move_oracle"], dtype=bool)
    correction = model.predict(rows, raw_score=True)
    score = rows[:, 0] + correction
    oracle_corr.extend(correction[oracle].tolist())
    other_corr.extend(correction[~oracle].tolist())
    for k in np.unique(line[oracle]):
        at = np.flatnonzero(line == k)
        lines += 1
        right_local += int(oracle[at[np.argmax(rows[at, 0])]])
        right_ranked += int(oracle[at[np.argmax(score[at])]])
print(f"{lines} lines: local scores' best is the oracle's {right_local / max(lines, 1):.4f}, ranked best {right_ranked / max(lines, 1):.4f}")
print("correction on the oracle's moves: mean %.3f; on the others: mean %.3f" % (np.mean(oracle_corr), np.mean(other_corr)))
print("local log-probability column, first rows:", rows[:5, 0])
