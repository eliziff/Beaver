"""Rebuild the benchmark's data directory from the committed JSON.

Usage: python rebuild.py [--text-backup DIR] [record_id ...]

For each record in records/ (the committed copies): download the source PDF
from source.json's url, check its sha256, and rebuild affidavit.pdf and
every exhibit file from the exact page lists in split.json. Stamp and record
page-number redactions are recomputed the same way split.py makes them; file
names come from split.json, so the gold's file references hold. Text files
come from --text-backup (a copy of records/<id>/affidavit.txt and
files/*.txt, including OCR output) when present, else from the rebuilt
PDFs. Multi-file records (split.json multi_file) fetch each exhibit's
source_files from source.json's sources list. Same-matter documents are re-downloaded from matter_docs.json. Records
whose source is missing or changed are reported, not guessed.
"""
import hashlib, json, os, shutil, subprocess, sys
import fitz
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from split import clean_copy, cover_label, record_folios, text_of
from ocr_exhibits import read, words

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", "benchmarks", "court-record-exhibits")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"


def fetch(url, path, referer=""):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if "docs.doanegrantthornton.ca/document-folder/view/" in url:
        return fetch_gt(url, path)
    url = url.replace(" ", "%20")
    headers = ["-H", "Accept: application/pdf,text/html;q=0.9,*/*;q=0.8", "-H", "Accept-Language: en-CA,en;q=0.9"]
    if referer:
        headers += ["-e", referer]
    r = subprocess.run(["curl", "-sfL", "--retry", "3", "--retry-all-errors", "-A", UA, *headers, "-o", path, url])
    ok = r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 0
    if not ok and os.path.exists(path):
        os.remove(path)  # never leave a partial download behind
    return ok


def fetch_gt(url, path):
    """Doane Grant Thornton's view endpoint returns JSON with a one-time viewer link, not the PDF:
    open the viewer (sets its session cookie), then download by the viewer key."""
    import tempfile, time, urllib.parse
    jar = os.path.join(tempfile.gettempdir(), "gt-rebuild-cookies.txt")
    cu = ["curl", "-s", "-m", "300", "-A", UA, "-c", jar, "-b", jar]
    for i in range(4):
        try:
            link = json.loads(subprocess.run(cu + [url], capture_output=True, text=True).stdout)["link"]
            k = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)["k"][0]
            subprocess.run(cu + ["-o", os.devnull, link])
            body = subprocess.run(cu + [f"https://doanegrantthornton.webpal.net/_ajax/download?ft=1&mode=pdf&generate=yes&p={k}&sk=&vl=1"], capture_output=True).stdout
            if body[:4] == b"%PDF":
                open(path, "wb").write(body)
                return True
        except Exception:
            pass
        time.sleep(3 * (i + 1))
    return False


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
    if split.get("multi_file"):  # each exhibit cut from its own posted file(s)
        srcs = {s["file"]: s for s in src_meta["sources"]}
        for ex in split["exhibits"]:
            pdf = fitz.open()
            for part in ex["source_files"]:
                s = srcs[part["file"]]
                path = os.path.join(DATA, "raw", s["file"])
                if not fetch(s.get("url", ""), path, src_meta.get("landing_url", "")):
                    return f"download failed: {s['file']}"
                if hashlib.sha256(open(path, "rb").read()).hexdigest() != s["sha256"]:
                    return f"source changed (sha256 differs): {s['file']}"
                doc = fitz.open(path)
                pages = [p - 1 for p in part["pages"]]
                fol = record_folios(doc, 0, len(doc) - 1)
                redact = {q: list(fol.get(q, [])) for q in pages}
                if part.get("stamp_page"):
                    redact.setdefault(part["stamp_page"] - 1, []).extend(cover_label(doc[part["stamp_page"] - 1])[2])
                for t in ex.get("redact_text", []):
                    for q in pages:
                        redact[q] = redact.get(q, []) + doc[q].search_for(t)
                for q, rs in part.get("redact_rects", {}).items():  # an invisible typed label's text
                    redact[int(q) - 1] = redact.get(int(q) - 1, []) + [fitz.Rect(r) for r in rs]
                blank = {int(q) - 1: rs for q, rs in part.get("blank", {}).items()}  # a scanned-in stamp whited out
                pdf.insert_pdf(clean_copy(doc, pages, redact, blank))
            pdf.set_metadata({}); pdf.set_toc([])
            try:
                pdf.set_page_labels([])
            except Exception:
                pass
            pdf.save(os.path.join(out, "files", ex["file"]), garbage=4, deflate=True)
    for ex in [] if split.get("multi_file") else split["exhibits"]:
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
                text = read(d, force=words(text) < 40)[0]
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
