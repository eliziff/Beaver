"""Data groups for every gold source (CONVENTIONS.md section 4): language layout read from the
gold's own typed text, genre group and yardstick from provenance. Recorded in the corpus store and
carried in the cohort manifest so the scorer reports each group on its own.

  python groups.py detect GOLD_DIR PROVENANCE.json --out groups.json     where the gold files are
  python groups.py apply groups.json MANIFEST.json [--sqlite]             write manifest fields (and the store)

`detect` reads v4/<sha>/gold.json.gz for language, label source (`label_source` in the gold:
"a2aj-silver" for silver labelled from A2AJ's text, else "model") and blank form fields, and
provenance.json for the rest.
`apply` rewrites the manifest's documents in place with language_layout, genre_group, country,
yardstick and label_source, and with --sqlite upserts corpus.sqlite's gold_source_groups.
"""
import argparse
import gzip
import json
import re
import sys
import time
from pathlib import Path

FRENCH = re.compile(r"\b(le|la|les|des|du|une|est|sont|aux|dans|pour|qui|sur|par|au|ou|et|de)\b|[éèêàçùâîô]", re.I)
ENGLISH = re.compile(r"\b(the|of|and|to|in|is|for|that|by|with|or|any|shall|under|be|on|a)\b", re.I)
RANKED = {"text", "list_item", "heading", "quote", "table", "caption", "headnote"}

GENRE_GROUPS = {
    "judgment": {"judgment", "ruling", "decision", "reasons", "opinion", "judgement"},
    "legislation": {"statute_compilation", "statute", "act", "regulation", "rules_or_regulations", "municipal_bylaw",
                    "bylaw", "ordinance", "legislation", "code"},
    "court-rules": {"court-rules", "practice_note", "practice_direction", "directive", "directions", "protocol",
                    "court_rules", "rules"},
    "filing": {"affidavit", "application", "notice", "order", "motion", "legal_submission", "factum", "brief",
               "complaint", "defence", "defense", "pleading", "summons", "subpoena", "certificate", "memorandum",
               "witness_statement", "petition", "claim", "statement_of_claim", "response", "reply", "declaration",
               "consent", "undertaking", "warrant", "endorsement", "judgment_form"},
    "contract": {"contract", "lease", "agreement", "licence", "license", "deed", "mortgage", "guarantee",
                 "indenture", "offer", "settlement"},
    "transcript": {"transcript", "questioning", "examination", "deposition", "cross_examination"},
    "publication": {"evaluation_report", "briefing_note", "policy_document", "report", "monograph", "article",
                    "guide", "manual", "handbook", "paper", "study", "review", "annual_report", "commission_report",
                    "legal_monograph"},
    "compilation": {"book-of-authorities", "case_record", "evidence_record", "exhibit", "court-record-exhibit",
                    "record", "appeal_book", "bundle"},
    "court-form": {"court_form", "form", "court-form", "template"},
    "administrative": {"agenda", "email_record", "correspondence", "presentation", "minutes", "letter", "email",
                       "schedule", "calendar", "invoice", "receipt"},
}
MAIN_GENRES = {"judgment", "legislation", "court-rules", "filing", "contract", "transcript", "publication", "compilation"}


def genre_group(genre, source_family=None):
    g = (genre or "").strip().lower().replace(" ", "_").replace("-", "_")
    # A court-forms collection is forms whatever the form was filled in as.
    if "form" in (source_family or "").lower() and g not in {"judgment", "ruling", "decision", "statute_compilation", "court-rules", "court_rules"}:
        return "court-form"
    for group, names in GENRE_GROUPS.items():
        if g in {n.replace("-", "_") for n in names}:
            return group
    family = (source_family or "").lower()
    if "form" in family:
        return "court-form"
    if "exhibit" in family or "record" in family:
        return "compilation"
    return "other"


def blank_form(gold):
    """A document whose lines carry a blank to fill in ("DATED ____", "CACV ________") on every
    page on average, four or more of them: a form, whatever the collection called it."""
    lines = gold.get("lines", [])
    pages = max((line.get("page", 0) for line in lines), default=0) + 1
    blanks = sum(1 for line in lines if "____" in line.get("text", ""))
    return blanks >= 4 and blanks >= pages


def language_layout(gold):
    units = [t for t in gold["typed"] if t.get("start") and t["region"] in RANKED]
    fr = en = 0
    for t in units:
        text = t.get("text", "")
        f, e = len(FRENCH.findall(text)), len(ENGLISH.findall(text))
        fr += f > e
        en += e > f
    n = len(units) or 1
    if fr / n >= 0.25 and en / n >= 0.25:
        return "parallel"
    if fr > en:
        return "fr" if en / n < 0.1 else "mixed"
    return "en" if fr / n < 0.1 else "mixed"


def yardstick(country, layout, group, source_family=None):
    """The main yardstick is Canadian contracts, judgments, filings, legislation, court rules, publications and
    compilations in one language. Transcripts (one 291-page questioning holds a third of the development set's
    parent pairs) and microfiche scans (the Canadiana legal monographs, whose recognition is unreadable) are
    reported as groups of their own, so the main number describes the documents the parser is for."""
    if layout == "parallel":
        return "bilingual"
    if group == "court-form":
        return "forms"
    if country != "ca":
        return "foreign"
    if "canadiana" in (source_family or "").lower():
        return "microfiche"
    if "synthetic" in (source_family or "").lower():
        return "synthetic"
    if group == "transcript":
        return "transcript"
    if group in MAIN_GENRES and layout in ("en", "fr"):
        return "main"
    return "other"


def records(provenance):
    rows = provenance["records"] if "records" in provenance else provenance
    return list(rows.values()) if isinstance(rows, dict) else rows


def detect(args):
    provenance = json.loads(Path(args.provenance).read_text(encoding="utf-8"))
    info = {r["sha256"]: r for r in records(provenance)}
    out = {}
    missing = 0
    for job in sorted(Path(args.gold).joinpath("v4").iterdir()):
        path = job / "gold.json.gz"
        if not path.is_file():
            continue
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            gold = json.load(stream)
        sha = gold["source_sha256"]
        r = info.get(sha)
        if r is None:
            missing += 1
        r = r or {}
        layout = language_layout(gold)
        group = genre_group(r.get("genre"), r.get("source_family"))
        if blank_form(gold):
            group = "court-form"
        country = (r.get("country") or "unknown").lower()
        out[sha] = {"language_layout": layout, "genre_group": group, "country": country,
                    "yardstick": yardstick(country, layout, group, r.get("source_family")), "label_source": label_source(gold), "genre": r.get("genre"),
                    "source_family": r.get("source_family"), "mode": gold.get("mode"), "split": r.get("split")}
    Path(args.out).write_text(json.dumps({"detected_at": time.time(), "sources": out}, indent=1), encoding="utf-8")
    from collections import Counter
    print(f"{len(out)} sources ({missing} without provenance) -> {args.out}")
    for field in ("yardstick", "language_layout", "genre_group", "country", "label_source"):
        print(f"  {field}: {dict(Counter(v[field] for v in out.values()).most_common())}")
    print("  main by genre_group:", dict(Counter(v["genre_group"] for v in out.values() if v["yardstick"] == "main").most_common()))
    print("  main by mode:", dict(Counter(v["mode"] for v in out.values() if v["yardstick"] == "main").most_common()))
    print("  main by split:", dict(Counter(v["split"] for v in out.values() if v["yardstick"] == "main").most_common()))


FIELDS = ("language_layout", "genre_group", "country", "yardstick", "label_source")


def label_source(gold):
    """Where the gold's labels come from: "a2aj-silver" (aligned from A2AJ's text) or "model"."""
    return gold.get("label_source") or gold.get("authoring", {}).get("label_source") or "model"


def apply(args):
    groups = json.loads(Path(args.groups).read_text(encoding="utf-8"))["sources"]
    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    changed = absent = 0
    for row in manifest["documents"]:
        g = groups.get(row["sha256"])
        if g is None:
            absent += 1
            continue
        for field in FIELDS:
            if field in g and row.get(field) != g[field]:
                row[field] = g[field]
                changed += 1
    manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"{manifest_path}: {changed} fields written, {absent} documents without groups")
    if args.sqlite:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "legal_pdf_corpus"))
        import corpus_store  # noqa: E402
        db = corpus_store.connect()
        db.execute("""create table if not exists gold_source_groups(
            dataset text, sha256 text references files(sha256), language_layout text, genre_group text,
            country text, yardstick text, genre text, source_family text, recorded_at text,
            primary key(dataset, sha256))""")
        if "label_source" not in {row[1] for row in db.execute("pragma table_info(gold_source_groups)")}:
            db.execute("alter table gold_source_groups add column label_source text")
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        for sha, g in groups.items():
            db.execute("""insert or replace into gold_source_groups(dataset, sha256, language_layout, genre_group, country,
                yardstick, genre, source_family, recorded_at, label_source) values(?,?,?,?,?,?,?,?,?,?)""",
                       (args.dataset, sha, g["language_layout"], g["genre_group"], g["country"], g["yardstick"],
                        g.get("genre"), g.get("source_family"), now, g.get("label_source", "model")))
        db.commit()
        print(f"gold_source_groups: {len(groups)} rows for dataset {args.dataset}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    d = sub.add_parser("detect")
    d.add_argument("gold")
    d.add_argument("provenance")
    d.add_argument("--out", required=True)
    d.set_defaults(run=detect)
    a = sub.add_parser("apply")
    a.add_argument("groups")
    a.add_argument("manifest")
    a.add_argument("--sqlite", action="store_true")
    a.add_argument("--dataset", default="legal-structure-gold.v4")
    a.set_defaults(run=apply)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
