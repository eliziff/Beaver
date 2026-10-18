"""An authoring manifest for the selected cohort: {documents: [{path, mode, split, sha256}]}.

  python experiments/legal-structure-gold/cohort_manifest.py --selection <family-selection.json> --out <manifest.json>

Each selected member's PDF is found in the corpus by its SHA-256 and its mode is the member's
selected mode. Members whose PDF is not in the corpus are listed on stderr and left out. Long
documents come first, so shards start on the slow ones.
"""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "legal_pdf_corpus"))
import corpus_store  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--split", choices=("train", "development", "test"), help="Only this split")
    parser.add_argument("--max-pages", type=int, help="Leave out members longer than this")
    args = parser.parse_args()
    selection = json.loads(args.selection.read_text(encoding="utf-8"))
    members = selection["members"]
    # A member's mode: its selected gold's, else its long-document group's, else the corpus
    # path's digitalborn/non_digital segment, else whether its pages carry text.
    long_modes = {row["sha256"]: row["mode"] for rows in selection.get("long_documents", {}).values() for row in rows}
    db = corpus_store.connect()
    documents, missing, probed = [], [], 0
    for member in members:
        if args.split and member["split"] != args.split: continue
        if args.max_pages and (member.get("pages") or 0) > args.max_pages: continue
        row = db.execute("select path from files where sha256=?", (member["sha256"],)).fetchone()
        path = corpus_store.HOME / row[0] if row else None
        if path is None or not path.is_file():
            missing.append(member["sha256"]); continue
        mode = (member.get("selected_gold") or {}).get("mode") or long_modes.get(member["sha256"])
        if mode not in ("digitalborn", "ocr"):
            parts = Path(row[0]).parts
            mode = "ocr" if "non_digital" in parts else "digitalborn" if "digitalborn" in parts else None
        if mode is None:
            mode = text_mode(path); probed += 1
        documents.append({"path": str(path), "mode": mode, "split": member["split"],
                          "sha256": member["sha256"], "pages": member.get("pages")})
    documents.sort(key=lambda d: -(d["pages"] or 0))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"documents": documents}, indent=1), encoding="utf-8")
    print(f"{len(documents)} documents ({sum(d['pages'] or 0 for d in documents)} pages) -> {args.out}; "
          f"{len(missing)} not in the corpus; {probed} modes decided by their pages' text")
    for sha in missing: print("missing", sha, file=sys.stderr)


def text_mode(path):
    """ocr when most pages carry no extractable text."""
    import fitz
    with fitz.open(path) as document:
        pages = [len(page.get_text("text").strip()) >= 200 for page in document]
    return "digitalborn" if pages and sum(pages) * 2 >= len(pages) else "ocr"


if __name__ == "__main__":
    main()
