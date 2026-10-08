"""Import the Open Access Journals Database's verified footnote pairing gold.

Reads the locked 100-article verified gold (read-only), stores each article's
source PDF once by sha256 in the shared corpus, writes one gold record per PDF
under benchmarks/local-data/olj-footnote-gold/, and registers sources, runs and
artifacts in the corpus gold catalog as dataset `olj-footnote-gold.v1`.

  python experiments/footnote-gold/import_olj.py [--olj <root>] [--pdfs <dir>] [--limit N]

Publisher hosts behind bot challenges refuse the pdf_url, so --pdfs supplies the
OAJD durable copies (gs://oajd-durable-peaceful-parity-139023/source-pdfs/<pdf_path
below data/pdfs>, saved as <DATASET>_<article_id>.pdf); other PDFs are fetched.
"""
import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "experiments/legal_pdf_corpus"))
import corpus_store  # noqa: E402

DATASET = "olj-footnote-gold.v1"
OUT = ROOT / "benchmarks/local-data/olj-footnote-gold"
GOLDSET = "Text-Fidelity-Project/tools/footnotes/output/goldset/target_1500_20260706_03"
INPUTS = ("goldset.sqlite", "gold_article_verification_ledger.jsonl", "gold_markers.locked.jsonl",
          "gold_pairs.locked.jsonl", "gold_text_copies/gold_lines.markerized.jsonl")


def sha_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def jsonl(path: Path):
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--olj", type=Path, default=Path.home() / "Desktop/Open Access Journals Database")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--pdfs", type=Path, help="Directory of <DATASET>_<article_id>.pdf copies of journals.db pdf_path")
    args = parser.parse_args()
    goldset = args.olj / GOLDSET
    inputs = {name: sha_file(goldset / name) for name in INPUTS}
    with sqlite3.connect((goldset / "goldset.sqlite").as_uri() + "?mode=ro", uri=True) as db:
        articles = db.execute("select dataset, article_id, article_title, verified_status, verified_page_count, pair_count"
                              " from articles where lane='footnote' and coalesce(verified_status,'')!='' and excluded=0"
                              " order by dataset, cast(article_id as integer)").fetchall()
    if args.limit:
        articles = articles[:args.limit]
    keys = {(d, str(a)) for d, a, *_ in articles}
    markers: dict = {}
    for row in jsonl(goldset / "gold_markers.locked.jsonl"):
        if (row["dataset"], str(row["article_id"])) in keys:
            markers.setdefault((row["dataset"], str(row["article_id"])), []).append(row)
    pairs_by_article: dict = {}
    for row in jsonl(goldset / "gold_pairs.locked.jsonl"):
        if (row["dataset"], str(row["article_id"])) in keys:
            pairs_by_article.setdefault((row["dataset"], str(row["article_id"])), []).append(row)
    wanted = {(m["dataset"], str(m["article_id"]), m["line_id"]) for rows in markers.values() for m in rows}
    lines = {}
    for row in jsonl(goldset / "gold_text_copies/gold_lines.markerized.jsonl"):
        key = (row["dataset"], str(row["article_id"]), row["line_id"])
        if key in wanted:
            lines[key] = row
    with sqlite3.connect((args.olj / "oajd/journals.db").as_uri() + "?mode=ro", uri=True) as journals:
        source = {(d, str(a)): journals.execute(
            "select pdf_url, pdf_page_count, pdf_type, citation_en from articles where dataset=? and article_id=?",
            (d, int(a))).fetchone() for d, a, *_ in articles}

    db = corpus_store.connect()
    rows, manifest = [], []
    for dataset, article_id, title, status, pages, pairs in articles:
        url, page_count, pdf_type, citation = source[(dataset, str(article_id))]
        meta = {"collection": "journals", "kind": "journal-article", "jurisdiction": "ca",
                "label": f"{dataset}:{article_id} {title}"[:300], "provenance": "Open Access Journals Database pdf_url"}
        local = args.pdfs and args.pdfs / f"{dataset}_{article_id}.pdf"
        if local and local.is_file():
            body = local.read_bytes()
            sha = corpus_store.add_file(db, body, "application/pdf", corpus_store.place(meta))
            corpus_store.note(db, sha, {**meta, "provenance": "OAJD durable source-pdfs bucket copy of pdf_path"}, url)
            db.commit()
            fetched = "stored"
        else:
            sha, fetched = corpus_store.fetch(db, url, meta, refresh=False)
        stored = sha and db.execute("select pages from files where sha256=?", (sha,)).fetchone()
        if not stored:
            print(f"SKIP {dataset}:{article_id} {fetched}")
            continue
        marker_rows = {}
        for marker in markers.get((dataset, str(article_id)), []):
            line = lines.get((dataset, str(article_id), marker["line_id"]), {})
            marker_rows[marker["marker_id"]] = {
                "role": marker["role"], "note_id": marker["note_id"], "page": int(marker["pdf_page"]),
                "selected_text": marker["selected_text"], "start": marker["start_offset"], "end": marker["end_offset"],
                "line_text": line.get("gold_text_source", ""), "region_type": line.get("region_type", "")}
        notes = [{"pair_id": pair["pair_key"], "note_id": pair["note_id"],
                  "labels": [marker_rows[i] for i in pair["label_marker_ids"]],
                  "refs": [marker_rows[i] for i in pair["ref_marker_ids"]]}
                 for pair in pairs_by_article.get((dataset, str(article_id)), [])]
        notes.sort(key=lambda n: (min(m["page"] for m in n["labels"] + n["refs"]), n["note_id"]))
        gold = {"schema_version": "olj-footnote-gold.v1", "dataset": dataset, "article_id": str(article_id),
                "title": title, "citation": citation, "source_url": url, "source_sha256": sha,
                "pdf_type": pdf_type, "pages": int(pages or page_count or 0), "verified_status": status, "notes": notes,
                "inputs": inputs}
        directory = OUT / "gold" / sha
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "gold.json").write_text(json.dumps(gold, ensure_ascii=False, indent=1), encoding="utf-8")
        receipt = {"run_id": f"{sha[:12]}-olj-{inputs['gold_markers.locked.jsonl'][:12]}", "source_sha256": sha,
                   "status": "complete", "dataset": DATASET, "article": f"{dataset}:{article_id}",
                   "gold_sha256": sha_file(directory / "gold.json"), "inputs": inputs, "pages": stored[0],
                   "configuration": {"mode": "ocr" if pdf_type != "digital_born" else "digitalborn"}}
        (directory / "receipt.json").write_text(json.dumps(receipt, indent=1), encoding="utf-8")
        rows.append({"sha256": sha, "mode": receipt["configuration"]["mode"]})
        manifest.append({"sha256": sha, "article": f"{dataset}:{article_id}", "pdf_pages": stored[0],
                         "gold_pages": gold["pages"], "pairs": len(notes), "status": fetched})
        if stored[0] != gold["pages"]:
            print(f"PAGES {dataset}:{article_id} pdf={stored[0]} gold={gold['pages']}")
    db.close()
    corpus_store.register_gold_sources(DATASET, rows)
    with corpus_store.connect() as db:
        for row in rows:
            directory = OUT / "gold" / row["sha256"]
            receipt = json.loads((directory / "receipt.json").read_text(encoding="utf-8"))
            db.execute("insert into gold_runs values (?,?,?,?,?,?,null,null) on conflict(run_id) do update set"
                       " status=excluded.status,receipt_path=excluded.receipt_path,receipt_sha256=excluded.receipt_sha256",
                       (receipt["run_id"], DATASET, row["sha256"], "complete", str((directory / "receipt.json").resolve()),
                        sha_file(directory / "receipt.json")))
            for role, name in (("receipt", "receipt.json"), ("gold", "gold.json")):
                db.execute("insert into gold_artifacts values (?,?,?,?) on conflict(run_id,role) do update set"
                           " path=excluded.path,sha256=excluded.sha256",
                           (receipt["run_id"], role, str((directory / name).resolve()), sha_file(directory / name)))
            db.execute("update gold_records set status='complete', run_id=? where dataset=? and sha256=?",
                       (receipt["run_id"], DATASET, row["sha256"]))
    (OUT / "manifest.json").write_text(json.dumps({"dataset": DATASET, "goldset": GOLDSET, "inputs": inputs,
                                                   "documents": manifest}, indent=1), encoding="utf-8")
    print(f"{len(rows)} documents, {sum(m['gold_pages'] for m in manifest)} pages,"
          f" {sum(m['pairs'] for m in manifest)} gold notes -> {OUT}")


if __name__ == "__main__":
    main()
