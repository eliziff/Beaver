"""Word alignment of a PDF's lines with the A2AJ text of the same decision.

Words are runs of letters or of digits, compatibility- and case-folded, so punctuation, spacing,
quotation marks and a note call glued to its word ("word1", "2006,[1]") read the same on both
sides. A word broken by a hyphen at a line end is read whole. Unique four-word shingles shared by
both sides anchor the alignment; the longest chain of anchors in order on both sides is kept and
the words between consecutive anchors are matched with difflib.
"""
from bisect import bisect_left
from difflib import SequenceMatcher
import unicodedata

from blocks import FOLD

SHINGLE = 4


def kind(char):
    return "d" if char.isdigit() else "a" if char.isalpha() else None


def words(text):
    """[(word, start, end)] over text (code point offsets)."""
    out, start, current, folded = [], None, None, []
    def close(end):
        if folded: out.append(("".join(folded), start, end))
    for at, char in enumerate(text):
        norm = unicodedata.normalize("NFKC", char).translate(FOLD).casefold()
        k = kind(norm[:1]) if norm else None
        if k is None or k != current:
            close(at); folded, start, current = [], at, k
        if k is not None: folded.append("".join(c for c in norm if kind(c) == k))
    close(len(text))
    return out


def line_words(lines):
    """Words over a list of line texts: [(word, [(line, start, end)])]. A line ending in a letter
    and a hyphen whose next line opens with a lower-case letter joins its last word to that one."""
    out, carry = [], None
    for n, text in enumerate(lines):
        found = words(text)
        if carry is not None and found and text.lstrip()[:1].islower():
            word, pieces = carry
            first = found.pop(0)
            out.append((word + first[0], pieces + [(n, first[1], first[2])]))
        elif carry is not None:
            out.append(carry)
        carry = None
        stripped = text.rstrip()
        for k, (word, a, b) in enumerate(found):
            if k == len(found) - 1 and stripped.endswith("-") and b == len(stripped) - 1 and word.isalpha():
                carry = (word, [(n, a, b)])
            else:
                out.append((word, [(n, a, b)]))
    if carry is not None: out.append(carry)
    return out


def shingles(seq):
    return [tuple(seq[k:k + SHINGLE]) for k in range(len(seq) - SHINGLE + 1)]


def overlap(left, right):
    """Share of left's shingles found in right, and of right's in left."""
    a, b = set(shingles(left)), set(shingles(right))
    if not a or not b: return 0.0, 0.0
    common = len(a & b)
    return common / len(a), common / len(b)


def unique_positions(seq):
    seen = {}
    for k, s in enumerate(shingles(seq)):
        seen[s] = -1 if s in seen else k
    return {s: k for s, k in seen.items() if k >= 0}


def chain(pairs):
    """Longest chain of (i, j) increasing in both, pairs sorted by i."""
    tails, tail_at, back = [], [], [None] * len(pairs)
    for n, (_, j) in enumerate(pairs):
        k = bisect_left(tails, j)
        if k == len(tails): tails.append(j); tail_at.append(n)
        else: tails[k] = j; tail_at[k] = n
        back[n] = tail_at[k - 1] if k else None
    out, n = [], tail_at[-1] if tail_at else None
    while n is not None: out.append(pairs[n]); n = back[n]
    return out[::-1]


def match(left, right, left_free=None, right_free=None):
    """{i: j} word matches between two word sequences, in order on both sides. left_free and
    right_free, where given, restrict the words that may match (indexes)."""
    li = [i for i in range(len(left)) if left_free is None or i in left_free]
    rj = [j for j in range(len(right)) if right_free is None or j in right_free]
    a, b = [left[i] for i in li], [right[j] for j in rj]
    ua, ub = unique_positions(a), unique_positions(b)
    anchors = chain(sorted((ua[s], ub[s]) for s in ua.keys() & ub.keys()))
    result = {}
    def fill(a0, a1, b0, b1):
        if a1 <= a0 or b1 <= b0: return
        if (a1 - a0) * (b1 - b0) > 4_000_000: return  # an unanchored stretch this long is no alignment
        for block in SequenceMatcher(None, a[a0:a1], b[b0:b1], autojunk=False).get_matching_blocks():
            for k in range(block.size): result[li[a0 + block.a + k]] = rj[b0 + block.b + k]
    pa = pb = 0
    for i, j in anchors:
        if i < pa or j < pb: continue
        fill(pa, i, pb, j)
        for k in range(SHINGLE): result[li[i + k]] = rj[j + k]
        pa, pb = i + SHINGLE, j + SHINGLE
    fill(pa, len(a), pb, len(b))
    return result
