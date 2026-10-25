"""Heading detection on development by provenance group: per collection, mode and genre (and the
genres' source families), pooled P/R/F1 at a threshold, from a heading detector's saved
probabilities and the gold's provenance registry.

  python by_provenance.py ROWS_DIR PROBABILITIES.npz PROVENANCE.json [--threshold T] [--exclude FILE]
"""
import argparse
import collections
import json
import sys

import numpy as np


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("rows")
    parser.add_argument("probabilities")
    parser.add_argument("provenance")
    parser.add_argument("--threshold", type=float, default=0.3)
    parser.add_argument("--exclude")
    args = parser.parse_args()
    probs = np.load(args.probabilities)
    prov = {r["sha256"]: r for r in json.load(open(args.provenance, encoding="utf-8"))["records"]}
    exclude = {l.split()[1] for l in open(args.exclude, encoding="utf-8") if len(l.split()) > 1} if args.exclude else set()
    groups = collections.defaultdict(lambda: [0, 0, 0, 0])
    for line in open(f"{args.rows}/rows-development.jsonl", encoding="utf-8"):
        doc = json.loads(line)
        if doc["sha256"] in exclude or doc["sha256"] not in probs:
            continue
        p = prov.get(doc["sha256"], {})
        gold = {k for k, g in enumerate(doc["gold"]) if g and g[0] == 3 and g[1] == 1}
        pred = set(np.flatnonzero(probs[doc["sha256"]] >= args.threshold).tolist())
        for key in (("collection", p.get("collection")), ("mode", doc["mode"]), ("genre", f"{p.get('genre')} / {doc['mode']}")):
            s = groups[key]
            s[0] += len(gold); s[1] += len(pred); s[2] += len(gold & pred); s[3] += 1
    for kind in ("collection", "mode", "genre"):
        print(f"== by {kind} (t={args.threshold})")
        rows = sorted(((k, v) for k, v in groups.items() if k[0] == kind), key=lambda kv: -kv[1][0])
        for (_, name), (g, pr, c, n) in rows[:30]:
            if g:
                print(f"  {str(name)[:45]:45} docs {n:4} gold {g:5}  P {c / max(pr, 1):.3f} R {c / g:.3f} F1 {2 * c / (g + pr):.3f}")


if __name__ == "__main__":
    main()
