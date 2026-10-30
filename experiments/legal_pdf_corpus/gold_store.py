"""The gold store: one folder, registered in the corpus SQLite, read only through here.

benchmarks/local-data/gold (the private gold repository; OPENLEGAL_GOLD names another copy, such as a
worker machine's) holds one folder per source PDF, named by its sha256:

  source.json                     the source itself: {partition (train, development or test: the one
                                  partition every model trained or graded on the gold uses, shared by
                                  the source's family of related documents), language_layout,
                                  genre_group, country, yardstick, label_source, pdf (its path in the
                                  corpus home)}
  split.json                      the source's split annotation: {sha256, pages, document_starts
                                  (pages, or {page, line_id, text} starts partway down one),
                                  origin, evidence}; the one record of where its documents start
  split/<origin>/                 what that annotation came from (the splitter's calls and receipt)
  structure/<batch>-<run>/        a structure gold (gold.json.gz, receipt.json, calls.jsonl.gz);
                                  run "a" is the source's current gold, other runs are agreement
                                  and model trials
  structure/archive/              earlier revisions kept outside git

batches/<batch>/ keeps each authoring batch's manifests and launchers: provenance, never a
convention, and never read for a partition. The source PDFs are in the corpus (corpus.sqlite
`files`); git keeps every earlier version of the store. The grader (experiments/legal-structure-gold/
grade) reads the store's folders directly, so a worker machine grades and trains on a checkout of
this same repository, never on a copy laid out another way.

register() records the store in corpus.sqlite: one gold_records row per source and kind
(`gold/structure`, `gold/split`), its runs in gold_runs and their files, with hashes, in
gold_artifacts. sources() and the helpers read it back, checking each file against its hash.

  python experiments/legal_pdf_corpus/gold_store.py register
"""
import argparse
from contextlib import closing
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import corpus_store  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
ROOT = Path(os.environ.get("OPENLEGAL_GOLD", REPO / "benchmarks" / "local-data" / "gold"))
STRUCTURE, SPLIT = "gold/structure", "gold/split"
# The datasets the store replaces: the split registry's origins and its archive.
RETIRED = ("page-stream-segmentation/%",)
CURRENT_RUN = "a"
PARTITIONS = ("train", "development", "test")
# What a machine makes while authoring or grading the store (page images, calls, extraction caches,
# inputs, grades) stays on that machine, beside the corpus home, never in the store.
WORK = corpus_store.HOME / "gold-work"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    raw = Path(path).read_bytes()
    return json.loads(gzip.decompress(raw) if str(path).endswith(".gz") else raw)


def structure_runs(folder):
    """The source's structure gold runs, its current run (run "a") first."""
    runs = [p for p in (folder / "structure").glob("*-*") if (p / "gold.json.gz").is_file()]
    return sorted(runs, key=lambda p: (p.name.split("-", 1)[1] != CURRENT_RUN, p.name))


def register():
    folders = sorted(p for p in ROOT.iterdir() if re.fullmatch(r"[0-9a-f]{64}", p.name))
    with closing(corpus_store.connect()) as db, db:
        missing = [p.name for p in folders if db.execute("select 1 from files where sha256=?", (p.name,)).fetchone() is None]
        if missing:
            raise ValueError(f"{len(missing)} gold sources are not in the corpus file index: {missing[:3]}")
        unpartitioned = [p.name for p in folders if source(p.name).get("partition") not in PARTITIONS]
        if unpartitioned:
            raise ValueError(f"{len(unpartitioned)} gold sources have no partition in source.json: {unpartitioned[:3]}")
        for pattern in RETIRED + (STRUCTURE, SPLIT):
            runs = [r for (r,) in db.execute("select run_id from gold_runs where dataset like ?", (pattern,))]
            db.executemany("delete from gold_artifacts where run_id=?", [(r,) for r in runs])
            for table in ("gold_runs", "gold_records", "gold_memberships"):
                db.execute(f"delete from {table} where dataset like ?", (pattern,))
        counts = {STRUCTURE: 0, SPLIT: 0}
        for folder in folders:
            sha, pages = folder.name, db.execute("select pages from files where sha256=?", (folder.name,)).fetchone()[0]
            runs = structure_runs(folder)
            for k, run in enumerate(runs):
                receipt = run / "receipt.json"
                authored = read(receipt) if receipt.is_file() else {}
                run_id = f"{STRUCTURE}:{sha}:{run.name}"
                db.execute("insert into gold_runs values (?,?,?,?,?,?,?,?)", (run_id, STRUCTURE, sha, "complete",
                           str(receipt) if receipt.is_file() else None, digest(receipt) if receipt.is_file() else None,
                           authored.get("started_at"), authored.get("finished_at")))
                for role, name in (("gold", "gold.json.gz"), ("receipt", "receipt.json"), ("calls", "calls.jsonl.gz")):
                    if (run / name).is_file():
                        db.execute("insert into gold_artifacts values (?,?,?,?)", (run_id, role, str(run / name), digest(run / name)))
                if k == 0:
                    db.execute("insert into gold_records values (?,?,?,?,?,?)", (STRUCTURE, sha, authored.get("mode"), pages, "complete", run_id))
                    counts[STRUCTURE] += 1
            split = folder / "split.json"
            if split.is_file():
                run_id = f"{SPLIT}:{sha}"
                db.execute("insert into gold_runs values (?,?,?,?,?,?,?,?)", (run_id, SPLIT, sha, "complete", None, None, None, None))
                db.execute("insert into gold_artifacts values (?,?,?,?)", (run_id, "gold", str(split), digest(split)))
                db.execute("insert into gold_records values (?,?,?,?,?,?)", (SPLIT, sha, None, pages, "complete", run_id))
                counts[SPLIT] += 1
    return counts


def sources(kind):
    """[(sha256, path of its current gold)] for a kind (STRUCTURE or SPLIT), each file checked against its hash."""
    with closing(corpus_store.connect()) as db:
        rows = db.execute("select r.sha256, a.path, a.sha256 from gold_records r join gold_artifacts a"
                          " on a.run_id=r.run_id and a.role='gold' where r.dataset=? and r.status='complete' order by r.sha256",
                          (kind,)).fetchall()
    out = []
    for sha, path, expected in rows:
        if digest(Path(path)) != expected:
            raise ValueError(f"Registered gold changed since registration: {path}")
        out.append((sha, Path(path)))
    return out


def source(sha):
    """A source's source.json (its partition, groups and corpus path), or {} where it has none."""
    path = ROOT / sha / "source.json"
    return read(path) if path.is_file() else {}


def splits():
    """{sha256: split annotation} for every source in the store's folder (a worker reads its copy of
    the folder; the registry indexes the same files)."""
    return {p.parent.name: read(p) for p in ROOT.glob("*/split.json")}


def split_of(sha):
    """A source's split annotation, or None where the store has none."""
    path = ROOT / sha / "split.json"
    return read(path) if path.is_file() else None


def split_sources(origin=None):
    """[(sha256, split annotation, its folder, path of its current structure gold or None)] for the
    registered splits, of one origin (splitter, b7-splitter, reference, structure-gold) or all."""
    structure = dict(sources(STRUCTURE))
    out = []
    for sha, path in sources(SPLIT):
        split = read(path)
        if origin is None or split["origin"] == origin:
            out.append((sha, split, path.parent, structure.get(sha)))
    return out


def pdf(sha):
    """The source PDF's path in the corpus."""
    with closing(corpus_store.connect()) as db:
        row = db.execute("select path from files where sha256=?", (sha,)).fetchone()
    if row is None:
        raise ValueError("Source is not in the corpus file index: " + sha)
    return corpus_store.HOME / row[0]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("register",))
    parser.parse_args()
    print(json.dumps(register()))
