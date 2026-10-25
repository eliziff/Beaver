"""Label a PDF's exported lines from A2AJ's reading of the same decision.

A2AJ's text is cut into segments: the front matter before the first numbered paragraph (caption,
one segment per A2AJ line; heading where A2AJ reads one), numbered paragraphs (text, their number
the marker), headings, list items (their label the marker), the unnumbered lines inside a
paragraph that A2AJ reads as quotations or leaves unread (one segment per A2AJ line), the matter
after the reasons (caption) and notes (their label the marker, their references located). Each
PDF line takes the segment its aligned words come from. The PDF decides only what A2AJ's flat
text cannot show: whether an unnumbered line inside a paragraph is a block quotation (indented), a
bulleted item, a heading (a short bold or capitalised line) or plain text; which lines are
running heads and page numbers (in the page margins, repeated or a bare number); and heading
levels (numbering family, else type style; a kind first seen after a heading nests under it).
"""
from collections import Counter, defaultdict
import gzip
import json
import re
import unicodedata

import align

# Numbering families a unit can open with.
_WORD_OUTER = re.compile(r"^(PART|PARTIE|BOOK|LIVRE|TITLE|TITRE|VOLUME)\b", re.I)
_WORD_INNER = re.compile(r"^(ARTICLE|CHAPTER|CHAPITRE|DIVISION|SECTION|SCHEDULE|ANNEX|ANNEXE|APPENDIX|TAB|RULE|R[ÈE]GLE|CLAUSE|FORM|FORMULE)\b", re.I)
_SEC = re.compile(r"^(\d+(?:\.\d+)?)\s*\(\d+\)")
_DOTTED = re.compile(r"^(\d+(?:\.\d+)+)\.?(?=\s|$)")
_NUM = re.compile(r"^(?:\(|\[)?(\d+)(?:[.)\]:]|(?=\s))(?=\s|$)")
_ROMAN = re.compile(r"^\(?([IVXLCivxlc]{1,6})[.)\]:](?=\s|$)")
_ALPHA = re.compile(r"^\(?([A-Za-z]{1,2})[.)\]](?=\s|$)")
_BULLET = re.compile(r"^[•·▪–—\-*●○■□►]\s")
_ROMANS = {"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii",
           "xviii", "xix", "xx", "xxi", "xxii", "xxiii", "xxiv", "xxv", "xxx", "xl", "l"}


def family(text, open_letter=None):
    """The numbering family a unit opens with ('' for none); `open_letter` is the last letter of an
    open lower-case letter list, so 'i' after 'h' reads as a letter, not a numeral."""
    t = text.lstrip()
    if _WORD_OUTER.match(t): return "word_outer"
    if _WORD_INNER.match(t): return "word_inner"
    if _SEC.match(t): return "sec"
    m = _DOTTED.match(t)
    if m: return f"dec{min(m.group(1).count('.') + 1, 4)}"
    if _NUM.match(t): return "num"
    m = _ROMAN.match(t)
    if m:
        token = m.group(1); lower = token.islower()
        if len(token) == 1 and token.lower() in "ivxlc":
            if open_letter == chr(ord(token.lower()) - 1): return "al" if lower else "AU"
            return "rl" if lower else "RU"
        if token.lower() in _ROMANS: return "rl" if lower else "RU"
    m = _ALPHA.match(t)
    if m:
        token = m.group(1)
        if len(token) == 2 and token[0] != token[1]: return ""
        return "al" if token.islower() else "AU"
    if _BULLET.match(t): return "bullet"
    return ""


FRONT, PARAGRAPH, HEADING, INNER, ITEM, TAIL, NOTE = "front", "paragraph", "heading", "inner", "item", "tail", "note"
BODY = {PARAGRAPH, HEADING, INNER, ITEM}
OWN = ("furniture", "page_label")
BULLETS = set("•·▪▫◦●○■□►▶➢➤✓✔‣⁃-–—*o")


class Refused(Exception):
    def __init__(self, reason, stats=None):
        super().__init__(reason)
        self.reason, self.stats = reason, stats or {}


# ---------------------------------------------------------------- A2AJ side

def nodes(listing):
    """The census listing as [(kind, label, start, end, parent)] and notes [(label, body, refs)]."""
    found, notes = [], []
    for item in listing.split(";"):
        if not item: continue
        parts = item.split(" ")
        if parts[0] == "note":
            label, body = (tuple(map(int, p.split("-"))) for p in parts[1:3])
            notes.append((label, body, [int(r) for r in " ".join(parts[4:]).split(",") if r.strip()]))
        else:
            a, b = map(int, parts[-2].split("-"))
            found.append((parts[0], " ".join(parts[1:-2]), a, b, None if parts[-1] == "-" else int(parts[-1])))
    return found, notes


def code_points(text):
    """Code point offset of each UTF-16 offset of text."""
    out = []
    for at, char in enumerate(text): out.extend([at] * (2 if ord(char) > 0xFFFF else 1))
    out.append(len(text))
    return lambda unit: out[min(unit, len(out) - 1)]


def lines_in(text, a, b):
    """(start, end) of each non-blank line of text[a:b], trimmed."""
    out, at = [], a
    while at < b:
        stop = text.find("\n", at, b)
        stop = b if stop < 0 else stop
        s, e = at, stop
        while s < e and text[s].isspace(): s += 1
        while e > s and text[e - 1].isspace(): e -= 1
        if e > s: out.append((s, e))
        at = stop + 1
    return out


def segments(text, listing, outline):
    """owner[code point] = segment index, and the segments."""
    cp = code_points(text)
    found, notes = nodes(listing)
    segs, owner = [], [None] * len(text)
    def paint(a, b, **seg):
        seg.update(index=len(segs), start=a, end=b); segs.append(seg)
        for i in range(a, b): owner[i] = seg["index"]
    paragraphs = [(cp(a), cp(b), label[3:]) for kind, label, a, b, _ in found if kind == "paragraph" and label.startswith("par")]
    prose = [(cp(a), cp(b), None) for kind, _, a, b, _ in found if kind == "prose"]
    reasons = sorted(paragraphs + prose)
    if not reasons: raise Refused("A2AJ reads no paragraphs")
    note_start = min((cp(label[0]) for label, _, _ in notes), default=len(text))
    start, end = reasons[0][0], max(b for _, b, _ in reasons)
    heads = {}
    for e in outline:
        if e["kind"] == "heading": heads.setdefault(cp(e["start"]), e["label"])
    for a, b in lines_in(text, 0, start):
        if a in heads: paint(a, b, kind=HEADING, label=heads[a], outside=True)
        else: paint(a, b, kind=FRONT)
    for a, b in lines_in(text, end, note_start):
        if a in heads: paint(a, b, kind=HEADING, label=heads[a], outside=True)
        else: paint(a, b, kind=TAIL)
    for a, b, number in reasons: paint(a, b, kind=PARAGRAPH, number=number)
    quoted = set()
    for kind, _, a, b, _ in found:
        if kind == "quote":
            quoted.update(range(cp(a), cp(b)))
            for x, y in lines_in(text, cp(a), cp(b)): paint(x, y, kind=INNER, quoted=True)
    for e in outline:  # lines inside the reasons that no node reads, as the case outline reads them
        a, b = cp(e["start"]), cp(e["end"])
        if not start <= a < end: continue
        owners = {segs[owner[i]]["kind"] if owner[i] is not None else None for i in range(a, b) if not text[i].isspace()}
        if e["kind"] == "heading" and owners == {None}: paint(a, b, kind=HEADING, label=e["label"])
        elif e["kind"] in ("text", "item") and (owners == {None} or owners == {PARAGRAPH} and e["level"] >= 1):
            for x, y in lines_in(text, a, b): paint(x, y, kind=INNER, quoted=False)
    for kind, label, a, b, _ in found:
        if kind == "list_item":
            paint(cp(a), cp(b), kind=ITEM, label=label, quoted=cp(a) in quoted)
    for kind, label, a, b, _ in found:
        if kind == "heading": paint(cp(a), cp(b), kind=HEADING, label=heads.get(cp(a)))
    for label, body, refs in notes:
        paint(cp(label[0]), cp(body[1]), kind=NOTE, label_range=(cp(label[0]), cp(label[1])), refs=[cp(r) for r in refs])
    return segs, owner


# ---------------------------------------------------------------- PDF side

def geometry(path):
    """{line id: {bbox, size, bold, italic}} and {page: (width, height)} from a parser export."""
    with gzip.open(path, "rt", encoding="utf-8") as stream: exported = json.load(stream)
    out, pages = {}, {}
    for page in exported["extraction"]["pages"]:
        pages[page["number"]] = (page.get("width") or 612, page.get("height") or 792)
        for line in page["lines"]:
            bold = italic = total = 0; sizes = Counter()
            for s in line.get("spans") or []:
                n = max(1, s.get("end", 0) - s.get("start", 0)); total += n
                font = (s.get("font") or "").lower()
                bold += n * (bool(s.get("flags", 0) & 16) or "bold" in font or "black" in font or "heavy" in font)
                italic += n * (bool(s.get("flags", 0) & 2) or "italic" in font or "oblique" in font)
                sizes[round((s.get("size") or 0) * 2) / 2] += n
            out[line["id"]] = {"bbox": line.get("bbox"), "bold": total > 0 and bold > 0.6 * total,
                               "italic": total > 0 and italic > 0.6 * total, "size": sizes.most_common(1)[0][0] if sizes else 0}
    return out, pages


def number_like(text):
    """A page number as printed: one or two numbers or short roman numerals, with at most the words page/of/p."""
    ws = [w for w, _, _ in align.words(text)]
    rest = [w for w in ws if w not in ("page", "of", "p", "pg")]
    return bool(rest) and len(rest) <= 2 and all(w.isdigit() or (len(w) <= 5 and set(w) <= set("ivxlc")) for w in rest)


def masked(text):
    return " ".join("#" if w.isdigit() else w for w, _, _ in align.words(text))


def margin(box, page):
    """Where a line sits: 'head' (top or bottom tenth of the page), 'side' (outside the middle
    four fifths across, or set sideways) or None."""
    width, height = page
    if box[1] < 0.12 * height or box[3] > 0.9 * height: return "head"
    if box[2] < 0.12 * width or box[0] > 0.88 * width or (box[3] - box[1]) > 2.5 * max(1, box[2] - box[0]) and box[3] - box[1] > 30:
        return "side"
    return None


def furniture(lines, geo, pages):
    """{line id: 'furniture' | 'page_label'}: lines in the page margins that are a page number, or
    whose words (digits masked) recur in the margins of another page."""
    place = {}
    for line in lines:
        box = (geo.get(line["id"]) or {}).get("bbox")
        if box and line["text"].strip(): place[line["id"]] = margin(box, pages.get(line["page"], (612, 792)))
    seen = defaultdict(set)
    for line in lines:
        if place.get(line["id"]): seen[masked(line["text"])].add(line["page"])
    out = {}
    for line in lines:
        where = place.get(line["id"])
        if not where: continue
        if where == "head" and page_number(line, lines, geo): out[line["id"]] = "page_label"
        elif not number_like(line["text"]) and masked(line["text"]) and len(seen[masked(line["text"])]) >= 2: out[line["id"]] = "furniture"
    return out


def page_number(line, lines, geo):
    """A number in the page head or foot that is no paragraph's number: not bracketed, and no text
    begins just after it on its row."""
    if not number_like(line["text"]) or any(c in line["text"] for c in "[("): return False
    box = geo[line["id"]]["bbox"]
    for other in lines:
        b = (geo.get(other["id"]) or {}).get("bbox")
        if other is line or other["page"] != line["page"] or not b or not other["text"].strip(): continue
        same_row = min(box[3], b[3]) - max(box[1], b[1]) > 0.5 * min(box[3] - box[1], b[3] - b[1])
        if same_row and 0 <= b[0] - box[2] < 60: return False
    return True


# ---------------------------------------------------------------- labelling

def bullet(text):
    """A bullet glyph: a listed symbol or a private-use (symbol font) character."""
    return len(text) == 1 and not text.isalnum() and (text in BULLETS or 0xE000 <= ord(text) <= 0xF8FF)


def enumerator(text):
    """A line that is only a printed marker: a bullet glyph or an enumerator ("iii.", "(b)", "2.")."""
    text = text.strip()
    if text[:1] == "[": return False  # a bracketed number is a paragraph's, never an item's
    return bullet(text) or (0 < len(text) <= 6 and " " not in text and bool(family(text + " x")))


def extend(text, a, b):
    """A printed marker's extent: the word with the brackets, parentheses or full stop around it."""
    while a > 0 and text[a - 1] in "[(": a -= 1
    while b < len(text) and text[b] in "]).:": b += 1
    return a, b


class Labelled:
    def __init__(self, lines, geo, pages, text, listing, outline):
        self.lines, self.geo, self.pages, self.text = lines, geo, pages, text
        self.segs, self.owner = segments(text, listing, outline)
        self.fixed = furniture(lines, geo, pages)
        self.align()
        self.cut()
        self.late_furniture()
        self.detached_bullets()
        self.page_margins()
        self.trailing()
        self.gate()

    def align(self):
        lines, segs = self.lines, self.segs
        live = [n for n, line in enumerate(lines) if line["id"] not in self.fixed]
        words = align.line_words([lines[n]["text"] for n in live])
        self.pdf_words = [(w, [(live[k], a, b) for k, a, b in pieces]) for w, pieces in words]
        self.a2aj_words = align.words(self.text)
        self.seg_of = [self.owner[a] for _, a, _ in self.a2aj_words]
        note = [s is not None and segs[s]["kind"] == NOTE for s in self.seg_of]
        left, right = [w for w, _ in self.pdf_words], [w for w, _, _ in self.a2aj_words]
        matches = align.match(left, right, right_free={j for j in range(len(right)) if not note[j]})
        if any(note):
            free = {i for i in range(len(left)) if i not in matches}
            matches.update(align.match(left, right, left_free=free, right_free={j for j in range(len(right)) if note[j]}))
        self.matches, self.to_pdf = matches, {j: i for i, j in matches.items()}

    def cut(self):
        """Pieces (line, start, end, segment | 'furniture' | 'page_label' | None) in reading order."""
        per_line = defaultdict(list)
        for i, (_, pieces) in enumerate(self.pdf_words):
            j = self.matches.get(i)
            s = self.seg_of[j] if j is not None else None
            for n, a, b in pieces: per_line[n].append((a, b, s))
        self.pieces = []
        for n, line in enumerate(self.lines):
            if not line["text"].strip(): continue
            if line["id"] in self.fixed:
                self.pieces.append((n, 0, len(line["text"]), self.fixed[line["id"]])); continue
            runs = []
            for a, b, s in (w for w in per_line.get(n, []) if w[2] is not None):
                if runs and runs[-1][2] == s: runs[-1][1] = b; runs[-1][3] += 1
                else: runs.append([a, b, s, 1])
            if not runs:
                self.pieces.append((n, 0, len(line["text"]), "bullet" if enumerator(line["text"]) else None)); continue
            # A run of one short word between two others is noise; a segment change splits the line.
            kept = [r for r in runs if r[3] >= 2 or r[1] - r[0] >= 4 or len(runs) == 1 or self.segs[r[2]].get("number") or self.segs[r[2]]["kind"] == NOTE]
            kept = kept or runs
            merged = []
            for r in kept:
                if merged and merged[-1][2] == r[2]: merged[-1][1] = r[1]
                else: merged.append(list(r))
            cuts = [0] + [r[0] for r in merged[1:]] + [len(line["text"])]
            for k, r in enumerate(merged): self.pieces.append((n, cuts[k], cuts[k + 1], r[2]))

    def late_furniture(self):
        """Lines A2AJ does not carry that are page furniture all the same: a page number in the
        page head or foot, or words (digits masked) that recur, uncarried, on other pages."""
        loose = []
        for k, p in enumerate(self.pieces):
            box = (self.geo.get(self.lines[p[0]]["id"]) or {}).get("bbox")
            where = box and margin(box, self.pages.get(self.lines[p[0]]["page"], (612, 792)))
            if p[3] is None and where: loose.append((k, where))
        pages = defaultdict(set)
        for k, _ in loose: pages[masked(self.lines[self.pieces[k][0]]["text"])].add(self.lines[self.pieces[k][0]]["page"])
        for k, where in loose:
            n, a, b, _ = self.pieces[k]
            line = self.lines[n]
            if where == "head" and page_number(line, self.lines, self.geo):
                self.pieces[k] = (n, a, b, "page_label")
            elif not number_like(line["text"]) and len(pages[masked(line["text"])]) >= 2 and len(masked(line["text"])) >= 3:
                self.pieces[k] = (n, a, b, "furniture")

    def detached_bullets(self):
        """A marker extracted as its own line on the row of its item's, heading's or line's first
        line opens it: self.bullet_of {segment: piece} and the pieces taken (self.bullets)."""
        self.bullets, self.bullet_of, opened = set(), {}, set()
        for k, p in enumerate(self.pieces):
            if isinstance(p[3], int):
                opened.add(p[3]); continue
            if p[3] != "bullet": continue
            nxt = next((q for q in range(k + 1, len(self.pieces)) if self.pieces[q][3] not in OWN), None)
            if nxt is None: continue
            s = self.pieces[nxt][3]
            here = (self.geo.get(self.lines[p[0]]["id"]) or {}).get("bbox")
            there = (self.geo.get(self.lines[self.pieces[nxt][0]]["id"]) or {}).get("bbox")
            row = bool(here and there) and min(here[3], there[3]) - max(here[1], there[1]) > 0.3 * min(here[3] - here[1], there[3] - there[1])
            if isinstance(s, int) and s not in opened and self.segs[s]["kind"] in (INNER, ITEM, HEADING) and row \
                    and self.lines[self.pieces[nxt][0]]["page"] == self.lines[p[0]]["page"]:
                self.bullets.add(k); self.bullet_of[s] = k

    def kind(self, piece):
        s = piece[3]
        if s == "bullet": return None
        return s if isinstance(s, str) else None if s is None else self.segs[s]["kind"]

    def gate(self):
        body = [k for k, p in enumerate(self.pieces) if self.kind(p) in BODY and not self.segs[p[3]].get("outside")]
        if not body: raise Refused("no A2AJ paragraph found in the PDF")
        self.first, self.last = body[0], body[-1]
        stats = Counter()
        for k, p in enumerate(self.pieces):
            if self.kind(p) in OWN: stats["furniture_lines"] += 1; continue
            if self.first <= k <= self.last:
                stats["body_lines"] += 1; stats["covered_lines"] += (p[3] is not None and p[3] != "bullet") or k in self.bullets
        # A paragraph number the PDF prints ("[95]" opening a line) that no A2AJ word takes:
        # A2AJ's text lost the numbering there, so its paragraphs are not the PDF's.
        matched_at = {(n, a) for i, (_, pieces) in enumerate(self.pdf_words) if i in self.matches for n, a, _ in pieces}
        stray = []
        for i, (word, pieces) in enumerate(self.pdf_words):
            n, a, b = pieces[0]
            line = self.lines[n]["text"]
            if word.isdigit() and i not in self.matches and line[:a].strip() == "[" and line[b:b + 1] == "]":
                stray.append(word)
        stats["stray_paragraph_numbers"] = len(stray)
        run = longest = 0
        for k in range(self.first, self.last + 1):
            p = self.pieces[k]
            if p[3] in OWN: continue
            run = run + 1 if p[3] is None or (p[3] == "bullet" and k not in self.bullets) else 0
            longest = max(longest, run)
        stats["longest_uncarried_run"] = longest
        counts = defaultdict(lambda: [0, 0])
        for j, s in enumerate(self.seg_of):
            if s is not None: counts[s][0] += 1; counts[s][1] += j in self.to_pdf
        numbered = [s for s in self.segs if s["kind"] == PARAGRAPH and s.get("number")]
        unmatched = [s["number"] for s in numbered if counts[s["index"]][1] < 0.6 * max(1, counts[s["index"]][0])]
        unread = [s for s in self.segs if s["kind"] in BODY | {NOTE} and counts[s["index"]][1] == 0 and counts[s["index"]][0] > 0]
        stats.update(pdf_lines=sum(1 for line in self.lines if line["text"].strip()), paragraphs=len(numbered),
                     unmatched_paragraphs=len(unmatched), unmatched_segments=len(unread),
                     a2aj_words=sum(1 for s in self.seg_of if s is not None),
                     a2aj_words_matched=sum(1 for j in self.to_pdf if self.seg_of[j] is not None),
                     pdf_words=len(self.pdf_words), pdf_words_matched=len(self.matches))
        self.stats = {**stats, "coverage": round(stats["covered_lines"] / max(1, stats["body_lines"]), 4),
                      "unmatched_paragraph_numbers": unmatched[:40],
                      "unmatched_segments_by_kind": dict(Counter(s["kind"] for s in unread))}
        if unmatched: raise Refused(f"{len(unmatched)} of {len(numbered)} numbered paragraphs not found in the PDF", self.stats)
        if self.stats["coverage"] < 0.9: raise Refused(f"A2AJ text covers {self.stats['coverage']:.1%} of the body lines", self.stats)
        if longest >= 4: raise Refused(f"{longest} consecutive body lines A2AJ does not carry", self.stats)
        if stray: raise Refused(f"the PDF numbers paragraphs A2AJ's text does not ({', '.join(stray[:5])})", self.stats)

    # ------------------------------------------------------------ PDF evidence

    def page_margins(self):
        """Each page's body text column (left, right), from the lines of numbered paragraphs."""
        xs = defaultdict(list)
        for n, a, b, s in self.pieces:
            if isinstance(s, int) and self.segs[s]["kind"] == PARAGRAPH:
                box = self.geo.get(self.lines[n]["id"], {}).get("bbox")
                if box: xs[self.lines[n]["page"]].append(box)
        everything = [box for boxes in xs.values() for box in boxes]
        def column(boxes):
            left = Counter(round(box[0] / 3) * 3 for box in boxes).most_common(1)[0][0]
            right = sorted(box[2] for box in boxes)[int(0.9 * (len(boxes) - 1))]
            return left, max(right, left + 100)
        fallback = column(everything) if everything else (72, 540)
        self.columns = {page: column(boxes) if len(boxes) >= 4 else fallback for page, boxes in xs.items()}
        self.fallback = fallback

    def column(self, page):
        return self.columns.get(page, self.fallback)

    def style(self, n):
        """A line's type: size, bold, italic, capitals, centred."""
        g = self.geo.get(self.lines[n]["id"], {})
        box, (left, right) = g.get("bbox") or [0, 0, 0, 0], self.column(self.lines[n]["page"])
        letters = [c for c in self.lines[n]["text"] if c.isalpha()]
        caps = len(letters) >= 3 and all(c.isupper() for c in letters)
        centred = box[0] - left > 20 and abs((box[0] + box[2]) / 2 - (left + right) / 2) < 15
        return (g.get("size", 0), bool(g.get("bold")), bool(g.get("italic")), caps, centred)

    def indent(self, n):
        g = self.geo.get(self.lines[n]["id"], {})
        box, (left, right) = g.get("bbox") or [0, 0, 0, 0], self.column(self.lines[n]["page"])
        return box[0] - left, (right - left)

    def evidence(self, members, quoted):
        """What the PDF shows an unnumbered line inside a paragraph to be: 'bullet', 'quote' (set
        apart from the paragraphs' text column: indented, or for a line A2AJ reads as a quotation,
        either way), 'heading', 'right' (set against the right margin) or 'text'."""
        n, a = members[0][0], members[0][1]
        lead = self.lines[n]["text"][a:].lstrip()
        if lead and bullet(lead[0]) and (lead[0] not in "o-*" or lead[1:2] == " "): return "bullet"
        rows = sorted({m[0] for m in members})
        shifts = [self.indent(r) for r in rows]
        if all(x > 0.45 * w for x, w in shifts): return "right"
        words = sum(len(self.lines[r]["text"].split()) for r in rows)
        styles = [self.style(r) for r in rows]
        if len(rows) <= 2 and words <= 15 and all(st[4] and (st[1] or st[3]) for st in styles): return "heading"
        if sum((15 <= x or (quoted and x <= -15)) and x <= 0.45 * w for x, w in shifts) >= 0.6 * len(shifts): return "quote"
        last = self.lines[rows[-1]]["text"].rstrip()[-1:]
        if len(rows) <= 2 and words <= 15 and last not in ".;," and all(s[1] or s[3] for s in styles): return "heading"
        return "text"

    # ------------------------------------------------------------ typed lines

    def trailing(self):
        """A2AJ reads the matter after the reasons (a signature block, the disposition and
        counsel, a formal judgment, an appendix) as lines of the last numbered paragraph. The
        lines after the last of that paragraph's own words, quotations (set apart in the PDF) and
        list items are that matter: caption when they are a few short lines; when they are many,
        long, or notes, the document is refused."""
        numbered = [seg for seg in self.segs if seg["kind"] == PARAGRAPH and seg.get("number")]
        if not numbered: return
        last = max(numbered, key=lambda seg: seg["start"])
        own = [i for i in range(last["start"], last["end"]) if self.owner[i] == last["index"] and not self.text[i].isspace()]
        if not own: return
        pieces = defaultdict(list)
        for p in self.pieces:
            if isinstance(p[3], int): pieces[p[3]].append(p)
        after = sorted({self.owner[i] for i in range(own[-1], last["end"]) if self.owner[i] is not None and self.owner[i] != last["index"]})
        after = [s for s in after if self.segs[s]["kind"] in (INNER, ITEM, HEADING)]
        def body(s):
            if not pieces[s]: return False
            if self.segs[s]["kind"] == ITEM or s in self.bullet_of: return True
            return self.segs[s]["kind"] == INNER and self.evidence(pieces[s], True) in ("quote", "bullet")
        cut = max((k for k, s in enumerate(after) if body(s)), default=-1)
        tail = [s for s in after[cut + 1:] if pieces[s]]
        if not tail: return
        words = [len(self.text[self.segs[s]["start"]:self.segs[s]["end"]].split()) for s in tail]
        noted = [s for s in tail if self.text[self.segs[s]["start"]] == "[" and "]" in self.text[self.segs[s]["start"]:self.segs[s]["start"] + 6]]
        if len(tail) > 12 or max(words) > 30 or noted:
            raise Refused(f"the matter after the reasons ({len(tail)} lines{', with notes' if noted else ''}) is read as part of the last paragraph",
                          {"tail_lines": len(tail)})
        for s in tail: self.segs[s].update(kind=TAIL, outside=True)
        self.tail_lines = len(tail)

    def typed(self):
        """The gold's typed lines, notes and heading levels."""
        lines, segs = self.lines, self.segs
        groups = defaultdict(list)  # segment -> its pieces in order
        for k, p in enumerate(self.pieces):
            if isinstance(p[3], int): groups[p[3]].append(k)
        region, marker = {}, {}
        decisions = Counter()
        # Unnumbered lines inside paragraphs, and list items: what the PDF shows them to be.
        later_paragraph = set()
        seen_paragraph = False
        for k in range(len(self.pieces) - 1, -1, -1):
            if seen_paragraph: later_paragraph.add(k)
            if self.kind(self.pieces[k]) == PARAGRAPH: seen_paragraph = True
        for s, ks in groups.items():
            seg = segs[s]
            members = [self.pieces[k] for k in ks]
            if seg["kind"] == INNER:
                found = "bullet" if s in self.bullet_of else self.evidence(members, seg["quoted"])
                decisions[f"inner_{'quote' if seg['quoted'] else 'unread'}_{found}"] += 1
                if found == "bullet":
                    region[s] = "list_item"
                elif found == "right":
                    region[s] = "caption" if ks[0] not in later_paragraph else "text"
                else:
                    region[s] = found
            elif seg["kind"] == ITEM:
                region[s] = "quote" if seg["quoted"] and self.evidence(members, True) == "quote" else "list_item"
                decisions[f"item_{region[s]}"] += 1
            else:
                region[s] = {FRONT: "caption", TAIL: "caption", PARAGRAPH: "text", HEADING: "heading", NOTE: "note"}[seg["kind"]]
        # Bullets: a glyph extracted as its own line before the item, or opening its first line.
        for s, ks in groups.items():
            if s in self.bullet_of:
                n = self.pieces[self.bullet_of[s]][0]
                at = len(lines[n]["text"]) - len(lines[n]["text"].lstrip())
                marker[s] = (n, at, len(lines[n]["text"].rstrip()))
                decisions["marker_detached"] += 1; continue
            if segs[s]["kind"] not in (INNER, ITEM) or region[s] not in ("list_item", "quote"): continue
            else:
                n, a = self.pieces[ks[0]][0], self.pieces[ks[0]][1]
                lead = lines[n]["text"][a:].lstrip()
                if lead and bullet(lead[0]) and (lead[0] not in "o-*" or lead[1:2] == " "):
                    at = a + len(lines[n]["text"][a:]) - len(lead)
                    marker[s] = (n, at, at + 1)
            if s in marker: decisions["marker_bullet"] += 1
        # Printed markers: the A2AJ word that opens the segment, where the PDF prints it first.
        for s, ks in groups.items():
            seg = segs[s]
            want = seg.get("number") if seg["kind"] == PARAGRAPH else seg.get("label") if seg["kind"] in (ITEM, HEADING) else None
            span = seg.get("label_range", (seg["start"], seg["end"])) if seg["kind"] == NOTE else (seg["start"], seg["end"])
            if seg["kind"] == NOTE: want = self.text[span[0]:span[1]]
            if not want or s in marker: continue
            target = [w for w, _, _ in align.words(want)]
            j = next((j for j, (_, a, _) in enumerate(self.a2aj_words) if span[0] <= a < span[1]), None)
            if j is None or not target or self.a2aj_words[j][0] != target[0] or j not in self.to_pdf:
                decisions[f"marker_missing_{seg['kind']}"] += 1; continue
            pieces = self.pdf_words[self.to_pdf[j]][1]
            n, a, b = pieces[0]
            first = self.pieces[ks[0]]
            before = lines[n]["text"][first[1]:a] if n == first[0] else None
            if before is None or before.strip("[( \t"):
                decisions[f"marker_missing_{seg['kind']}"] += 1; continue
            if len(target) > 1 and len(pieces) == 1:  # "B.1": the label's further words
                for jj in range(j + 1, j + len(target)):
                    if jj in self.to_pdf and self.pdf_words[self.to_pdf[jj]][1][0][0] == n: b = self.pdf_words[self.to_pdf[jj]][1][0][2]
            marker[s] = (n, *extend(lines[n]["text"], a, b))
            decisions[f"marker_{seg['kind']}"] += 1
        # References to notes, located through the word A2AJ prints at each.
        refs = defaultdict(list)  # line -> [(a, b, note segment)]
        for s, ks in groups.items():
            seg = segs[s]
            for r in seg.get("refs", []):
                j = next((j for j, (_, a, _) in enumerate(self.a2aj_words) if r <= a < r + 4), None)
                if j is None or j not in self.to_pdf:
                    decisions["reference_missing"] += 1; continue
                n, a, b = self.pdf_words[self.to_pdf[j]][1][0]
                text = lines[n]["text"]
                if 0 < a and b < len(text) and text[a - 1] + text[b] in ("[]", "()"): a, b = a - 1, b + 1
                refs[n].append((a, b, s))
                decisions["reference"] += 1
        # Typed lines in reading order.
        typed, fills, unit_seg = [], [], {}
        previous_region = previous_seg = None
        last_of = {}
        for k, (n, a, b, s) in enumerate(self.pieces):
            line = lines[n]
            text = line["text"]
            whole = a == 0 and b == len(text)
            if not whole:
                while a < b and text[a].isspace(): a += 1
                while b > a and text[b - 1].isspace(): b -= 1
            entry = {"page": line["page"], "spans": [{"line_id": line["id"], "start": a, "end": b}], "markers": [], "references": []}
            if k in self.bullets: continue
            if s == "bullet": s = None
            if s in OWN:
                entry.update(region=s, start=True)
            elif s is None:
                if self.first < k < self.last:
                    fills.append((k, len(typed))); continue
                start = not (typed and typed[-1]["region"] == "caption" and typed[-1].get("_free") and typed[-1]["page"] == line["page"])
                entry.update(region="caption", start=start, _free=True)
            else:
                r = region[s]
                opening = last_of.get(s) is None
                if not opening and self.segs[s]["kind"] == PARAGRAPH and previous_region not in (None, "quote") and previous_seg != s:
                    start = True  # the paragraph's words after a list, heading or unnumbered line
                else:
                    start = opening
                entry.update(region=r, start=start)
                if s in marker and opening and (marker[s][0] == n or s in self.bullet_of):
                    m = marker[s]
                    entry["markers"] = [[{"line_id": lines[m[0]]["id"], "start": m[1], "end": m[2]}]]
                    if m[0] != n: entry["spans"].insert(0, {"line_id": lines[m[0]]["id"], "start": 0, "end": len(lines[m[0]]["text"])})
                last_of[s] = len(typed)
            for x, y, note in refs.get(n, []):
                if a <= x and y <= b and entry["region"] not in OWN + ("note",):
                    entry["references"].append({"label": text[x:y], "spans": [{"line_id": line["id"], "start": x, "end": y}], "_note": note})
            entry["text"] = self.typed_text(text, a, b, entry)
            if entry["markers"] and entry["markers"][0][0]["line_id"] != line["id"]:
                m = entry["markers"][0][0]
                glyph = lines[self.pieces[self.bullet_of[s]][0]]["text"][m["start"]:m["end"]]
                entry["text"] = glyph + "\t" + entry["text"].lstrip()
            if entry["region"] not in OWN + ("note",):
                previous_region = entry["region"]; previous_seg = s
            typed.append(entry)
            unit_seg[len(typed) - 1] = s
        # Lines inside the reasons that A2AJ does not carry join the typed line before them on
        # their page (else the next), as the authoring runner fills lines the model did not type.
        self.unfilled = []
        for k, at in fills:
            n = self.pieces[k][0]
            page = lines[n]["page"]
            near = [t for t in range(at - 1, -1, -1) if typed[t]["page"] == page and typed[t]["region"] not in OWN]
            near = near or [t for t in range(at, len(typed)) if typed[t]["page"] == page and typed[t]["region"] not in OWN]
            near = near or [t for t in range(at - 1, -1, -1) if typed[t]["region"] not in OWN]
            typed[near[0]]["spans"].append({"line_id": lines[n]["id"], "start": 0, "end": len(lines[n]["text"])})
            self.unfilled.append(lines[n]["text"])
        position = {line["id"]: k for k, line in enumerate(lines)}
        for entry in typed:
            entry["spans"].sort(key=lambda sp: (position[sp["line_id"]], sp["start"]))
        self.decisions = decisions
        return typed, unit_seg

    def typed_text(self, text, a, b, entry):
        """The printed line as the authoring model types it: a tab after a leading marker, note
        references as [^mark]."""
        edits = []
        for m in (m for m in entry["markers"] if m[0]["line_id"] == entry["spans"][-1]["line_id"]):
            end = m[0]["end"]
            gap = end
            while gap < b and text[gap] in " \t": gap += 1
            edits.append((end, gap, "\t"))
        for ref in entry["references"]:
            x, y = ref["spans"][0]["start"], ref["spans"][0]["end"]
            edits.append((x, y, "[^" + text[x:y] + "]"))
        out, cursor = [], a
        for x, y, new in sorted(edits):
            if x < cursor: continue
            out.append(text[cursor:x]); out.append(new); cursor = y
        out.append(text[cursor:b])
        return "".join(out)


def heading_levels(doc, typed, units):
    """Each heading unit's level: a kind of heading (its numbering family, else its type style)
    keeps the level it was first given; a kind first seen nests under the heading before it."""
    levels, kinds, previous = {}, {}, None
    for u, unit in enumerate(units):
        first = typed[unit["lines"][0]]
        if first["region"] != "heading": continue
        family = family(" ".join(first["text"].split()))
        if family:
            kind = ("numbered", family)
        else:
            line = next(k for k, l in enumerate(doc.lines) if l["id"] == first["spans"][0]["line_id"])
            kind = ("style", doc.style(line))
        if kind not in kinds:
            kinds[kind] = min(9, (levels[previous] + 1) if previous is not None else 1)
        levels[u] = kinds[kind]
        previous = u
    return levels, len(kinds)
