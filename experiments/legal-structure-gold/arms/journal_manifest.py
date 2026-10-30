"""The manifest of journal PDFs whose pages the 661-page journal manual gold covers.

The manual gold (eScriptorium PageXML, one human-corrected page each) names its source in the file
name: NNN_<dataset>_article-<id>_pdf-page-<n>.xml, n the physical PDF page. Each article's PDF is
found in the shared corpus by its Open Access Journals Database label ("<dataset>:<id> ...", as
experiments/footnote-gold/import_olj.py stores them) or, with --fetch, stored there from the
database's pdf_url. Articles with eval or test pages come first, spread over journals; at most
--count are kept. Each row records its truth pages and how well the corpus page text agrees with
the human transcription (a check that the page numbering lines up). A source's partition and groups
are its source.json in the gold store, never this manifest.

  python journal_manifest.py [--gold <remote_bundle>] [--fetch] [--count 30] [--out journal_manifest.json]
"""
import argparse
import difflib
import json
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "experiments/legal_pdf_corpus"))
import corpus_store  # noqa: E402

BUNDLE = Path.home() / "Desktop/MikeOSS Fork/benchmarks/local-data/olj-manual-gold/pagexml-661-20260810/remote_bundle"
OLJ = Path.home() / "Desktop/Open Access Journals Database"
DESKTOP_HOME = r"C:\Users\elias\AppData\Local\OpenLegalData"
NAME = re.compile(r"\d+_(.+)_article-(\d+)_pdf-page-(\d+)\.xml$")
NS = "{http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15}"


def truth_pages(bundle: Path):
    split = {Path(line).name: s for s in ("train", "eval", "test")
             for line in (bundle / f"{s}.lst").read_text(encoding="utf-8").split()}
    pages = defaultdict(list)
    for xml in sorted((bundle / "data").glob("*.xml")):
        m = NAME.match(xml.name)
        pages[(m[1], m[2])].append({"page": int(m[3]), "split": split.get(xml.name, "none"), "xml": xml.name})
    return pages


def page_text(xml: Path) -> str:
    root = ET.parse(xml).getroot()
    return " ".join(u.text or "" for line in root.iter(NS + "TextLine")
                    for u in line.findall(f"{NS}TextEquiv/{NS}Unicode"))


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def thumbnail(image):
    import numpy as np
    pixels = np.asarray(image.convert("L").resize((48, 64)), dtype=float)
    return (pixels - pixels.mean()) / (pixels.std() or 1)


def image_agreement(pdf: Path, page: int, png: Path) -> float:
    """Correlation of the rendered PDF page with the truth page image, both shrunk to 48x64
    (for PDFs without a text layer; text pages are checked by their text)."""
    import fitz
    from PIL import Image
    with fitz.open(pdf) as document:
        if page > len(document):
            return 0.0
        pix = document[page - 1].get_pixmap(dpi=40, colorspace=fitz.csGRAY)
        rendered = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    return round(float((thumbnail(rendered) * thumbnail(Image.open(png))).mean()), 3)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--gold", type=Path, default=BUNDLE)
    p.add_argument("--olj", type=Path, default=OLJ)
    p.add_argument("--count", type=int, default=30)
    p.add_argument("--fetch", action="store_true", help="Store missing eval/test PDFs in the corpus from pdf_url")
    p.add_argument("--out", type=Path, default=HERE / "journal_manifest.json")
    a = p.parse_args()
    pages = truth_pages(a.gold)
    db = corpus_store.connect()
    stored = {}
    for sha, label, path, count in db.execute("select d.sha256, d.label, f.path, f.pages from documents d join files f using(sha256)"
                                              " where d.collection='journals'"):
        stored[tuple(label.split(" ")[0].split(":"))] = (sha, path, count)
    journals = sqlite3.connect((a.olj / "oajd/journals.db").as_uri() + "?mode=ro", uri=True)
    held_out = [k for k, v in pages.items() if any(t["split"] in ("eval", "test") for t in v)]
    # Spread over journals: round-robin by dataset, articles with more held-out pages first.
    by_journal = defaultdict(list)
    for key in sorted(held_out, key=lambda k: (-sum(t["split"] != "train" for t in pages[k]), k)):
        by_journal[key[0]].append(key)
    order = []
    while any(by_journal.values()):
        for journal in sorted(by_journal):
            if by_journal[journal]:
                order.append(by_journal[journal].pop(0))
    rows, skipped = [], []
    for dataset, article in order:
        if len(rows) >= a.count:
            break
        url, title, pdf_type, language = journals.execute(
            "select pdf_url, name_en, pdf_type, language from articles where dataset=? and article_id=?",
            (dataset, int(article))).fetchone()
        if (dataset, article) not in stored and a.fetch and url:
            meta = {"collection": "journals", "kind": "journal-article", "jurisdiction": "ca",
                    "label": f"{dataset}:{article} {title}"[:300], "provenance": "Open Access Journals Database pdf_url"}
            sha, status = corpus_store.fetch(db, url, meta, refresh=False)
            found = sha and db.execute("select path, pages from files where sha256=?", (sha,)).fetchone()
            if found and found[1]:
                stored[(dataset, article)] = (sha, *found)
            print(f"fetch {dataset}:{article} {status}", flush=True)
        if (dataset, article) not in stored:
            skipped.append(f"{dataset}:{article}")
            continue
        sha, path, count = stored[(dataset, article)]
        truth = sorted(pages[(dataset, article)], key=lambda t: t["page"])
        for t in truth:
            corpus = db.execute("select text from pages where sha256=? and page=?", (sha, t["page"])).fetchone()
            human = squash(page_text(a.gold / "data" / t["xml"]))
            t["corpus_text_agreement"] = round(difflib.SequenceMatcher(None, squash(corpus[0]) if corpus else "", human,
                                                                       autojunk=False).ratio(), 3)
            t["image_agreement"] = image_agreement(corpus_store.HOME / path, t["page"],
                                                   a.gold / "data" / t["xml"].replace(".xml", ".png"))
        # A PDF that is not the one the truth was made on (another version, a cover page more).
        if any(t["page"] > count or max(t["corpus_text_agreement"], t["image_agreement"]) < 0.9 for t in truth):
            skipped.append(f"{dataset}:{article} (pages differ)")
            continue
        rows.append({"path": DESKTOP_HOME + "\\" + path.replace("/", "\\"),
                     "mode": "digitalborn" if pdf_type == "digital_born" else "ocr", "sha256": sha, "pages": count,
                     "article": f"{dataset}:{article}", "pdf_type": pdf_type, "truth_pages": truth})
    a.out.write_text(json.dumps({"source": str(a.gold), "skipped": skipped, "documents": rows}, indent=1, ensure_ascii=False),
                     encoding="utf-8")
    print("skipped:", ", ".join(skipped))
    print(f"{len(rows)} documents, {sum(len(r['truth_pages']) for r in rows)} truth pages"
          f" ({sum(t['split'] != 'train' for r in rows for t in r['truth_pages'])} eval/test),"
          f" {sum(r['pages'] for r in rows)} PDF pages; not in the corpus: {len(skipped)} -> {a.out}")


if __name__ == "__main__":
    main()
