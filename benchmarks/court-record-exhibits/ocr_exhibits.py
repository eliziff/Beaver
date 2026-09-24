"""OCR exhibit pages whose text layer a reader could not use, so each .txt holds what a reader (or Event Strip's OCR) would get.

Usage: python ocr_exhibits.py [record_id ...]

A page is OCR'd with Tesseract through PyMuPDF (TESSDATA_PREFIX) when
- the file is image-only (under 40 words of text in all) and the page carries images, or
- the page's text is a broken font encoding: glyph codes that extract as control characters
  (more than 5% of its characters), which pdf.js and PyMuPDF both return as garbage.
The record's split.json lists the files OCR'd under ocr_files; rebuild.py re-OCRs exactly those.
"""
import json, os, re, sys
import fitz
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from baseline import ROOT


def broken(text):
    chars = [c for c in text if not c.isspace()]
    return len(chars) >= 50 and sum(ord(c) < 32 for c in chars) / len(chars) > 0.05


def read(doc, force=False):
    """Page-marked text in split.py's format; image-only (force) or broken-encoding pages are OCR'd."""
    out, used = [], False
    for i, p in enumerate(doc):
        t = p.get_text()
        if broken(t) or (force and p.get_images()):
            t, used = p.get_textpage_ocr(dpi=300, full=True).extractText(), True
        out.append(f"[page {i + 1}]\n{t}")
    return "\n".join(out), used


def words(text):
    return len(re.sub(r"\[page \d+\]", " ", text).split())  # page markers are not text


def needs_ocr(pdf, txt):
    text = open(txt, encoding="utf-8").read() if os.path.exists(txt) else ""
    return words(text) < 40 or broken(text)


def main():
    ids = sys.argv[1:] or sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "gold.json")))
    total = 0
    for rid in ids:
        files = os.path.join(ROOT, rid, "files")
        done = []
        for name in sorted(os.listdir(files)):
            pdf, txt = os.path.join(files, name), os.path.join(files, name[:-4] + ".txt")
            if not name.endswith(".pdf") or not needs_ocr(pdf, txt):
                continue
            doc = fitz.open(pdf)
            text, used = read(doc, force=words(open(txt, encoding="utf-8").read()) < 40 if os.path.exists(txt) else True)
            if used:
                open(txt, "w", encoding="utf-8").write(text)
                done.append(name)
        if done:
            sp = os.path.join(ROOT, rid, "split.json")
            split = json.load(open(sp, encoding="utf-8"))
            split["ocr_files"] = sorted(set(split.get("ocr_files", [])) | set(done))
            json.dump(split, open(sp, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
            print(f"{rid}: OCR {len(done)} files", flush=True)
            total += len(done)
    print(f"{total} files OCR'd")


if __name__ == "__main__":
    main()
