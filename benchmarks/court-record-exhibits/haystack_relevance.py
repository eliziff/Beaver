"""Zero-shot relevance filters for the haystack chronology, with browser-sized models.

Usage: python haystack_relevance.py <rows.json> <minilm_dir> <embed_dir> [--pooling cls]

rows.json comes from chrono_fast.py --haystack. The "focus" a user would type
is the gold proceeding plus the affidavit's stated purpose. Each row's
document (title + opening) is scored against it with (a) the MiniLM ms-marco
cross-encoder and (b) a small retrieval embedder. For each method, rows of
documents below a per-record rank cut are dropped, and the result is scored
with score.py haystack-chronology. Also prints how much of each distractor
role survives, because synthetic distractors share one renderer and a filter
that only learns its look would be worthless.
"""
import io, json, os, re, sys, contextlib
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score
from fastmatch import MiniLM, Embedder
from chrono_fast import file_text

rows_by = json.load(open(sys.argv[1], encoding="utf-8"))
minilm = MiniLM(sys.argv[2], max_len=256)
emb = Embedder(sys.argv[3], "cls")
HS = os.path.join(os.path.dirname(score.ROOT), "haystack")


def focus(rid):
    g = score.gold(rid)
    return f"{g['proceeding']}. {g['document']}"


doc_scores = {}
for rid in rows_by:
    man = {e["file"]: e for e in json.load(open(os.path.join(HS, rid, "manifest.json"), encoding="utf-8"))["files"]}
    f = focus(rid)
    fv = emb.embed(f, query=True)
    heads = {name: re.sub(r"\s+", " ", file_text(os.path.join(HS, rid, "files", name)))[:1200] for name in man}
    doc_scores[rid] = {name: {"role": man[name]["role"],
                              "minilm": minilm.score(f[:400], h) if h.strip() else -20.0,
                              "embed": float(fv @ emb.embed(h)) if h.strip() else -1.0} for name, h in heads.items()}


def run(kept):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        score.haystack_chronology(kept, False)
    return [float(x) for x in re.search(r"precision ([\d.]+) recall ([\d.]+) F1 ([\d.]+)", buf.getvalue()).groups()]


print(f"{len(rows_by)} haystacks; baseline (no filter): P/R/F1 {run(rows_by)}")
for method in ("minilm", "embed"):
    for keep in (0.3, 0.4, 0.5, 0.6, 0.7):
        kept, survive = {}, {}
        for rid, rows in rows_by.items():
            ds = doc_scores[rid]
            order = sorted(ds, key=lambda n: -ds[n][method])
            keepset = set(order[:max(1, round(keep * len(order)))])
            for n, d in ds.items():
                s = survive.setdefault(d["role"], [0, 0]); s[1] += 1; s[0] += n in keepset
            kept[rid] = [r for r in rows if set(r["files"]) & keepset]
        roles = " ".join(f"{k} {v[0] / v[1]:.2f}" for k, v in sorted(survive.items()))
        print(f"  {method:6} keep top {keep:.0%} of documents: P/R/F1 {run(kept)} | kept share by role: {roles}")
