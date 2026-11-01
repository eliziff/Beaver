"""What a dump's stylesheet read of each document: the lines the outline anchors (with level), the templates that
may be headings with their level, share read as headings by the local scores, line count and a sample text, and
how many of the gold's headings fall in those templates. python sheet_peek.py DUMP_DIR [SHA_PREFIX...]"""
import collections, json, os, sys
import numpy as np
folder, wanted = sys.argv[1], sys.argv[2:]
for name in sorted(os.listdir(folder)):
    if not name.endswith(".json") or (wanted and not any(name.startswith(w) for w in wanted)):
        continue
    meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
    rows = np.fromfile(os.path.join(folder, f"{meta['sha256']}.moves.f32"), dtype="<f4").reshape(-1, meta["move_width"])
    names = meta["candidate_features"]
    col = lambda n: 2 + names.index(n)
    lines = np.asarray(meta["move_lines"])
    first = {}
    for r, k in enumerate(lines.tolist()):
        first.setdefault(k, r)
    texts, templates, anchors, gold = meta["texts"], meta["templates"], meta["anchors"], meta["gold"]
    print(f"== {meta['sha256'][:8]}: {meta['lines']} lines, {len(set(templates))} templates, {sum(1 for a in anchors if a)} lines anchored")
    for k, a in enumerate(anchors):
        if a:
            print(f"   anchor level {a}: {texts[k][:70]!r} (gold region {gold[k][0]})")
    by_template = collections.defaultdict(list)
    for k, t in enumerate(templates):
        by_template[t].append(k)
    shown = []
    for t, ks in by_template.items():
        r = rows[first[ks[0]]]
        if r[col("template_level")] > 0:
            heads = sum(1 for k in ks if gold[k][0] == 3 and gold[k][1] == 1)
            shown.append((r[col("template_level")], t, len(ks), r[col("template_heading")], heads, texts[ks[0]][:50]))
    for level, t, n, p, heads, text in sorted(shown)[:14]:
        print(f"   template {t:4} level {level:.0f} lines {n:4} local heading {p:.2f} gold headings {heads:4} {text!r}")
    gold_heads = [k for k, g in enumerate(gold) if g[0] == 3 and g[1] == 1]
    covered = sum(1 for k in gold_heads if rows[first[k]][col("template_level")] > 0)
    print(f"   gold headings {len(gold_heads)}, in a levelled template {covered}")
