"""Rebuild the benchmark's data directory from the committed JSON.

Usage: python rebuild.py [--text-backup DIR] [record_id ...]

For each record in records/ (the committed copies): download the source PDF
from source.json's url, check its sha256, and rebuild affidavit.pdf and
every exhibit file from the exact page lists in split.json. Stamp and record
page-number redactions are recomputed the same way split.py makes them; file
names come from split.json, so the gold's file references hold. Text files
come from --text-backup (a copy of records/<id>/affidavit.txt and
files/*.txt, including OCR output) when present, else from the rebuilt
PDFs. Same-matter documents are re-downloaded from matter_docs.json. Records
whose source is missing or changed are reported, not guessed.
"""
import hashlib, json, os, shutil, subprocess, sys
import fitz
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from split import clean_copy, cover_label, record_folios, text_of
from ocr_exhibits import read

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", "benchmarks", "court-record-exhibits")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"


def fetch(url, path, referer=""):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    url = url.replace(" ", "%20")
    headers = ["-H", "Accept: application/pdf,text/html;q=0.9,*/*;q=0.8", "-H", "Accept-Language: en-CA,en;q=0.9"]
    if referer:
        headers += ["-e", referer]
    r = subprocess.run(["curl", "-sfL", "--retry", "3", "--retry-all-errors", "-A", UA, *headers, "-o", path, url])
    ok = r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 0
    if not ok and os.path.exists(path):
        os.remove(path)  # never leave a partial download behind
    return ok


def rebuild(rid, backup):
    rec = os.path.join(HERE, "records", rid)
    src_meta = json.load(open(os.path.join(rec, "source.json"), encoding="utf-8"))
    split = json.load(open(os.path.join(rec, "split.json"), encoding="utf-8"))
    url = src_meta.get("url")
    raw = os.path.join(DATA, "raw", src_meta["source_file"])
    if not url and not os.path.exists(raw):
        return "no url"
    if not fetch(url, raw, src_meta.get("landing_url", "")):
        return "download failed"
    digest = hashlib.sha256(open(raw, "rb").read()).hexdigest()
    if src_meta.get("source_sha256") and digest != src_meta["source_sha256"]:
        return "source changed (sha256 differs)"
    src = fitz.open(raw)
    first, last = src_meta["page_range"][0] - 1, src_meta["page_range"][1] - 1
    out = os.path.join(DATA, "records", rid)
    os.makedirs(os.path.join(out, "files"), exist_ok=True)
    folios = record_folios(src, first, last)
    aff = clean_copy(src, [p - 1 for p in split["affidavit_pages"]])
    aff.save(os.path.join(out, "affidavit.pdf"), garbage=4, deflate=True)
    for ex in split["exhibits"]:
        pages = [p - 1 for p in ex["source_pages"]]
        redact = {q: list(folios.get(q, [])) for q in pages}
        if ex.get("stamp_page"):
            redact.setdefault(ex["stamp_page"] - 1, []).extend(cover_label(src[ex["stamp_page"] - 1])[2])
        for s in ex.get("redact_text", []):  # a label printed in the document's own title ("Exhibit D - ...")
            for q in pages:
                redact[q] = redact.get(q, []) + src[q].search_for(s)
        clean_copy(src, pages, redact).save(os.path.join(out, "files", ex["file"]), garbage=4, deflate=True)
    for name in ("gold.json", "split.json", "source.json", "matter_docs.json"):
        if os.path.exists(os.path.join(rec, name)):
            shutil.copyfile(os.path.join(rec, name), os.path.join(out, name))
    texts = [("affidavit.txt", aff)] + [(os.path.join("files", ex["file"].replace(".pdf", ".txt")), None) for ex in split["exhibits"]]
    restored = 0
    for rel, doc in texts:
        b = os.path.join(backup, rid, rel) if backup else ""
        if b and os.path.exists(b):
            shutil.copyfile(b, os.path.join(out, rel)); restored += 1
        else:
            d = doc or fitz.open(os.path.join(out, rel.replace(".txt", ".pdf")))
            text = text_of(d)
            if os.path.basename(rel).replace(".txt", ".pdf") in split.get("ocr_files", []):  # the same pages ocr_exhibits.py read
                text = read(d, force=len(text.split()) < 40)[0]
            open(os.path.join(out, rel), "w", encoding="utf-8").write(text)
    md = os.path.join(rec, "matter_docs.json")
    missing = 0
    for m in json.load(open(md, encoding="utf-8")) if os.path.exists(md) else []:
        path = os.path.join(DATA, m["file"]) if m["file"].replace("\\", "/").startswith("raw/") else os.path.join(DATA, "raw", "matter", rid, m["file"])
        missing += not (m.get("url") and fetch(m["url"], path))
    return f"ok ({len(split['exhibits'])} exhibits, {restored}/{len(texts)} texts from backup, {missing} matter docs missing)"


def main():
    args = sys.argv[1:]
    backup = args[args.index("--text-backup") + 1] if "--text-backup" in args else ""
    ids = [a for a in args if not a.startswith("--") and a != backup] or sorted(os.listdir(os.path.join(HERE, "records")))
    bad = 0
    for rid in ids:
        try:
            status = rebuild(rid, backup)
        except Exception as e:
            status = f"error: {e}"
        bad += not status.startswith("ok")
        print(f"{rid}: {status}", flush=True)
    print(f"{len(ids) - bad}/{len(ids)} rebuilt")


if __name__ == "__main__":
    main()
