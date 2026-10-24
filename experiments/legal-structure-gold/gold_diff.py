"""Where two authorings of the same documents disagree, line by line (CONVENTIONS section 7).

Both stores hold golds of the same sources over the same extracted lines, so each typed line is keyed
by where it starts in the source (line id and offset) and compared on its region, whether it starts a
unit, whether it carries a marker, and, between consecutive headings both authorings share, whether
the level steps in, out or holds. The confusions are tallied by genre with examples, which is what a
convention fix is written from.

python gold_diff.py STORE_A STORE_B MANIFEST [--examples N] [--genre G]
"""
import gzip
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def flat(text):
    return " ".join(text.replace("\t", " ").split())


def lines_of(gold):
    """{(line id, offset): (region, starts a unit, marked, unit index, text)} and each unit's level."""
    unit_of = {t: u for u, unit in enumerate(gold["units"]) for t in unit["lines"]}
    found = {}
    for t, line in enumerate(gold["typed"]):
        if not line.get("spans"):
            continue
        span = line["spans"][0]
        u = unit_of.get(t)
        first = u is not None and gold["units"][u]["lines"][0] == t
        found[(span["line_id"], span["start"])] = (line["region"], first, bool(line.get("markers")) and first, u, flat(line["text"]))
    levels = [unit.get("level") for unit in gold["units"]]
    return found, levels


def steps(found, levels, keys):
    """The level step from each shared heading start to the next one, in source order."""
    starts = [k for k in keys if found[k][0] == "heading" and found[k][1]]
    result = {}
    for a, b in zip(starts, starts[1:]):
        la, lb = levels[found[a][3]], levels[found[b][3]]
        if la is not None and lb is not None:
            result[b] = "in" if lb > la else "out" if lb < la else "same"
    return result


def main(argv):
    store_a, store_b, manifest = Path(argv[0]), Path(argv[1]), json.loads(Path(argv[2]).read_text(encoding="utf-8"))
    shown = int(argv[argv.index("--examples") + 1]) if "--examples" in argv else 3
    only = argv[argv.index("--genre") + 1] if "--genre" in argv else None
    regions, starts, marks, level_steps = defaultdict(Counter), defaultdict(Counter), defaultdict(Counter), defaultdict(Counter)
    examples = defaultdict(list)
    coverage = Counter()
    for row in manifest["documents"]:
        sha, genre = row["sha256"], row.get("genre_group", "?")
        if only and genre != only:
            continue
        paths = [store / "v4" / sha / "gold.json.gz" for store in (store_a, store_b)]
        if not all(p.is_file() for p in paths):
            coverage["missing"] += 1
            continue
        (a, la), (b, lb) = (lines_of(load(p)) for p in paths)
        shared = [k for k in a if k in b]
        coverage["documents"] += 1
        coverage["lines in both"] += len(shared)
        coverage["lines in one only"] += len(set(a) ^ set(b))
        for k in shared:
            ra, rb = a[k][0], b[k][0]
            regions[genre][(ra, rb)] += 1
            if ra != rb and len(examples[(genre, "region", ra, rb)]) < shown:
                examples[(genre, "region", ra, rb)].append(f"{sha[:10]} {a[k][4][:100]}")
            if ra == rb:
                starts[genre][(a[k][1], b[k][1])] += 1
                if a[k][1] != b[k][1] and len(examples[(genre, "start", ra, a[k][1])]) < shown:
                    examples[(genre, "start", ra, a[k][1])].append(f"{sha[:10]} {a[k][4][:100]}")
                if a[k][1] and b[k][1]:
                    marks[genre][(a[k][2], b[k][2])] += 1
                    if a[k][2] != b[k][2] and len(examples[(genre, "marker", ra, a[k][2])]) < shown:
                        examples[(genre, "marker", ra, a[k][2])].append(f"{sha[:10]} {a[k][4][:100]}")
        sa, sb = steps(a, la, shared), steps(b, lb, shared)
        for k in set(sa) & set(sb):
            level_steps[genre][(sa[k], sb[k])] += 1
            if sa[k] != sb[k] and len(examples[(genre, "level", sa[k], sb[k])]) < shown:
                examples[(genre, "level", sa[k], sb[k])].append(f"{sha[:10]} {a[k][4][:100]}")
    print(dict(coverage))
    for genre in sorted(regions):
        r = regions[genre]
        total, same = sum(r.values()), sum(n for (x, y), n in r.items() if x == y)
        s, m, l = starts[genre], marks[genre], level_steps[genre]
        agree = lambda c: sum(n for (x, y), n in c.items() if x == y) / max(1, sum(c.values()))
        print(f"\n== {genre}: lines {total}, region agree {same / max(1, total):.3f}, unit starts {agree(s):.3f}, "
              f"markers {agree(m):.3f}, heading steps {agree(l):.3f} (n={sum(l.values())})")
        for (x, y), n in sorted(((k, n) for k, n in r.items() if k[0] != k[1]), key=lambda kv: -kv[1])[:8]:
            print(f"   region {x:>13} vs {y:<13} {n:6}")
            for e in examples[(genre, "region", x, y)]:
                print(f"          {e}")
        for (x, y), n in sorted(((k, n) for k, n in l.items() if k[0] != k[1]), key=lambda kv: -kv[1])[:3]:
            print(f"   level step {x:>4} vs {y:<4} {n:6}")
            for e in examples[(genre, "level", x, y)]:
                print(f"          {e}")
        for key in sorted(k for k in examples if k[0] == genre and k[1] in ("start", "marker")):
            print(f"   {key[1]} differs on {key[2]} (a says {key[3]}): " + " | ".join(examples[key][:2]))


if __name__ == "__main__":
    main(sys.argv[1:])
