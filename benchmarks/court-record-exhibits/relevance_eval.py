"""Score precomputed document relevance scores on the haystack chronology.

Usage: python relevance_eval.py <rows.json> <doc_scores.json>

doc_scores.json is {record: {file: {"role", "score"}}} (train_relevance.py).
For each keep-share, the top documents per record by score are kept, their
rows scored with score.py haystack-chronology, and the share of each file
role that survives is printed.
"""
import io, json, re, sys, contextlib
import score

rows_by = json.load(open(sys.argv[1], encoding="utf-8"))
scores = json.load(open(sys.argv[2], encoding="utf-8"))


def run(kept):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        score.haystack_chronology(kept, False)
    return [float(x) for x in re.search(r"precision ([\d.]+) recall ([\d.]+) F1 ([\d.]+)", buf.getvalue()).groups()]


rows_by = {k: v for k, v in rows_by.items() if k in scores}
print(f"{len(rows_by)} haystacks; no filter: P/R/F1 {run(rows_by)}")
for keep in (0.3, 0.4, 0.5, 0.6, 0.7):
    kept, survive = {}, {}
    for rid, rows in rows_by.items():
        ds = scores[rid]
        order = sorted(ds, key=lambda n: -ds[n]["score"])
        keepset = set(order[:max(1, round(keep * len(order)))])
        for n, d in ds.items():
            s = survive.setdefault(d["role"], [0, 0]); s[1] += 1; s[0] += n in keepset
        kept[rid] = [r for r in rows if set(r["files"]) & keepset]
    print(f"  keep top {keep:.0%}: P/R/F1 {run(kept)} | kept by role: " + " ".join(f"{k} {v[0] / v[1]:.2f}" for k, v in sorted(survive.items())))
