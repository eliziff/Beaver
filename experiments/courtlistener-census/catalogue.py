"""One discovery round: everything the sampled opinions encode, and what of it is not yet catalogued.

    python -I catalogue.py LEDGER_DB CL_DB SAMPLE_DIR ROUND

For every sampled opinion (SAMPLE_DIR/<id>/, from sample_head.py) and its cluster's text fields
(from CL_DB's opinion_clusters), per rendition or field:
  markup  every element name, class, attribute name, and the shape of id/label/href/name/type-like
          attribute values (letters -> a/A, digits -> 9), from a real HTML parser;
  lines   every line shape that repeats 3+ times within the text (running heads, footers, page
          numbers), digits -> 9.
Counts go to `vocab` (key, opinions, occurrences, round) and up to 3 examples per key to `example`
(opinion, court, year, 400 characters of source around it). Keys absent from `catalogue` are this
round's new items (`fresh`), for reading. Nothing here decides what anything means.
"""
import json
import os
import re
import sys
from collections import defaultdict
from html.parser import HTMLParser
import duckdb

CLUSTER_TEXT = ["judges", "attorneys", "syllabus", "headnotes", "summary", "disposition", "history", "other_dates",
                "cross_reference", "correction", "procedural_history", "posture", "arguments", "headmatter", "nature_of_suit"]
VALUE_ATTRS = re.compile(r"^(id|label|href|name|type|data-.*|pgmap|citation-index|pagescheme|number|num|class)$")


def shape(v, n=24):
    v = re.sub(r"[A-Z]+", "A", re.sub(r"[a-z]+", "a", re.sub(r"\d+", "9", v)))
    v = re.sub(r"(?:[aA][-_ ])+[aA]\b", "a*", v)  # a run of words (a slug, a name) is one shape
    return re.sub(r"\s+", " ", v)[:n]


class Vocab(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.text, self.keys = text, []
        self.line_starts = [0] + [m.end() for m in re.finditer("\n", text)]
        self.pre_depth, self.pre_text = 0, []

    def handle_endtag(self, tag):
        if tag == "pre" and self.pre_depth:
            self.pre_depth -= 1
            self.pre_text.append("\n")

    def handle_data(self, data):
        if self.pre_depth:
            self.pre_text.append(data)

    def handle_starttag(self, tag, attrs):
        line, col = self.getpos()
        at = self.line_starts[line - 1] + col
        if tag == "pre":
            self.pre_depth += 1
        self.keys.append((f"tag:{tag}", at))
        for a, v in attrs:
            self.keys.append((f"attr:{tag}@{a}", at))
            if a == "class" and v:
                for c in v.split():
                    self.keys.append((f"class:{tag}.{c}", at))
            elif v is not None and VALUE_ATTRS.match(a):
                self.keys.append((f"value:{tag}@{a}={shape(v)}", at))


def markup_keys(text):
    """Markup vocabulary, plus repeated lines of any <pre> text (court PDFs carried as preformatted text)."""
    p = Vocab(text)
    try:
        p.feed(text)
        p.close()
    except Exception as e:  # a malformed document still yields what parsed
        p.keys.append((f"parse-error:{type(e).__name__}", 0))
    pre = "".join(p.pre_text)
    return p.keys + ([(k, 0) for k, _ in line_keys(pre)] if pre.strip() else [])


def line_keys(text):
    """Lines that repeat 3+ times within the text, words kept and only digits collapsed, so a running
    head, page footer, stamp or caption separator repeats exactly and reads as itself."""
    counts, first = defaultdict(int), {}
    pos = 0
    for line in text.split("\n"):
        s = line.strip()
        if s:
            k = re.sub(r"\s+", " ", re.sub(r"\d+", "9", s))[:80]
            counts[k] += 1
            first.setdefault(k, pos)
        pos += len(line) + 1
    return [(f"repeat:{k}", first[k]) for k, n in counts.items() if n >= 3]


def is_markup(text):
    return bool(re.search(r"<[A-Za-z][^>]{0,200}>", text[:5000]))


def main():
    ledger_path, cl_path, sample_dir, rnd = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    con = duckdb.connect(ledger_path)
    ids = [i for i in sorted(os.listdir(sample_dir)) if os.path.isfile(os.path.join(sample_dir, i, "fields.json"))]
    fields = {i: json.load(open(os.path.join(sample_dir, i, "fields.json"), encoding="utf-8")) for i in ids}
    clusters = {}
    if cl_path != "-":  # "-": the opinions' own renditions only
        con.execute(f"ATTACH '{cl_path}' AS cl (READ_ONLY)")
        cl_ids = sorted({int(f["cluster_id"]) for f in fields.values()})
        cols = ", ".join(["id", "source", "date_filed"] + CLUSTER_TEXT)
        for row in con.execute(f"SELECT {cols} FROM cl.opinion_clusters WHERE id IN (SELECT unnest(?))", [cl_ids]).fetchall():
            clusters[row[0]] = dict(zip(["id", "source", "date_filed"] + CLUSTER_TEXT, row))

    occ, opinions, examples = defaultdict(int), defaultdict(set), defaultdict(list)
    for i in ids:
        cl = clusters.get(int(fields[i]["cluster_id"]), {})
        year = (cl.get("date_filed") or "")[:4]
        texts = {}
        for name in os.listdir(os.path.join(sample_dir, i)):
            if name != "fields.json":
                texts[os.path.splitext(name)[0]] = open(os.path.join(sample_dir, i, name), encoding="utf-8").read()
        for f in CLUSTER_TEXT:
            if cl.get(f):
                texts[f"cluster.{f}"] = cl[f]
        for rend, text in texts.items():
            keys = markup_keys(text) if is_markup(text) else line_keys(text)
            for k, at in keys:
                key = f"{rend}|{k}"
                occ[key] += 1
                if i not in opinions[key]:
                    opinions[key].add(i)
                    if len(examples[key]) < 3:
                        examples[key].append((int(i), cl.get("source"), year, text[max(0, at - 100):at + 300]))

    con.execute("CREATE TABLE IF NOT EXISTS vocab (key VARCHAR, round INTEGER, opinions INTEGER, occurrences INTEGER)")
    con.execute("CREATE TABLE IF NOT EXISTS example (key VARCHAR, round INTEGER, id BIGINT, cluster_source VARCHAR, year VARCHAR, snippet VARCHAR)")
    con.execute("CREATE TABLE IF NOT EXISTS catalogue (key VARCHAR, round INTEGER, model VARCHAR, meaning VARCHAR, verdict VARCHAR)")
    con.execute("DELETE FROM vocab WHERE round = ?", [rnd]); con.execute("DELETE FROM example WHERE round = ?", [rnd])
    con.executemany("INSERT INTO vocab VALUES (?, ?, ?, ?)", [(k, rnd, len(opinions[k]), occ[k]) for k in occ])
    con.executemany("INSERT INTO example VALUES (?, ?, ?, ?, ?, ?)", [(k, rnd, *e) for k, ex in examples.items() for e in ex])
    con.execute("CREATE OR REPLACE VIEW fresh AS SELECT v.* FROM vocab v WHERE v.round = (SELECT max(round) FROM vocab) "
                "AND v.key NOT IN (SELECT key FROM catalogue)")
    fresh = con.execute("SELECT count(*) FROM fresh").fetchone()[0]
    print(json.dumps({"round": rnd, "opinions": len(ids), "clusters_found": len(clusters), "keys": len(occ), "fresh": fresh}))


main()
