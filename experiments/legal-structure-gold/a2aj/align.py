"""The A2AJ aligner's Python face. The aligner is the Rust crate in aligner/ (cargo build --release there, which leaves
the library in its own target folder): a PDF's lines aligned with A2AJ's text of the same decision, word by word, and
the record each PDF keeps of it. Every rule of the alignment lives there, once; this file only calls it, for run.py's
records and for the words and page rules the gold's labelling reads by.
"""
import ctypes
import json
from functools import lru_cache
from pathlib import Path

LIBRARY = ctypes.CDLL(str(Path(__file__).resolve().parent / "aligner/target/release/a2aj_align.dll"))
LIBRARY.a2aj_call.restype = ctypes.POINTER(ctypes.c_char)
LIBRARY.a2aj_call.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
LIBRARY.a2aj_free.argtypes = [ctypes.POINTER(ctypes.c_char), ctypes.c_size_t]


def call(op, **args):
    body = json.dumps(args, ensure_ascii=False).encode("utf-8")
    size = ctypes.c_size_t()
    reply = LIBRARY.a2aj_call(op.encode(), body, len(body), ctypes.byref(size))
    try:
        answer = json.loads(ctypes.string_at(reply, size.value))
    finally:
        LIBRARY.a2aj_free(reply, size.value)
    if "error" in answer:
        raise RuntimeError(f"aligner {op}: {answer['error']}")
    return answer["ok"]


CODE = call("code")  # what a record is stamped with: only a change to the crate makes a record stale


@lru_cache(maxsize=1 << 15)
def words_of(text, start=0):
    """(normalised word, start, end) for every word of text[start:]; offsets are into text. Kept, as a reference text is
    read whole several times over."""
    return tuple(tuple(word) for word in call("words_of", text=text, start=start))


def edit_distance(a, b):
    return call("edit_distance", a=a, b=b)


def number_like(text):
    """A page number as printed: one or two numbers or short roman numerals, with at most the words page/of/p."""
    return call("number_like", text=text)


def masked(text):
    """A line's words with their digits masked."""
    return call("masked", text=text)


def margin(box, page):
    """Where a line sits: 'head' (top or bottom tenth of the page), 'side' (outside the middle four fifths across, or
    set sideways) or None."""
    return call("margin", bbox=box, page=page)


def same_row(a, b):
    """Whether two lines (each with its page and bbox) stand on one row of their page."""
    return a.get("page") == b.get("page") and call("same_row", a=a.get("bbox"), b=b.get("bbox"))


def page_number(line, lines):
    """A number in the page head or foot that is no paragraph's number: not bracketed, and no text begins just after it
    on its row."""
    others = [(other["text"], other.get("bbox")) for other in lines if other is not line and other["page"] == line["page"]]
    return call("page_number", text=line["text"], bbox=line.get("bbox"), others=others)


def placed(lines):
    return [{"page": line["page"], "bbox": line["bbox"], "text": line["text"]} for line in lines]


def column_order(lines, pages):
    """Indices of a record's lines in reading order by column ({page: [width, height]}, as a record keeps them)."""
    return call("column_order", lines=placed(lines), pages=pages)


def in_gutter(lines, pages):
    """Ids of the lines of a few characters in the gutter of a page in two columns."""
    return {lines[i]["id"] for i in call("in_gutter", lines=placed(lines), pages=pages)}


def start_of(text, language):
    """Where the decision proper begins in A2AJ's text of it."""
    return call("start_of", text=text, language=language)


def trimmed(text):
    """A decision's text as the census read it: its JavaScript white space trimmed, so the listing's offsets hold."""
    return call("trimmed", text=text)


def align_all(work, a2aj, only, limit):
    """Align every read pair (of those `only` names) without a current record -> work/records/<sha>.json.gz, on every
    core; its progress goes to standard output. Returns how many and how long."""
    return call("align_all", work=str(work), a2aj=str(a2aj), only=only, limit=limit)
