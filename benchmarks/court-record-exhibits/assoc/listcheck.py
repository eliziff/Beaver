"""How many of the 51 itemless list-group cases (list51.json, from the v4 run) a new refs.py output makes
matchable: the gold label now has an item of its own (differs from every sibling's), and whether that
item points at the right file (its TF-IDF cosine to its own gold file beats the siblings' gold files).

Usage: python listcheck.py <inputs json> [--show]
"""
import json, os, re, sys
from common import HERE
from feats2 import tfidf_pair

recs = {r["record"]: r for r in json.load(open(os.path.join(HERE, sys.argv[1]), encoding="utf-8"))}
cases = json.load(open(os.path.join(HERE, "list51.json")))
own = right = 0
for rid, g, f in cases:
    r = recs[rid]; C = r["ctx"]; c = C[g]
    gold = {l: next((i for i, x in enumerate(r["files"]) if r["truth"][x] == l), None) for l in r["labels"]}
    sibs = [l for l in r["labels"] if l != g and C[l]["main"] == c["main"] and C[l]["group_size"] > 1] if c["group_size"] > 1 else []
    has = bool(c["item"]) and all(C[l]["item"] != c["item"] for l in sibs)
    ok = False
    if has:
        own += 1
        cand = [g] + [l for l in sibs if gold[l] is not None]
        m = tfidf_pair([c["item"].split(" | ")[0]], [r["texts"][gold[l]][:3000] for l in cand])[0]
        ok = m.argmax() == 0 and (len(cand) == 1 or m[0] > sorted(m)[-2])
        right += ok
    if "--show" in sys.argv:
        print(f"[{rid}] {g} {'own' if has else '---'} {'RIGHT' if ok else ''}: {c['item'][:160]!r}")
print(f"{len(cases)} cases: own item {own}, item points at the gold file among its siblings' {right}")
