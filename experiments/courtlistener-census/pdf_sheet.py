"""Court PDFs as an answer key for opinions with no Harvard: each page's lines, in reading order, with what print says of them.

    python -I pdf_sheet.py PDF_DIR OUT.jsonl

Writes {"id": opinion, "pages": [{"lines": [[text, size, bold, centred], ...], "body": body size}, ...]}, a line an opinion, from the
PDF's text layer. Size says what plain text cannot: a footnote stands in smaller type at the page's foot. A PDF with no text layer is left out.
"""
import collections, concurrent.futures, json, os, sys
import fitz

pdfs, out = sys.argv[1:3] if len(sys.argv) >= 3 else (None, None)
WORKERS = 2
LEAST_TEXT = 200


def read_pdf(path):
    try:
        doc = fitz.open(path)
        pages = []
        chars = 0
        for page in doc:
            width = page.rect.width
            sizes = collections.Counter()
            lines = []
            for block in page.get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    spans = [span for span in line["spans"] if span["text"].strip()]
                    if not spans:
                        continue
                    text = "".join(span["text"] for span in line["spans"]).strip()
                    size = max(spans, key=lambda span: len(span["text"]))["size"]
                    sizes[round(size, 1)] += len(text)
                    bold = all("Bold" in span["font"] or span["flags"] & 16 for span in spans)
                    left, right = line["bbox"][0], line["bbox"][2]
                    centred = abs((left + right) / 2 - width / 2) < width * 0.06 and right - left < width * 0.7
                    lines.append([text, round(size, 1), bold, centred, round(line["bbox"][1], 1)])
                    chars += len(text)
            lines.sort(key=lambda line: line[4])
            pages.append({"body": sizes.most_common(1)[0][0] if sizes else 0, "lines": [line[:4] for line in lines]})
        return pages if chars >= LEAST_TEXT else None
    except Exception:
        return None


if __name__ == "__main__":
    held = set()
    if os.path.exists(out):
        with open(out, encoding="utf-8") as sheet:
            held = {line[8:line.index('"', 8)] for line in sheet}
    names = [name for name in sorted(os.listdir(pdfs)) if name.endswith(".pdf") and name[:-4] not in held and os.path.getsize(os.path.join(pdfs, name)) > 0]
    written = skipped = 0
    with open(out, "a", encoding="utf-8", newline="\n") as sheet, concurrent.futures.ProcessPoolExecutor(WORKERS) as pool:
        for name, pages in zip(names, pool.map(read_pdf, [os.path.join(pdfs, name) for name in names], chunksize=8)):
            if pages is None:
                skipped += 1
                continue
            sheet.write(json.dumps({"id": name[:-4], "pages": pages}, ensure_ascii=False) + "\n")
            written += 1
    print("opinions new", written, "already held", len(held), "no text layer", skipped)
