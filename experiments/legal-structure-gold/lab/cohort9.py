"""Batch 9's authoring cohort, aimed at the gold's thin classes: single-document kinds from the
corpus catalogue that no earlier batch used, within a page cap per kind, with their mode read from
their pages' text and a train/development split by hash. Writes the manifest and prints the
composition.

  python cohort9.py SCRATCH OUT_MANIFEST [--dry]
"""
import collections
import glob
import hashlib
import json
import os
import sqlite3
import sys

import fitz

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sp, out_path = sys.argv[1], sys.argv[2]
dry = "--dry" in sys.argv
HOME = os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData")
used = set()
for path in glob.glob(rf"{sp}\manifests\*.json"):
    m = json.load(open(path, encoding="utf-8"))
    for d in (m["documents"] if isinstance(m, dict) else m):
        used.add(d["sha256"])
# (kinds, documents wanted, page cap): the thin classes first.
PLAN = [
    (("legislation", "statute_compilation", "rules_or_regulations", "municipal_bylaw", "court-rules"), 230, 120),
    (("transcript", "transcript-candidate", "questioning-transcript"), 120, 40),
    (("order", "ruling", "practice_note"), 50, 30),
    (("law_reform_report", "inquiry_report", "commission_record", "consultation_response"), 110, 40),
    (("legal_submission", "closing_submission", "factum", "brief", "memorandum", "pleading"), 150, 40),
    (("legal_monograph",), 40, 40),
    (("journal-article",), 50, 40),
    (("contract",), 90, 50),
    (("affidavit", "affidavit-candidate", "witness_statement"), 90, 40),
    (("judgment",), 160, 40),
]
db = sqlite3.connect(f"file:{os.path.join(HOME, 'corpus', 'corpus.sqlite')}?mode=ro", uri=True)


def mode_of(path):
    """ocr when most pages carry no extractable text (cohort_manifest.text_mode)."""
    try:
        with fitz.open(path) as document:
            pages = [len(page.get_text("text").strip()) >= 200 for page in document]
    except Exception:
        return None
    return "digitalborn" if pages and sum(pages) * 2 >= len(pages) else "ocr"


documents = []
summary = collections.defaultdict(lambda: collections.Counter())
for kinds, wanted, cap in PLAN:
    rows = []
    for kind in kinds:
        for sha, path, pages, jurisdiction, collection in db.execute(
                "select d.sha256, f.path, f.pages, d.jurisdiction, d.collection from documents d join files f on f.sha256 = d.sha256 "
                "where d.kind = ? and f.content_type like '%pdf%' group by d.sha256", (kind,)):
            if sha in used or not pages or pages > cap or pages < 1:
                continue
            full = os.path.join(HOME, path)
            if not os.path.isfile(full):
                continue
            rows.append((sha, full, pages, kind, jurisdiction, collection))
    # Spread the pick over the kinds and jurisdictions: deterministic order by hash, then take.
    rows.sort(key=lambda r: hashlib.sha256(("b9" + r[0]).encode()).hexdigest())
    picked, per_kind = [], collections.Counter()
    quota = max(wanted // len(kinds), 1)
    for r in rows:
        if per_kind[r[3]] < quota * 2 and len(picked) < wanted:
            picked.append(r); per_kind[r[3]] += 1
    for r in rows:
        if len(picked) >= wanted:
            break
        if r not in picked:
            picked.append(r)
    for sha, full, pages, kind, jurisdiction, collection in picked:
        mode = None if dry else mode_of(full)
        if not dry and mode is None:
            continue
        split = "development" if int(hashlib.sha256(("split" + sha).encode()).hexdigest()[:8], 16) % 5 == 0 else "train"
        documents.append({"path": full, "mode": mode or "?", "split": split, "sha256": sha, "pages": pages, "kind": kind,
                          "jurisdiction": jurisdiction, "collection": collection})
        summary[kinds[0]][f"{mode or '?'} {split}"] += 1
        summary[kinds[0]]["pages"] += pages
# The recognized lane is the weakest: top it up with scanned documents of the key kinds (the
# catalogue's page text names a scan: under 50 characters a page), confirmed by their pages.
chosen = {d["sha256"] for d in documents}
TOPUP = (("judgment", 60, 40), ("affidavit", 40, 40), ("affidavit-candidate", 30, 40), ("legal_submission", 30, 40), ("factum", 20, 40),
         ("transcript-candidate", 20, 40), ("statute_compilation", 30, 120), ("consultation_response", 15, 40), ("contract", 20, 50), ("document", 30, 40))
for kind, wanted, cap in TOPUP:
    rows = db.execute("select d.sha256, f.path, f.pages, d.jurisdiction, d.collection from documents d join files f on f.sha256 = d.sha256 "
                      "where d.kind = ? and f.content_type like '%pdf%' group by d.sha256", (kind,)).fetchall()
    rows.sort(key=lambda r: hashlib.sha256(("b9ocr" + r[0]).encode()).hexdigest())
    taken = 0
    for sha, path, pages, jurisdiction, collection in rows:
        if taken >= wanted:
            break
        if sha in used or sha in chosen or not pages or pages > cap:
            continue
        chars = db.execute("select sum(length(text)) from pages where sha256 = ?", (sha,)).fetchone()[0] or 0
        if chars >= 50 * pages:
            continue
        full = os.path.join(HOME, path)
        if not os.path.isfile(full):
            continue
        mode = None if dry else mode_of(full)
        if not dry and mode != "ocr":
            continue
        split = "development" if int(hashlib.sha256(("split" + sha).encode()).hexdigest()[:8], 16) % 5 == 0 else "train"
        documents.append({"path": full, "mode": mode or "?", "split": split, "sha256": sha, "pages": pages, "kind": kind,
                          "jurisdiction": jurisdiction, "collection": collection})
        chosen.add(sha); taken += 1
        summary["ocr top-up " + kind][f"{mode or '?'} {split}"] += 1
        summary["ocr top-up " + kind]["pages"] += pages
documents.sort(key=lambda d: -(d["pages"] or 0))
print(f"{len(documents)} documents, {sum(d['pages'] for d in documents)} pages, {sum(os.path.getsize(d['path']) for d in documents) / 1e6:.0f} MB")
for group, counts in summary.items():
    print(f"  {group:22} " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
if not dry:
    json.dump({"documents": documents}, open(out_path, "w", encoding="utf-8"), indent=1)
    print("wrote", out_path)
