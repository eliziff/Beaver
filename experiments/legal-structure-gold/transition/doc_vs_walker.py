"""Where one grade loses against another, layer by layer: each document's losses (missed plus spurious) in both, the
documents the second loses more on, worst first, with their mode and genre, and how much of the layer's difference
the ten worst hold.
python doc_vs_walker.py GRADE_A GRADE_B [LAYER,...]"""
import json, sys
from collections import Counter

a, b = (json.load(open(path, encoding="utf-8")) for path in sys.argv[1:3])
runs = lambda g: {r["source_sha256"]: r for r in g["per_run"]}
A, B = runs(a), runs(b)
layers = sys.argv[3].split(",") if len(sys.argv) > 3 else sorted({k for r in A.values() for k in r.get("metrics", {})})


def lost(run, layer):
    m = run.get("metrics", {}).get(layer)
    return (m["expected"] - m["correct"], m["predicted"] - m["correct"], m["expected"]) if m else (0, 0, 0)


for layer in layers:
    rows, net, by = [], 0, Counter()
    for sha in A.keys() & B.keys():
        (ma, sa, e), (mb, sb, _) = lost(A[sha], layer), lost(B[sha], layer)
        delta = (mb + sb) - (ma + sa)
        net += delta
        if delta:
            rows.append((delta, sha[:12], A[sha].get("mode") or "-", A[sha].get("genre_group") or "-", e, ma, sa, mb, sb))
            by[(A[sha].get("mode") or "-", A[sha].get("genre_group") or "-")] += delta
    if not rows:
        continue
    rows.sort(reverse=True)
    worse = sum(r[0] for r in rows if r[0] > 0)
    print(f"\n{layer}: B loses {net:+d} on net ({worse} more in {sum(r[0] > 0 for r in rows)} documents, {sum(-r[0] for r in rows if r[0] < 0)} fewer in {sum(r[0] < 0 for r in rows)})")
    print("  by mode and genre: " + ", ".join(f"{m}/{g} {d:+d}" for (m, g), d in by.most_common()))
    print(f"  worst ten hold {sum(r[0] for r in rows[:10]) / max(worse, 1):.2f} of B's extra losses:")
    for delta, sha, mode, genre, e, ma, sa, mb, sb in rows[:10]:
        print(f"    {sha} {mode:>8} {genre:<14} expected {e:5}  A -{ma}/+{sa}  B -{mb}/+{sb}  ({delta:+d})")
