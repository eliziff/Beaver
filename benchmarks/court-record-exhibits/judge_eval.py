"""Sweep a judged-candidates file: keep rows with p >= t, score each threshold.

Usage: python judge_eval.py <judged.json> [--with-affidavit]
judged.json is {record: [row + "p"]} from an LLM judge over rule candidates.
"""
import io, json, re, sys, contextlib
import score

judged = json.load(open(sys.argv[1], encoding="utf-8"))
wa = "--with-affidavit" in sys.argv
def run(rows_by):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        score.chronology(rows_by, wa)
    m = re.search(r"precision ([\d.]+) recall ([\d.]+) F1 ([\d.]+)", buf.getvalue())
    return tuple(float(x) for x in m.groups())
n = sum(len(v) for v in judged.values())
print(f"{len(judged)} records, {n} candidate rows")
for t in [0.0, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9]:
    kept = {k: [r for r in v if r["p"] >= t] for k, v in judged.items()}
    p, r, f = run(kept)
    print(f"  keep p>={t:<4}  rows {sum(len(v) for v in kept.values()):5}  precision {p:.3f} recall {r:.3f} F1 {f:.3f}")
