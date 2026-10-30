"""Proof sheets for the alignment records, drawn round-robin over the documents (seeded), each cropped from its page
image, to be read against the picture: lines (anchored, filled and moved alike) and numbered paragraphs with A2AJ's
text beside them in OUT/lines.txt, and words of each kind of pairing (exact, fuzzy, forced, split, merged, moved),
the word boxed in its line and A2AJ's word written above it, in OUT/words-<kind>-<n>.png. OUT is scratch: delete it
afterwards. Run through run.py proof."""
import json
import random
from pathlib import Path

import fitz
from PIL import Image, ImageDraw, ImageFont

WORD_KINDS = ("exact", "fuzzy", "forced", "split", "merged", "moved")


def draw(pools, count, rng):
    """`count` picks, one document's at a time, each document's pool shuffled."""
    for _, pool in pools: rng.shuffle(pool)
    picks, at = [], 0
    while len(picks) < count and any(pool for _, pool in pools):
        record, pool = pools[at % len(pools)]
        at += 1
        if pool: picks.append((record, pool.pop()))
    return picks


def crop(document, record, page, rects, mark=None):
    """The page region holding `rects` (in the reading's units, scaled to the PDF's page), `mark` boxed in red."""
    pdf = document[page - 1]
    width, height = record["pages"][str(page)]
    sx, sy = pdf.rect.width / width, pdf.rect.height / height
    x0, y0 = min(r[0] for r in rects) * sx - 6, min(r[1] for r in rects) * sy - 4
    x1, y1 = max(r[2] for r in rects) * sx + 6, max(r[3] for r in rects) * sy + 4
    pix = pdf.get_pixmap(dpi=160, clip=fitz.Rect(x0, y0, x1, y1))
    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    if mark:
        k = 160 / 72
        ImageDraw.Draw(image).rectangle([(mark[0] * sx - x0) * k - 2, (mark[1] * sy - y0) * k - 2,
                                         (mark[2] * sx - x0) * k + 2, (mark[3] * sy - y0) * k + 2], outline="red", width=2)
    scale = min(1.0, 1000 / image.width)
    return image.resize((int(image.width * scale), int(image.height * scale)))


def word_pools(records, texts):
    """Per record, its paired words by kind: (line, PDF word box, A2AJ's span). A split is half a word of A2AJ's."""
    pools = {kind: [] for kind in WORD_KINDS}
    for r in records:
        found = {kind: [] for kind in WORD_KINDS}
        for line in r["lines"]:
            text = texts(r, line["lang"]) if line["lang"] else ""
            inside = lambda a, b: a > 0 and text[a - 1].isalnum() or b < len(text) and text[b].isalnum()
            boxes = {(b[0], b[1]): b[2:] for b in line.get("boxes", [])}
            by_pdf = {}
            for s, e, a, b, kind in line["words"]: by_pdf.setdefault((s, e), []).append((a, b, kind))
            for (s, e), spans in by_pdf.items():
                box = boxes.get((s, e)) or next((v for (bs, be), v in boxes.items() if bs <= s < be), None)
                if not box: continue
                a, b, kind = spans[0]
                kind = ("moved" if line["status"] == "moved" else "merged" if len(spans) > 1 else
                        "split" if inside(a, b) else kind)
                found.setdefault(kind, []).append((line, box, (a, spans[-1][1])))
        for kind in WORD_KINDS: pools[kind].append((r, found.get(kind, [])))
    return pools


def sheets(records, out, lines, paragraphs, seed, work, words=0, texts=None):
    rng, out = random.Random(seed), Path(out)
    rng.shuffle(records)
    line_pools = [(r, [l for l in r["lines"] if l["status"] != "unmatched" and len((l["exact"] or "").split()) >= 2]) for r in records]
    passage_pools = []
    for r in records:
        path = work / "passages" / f"{r['pair']['sha256']}.json"
        if path.is_file():
            passage_pools.append((r, [p for p in json.loads(path.read_text(encoding="utf-8"))["paragraphs"] if p["lines"]]))
    out.mkdir(parents=True, exist_ok=True)
    crops, notes, opened = [], [], {}
    for record, line in draw(line_pools, lines, rng):
        document = opened.setdefault(record["pair"]["sha256"], fitz.open(record["pair"]["path"]))
        crops.append(crop(document, record, line["page"], [line["bbox"]]))
        notes.append(f"[line {line['status']}/{line['lang']}] {record['pair']['citation']} {line['id']}\n"
                     f"     pdf:  {line['text']}\n     a2aj: {line['exact']}")
    for record, paragraph in draw(passage_pools, paragraphs, rng):
        document = opened.setdefault(record["pair"]["sha256"], fitz.open(record["pair"]["path"]))
        boxes = {l["id"]: l["bbox"] for l in record["lines"]}
        first_page = paragraph["lines"][0][1]
        crops.append(crop(document, record, first_page, [boxes[i] for i, page, _, _ in paragraph["lines"] if page == first_page]))
        notes.append(f"[paragraph {paragraph['number']}, placed {paragraph['placed']:.0%}, page {first_page} of "
                     f"{sorted({p for _, p, _, _ in paragraph['lines']})}] {record['pair']['citation']}\n     a2aj: {paragraph['text'][:600]}")
    for sheet, start in enumerate(range(0, len(crops), 4), 1):
        group = crops[start:start + 4]
        canvas = Image.new("RGB", (1060, sum(c.height + 22 for c in group)), "white")
        y = 0
        for number, image in enumerate(group, start + 1):
            ImageDraw.Draw(canvas).text((4, y + 4), str(number), fill="red")
            canvas.paste(image, (40, y + 4))
            y += image.height + 22
        canvas.save(out / f"sheet-{sheet}.png")
    (out / "lines.txt").write_text("\n".join(f"{n:2d} {note}" for n, note in enumerate(notes, 1)), encoding="utf-8")
    print(f"{len(notes)} proofs: {out / 'lines.txt'} and {len(range(0, len(crops), 4))} sheets")
    if not words: return
    font = ImageFont.truetype("arial.ttf", 20)
    listing = []
    for kind, pools in word_pools(records, texts).items():
        picks = draw(pools, words, rng)
        rows = []
        for record, (line, box, (a, b)) in picks:
            document = opened.setdefault(record["pair"]["sha256"], fitz.open(record["pair"]["path"]))
            text = texts(record, line["lang"])[a:b]
            rows.append((crop(document, record, line["page"], [line["bbox"]], box), text))
            listing.append(f"{kind}\t{record['pair']['citation']}\t{line['id']}\t{text}\t{line['text']}")
        for sheet, start in enumerate(range(0, len(rows), 8), 1):
            group = rows[start:start + 8]
            canvas = Image.new("RGB", (1060, sum(image.height + 34 for image, _ in group)), "white")
            y = 0
            for number, (image, text) in enumerate(group, start + 1):
                ImageDraw.Draw(canvas).text((4, y + 4), f"{number}  {text}", fill="blue", font=font)
                canvas.paste(image, (40, y + 30))
                y += image.height + 34
            canvas.save(out / f"words-{kind}-{sheet}.png")
    (out / "words.txt").write_text("\n".join(listing), encoding="utf-8")
    print(f"{len(listing)} word proofs: {out / 'words.txt'} and words-<kind>-<n>.png")
