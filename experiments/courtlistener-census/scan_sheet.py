"""Harvard's scans as an answer key: each case's physical pages, their words in reading order, and the number the first page prints.

    python -I scan_sheet.py SCANS_DIR OUT.jsonl

Writes {"cluster": id, "first": printed number of the first physical page, "pages": [text, ...]}, a line a case. A scan's text layer does
not run in reading order, so the words are laid out again by where they stand on the page, one column at a time. courtlistener-structure
grade reads the sheet as --scans: no network, no PDF, seconds. A case whose page numbers cannot be read is left out.
The PDFs stay where they are: their images are of use beyond this sheet.
"""
import collections, concurrent.futures, json, os, re, sys
import fitz

scans, out = sys.argv[1:3] if len(sys.argv) >= 3 else (None, None)
WORKERS = 3
LINE = 5.0  # points: words nearer than this in height stand on one line
TWO_COLUMNS = 0.12  # at most this share of lines may cross the middle of a two-column page


def lines_of(words):
    lines = []
    for word in sorted(words, key=lambda word: (word[1], word[0])):
        if lines and abs(lines[-1][0] - word[1]) <= LINE:
            lines[-1][1].append(word)
        else:
            lines.append((word[1], [word]))
    return [sorted(line[1], key=lambda word: word[0]) for line in lines]


def laid_out(page):
    words = page.get_text("words")
    if not words:
        return ""
    middle = page.rect.width / 2
    lines = lines_of(words)
    body = lines[1:] if len(lines) > 1 else lines
    crossing = sum(1 for line in body if line[0][0] < middle < line[-1][2] and any(word[0] < middle < word[2] for word in line) or
                   (line[0][2] < middle and line[-1][0] > middle and any(after[0] - before[2] < 6 for before, after in zip(line, line[1:]) if before[2] <= middle <= after[0])))
    if body and crossing / len(body) <= TWO_COLUMNS:
        head, rest = lines[:1], [word for line in lines[1:] for word in line]
        left = [word for word in rest if word[2] <= middle or (word[0] + word[2]) / 2 < middle]
        right = [word for word in rest if not (word[2] <= middle or (word[0] + word[2]) / 2 < middle)]
        lines = head + lines_of(left) + lines_of(right)
    return "\n".join(" ".join(word[4] for word in line) for line in lines)


def first_page(texts):
    """The number of the first physical page: the offset most pages agree on, so that one misread header changes nothing."""
    offsets = collections.Counter()
    for at, text in enumerate(texts):
        for number in re.findall(r"(?<![\d.,])(\d{1,5})(?![\d,])", text[:90]):
            offsets[int(number) - at] += 1
    if not offsets:
        return None
    offset, count = offsets.most_common(1)[0]
    return offset if count >= max(2, len(texts) // 3) or len(texts) <= 2 else None


def read_scan(path):
    try:
        doc = fitz.open(path)
        pages = [laid_out(doc[at]) for at in range(len(doc))]
        first = first_page(pages)
    except Exception:
        return None
    return None if first is None else (first, pages)


if __name__ == "__main__":
    held = set()
    if os.path.exists(out):
        with open(out, encoding="utf-8") as sheet:
            held = {json.loads(line[:line.index(', "first"')] + "}")["cluster"] for line in sheet}
    names = [name for name in sorted(os.listdir(scans)) if name.endswith(".pdf") and name[:-4] not in held and os.path.getsize(os.path.join(scans, name)) > 0]
    written = skipped = 0
    with open(out, "a", encoding="utf-8", newline="\n") as sheet, concurrent.futures.ProcessPoolExecutor(WORKERS) as pool:
        for name, read in zip(names, pool.map(read_scan, [os.path.join(scans, name) for name in names], chunksize=8)):
            if read is None:
                skipped += 1
                continue
            sheet.write(json.dumps({"cluster": name[:-4], "first": read[0], "pages": read[1]}, ensure_ascii=False) + "\n")
            written += 1
    print("cases new", written, "already held", len(held), "page numbers unreadable", skipped)
