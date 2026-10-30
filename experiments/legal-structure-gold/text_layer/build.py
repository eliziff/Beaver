"""Build exact text layers for scanned SCC judgments from (scanned PDF, A2AJ text) pairs.

  python build.py discover      list the local public SCC originals (the app's provider-PDF receipts) that
                                are scans, at most 40 pages, not already in the gold store, paired by
                                publisher item URL with the local A2AJ store -> DATA/candidates.json
  python build.py run [--only CITATION ...]
                                for each candidate: verify the pair, parse it with the installed parser
                                (extract.mjs ... ocr, one PDF at a time, below-normal priority), align,
                                write DATA/text-layers/<sha256>.json; then rewrite DATA/pairs.jsonl
  python build.py report        stats from the written layers (README numbers)

DATA is benchmarks/local-data/legal-structure-gold/text-layers-2026-10-20 of the main checkout.
Nothing is built or downloaded; it reads local files only.
"""
import argparse
import collections
import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[2] / "legal_pdf_corpus")]
import align as al  # noqa: E402
import gold_store  # noqa: E402

BEAVER = Path(os.environ.get("BEAVER_ROOT", "C:/Users/elias/Desktop/MikeOSS Fork"))
DATA = BEAVER / "benchmarks/local-data/legal-structure-gold/text-layers-2026-10-20"
ROOT = Path(os.environ["LOCALAPPDATA"]) / "OpenLegalData"
MAX_PAGES = 40
MARKERS = {"en": "Decision Content", "fr": "Contenu de la décision"}


def a2aj():
    return sqlite3.connect((ROOT / "providers/a2aj/a2aj.sqlite").as_uri() + "?mode=ro", uri=True)


def item_of(url):
    p = urlparse(url or "")
    m = re.search(r"/(?:item/)?(\d+)/(?:1/document\.do|index\.do)$", p.path)
    return m.group(1) if p.hostname == "decisions.scc-csc.ca" and m else None


def receipts():
    """Provider-PDF receipts of the app's libraries and cache: {sha256: (receipt, pdf path)}."""
    found = {}
    bases = [ROOT / "apps/mike/launcher/data-20260904", ROOT / "apps/mike/library-current", ROOT / "apps/mike/library-v9"]
    for base in bases:
        for file in (base / "projections/v1/source-pdf").glob("*.json"):
            record = json.loads(file.read_text(encoding="utf-8"))
            digest = record.get("source_sha256", "")
            pdf = base / "projections/v1/content/pdf" / digest[:2] / (digest + ".pdf")
            if record.get("provider") == "a2aj" and pdf.is_file():
                found[digest] = (record, pdf)
    cache = ROOT / "cache/a2aj/pdf"
    for file in (cache / "requests").glob("*.json"):
        record = json.loads(file.read_text(encoding="utf-8"))
        digest = record.get("source_sha256", "")
        if record.get("provider") == "a2aj" and (cache / "blobs" / (digest + ".pdf")).is_file():
            found[digest] = (record, cache / "blobs" / (digest + ".pdf"))
    return found


def discover():
    import fitz
    used = {sha for sha, _ in gold_store.sources(gold_store.STRUCTURE)}
    by_item = {}
    with a2aj() as db:
        for row in db.execute("select id,citation_en,citation_fr,name_en,document_date_en,url_en,url_fr,length(unofficial_text_fr) "
                              "from document where dataset='SCC'"):
            for url in row[5:7]:
                if item_of(url):
                    by_item.setdefault(item_of(url), row)
    rows, skipped = [], collections.Counter()
    for digest, (record, pdf) in receipts().items():
        item = item_of(record.get("canonical_url")) or item_of(record.get("url"))
        if not item or item not in by_item:
            continue
        with fitz.open(pdf) as doc:
            pages, first = len(doc), doc[0]
            scan = len(first.get_text().strip()) < 50 and bool(first.get_images())
        ident, citation, citation_fr, name, date, url_en, _, fr_length = by_item[item]
        reason = ("born-digital" if not scan else "over 40 pages" if pages > MAX_PAGES else
                  "already in the gold store" if digest in used else None)
        if reason:
            skipped[reason] += 1
            continue
        rows.append({"sha256": digest, "pdf_path": str(pdf), "pages": pages, "a2aj_id": ident, "citation": citation,
                     "citation_fr": citation_fr, "name": name, "date": date[:10], "item_url": url_en,
                     "bilingual_text": bool(fr_length)})
    rows.sort(key=lambda r: r["date"])
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "candidates.json").write_text(json.dumps({"skipped": skipped, "candidates": rows}, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(rows)} candidates; skipped {dict(skipped)}")


def start_of(text, language):
    """Where the decision proper begins: after the metadata block and the generated preamble lines."""
    at = text.find(MARKERS[language])
    at = at + len(MARKERS[language]) if at >= 0 else 0
    date = re.compile(r"\n(?:Supreme Court of Canada|Cour suprême du Canada)\n[^\n]*\nDate: ?\d{4}-\d\d-\d\d\n").match(text, at)
    return date.end() if date else at


def extract(pdf, sha):
    """The parser's OCR lines for the PDF (one process, below-normal priority); returns the ocr.json.gz path."""
    existing = sorted((DATA / "extract" / sha).glob("*/*/ocr.json.gz"))
    if existing:
        return existing[-1]
    out = DATA / "extract"
    result = subprocess.run(["node", "--no-warnings", "extract.mjs", str(pdf), str(out), "ocr"],
                            cwd=BEAVER / "experiments/legal-structure-gold", creationflags=0x4000,
                            capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(result.stderr[-800:])
    path = Path(result.stdout.strip().splitlines()[-1])
    shutil.rmtree(path.parents[2] / "ocr/raster", ignore_errors=True)
    return path


def page_lines(path):
    pages = json.load(gzip.open(path))["extraction"]["pages"]
    return [{"id": ln["id"], "page": p["number"], "text": ln["text"], "x": (ln["bbox"][0] + ln["bbox"][2]) / 2, "width": p["width"]}
            for p in pages for ln in p["lines"] if ln["text"].strip()]


def column_order(lines):
    """Indices in reading order by column: a page with text on both sides of its centre (the bilingual
    reports print English left, French right) is read left column, then right. The parser interleaves
    the two columns by blocks; a word broken across a line pair needs its two lines to be neighbours."""
    order = []
    for page in sorted({ln["page"] for ln in lines}):
        members = [i for i, ln in enumerate(lines) if ln["page"] == page]
        right = [i for i in members if lines[i]["x"] > lines[i]["width"] / 2]
        left = [i for i in members if lines[i]["x"] <= lines[i]["width"] / 2]
        two = min(len(left), len(right)) >= 0.25 * len(members)
        order += left + right if two else members
    return order


def verify(lines, text, citation):
    """Citation and opening words must agree: the first page prints the reporter citation (or its folio is
    the start page) and the first words of the text's decision appear among the first page's lines."""
    first = [ln["text"] for ln in lines if ln["page"] == 1]
    head = " ".join(first)
    start_page = re.search(r"(\d+)\s*$", citation).group(1)
    year = re.search(r"[\[(](\d{4})[\])]", citation).group(1)
    cited = (year in head and bool(re.search(r"S\.?\s?C\.?\s?R|R\.?\s?C\.?\s?S", head))) or start_page in head.split()
    opening = [w for w, _, _ in al.words_of(text, start_of(text, "en"))[:14]]
    seen = [w for w, _, _ in al.words_of(head)]
    hits = sum(1 for w in opening if w in seen or any(len(w) > 4 and al.similarity(w, s) >= 0.8 for s in seen))
    return {"citation_on_page_1": cited, "opening_words_found": f"{hits}/{len(opening)}", "ok": cited and hits >= 0.6 * len(opening)}


def characters(ocr, exact):
    a, b = " ".join(ocr.split()), " ".join(exact.split())
    return al.edit_distance(a, b), len(b)


def build(candidate):
    sha = candidate["sha256"]
    original = page_lines(extract(candidate["pdf_path"], sha))
    order = column_order(original)
    lines = [original[i] for i in order]
    with a2aj() as db:
        text_en, text_fr = db.execute("select unofficial_text_en, unofficial_text_fr from document where id=?", (candidate["a2aj_id"],)).fetchone()
    check = verify(lines, text_en, candidate["citation"])
    if not check["ok"]:
        raise RuntimeError(f"pair does not verify: {check}")
    results = [dict(r, lang=None) for r in al.align(lines, text_en, start_of(text_en, "en"))]
    for r in results:
        r["lang"] = "en" if r["status"] != "unmatched" else None
    texts = [("en", text_en)] + ([("fr", text_fr)] if text_fr else [])
    # the other language's column, then footnotes: what is left is aligned again against the words not yet used
    for language, text in texts[1:] + texts[:1] + texts[1:]:
        left = [i for i, r in enumerate(results) if r["status"] == "unmatched"]
        if not left:
            break
        taken = [r["span"] for r in results if r["lang"] == language and r["span"]]
        again = al.align([lines[i] for i in left], text, start_of(text, language), taken)
        for i, r in zip(left, again):
            if r["status"] != "unmatched":
                results[i] = dict(r, lang=language)
    out = []
    restored = [None] * len(lines)
    for at, i in enumerate(order):
        restored[i] = at
    for line, r in zip(original, (results[at] for at in restored)):
        out.append({"id": line["id"], "page": line["page"], "ocr": line["text"], "exact": r["exact"], "status": r["status"],
                    "lang": r["lang"], "span": r["span"]})
    matched = [x for x in out if x["status"] != "unmatched"]
    errors = [characters(x["ocr"], x["exact"]) for x in matched]
    stats = {"lines": len(out), **{s: sum(x["status"] == s for x in out) for s in ("anchored", "filled", "unmatched")},
             "by_language": dict(collections.Counter(x["lang"] for x in matched)),
             "ocr_char_agreement": round(1 - sum(e for e, _ in errors) / max(1, sum(n for _, n in errors)), 4)}
    layer = {"source_sha256": sha, "pdf_path": candidate["pdf_path"],
             "a2aj": {"citation": candidate["citation"], "id": candidate["a2aj_id"], "name": candidate["name"],
                      "date": candidate["date"], "item_url": candidate["item_url"]},
             "binary": json.load(gzip.open(extract(candidate["pdf_path"], sha)))["parser"]["binary_sha256"],
             "layout": "bilingual two-column (English left, French right)" if stats["by_language"].get("fr", 0) > 0.2 * len(out) else "single column",
             "pair_check": check, "lines": out, "stats": stats}
    (DATA / "text-layers").mkdir(exist_ok=True)
    (DATA / "text-layers" / f"{sha}.json").write_text(json.dumps(layer, ensure_ascii=False), encoding="utf-8")
    return layer


def run(only):
    candidates = json.loads((DATA / "candidates.json").read_text(encoding="utf-8"))["candidates"]
    for c in candidates:
        if only and c["citation"] not in only:
            continue
        began = time.time()
        try:
            layer = build(c)
            print(c["citation"], c["name"][:30], c["pages"], "pp", layer["stats"], f"{time.time() - began:.0f}s", flush=True)
        except Exception as error:
            print("FAILED", c["citation"], str(error)[:300], flush=True)
            (DATA / "failures.jsonl").open("a", encoding="utf-8").write(json.dumps({"citation": c["citation"], "error": str(error)[:600]}) + "\n")
    index()


def index():
    with (DATA / "pairs.jsonl").open("w", encoding="utf-8") as out:
        for file in sorted((DATA / "text-layers").glob("*.json")):
            layer = json.loads(file.read_text(encoding="utf-8"))
            out.write(json.dumps({"source_sha256": layer["source_sha256"], "pdf_path": layer["pdf_path"], **layer["a2aj"],
                                  "layout": layer["layout"], "pages": layer["lines"][-1]["page"], "pair_check": layer["pair_check"],
                                  "stats": layer["stats"], "layer": f"text-layers/{file.name}"}, ensure_ascii=False) + "\n")


def report():
    rows = [json.loads(line) for line in (DATA / "pairs.jsonl").read_text(encoding="utf-8").splitlines()]
    decades = collections.Counter(r["date"][:3] + "0s" for r in rows)
    total = collections.Counter()
    for r in rows:
        total.update({k: r["stats"][k] for k in ("lines", "anchored", "filled", "unmatched")})
    print(dict(decades), dict(total))
    for r in rows:
        s = r["stats"]
        print(r["date"][:4], r["citation"], r["name"][:34], s["lines"], f"A{s['anchored']/s['lines']:.1%} F{s['filled']/s['lines']:.1%} U{s['unmatched']/s['lines']:.1%}", s["ocr_char_agreement"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["discover", "run", "report"])
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    run(args.only) if args.command == "run" else {"discover": discover, "report": report}[args.command]()
