"""A PDF's lines aligned with a clean text of the same decision, word by word. Standard library only, deterministic.

pair(lines, text, start, exclude) pairs the PDF's words, in reading order, with the words of `text`.
  lines    [{"text": str}, ...]  the parser's lines, page by page
  text     the reference text (A2AJ's unofficial text); `start` is where the decision proper begins;
           `exclude` lists [begin, end) spans of it that earlier passes already gave to other lines
Pairing.words() is the alignment itself: each paired PDF word's line and offsets in it, the span of `text` it
stands for, and whether it reads exactly so (exact), is a close misreading (fuzzy) or is placed by its neighbours
alone (forced). slices(pairing) reads
each line's exact text off it: always text copied from `text`, never edited or reordered.
Words are compared normalised (case, accents, ligatures, apostrophes, spacing); a word the print breaks
across two lines, or the reader cuts in two, pairs with the reference word as a split, each half standing
for its part of it; two reference words the reader runs together pair with the one PDF word (a merge).

Method: runs of 6, 4, 3 and 2 words that are unique in the OCR and in the text are chained by longest
increasing subsequence (patience diff) and grown while the words keep agreeing; what lies between the
anchors is aligned by word edit distance. A line is then
  anchored   its first and last words are both pinned by exactly matching words;
  filled     it lies between pinned lines but is garbled at an end: its slice runs between its pinned
             words, extended over the free words next to a garbled end; or nothing in it matched and it
             takes the free words between its neighbours, if it still resembles them;
  unmatched  the text has nothing for it (running heads, folios, the other language's column): it keeps
             its OCR text.
"""
from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left, bisect_right
from functools import lru_cache

WORD = re.compile(r"[^\W_]+(?:['’‘ʼ`´][^\W_]+)*", re.UNICODE)
APOSTROPHE = re.compile(r"['’‘ʼ`´]")
LIGATURES = (("æ", "ae"), ("œ", "oe"), ("ĳ", "ij"))
TRAILING = ".,;:!?)]}»”’…—–%*"
LEADING = "([{«“‘$"
LEVELS = (6, 4, 3, 2)
CELL_LIMIT = 1_000_000  # a gap this big between anchors is text one side lacks (a wrong document, a language not printed)
GAP = -0.4
MIN_RESEMBLANCE = 0.5


@lru_cache(maxsize=1 << 18)
def norm(word: str) -> str:
    """A word as compared: no accents, ligatures, apostrophes or case."""
    word = unicodedata.normalize("NFKD", word)
    word = "".join(c for c in word if not unicodedata.combining(c))
    word = APOSTROPHE.sub("", word).casefold()
    for ligature, plain in LIGATURES:
        word = word.replace(ligature, plain)
    return word


@lru_cache(maxsize=1 << 15)
def words_of(text: str, start: int = 0):
    """(normalised word, start, end) for every word of text[start:]; offsets are into text. Kept, as a reference text
    is read whole several times over."""
    found = [(norm(m.group()), m.start(), m.end()) for m in WORD.finditer(text, start)]
    return tuple(t for t in found if t[0])


def edit_distance(a: str, b: str) -> int:
    """Levenshtein distance, a column of the table at a time in the bits of one integer (Myers, Hyyrö): whole lines
    are compared this way thousands of times a document."""
    if a == b:
        return 0
    if not a or not b:
        return len(a) + len(b)
    full, top = (1 << len(a)) - 1, 1 << (len(a) - 1)
    peq = {}
    for i, c in enumerate(a):
        peq[c] = peq.get(c, 0) | 1 << i
    pv, mv, score = full, 0, len(a)
    for c in b:
        eq = peq.get(c, 0)
        xv = eq | mv
        xh = (((eq & pv) + pv) ^ pv) | eq
        ph = mv | ~(xh | pv) & full
        mh = pv & xh
        score += (ph & top > 0) - (mh & top > 0)
        ph = (ph << 1 | 1) & full
        mh = (mh << 1) & full
        pv = mh | ~(xv | ph) & full
        mv = ph & xv
    return score


def similarity(a: str, b: str) -> float:
    return 1.0 - edit_distance(a, b) / max(len(a), len(b), 1)


def resemblance(ocr: str, exact: str) -> float:
    """How alike two lines read, by their normalised words."""
    a = " ".join(w for w, _, _ in words_of(ocr))
    b = " ".join(w for w, _, _ in words_of(exact))
    return similarity(a, b) if a or b else 0.0


def unlike(ocr: str, word: str) -> bool:
    """A number against a word of letters, of two characters or more: no misreading of the one."""
    return max(len(ocr), len(word)) >= 2 and (ocr.isdigit() and word.isalpha() or ocr.isalpha() and word.isdigit())


def longest_increasing(sequence):
    """Indices of a longest strictly increasing subsequence."""
    tails, tail_at, previous = [], [], [-1] * len(sequence)
    for i, value in enumerate(sequence):
        at = bisect_left(tails, value)
        if at == len(tails):
            tails.append(value)
            tail_at.append(i)
        else:
            tails[at] = value
            tail_at[at] = i
        previous[i] = tail_at[at - 1] if at else -1
    chain, i = [], tail_at[-1] if tail_at else -1
    while i != -1:
        chain.append(i)
        i = previous[i]
    return chain[::-1]


def offset_of(text, atoken, length):
    """Offset inside a reference word where its first `length` normalised characters end."""
    _, start, end = atoken
    taken = 0
    for at in range(start, end):
        taken += len(norm(text[at]))
        if taken >= length:
            return at + 1
    return end


class Pairing:
    """OCR words against reference words: o2a[i] is the reference word OCR word i stands for, or -1.

    Two OCR words may stand together for one reference word (the print broke it at a line's end, the
    reader cut it at a ligature, or a margin letter fell inside it): partner records the pair; both map
    to the same reference word. One OCR word may stand for two reference words the print or the reader
    ran together ("redressilegal"): merged[o] is the second."""

    def __init__(self, lines, text, start, exclude=()):
        self.lines, self.text = lines, text
        atokens = words_of(text, start)
        if exclude:
            begins = sorted(exclude)
            starts = [b for b, _ in begins]

            def excluded(token):
                at = bisect_right(starts, token[1]) - 1
                return at >= 0 and token[1] < begins[at][1]
            atokens = [t for t in atokens if not excluded(t)]
        self.atokens = atokens
        self.A = [t[0] for t in atokens]
        self.O, self.line_of, self.offsets = [], [], []
        self.line_tokens = [[] for _ in lines]
        for k, line in enumerate(lines):
            for word, begin, end in words_of(line["text"]):
                self.line_tokens[k].append(len(self.O))
                self.O.append(word)
                self.line_of.append(k)
                self.offsets.append((begin, end))
        self.break_after = [i + 1 < len(self.O) and self.line_of[i + 1] != self.line_of[i] for i in range(len(self.O))]
        self.o2a = [-1] * len(self.O)
        self.kind = [""] * len(self.O)
        self.a_owner = [-1] * len(self.A)
        self.partner = {}  # o -> its other half, for the two words of a split
        self.merged = {}  # o -> the second reference word it stands for
        self.cuts = {}  # o -> its part of a split word, once the pairing is done

    def link(self, o, a, kind):
        self.o2a[o], self.a_owner[a], self.kind[o] = a, o, kind

    def last(self, o):
        """The last reference word OCR word o stands for."""
        return self.merged.get(o, self.o2a[o])

    def unlink(self, o):
        for t in {o, self.partner.pop(o, o)}:
            self.partner.pop(t, None)
            if t in self.merged:
                self.a_owner[self.merged.pop(t)] = -1
            if self.o2a[t] >= 0 and self.a_owner[self.o2a[t]] in (o, t):
                self.a_owner[self.o2a[t]] = -1
            self.o2a[t], self.kind[t] = -1, ""

    # -- anchors -----------------------------------------------------------------------------------
    def anchor_gap(self, gap, n):
        olo, ohi, alo, ahi = gap
        if ohi - olo < n or ahi - alo < n:
            return
        O, A = self.O, self.A
        in_a = {}
        for a in range(alo, ahi - n + 1):
            in_a.setdefault(tuple(A[a:a + n]), []).append(a)
        in_o = {}
        for o in range(olo, ohi - n + 1):
            gram = tuple(O[o:o + n])
            if gram in in_a:
                in_o.setdefault(gram, []).append(o)
        pairs = sorted((positions[0], in_a[gram][0]) for gram, positions in in_o.items()
                       if len(positions) == 1 and len(in_a[gram]) == 1)
        for at in longest_increasing([a for _, a in pairs]):
            o, a = pairs[at]
            for j in range(n):
                if self.o2a[o + j] < 0 and self.a_owner[a + j] < 0:
                    self.link(o + j, a + j, "exact")
        # grow every pinned run while the words keep agreeing, to the right and then to the left
        for o in range(olo, ohi):
            a, step = self.o2a[o], 1
            while a >= 0 and o + step < ohi and a + step < ahi and self.o2a[o + step] < 0 \
                    and self.a_owner[a + step] < 0 and O[o + step] == A[a + step]:
                self.link(o + step, a + step, "exact")
                step += 1
        for o in range(ohi - 1, olo - 1, -1):
            a, step = self.o2a[o], 1
            while a >= 0 and o - step >= olo and a - step >= alo and self.o2a[o - step] < 0 \
                    and self.a_owner[a - step] < 0 and O[o - step] == A[a - step]:
                self.link(o - step, a - step, "exact")
                step += 1

    def gaps_in(self, gap):
        """The stretches of a gap between its pinned words that have words on both sides."""
        olo, ohi, alo, ahi = gap
        found, previous_o, previous_a = [], olo - 1, alo - 1
        for o in range(olo, ohi + 1):
            if o < ohi and self.o2a[o] < 0:
                continue
            a = self.o2a[o] if o < ohi else ahi
            if o - previous_o > 1 and a - previous_a > 1:
                found.append((previous_o + 1, o, previous_a + 1, a))
            previous_o, previous_a = o, a
        return found

    @staticmethod
    def pair_score(o, a):
        if o == a:
            return 2.0
        if len(o) < 3 or len(a) < 3 or abs(len(o) - len(a)) > max(len(o), len(a)) / 2:
            return None
        sim = similarity(o, a)
        return 2 * sim - 0.6 if sim >= 0.6 else None

    @staticmethod
    def split_score(first, second, a):
        """Two OCR words read together as one reference word (also two reference words read as one OCR word),
        when together they read more like it than either alone ("[TRADUCTiION]" is "traduction", not "traduction le")."""
        joined = first + second
        if joined == a:
            return 2.0
        if len(a) < 5 or abs(len(joined) - len(a)) > 2:
            return None
        sim = similarity(joined, a)
        if sim < 0.75 or sim <= max(similarity(first, a), similarity(second, a)):
            return None
        return 2 * sim - 0.6

    def dp_gap(self, gap):
        """Align a small gap by word edit distance: exact words and close misreadings pair up, and so do
        a word the print broke across a line or the reader cut in two (with a margin letter of one or two
        characters fallen between the halves), and two words the reader ran together."""
        olo, ohi, alo, ahi = gap
        m, n = ohi - olo, ahi - alo
        if m * n > CELL_LIMIT:
            return
        O, A = self.O, self.A
        back = [bytearray(n + 1) for _ in range(m + 1)]
        for j in range(1, n + 1):
            back[0][j] = 2
        rows = [[GAP * j for j in range(n + 1)]]
        for i in range(1, m + 1):
            previous = rows[-1]
            current = [GAP * i] + [0.0] * n
            back[i][0] = 1
            word = O[olo + i - 1]
            before = O[olo + i - 2] if i >= 2 else None
            around = O[olo + i - 3] if i >= 3 and len(before) <= 2 else None
            for j in range(1, n + 1):
                best, move = previous[j] + GAP, 1
                if current[j - 1] + GAP > best:
                    best, move = current[j - 1] + GAP, 2
                a = A[alo + j - 1]
                score = self.pair_score(word, a)
                if score is not None and previous[j - 1] + score >= best:
                    best, move = previous[j - 1] + score, 0
                if before is not None:
                    score = self.split_score(before, word, a)
                    if score is not None and rows[i - 2][j - 1] + score >= best:
                        best, move = rows[i - 2][j - 1] + score, 3
                if around is not None:
                    score = self.split_score(around, word, a)
                    if score is not None and rows[i - 3][j - 1] + score >= best:
                        best, move = rows[i - 3][j - 1] + score, 5
                # two reference words read as one ("[f]or" as "flor"), but no paragraph's "6" swallowed into the
                # "L'HUREUX" after it
                if j >= 2 and (A[alo + j - 2] + a == word or not unlike(A[alo + j - 2], a)):
                    score = self.split_score(A[alo + j - 2], a, word)
                    if score is not None and previous[j - 2] + score >= best:
                        best, move = previous[j - 2] + score, 4
                current[j], back[i][j] = best, move
            rows.append(current)
            if i >= 4:
                rows[i - 4] = None
        i, j = m, n
        while i > 0 or j > 0:
            move = back[i][j]
            if i > 0 and j > 0 and move == 0:
                o, a = olo + i - 1, alo + j - 1
                self.link(o, a, "exact" if O[o] == A[a] else "fuzzy")
                i, j = i - 1, j - 1
            elif j > 0 and move in (3, 5):
                width = 2 if move == 3 else 3
                first, second, a = olo + i - width, olo + i - 1, alo + j - 1
                kind = "exact" if O[first] + O[second] == A[a] else "fuzzy"
                self.link(first, a, kind)
                self.o2a[second], self.kind[second] = a, kind
                self.partner[first], self.partner[second] = second, first
                i, j = i - width, j - 1
            elif i > 0 and j > 1 and move == 4:
                o, a = olo + i - 1, alo + j - 2
                self.link(o, a, "exact" if A[a] + A[a + 1] == O[o] else "fuzzy")
                self.a_owner[a + 1], self.merged[o] = o, a + 1
                i, j = i - 1, j - 2
            elif i > 0 and (j == 0 or move == 1):
                i -= 1
            else:
                j -= 1

    def run(self):
        gaps = [(0, len(self.O), 0, len(self.A))]
        for n in LEVELS:
            following = []
            for gap in gaps:
                self.anchor_gap(gap, n)
                following.extend(self.gaps_in(gap))
            gaps = following
        for gap in gaps:
            self.dp_gap(gap)
        self.drop_chance_matches()
        self.force_sandwiched()
        return self

    def force_sandwiched(self):
        """A reference word left alone between two paired neighbours stands for the one PDF word left between
        theirs, however it reads ("1”" for "1er", "(6)" for "(b)" at a line's start): its place decides it; but a
        number does not stand for a word of letters, nor the reverse ("53", a paragraph's number in the margin, for
        "by", a word A2AJ's text lacks). Where other lines come between (a page's running head and folio, the
        other language's column), what counts is the end of the one neighbour's line and the start of the other's,
        and what is there must read like the word: one word, or two together (a word broken across a page)."""
        for a in range(1, len(self.A) - 1):
            if self.a_owner[a] >= 0 or self.a_owner[a - 1] < 0 or self.a_owner[a + 1] < 0:
                continue
            before = self.a_owner[a - 1]
            before, after = max(before, self.partner.get(before, before)), self.a_owner[a + 1]
            between = list(range(before + 1, after))
            if len(between) == 1 and not unlike(self.O[between[0]], self.A[a]):
                self.link(between[0], a, "forced")
                continue
            between = [t for t in between if self.line_of[t] in (self.line_of[before], self.line_of[after])]
            if len(between) == 1 and similarity(self.O[between[0]], self.A[a]) >= MIN_RESEMBLANCE:
                self.link(between[0], a, "forced")
            elif len(between) == 2 and self.line_of[between[0]] != self.line_of[between[1]] \
                    and similarity(self.O[between[0]] + self.O[between[1]], self.A[a]) >= MIN_RESEMBLANCE:
                first, second = between
                self.link(first, a, "forced")
                self.o2a[second], self.kind[second] = a, "forced"
                self.partner[first], self.partner[second] = second, first

    def drop_chance_matches(self):
        """A line of four or more words with under 30% of them matched agrees by chance (the other
        language's column, running heads); a short line's match must sit next to its neighbours' on
        one side at least."""
        for tokens in self.line_tokens:
            hits = [t for t in tokens if self.o2a[t] >= 0]
            if hits and len(tokens) >= 4 and len(hits) < 0.3 * len(tokens):
                for t in hits:
                    if self.o2a[t] >= 0:
                        self.unlink(t)
        matched = [t for t in range(len(self.O)) if self.o2a[t] >= 0]
        where = [self.o2a[t] for t in matched]
        for position, t in enumerate(matched):
            if len(self.line_tokens[self.line_of[t]]) > 3 or self.o2a[t] < 0:
                continue
            before = position == 0 or where[position] - where[position - 1] > 3
            after = position + 1 == len(matched) or where[position + 1] - where[position] > 3
            if before and after:
                self.unlink(t)


    def edges(self, t):
        """Offsets of the part of the reference word that PDF word t stands for (of both, for a merge)."""
        atoken = self.atokens[self.o2a[t]]
        if t not in self.partner:
            return atoken[1], self.atokens[self.last(t)][2]
        if t not in self.cuts:
            self.cuts[t] = self.cut(t, atoken)
        return self.cuts[t]

    def cut(self, t, atoken):
        """The offsets of PDF word t's half of a split reference word."""
        first, second = sorted((t, self.partner[t]))
        a = atoken[0]
        # the cut that makes the two pieces read most like the two halves of the reference word
        cut = min(range(1, max(2, len(a))), key=lambda c: (
            edit_distance(self.O[first], a[:c]) + edit_distance(self.O[second], a[c:]), abs(c - len(self.O[first]))))
        at = offset_of(self.text, atoken, cut)
        return (atoken[1], at) if t == first else (at, atoken[2])

    def words(self):
        """Each paired PDF word: [line, start, end, text start, text end, kind], in reading order; a PDF word
        that stands for two reference words is paired with each."""
        out = []
        for t in range(len(self.O)):
            if self.o2a[t] < 0:
                continue
            if t in self.merged:
                out += [[self.line_of[t], *self.offsets[t], *self.atokens[a][1:], self.kind[t]] for a in (self.o2a[t], self.merged[t])]
            else:
                out.append([self.line_of[t], *self.offsets[t], *self.edges(t), self.kind[t]])
        return out


def pair(lines, text, start=0, exclude=()):
    return Pairing(lines, text, start, exclude).run()


def slices(pairing):
    """One result per line: {status, exact, span}; exact is the slice of the text, or the line's own text when
    unmatched, and span its [start, end) offsets into the text."""
    lines = pairing.lines
    text, O, o2a, kind, atokens, a_owner = pairing.text, pairing.O, pairing.o2a, pairing.kind, pairing.atokens, pairing.a_owner
    partner, edges = pairing.partner, pairing.edges
    claimed = [False] * len(atokens)  # reference words taken by an extension

    spans = [None] * len(lines)  # [first word, last word, start, end, first token, last token]
    for k, tokens in enumerate(pairing.line_tokens):
        hits = [t for t in tokens if o2a[t] >= 0]
        if not hits:
            continue
        first, last = hits[0], hits[-1]
        a0, a1 = o2a[first], pairing.last(last)
        begin, finish = edges(first)[0], edges(last)[1]
        lead, trail = tokens.index(first), len(tokens) - 1 - tokens.index(last)
        starts_inside = first in partner and partner[first] < first
        ends_inside = last in partner and partner[last] > last
        while lead > 0 and not starts_inside and a0 - 1 >= 0 and a_owner[a0 - 1] < 0 and not claimed[a0 - 1]:
            a0 -= 1
            lead -= 1
            claimed[a0] = True
            begin = atokens[a0][1]
        while trail > 0 and not ends_inside and a1 + 1 < len(atokens) and a_owner[a1 + 1] < 0 \
                and not claimed[a1 + 1]:
            a1 += 1
            trail -= 1
            claimed[a1] = True
            finish = atokens[a1][2]
        spans[k] = [a0, a1, begin, finish, first, last]

    # a line in which nothing matched takes the free words between its neighbours, if they fit it
    k = 0
    while k < len(lines):
        if spans[k] is not None or not pairing.line_tokens[k]:
            k += 1
            continue
        run = k
        while run < len(lines) and spans[run] is None:
            run += 1
        before = next((spans[i] for i in range(k - 1, -1, -1) if spans[i] is not None), None)
        after = spans[run] if run < len(lines) else None
        if before and after:
            free = [a for a in range(before[1] + 1, after[0]) if a_owner[a] < 0 and not claimed[a]]
            members = [i for i in range(k, run) if pairing.line_tokens[i]]
            need = sum(len(pairing.line_tokens[i]) for i in members)
            if free and members and 0.5 * need <= len(free) <= 2.0 * need + 1:
                weight = [max(1, len(lines[i]["text"].strip())) for i in members]
                total, taken, running = sum(weight), 0, 0
                for i, w in zip(members, weight):
                    running += w
                    stop = round(len(free) * running / total)
                    if stop > taken:
                        chunk = free[taken:stop]
                        spans[i] = [chunk[0], chunk[-1], atokens[chunk[0]][1], atokens[chunk[-1]][2], None, None]
                        taken = stop
        k = run

    results, cursor = [], 0
    for k, line in enumerate(lines):
        span = spans[k]
        if span is None:
            results.append({"status": "unmatched", "exact": line["text"], "span": None})
            continue
        begin, finish = max(span[2], cursor), span[3]
        # punctuation stuck to the first and last word belongs to the line
        while begin > cursor and text[begin - 1] in LEADING:
            begin -= 1
        while finish < len(text) and text[finish] in TRAILING:
            finish += 1
        exact = text[begin:finish].strip()
        if begin >= finish or resemblance(line["text"], exact) < MIN_RESEMBLANCE:
            results.append({"status": "unmatched", "exact": line["text"], "span": None})
            continue
        pinned = span[4] is not None and kind[span[4]] == "exact" and kind[span[5]] == "exact"
        results.append({"status": "anchored" if pinned else "filled", "exact": exact, "span": [begin, finish]})
        cursor = finish
    return results
