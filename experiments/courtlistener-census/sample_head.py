"""Write out opinions from anywhere in CourtListener's opinions dump, for reading.

    python -I sample_head.py OPINIONS_CSV_BZ2 OUT_DIR SAMPLES [MIN_CHARS]

bzip2 compresses in independent blocks, so any part of the 55 GB file decodes on its own. At SAMPLES
evenly spaced byte offsets this finds the next block's 48-bit magic (at any of 8 bit alignments, by
plain byte search), decodes from there until it holds a whole record past the first record start,
and takes the first opinion with at least MIN_CHARS of text in some rendition. Each one's
non-empty renditions and scalar fields go to OUT_DIR/<id>/ exactly as stored:
<rendition>.html|.xml|.txt and fields.json.
"""
import bz2
import csv
import io
import json
import os
import re
import sys
import time

RENDS = {"plain_text": "txt", "html": "html", "html_lawbox": "html", "html_columbia": "html",
         "html_anon_2020": "html", "xml_harvard": "xml", "xml_scan": "xml", "html_with_citations": "html"}
MAGIC = 0x314159265359
RECORD_START = re.compile(rb"\n\"(\d{1,9})\",\"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d")
csv.field_size_limit(2**31 - 1)

# For the magic starting s bits into a byte, bytes 1..5 of its 7-byte span are fixed: search those.
ALIGN = []
for s in range(8):
    v = (MAGIC << (8 - s)).to_bytes(7, "big")
    ALIGN.append((s, v[1:6]))


def block_start(fh, offset, span=4 << 20):
    """(byte, bit) of the first block magic at or after offset."""
    fh.seek(offset)
    buf = fh.read(span)
    best = None
    for s, core in ALIGN:
        i = buf.find(core, 1)
        while i >= 1:
            k = i - 1  # the byte holding the magic's first bit
            window = int.from_bytes(buf[k:k + 7].ljust(7, b"\0"), "big")
            if (window >> (8 - s)) & ((1 << 48) - 1) == MAGIC:
                if best is None or k * 8 + s < best[0] * 8 + best[1]:
                    best = (k, s)
                break
            i = buf.find(core, i + 1)
    return None if best is None else (offset + best[0], best[1])


def decoded_from(fh, byte, bit, chunk=1 << 20):
    """Decoded bytes, in pieces, from the block that starts at (byte, bit)."""
    dec = bz2.BZ2Decompressor()
    at, first = byte, True
    while True:
        fh.seek(at)
        raw = fh.read(chunk + 1)  # one byte past the chunk supplies the shifted-in low bits
        if len(raw) <= 1:
            return
        if bit:
            n = (int.from_bytes(raw, "big") << bit) & ((1 << (len(raw) * 8)) - 1)
            data = n.to_bytes(len(raw), "big")[:chunk]
        else:
            data = raw[:chunk]
        at += chunk
        try:
            out = dec.decompress((b"BZh9" if first else b"") + data)
        except (OSError, EOFError):
            return
        first = False
        if out:
            yield out


def first_opinion(fh, offset, head, min_chars, budget=48 << 20):
    pos = block_start(fh, offset)
    if pos is None:
        return None
    buf = bytearray()
    for piece in decoded_from(fh, *pos):
        buf += piece
        m = RECORD_START.search(buf)
        if not m:
            if len(buf) > budget:
                return None
            continue
        text = bytes(buf[m.start() + 1:])
        # Only records followed by another record start are known to be whole.
        starts = [x.start() for x in RECORD_START.finditer(text)]
        for a, b in zip([0] + starts, starts):
            rec = next(csv.reader(io.StringIO(text[a:b].decode("utf-8", "replace"), newline=""), escapechar="\\", doublequote=False), None)
            if not rec or len(rec) != len(head):
                continue
            row = dict(zip(head, rec))
            texts = {k: row[k] for k in RENDS if row.get(k)}
            if texts and max(len(v) for v in texts.values()) >= min_chars:
                return row, texts
        if len(buf) > budget:
            return None
    return None


def main():
    src, out, samples = sys.argv[1], sys.argv[2], int(sys.argv[3])
    min_chars = int(sys.argv[4]) if len(sys.argv) > 4 else 5000
    with bz2.open(src, "rb") as f:
        head = next(csv.reader(io.TextIOWrapper(f, encoding="utf-8", newline=""), escapechar="\\", doublequote=False))
    size = os.path.getsize(src)
    os.makedirs(out, exist_ok=True)
    taken, t0 = [], time.time()
    with open(src, "rb") as fh:
        for w in range(samples):
            offset = int(size * (w + 0.5) / samples)
            got = first_opinion(fh, offset, head, min_chars)
            if not got:
                continue
            row, texts = got
            d = os.path.join(out, row["id"])
            os.makedirs(d, exist_ok=True)
            for k, v in texts.items():
                with open(os.path.join(d, f"{k}.{RENDS[k]}"), "w", encoding="utf-8", newline="") as wf:
                    wf.write(v)
            with open(os.path.join(d, "fields.json"), "w", encoding="utf-8") as wf:
                json.dump({k: v for k, v in row.items() if k not in RENDS} | {"_file_offset": offset}, wf, indent=1)
            taken.append(row["id"])
    print(json.dumps({"samples": samples, "taken": len(taken), "seconds": round(time.time() - t0, 1)}))


main()
