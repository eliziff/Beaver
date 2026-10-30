"""Machine-silver structure gold for Canadian judgments, labelled from A2AJ's text of the same decision.

Local PDFs only. Each PDF's neutral citation (read from its first pages by the engine's citation
reader) is looked up in the local A2AJ store; the parser's exported lines (author.py's export) are
aligned word by word with A2AJ's text, and A2AJ's structure reading labels them: the census node
listing (numbered paragraphs, quotations, lists, headings, notes and their references) and the
engine's case outline (heading labels, headings in the front matter, lines no node reads); the PDF
decides furniture, page numbers, set-apart quotations, bullets and heading levels (label.py).
Its units carry heading levels and no numbering levels, so no numbering levels are scored on it. A document is refused when under 90 percent of its body
lines are covered by A2AJ text, any numbered paragraph is not found, four or more consecutive body
lines are not in A2AJ, the PDF prints paragraph numbers A2AJ's text lacks, or A2AJ folds long end
matter (formal judgment, counsel, notes) into the last paragraph.

  python silver.py candidates [--wide] [--out FILE]   PDFs matched to A2AJ, with their screens
  python silver.py export [--jobs 2]            the parser's lines for every accepted candidate
  python silver.py label [--sha PREFIX]         align, gate and write STORE/<sha>/structure/silver-a/gold.json.gz + receipt.json
  python silver.py sources                      write each written silver's source.json (partition train, its groups);
                                                A2AJ-cache PDFs are first stored in the corpus store

The silver store (--store, default benchmarks/local-data/silver) has the gold store's folder layout
(experiments/legal_pdf_corpus/gold_store.py) and is never the gold store. Candidates, alignment
receipts and the parser's exports are kept in --work (default the gold work folder's silver-a2aj/).
LEGAL_STRUCTURE_ADDON defaults to MikeOSS Fork's release addon.
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLD_CODE = HERE.parent
sys.path[:0] = [str(HERE), str(GOLD_CODE), str(GOLD_CODE.parents[1] / "tools"), str(GOLD_CODE.parent / "legal_pdf_corpus")]
import align  # noqa: E402
import gold_store  # noqa: E402

STORE = GOLD_CODE.parents[1] / "benchmarks/local-data/silver"
RUN = "silver-a"
FRENCH = re.compile(r"\b(le|la|les|des|du|une|est|sont|aux|dans|pour|qui|sur|par|au|ou|et|de)\b|[éèêàçùâîô]", re.I)
ENGLISH = re.compile(r"\b(the|of|and|to|in|is|for|that|by|with|or|any|shall|under|be|on|a)\b", re.I)
ADDON = "C:/Users/elias/Desktop/MikeOSS Fork/native/legal-structure-node/target/release/legal_structure_node.dll"
DATA = Path(os.environ["LOCALAPPDATA"]) / "OpenLegalData"
A2AJ = DATA / "providers/a2aj/a2aj.sqlite"
CORPUS = DATA / "corpus/corpus.sqlite"
LISTING = DATA / "experiments/a2aj-structure/cases-stageH2.nodes.jsonl"
MAX_PAGES = 150
os.environ.setdefault("LEGAL_STRUCTURE_ADDON", ADDON)


def work(args):
    args.work.mkdir(parents=True, exist_ok=True)
    return args.work


def engine(op, texts):
    """The engine's reading of each text (engine.mjs)."""
    run = subprocess.run(["node", str(HERE / "engine.mjs")], input=json.dumps({"op": op, "texts": texts}, ensure_ascii=False),
                         capture_output=True, encoding="utf-8")
    if run.returncode: raise RuntimeError(run.stderr[-2000:])
    return json.loads(run.stdout)


JS_SPACE = "\t\n\v\f\r \u00a0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200b)) + "\u2028\u2029\u202f\u205f\u3000\ufeff"


def a2aj_text(row, language):
    """A document's text as the census read it (trimmed of JavaScript white space)."""
    text = row[f"unofficial_text_{language}"]
    return text.strip(JS_SPACE) if text else None


def a2aj_db():
    db = sqlite3.connect(f"file:{A2AJ}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def excluded(store):
    """sha256 of every source already in the gold store or the silver store."""
    return {p.name for root in (gold_store.ROOT, store) if root.is_dir() for p in root.iterdir() if len(p.name) == 64}


NAMED = {"legal-pdf", "misc", "reporter-recovery-books", "caselaw", "legal-pdf/pdfs"}


def local_pdfs(wide):
    """(path, collection, kind, label) for every local PDF the silver may come from: the corpus
    store's judgment collections (every corpus PDF and the A2AJ PDF cache with --wide)."""
    db = sqlite3.connect(f"file:{CORPUS}?mode=ro", uri=True)
    rows = db.execute("""select f.path, d.collection, d.kind, d.label from documents d join files f using(sha256)
        where lower(f.path) like '%.pdf' order by d.collection != 'legal-pdf', d.collection != 'misc', d.id""").fetchall()
    seen, out = set(), []
    for path, collection, kind, label in rows:
        if not wide and collection not in NAMED: continue
        if not wide and collection == "legal-pdf" and kind not in ("judgment", "ruling", "law_report", "decision", "reasons"): continue
        full = Path(path) if os.path.isabs(path) else DATA / path
        if full not in seen and full.is_file():
            seen.add(full); out.append((full, collection, kind, label))
    for full in sorted((DATA / "corpus/legal-pdf/pdfs").rglob("*.pdf")):
        if full not in seen:
            seen.add(full); out.append((full, "legal-pdf/pdfs", full.parent.name, full.name))
    if wide:
        for full in sorted((DATA / "cache/a2aj/pdf/blobs").glob("*.pdf")):
            if full not in seen:
                seen.add(full); out.append((full, "a2aj-pdf-cache", "judgment", full.name))
    return out


def first_text(item):
    """The first two pages' text, or why the PDF cannot be used."""
    import fitz
    try:
        with fitz.open(item[0]) as document:
            if len(document) > MAX_PAGES: return None, "over 150 pages"
            return "\n".join(document[p].get_text() for p in range(min(2, len(document)))), None
    except Exception as exc:
        return None, f"unreadable: {exc}"[:200]


def mode_of(document):
    """ocr when at least half of six sampled pages are mostly one image or carry no text, else
    digitalborn (the 2026-10-21 candidate round's check)."""
    import fitz
    n = len(document)
    sample = sorted({round(k * (n - 1) / 5) for k in range(6)}) if n > 1 else [0]
    scanned = 0
    for p in sample:
        page = document[p]
        area = page.rect.width * page.rect.height or 1
        big = max((abs(fitz.Rect(i["bbox"]) & page.rect) / area for i in page.get_image_info()), default=0)
        scanned += big >= 0.5 or len(page.get_text().strip()) < 20
    return "ocr" if scanned * 2 >= len(sample) else "digitalborn"


def layout_of(lines):
    """Language layout of text lines, by their French and English word counts."""
    fr = en = 0
    lines = [line for line in lines if len(line.split()) >= 4]
    for text in lines:
        f, e = len(FRENCH.findall(text)), len(ENGLISH.findall(text))
        fr += f > e; en += e > f
    n = len(lines) or 1
    if fr / n >= 0.25 and en / n >= 0.25: return "parallel"
    if fr > en: return "fr" if en / n < 0.1 else "mixed"
    return "en" if fr / n < 0.1 else "mixed"


def screen(record):
    """Hash, page count, text and mode of a PDF that cites an A2AJ case on its first pages."""
    import fitz
    try:
        data = Path(record["path"]).read_bytes()
        record["sha256"] = hashlib.sha256(data).hexdigest()
        with fitz.open(stream=data, filetype="pdf") as document:
            record["pages"] = len(document)
            record["text"] = "\n".join(page.get_text() for page in document)
            record["mode"] = mode_of(document)
    except Exception as exc:
        record["refused"] = f"unreadable: {exc}"[:200]
    return record


def candidates(args):
    out = work(args)
    skip = excluded(args.store)
    items = local_pdfs(args.wide)
    print(f"{len(items)} local PDFs", flush=True)
    with ThreadPoolExecutor(6) as pool: firsts = list(pool.map(first_text, items))
    records = [{"path": str(p), "collection": c, "kind": k, "label": label} for p, c, k, label in items]
    for r, (_, why) in zip(records, firsts):
        if why: r["refused"] = why
    live = [(r, text) for r, (text, _) in zip(records, firsts) if text is not None]
    found = engine("citations", [text for _, text in live])
    texts = sorted({c["text"] for cs in found if isinstance(cs, list) for c in cs if c.get("family") == "neutral"})
    keys = dict(zip(texts, engine("keys", texts))) if texts else {}
    db = a2aj_db()
    resolved = []
    for (r, _), cs in zip(live, found):
        cs = [c for c in (cs if isinstance(cs, list) else []) if c.get("family") == "neutral"]
        r["citations"] = list(dict.fromkeys(c["text"] for c in sorted(cs, key=lambda c: c["start"])))
        r["a2aj_documents"] = [doc for citation in r["citations"][:4] for (doc,) in db.execute(
            "select c.document_id from citation_lookup c join document d on d.id = c.document_id where c.citation_key = ? and d.doc_type = 'cases'",
            (keys.get(citation),))]
        if not r["citations"]: r["refused"] = "no neutral citation on the first pages"
        elif not r["a2aj_documents"]: r["refused"] = "no A2AJ case for its citations"
        else: resolved.append(r)
    print(f"{len(resolved)} cite an A2AJ case on their first pages", flush=True)
    with ThreadPoolExecutor(6) as pool: list(pool.map(screen, resolved))
    by_sha, dupes = {}, 0
    for r in records:
        if "sha256" in r and r["sha256"] in by_sha: r["refused"] = "duplicate of " + by_sha[r["sha256"]]["path"]; dupes += 1; continue
        if "sha256" in r: by_sha[r["sha256"]] = r
    for r in records:
        if "refused" not in r and r["sha256"] in skip: r["refused"] = "already in the gold store or the silver store"
    for r in records:
        if "refused" in r or "sha256" not in r: continue
        options, pdf_words = [], None
        for doc in dict.fromkeys(r["a2aj_documents"]):
            row = db.execute("select * from document where id = ?", (doc,)).fetchone()
            for language in ("en", "fr"):
                text = a2aj_text(row, language)
                if not text: continue
                pdf_words = pdf_words or [w for w, _, _ in align.words(r["text"])]
                pdf_in, a2aj_in = align.overlap(pdf_words, [w for w, _, _ in align.words(text)])
                options.append({"document_id": doc, "language": language, "citation": row[f"citation_{language}"] or row["citation_en"],
                                "dataset": row["dataset"], "name": row[f"name_{language}"] or row["name_en"] or row["name_fr"],
                                "pdf_in_a2aj": round(pdf_in, 4), "a2aj_in_pdf": round(a2aj_in, 4)})
        if not options: r["refused"] = "no A2AJ text for its citations"; continue
        best = max(options, key=lambda o: o["pdf_in_a2aj"] + o["a2aj_in_pdf"])
        r["a2aj"], r["options"] = best, len(options)
        r["layout"] = layout_of(r["text"].splitlines())
        if r["layout"] not in ("en", "fr"): r["refused"] = f"language layout {r['layout']}"
        elif best["pdf_in_a2aj"] < 0.5: r["refused"] = "PDF text is not A2AJ's text of the case"
    for r in records: r.pop("text", None)
    path = args.out or out / "candidates.json"
    path.write_text(json.dumps({"documents": records}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(records)} PDFs ({dupes} duplicate copies) -> {path}")
    print(" refused:", dict(Counter(r.get("refused", "accepted") for r in records).most_common()))
    accepted = [r for r in records if "refused" not in r]
    print(" accepted by collection:", dict(Counter(r["collection"] for r in accepted)), "mode:", dict(Counter(r["mode"] for r in accepted)),
          "language:", dict(Counter(r["a2aj"]["language"] for r in accepted)))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--store", type=Path, default=STORE, help="The silver store (never the gold store)")
    p.add_argument("--work", type=Path, default=gold_store.WORK / "silver-a2aj", help="Candidates, receipts and the parser's exports")
    sub = p.add_subparsers(dest="command", required=True)
    c = sub.add_parser("candidates"); c.add_argument("--out", type=Path)
    c.add_argument("--wide", action="store_true", help="every corpus PDF and the A2AJ PDF cache, not only the judgment collections")
    c.set_defaults(run=candidates)
    import stages
    e = sub.add_parser("export"); e.add_argument("--jobs", type=int, default=2); e.set_defaults(run=stages.export)
    lab = sub.add_parser("label"); lab.add_argument("--sha"); lab.add_argument("--dry-run", action="store_true")
    lab.set_defaults(run=stages.label_all)
    m = sub.add_parser("sources"); m.set_defaults(run=stages.sources)
    a = p.parse_args()
    if a.store.resolve() == gold_store.ROOT.resolve():
        p.error("the silver store is never the gold store")
    a.run(a)


if __name__ == "__main__":
    main()
