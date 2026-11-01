"""Where development's heading errors fall against the stylesheet's templates: a parse's labels against the gold's,
line by line, each line's template from the dump. For heading openings: how far each template's gold is one role
and one level (the ceiling a per-template decision reaches), how far the parse's reading of a template is
consistent, and the accuracy were each template made its gold majority's role and level, or its own reading's
majority. python template_errors.py DUMP_DIR LABELS_DIR"""
import json, os, sys
from collections import Counter, defaultdict
import numpy as np

dump, labels_dir = sys.argv[1:3]
HEADING = 3


def absolute(rows):
    """Each heading opening's level, the steps chained as gold_labels.py writes them (-1 elsewhere)."""
    out, current = [-1] * len(rows), 0
    for k, g in enumerate(rows):
        if g[2] == 1:
            current = 0
        if g[0] == HEADING and g[1] == 1:
            if g[4] < 0:
                current = 0
                continue
            current = int(np.clip(max(current, 1) + g[4] - 10, 1, 9))
            out[k] = current
    return out


t = Counter()
mixed_examples = []
for name in sorted(os.listdir(dump)):
    if not name.endswith(".json"):
        continue
    meta = json.load(open(os.path.join(dump, name), encoding="utf-8"))
    sha = meta["sha256"]
    lp = os.path.join(labels_dir, f"{sha}.labels.json")
    if not os.path.exists(lp):
        continue
    pred = json.load(open(lp, encoding="utf-8"))["labels"]
    gold = meta["gold"]
    tmpl = meta["templates"]
    if not (len(pred) == len(gold) == len(tmpl)):
        t["length mismatch"] += 1
        continue
    t["documents"] += 1
    known = [g[0] >= 0 for g in gold]
    gh = [g[0] == HEADING and g[1] == 1 for g in gold]
    ph = [p[0] == HEADING and p[1] == 1 for p in pred]
    gl, pl = absolute(gold), absolute(pred)
    # Heading openings, line by line.
    for k in range(len(gold)):
        if not known[k]:
            continue
        t["tp"] += gh[k] and ph[k]
        t["gold"] += gh[k]
        t["pred"] += ph[k]
        if gh[k] and gl[k] > 0:
            t["levelled"] += 1
            t["level right"] += ph[k] and pl[k] == gl[k]
    # Per template: the gold's roles and levels, the parse's.
    by = defaultdict(list)
    for k in range(len(gold)):
        if known[k]:
            by[tmpl[k]].append(k)
    for tid, ks in by.items():
        g_roles = Counter(gh[k] for k in ks)
        p_roles = Counter(ph[k] for k in ks)
        g_major, p_major = g_roles.most_common(1)[0][0], p_roles.most_common(1)[0][0]
        # Heading opening F1 were the template made its gold majority's role (the ceiling of a hard per-template role).
        for k in ks:
            t["tp role-oracle"] += g_major and gh[k]
            t["pred role-oracle"] += g_major
            t["tp role-self"] += p_major and gh[k]
            t["pred role-self"] += p_major
        heads = [k for k in ks if gh[k] and gl[k] > 0]
        if not heads:
            continue
        g_levels = Counter(gl[k] for k in heads)
        g_level, g_n = g_levels.most_common(1)[0]
        t["levelled in templates"] += len(heads)
        t["level template-oracle"] += g_n
        t["templates with headings"] += 1
        t["templates one gold level"] += len(g_levels) == 1
        if len(g_levels) > 1 and len(mixed_examples) < 12:
            mixed_examples.append((sha[:10], tid, dict(g_levels), len(heads)))
        p_levels = Counter(pl[k] for k in heads if ph[k])
        if p_levels:
            p_level = p_levels.most_common(1)[0][0]
            t["level template-self"] += sum(1 for k in heads if ph[k] and p_level == gl[k])
            t["templates parse one level"] += len(p_levels) == 1
            t["templates parse right level"] += p_level == g_level
        # The errors: a heading the parse made at the wrong level, where the template's gold is one level.
        for k in heads:
            if ph[k] and pl[k] != gl[k]:
                kind = "template one gold level" if len(g_levels) == 1 else "template mixed gold levels"
                t["wrong level: " + kind] += 1
                t["wrong level by offset %+d" % (pl[k] - gl[k])] += 1


def f1(tp, gold, pred):
    p, r = tp / max(pred, 1), tp / max(gold, 1)
    return f"P {p:.3f} R {r:.3f} F1 {2 * p * r / max(p + r, 1e-9):.3f}"


print(f"{t['documents']} documents ({t['length mismatch']} with mismatched lengths)")
print("heading openings, the parse:", f1(t["tp"], t["gold"], t["pred"]), f"({t['gold']} gold)")
print("  each template its gold majority's role:", f1(t["tp role-oracle"], t["gold"], t["pred role-oracle"]))
print("  each template its own reading's majority role:", f1(t["tp role-self"], t["gold"], t["pred role-self"]))
print(f"heading levels (absolute, gold heading openings with a level, the parse opening a heading there at that level): {t['level right'] / max(t['levelled'], 1):.3f} over {t['levelled']}")
print(f"  each template its gold majority's level: {t['level template-oracle'] / max(t['levelled in templates'], 1):.3f}")
print(f"  each template its own reading's majority level: {t['level template-self'] / max(t['levelled in templates'], 1):.3f}")
print(f"templates holding headings {t['templates with headings']}: one gold level {t['templates one gold level']}, the parse one level {t['templates parse one level']}, the parse's majority the gold's {t['templates parse right level']}")
for key in sorted(k for k in t if k.startswith("wrong level")):
    print(f"  {key}: {t[key]}")
print("mixed-level templates (sha, template, gold levels, headings):")
for e in mixed_examples:
    print("  ", e)
