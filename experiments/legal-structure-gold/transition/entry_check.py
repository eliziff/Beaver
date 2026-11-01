"""How the parser's contents entries answer headings, on an oracle walk's dump: per document, the gold's heading
openings that answer an entry, the other lines that would, contents rows, and the entry level against the gold's
heading level step. python entry_check.py DUMP_DIR"""
import json, os, sys
import numpy as np
folder = sys.argv[1]
for name in sorted(os.listdir(folder)):
    if not name.endswith(".json") or name.endswith(".labels.json"):
        continue
    meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
    rows = np.fromfile(os.path.join(folder, f"{meta['sha256']}.moves.f32"), dtype="<f4").reshape(-1, meta["move_width"])
    col = lambda n: 2 + meta["candidate_features"].index(n)
    line = np.asarray(meta["move_lines"])
    first = {}
    for r, k in enumerate(line.tolist()):
        first.setdefault(k, r)
    gold = meta["gold"]
    heads = [k for k, g in enumerate(gold) if g[0] == 3 and g[1] == 1]
    answers = [k for k in first if rows[first[k], col("answers_entry")] > 0]
    rows_ = [k for k in first if rows[first[k], col("contents_row")] > 0]
    true_hits = [k for k in answers if gold[k][0] == 3]
    print(f"{meta['sha256'][:8]} gold headings {len(heads):4} heading lines answering {len(true_hits):4} | other lines answering {len(answers) - len(true_hits):4} | contents rows {len(rows_):4} entries at most {np.exp(rows[:, col('entries')].max()) - 1:.0f}")
    for k in [k for k in answers if gold[k][0] != 3][:3]:
        print("   false:", gold[k][0], repr(meta["texts"][k][:60]))
