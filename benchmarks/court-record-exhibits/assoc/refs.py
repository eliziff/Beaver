"""Affidavit side: find every mention of every exhibit label and build its context.

Handles quoted/unquoted labels with stray spaces or line breaks, label lists
("Exhibits "C", "D" and "E" respectively"), ranges ("Exhibits A to D"),
multi-letter and numeric labels, and exhibit tables (a label alone on a line
followed by its row). Only labels the record actually has are accepted.

Usage: python refs.py [out.json] [--look-back]   (default inputs2.json; prints recall against gold paragraphs)
"""
import json, os, re, sys
from common import HERE, ROOT, load

QUOTES = str.maketrans({c: '"' for c in "“”«»�„‟"} | {c: "'" for c in "‘’‚‛"})
LAB = r"(?:[A-Z]{1,4}-?\d{1,3}|[A-Z]{1,4}|\d{1,3}(?:-\d{1,3})?)"
QL = rf"[\"']?\s?({LAB})\s?[\"']?(?![A-Za-z0-9])"
SEP = r"\s*(?:,\s*(?:and\s+|&\s*)?|\band\b|&|\bto\b|\bthrough\b|[-–—]|(?=e?xhibits?\s*[\"']))\s*(?:e?xhibits?\s*)?"
LIST = re.compile(rf"\b(?:exhibits?|pi[eè]ces?)\s*(?:nos?\.?\s*)?{QL}((?:{SEP}{QL})*)", re.I)
ONE = re.compile(rf"({SEP}){QL}", re.I)
INTRO = re.compile(r"\battached\b|\bmarked\b|\bannexed\b|\bappended\b|\benclosed\b|\bproduced\b|\bis a (?:true )?copy\b|\bare (?:true )?copies\b|\bnow shown\b", re.I)
PARA = re.compile(r"(?:^|\n)[ \t]*\(?(\d{1,3})[.)](?=\s)")
OCR = {"0": "O", "1": "I", "L": "I"}  # text-layer misreads of a one-letter label


def canon(raw, L, quoted=True):
    """The record label a mention names, allowing "F-1" for F1 and OCR's "0" for O. An unquoted
    lower-case word is prose ("Exhibit G, and a copy", "exhibits:"), not a label."""
    if not quoted and re.search(r"[a-z]", raw):
        return None
    x = raw.upper().replace(" ", "")
    if x in L:
        return x
    if x.replace("-", "") in L:
        return x.replace("-", "")
    if OCR.get(raw) in L and raw not in L:
        return OCR[raw]
    return None


def lab_key(l):
    if l.isdigit():
        return (0, int(l), "")
    m = re.match(r"([A-Z]+)-?(\d*)$", l)
    return (len(m[1]), m[1], int(m[2] or 0)) if m else (9, l, 0)


def expand(a, b, labels):
    """Labels from a to b inclusive, in the record's own label order."""
    order = sorted(labels, key=lab_key)
    if a in order and b in order and order.index(a) < order.index(b):
        return order[order.index(a):order.index(b) + 1]
    return [x for x in (a, b) if x in labels]


def clean(aff):
    # a page break (and the page's own number printed as its header) does not end a sentence
    t = re.sub(r"\s*\[page (\d+)\]\s*(?:(?:-\s?0*\1\s?-|[Pp]age\s0*\1(?:\sof\s\d+)?|0*\1)[ \t]*\n)?", "\n", aff)
    t = t.translate(QUOTES).replace("­", "")
    return re.sub(r"[ \t]+", " ", t)


def paragraphs(text):
    """(start, end, number) spans of numbered paragraphs; unnumbered text is one span per blank-line block."""
    starts = [(m.start(), int(m.group(1))) for m in PARA.finditer(text)]
    # keep a monotone run of paragraph numbers (drops list items and dates that look like numbers)
    keep, last = [], 0
    for s, n in starts:
        if last < n <= last + 3:
            keep.append((s, n)); last = n
    if len(keep) < 3:
        blocks = [m.start() for m in re.finditer(r"\n\s*\n", text)]
        keep = [(0, 0)] + [(b, 0) for b in blocks]
    spans = []
    for k, (s, n) in enumerate(keep):
        e = keep[k + 1][0] if k + 1 < len(keep) else len(text)
        spans.append((s, e, n))
    if keep and keep[0][0] > 0:
        spans.insert(0, (0, keep[0][0], 0))
    return spans


def mentions(text, labels):
    """[(start, end, [labels], respectively?)] for every exhibit mention naming known labels."""
    L = set(labels)
    out = []
    q = lambda pos: bool(re.search(r"[\"']", text[max(0, pos - 2):pos]))
    for m in LIST.finditer(text):
        first = canon(m.group(1), L, q(m.start(1)))
        got = [first] if first else []
        prev = first
        for s in ONE.finditer(m.group(2) or ""):
            lab = canon(s.group(2), L, q(m.start(2) + s.start(2)))
            if not lab or not prev:
                break
            if re.search(r"\bto\b|\bthrough\b|[-–—]", s.group(1), re.I) and not re.search(r",|\band\b", s.group(1)):
                got += [x for x in expand(prev, lab, L) if x not in got]
            else:
                got.append(lab)
            prev = lab
        if got:
            tail = text[m.end():m.end() + 40]
            out.append((m.start(), m.end(), got, bool(re.match(r"\W{0,3}respectively", tail, re.I))))
    return out


def table_rows(text, labels, found):
    """Labels never mentioned in prose but listed as table rows: the label alone on a line."""
    out = []
    missing = [l for l in labels if l not in found]
    for l in missing:
        for m in re.finditer(rf"(?m)^\s*\"?{re.escape(l)}\"?\s*$", text):
            nxt = text[m.end():m.end() + 300]
            stop = re.search(r"\n\s*\"?(?:[A-Z]{1,4}|\d{1,3})\"?\s*\n", nxt)
            out.append((m.start(), m.end() + (stop.start() if stop else len(nxt)), [l], False))
            break
    return out


SENT_ABBR = re.compile(r"(?:\b(?:Mr|Ms|Mrs|Dr|No|Nos|Inc|Ltd|Co|Corp|St|Ave|para|paras|s|ss|Hon|Jr|Sr|vs|v|Reg|c|ch|art|arts)|Drs)\.\s", re.I)


def sentence_span(text, a, b):
    """(start, end) of the sentence containing text[a:b]."""
    lo = max(0, a - 700)
    left = text[lo:a]
    right = text[b:b + 700]
    lm = [m.end() for m in re.finditer(r"[.;:!?]\s+(?=[\"(]?[A-Z0-9]|\(?[a-z]\)\s)|\n\s*\n|\n\s*\(?\d{1,3}[.)]\s", SENT_ABBR.sub(lambda x: x.group(0).replace(".", "~"), left))]
    rm = re.search(r"[.;!?](?=\s+[\"(]?[A-Z0-9]|\s+\(?[a-z]\)\s|\s*$)|\n\s*\n|\n\s*\(?\d{1,3}[.)]\s", SENT_ABBR.sub(lambda x: x.group(0).replace(".", "~"), right))
    return lo + (lm[-1] if lm else 0), b + (rm.end() if rm else len(right))


ws = lambda t: re.sub(r"\s+", " ", t).strip()

# ---- list items: one reference text per label of a list mention
MN = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
DT = re.compile(rf"\b(?:({MN})\.?\s?(\d{{1,2}})(?:st|nd|rd|th)?|(\d{{1,2}})(?:st|nd|rd|th)?\s(?:day\sof\s)?({MN})\b\.?)(?:,?\s?((?:19|20)\d\d)\b)?", re.I)
NUMT = re.compile(r"(?:#\s?)?\b\d{1,4}(?:/\d{2,4})?\b")
GAP = re.compile(r"[\s,]*(?:and|&|or)?[\s,]*")
NGAP = re.compile(r"\s*(?:,\s*(?:and|&|or)?|and|&|or)\s*")  # numbers need a written separator ("112 052 406" is one number)
VERB = re.compile(r"\b(?:(?:is|are|was|were|ha(?:ve|s) been)\s+(?:hereto\s+|also\s+|each\s+)?)?(?:attached|marked|appended|annexed|produced|enclosed)\b|\bcop(?:y|ies)\s+of\s+which(?:\s+\w+)?|\bwhich\s+(?:is|are)\b", re.I)
LEAD = re.compile(r"^(?:[^\w(]|\b(?:and|also|see|hereto|herewith|respectively|to\s+(?:this|my)\s+(?:\w+\s+)?affidavit|of\s+my\s+affidavit|are|is|true|signed|certified|(?:a\s+)?cop(?:y|ies)\s+of(?:\s+each\s+of)?|each\s+of|examples\s+of|the\s+following(?:\s+documents)?)\b)+", re.I)
MODIFIER = re.compile(r"(?:dated|of|from|to|between|made|sent|respecting|in\s+respect|which|that|being|issued|signed|registered|including|with|by|on)\b", re.I)
LEVELS = [r";\s*(?:and\s+)?", r"[;\x03]\s*(?:and\s+)?|,\s*(?:and|&|as\s+well\s+as|or)\s+|\s+as\s+well\s+as\s+",
          r"[;\x03]\s*(?:and\s+)?|,\s*(?:(?:and|&|as\s+well\s+as|or)\s+)?|\s+as\s+well\s+as\s+",
          r"[;\x03]\s*(?:and\s+)?|,\s*(?:(?:and|&|as\s+well\s+as|or)\s+)?|\s+as\s+well\s+as\s+|\s+(?:and|&)\s+"]


def protect(s):
    """Hide separators that do not separate items: inside parentheses, dates ("May 8, 2025"), numbers ("1,000")."""
    s = re.sub(r"\([^()]*\)", lambda m: m.group(0).replace(",", "\x01").replace(" and ", " \x02 ").replace(";", "\x04"), s)
    s = re.sub(rf"({MN}\.?\s?\d{{1,2}}(?:st|nd|rd|th)?),(\s?(?:19|20)\d\d)", "\\1\x01\\2", s, flags=re.I)
    return re.sub(r"(\d),(\d{3})", "\\1\x01\\2", s)


def unprotect(s):
    return s.replace("\x01", ",").replace(" \x02 ", " and ").replace("\x04", ";")


def value_run(region, n):
    """n dates (or n numbers) written as one list: "dated May 8, June 4 and June 16, 2025", "Directives #3 and #5"."""
    ds = list(DT.finditer(region))
    runs, run = [], []
    for m in ds:
        if run and not GAP.fullmatch(region[run[-1].end():m.start()]):
            runs.append(run); run = []
        run.append(m)
    if run:
        runs.append(run)
    for run in runs:
        if len(run) == n:
            years = [m[5] for m in run]
            anyyear = re.findall(r"\b(?:19|20)\d\d\b", region)
            out = []
            for k, m in enumerate(run):
                y = next((v for v in years[k:] if v), anyyear[-1] if anyyear else "")
                mon, day = (m[1], m[2]) if m[1] else (m[4], m[3])
                out.append((m.group(0), f"{mon} {int(day)}, {y}".strip(" ,")))
            return out
    blank = DT.sub(lambda m: "\x05" * len(m.group(0)), region)
    ns = [m for m in NUMT.finditer(blank) if not re.fullmatch(r"(?:19|20)\d\d", m.group(0))]
    runs, run = [], []
    for m in ns:
        if run and not NGAP.fullmatch(blank[run[-1].end():m.start()]):
            runs.append(run); run = []
        run.append(m)
    if run:
        runs.append(run)
    for run in runs:
        if len(run) == n:
            head = " ".join(re.findall(r"[A-Za-z][\w.'-]*", region[:run[0].start()])[-2:])
            return [(m.group(0), f"{head} {m.group(0)}") for m in run]
    return None


PERSON = re.compile(r"\b(?:(?:Mr|Ms|Mrs|Dr|Drs)\.?\s+)?[A-Z][\w'’\-]+(?:\s+[A-Z][\w'’\-]+){0,2}")


LOOK_BACK = "--look-back" in sys.argv  # measured flat (1173 vs 1174 official), off by default


def look_back(before, n):
    """An itemless list ("Copies of both orders are attached as Exhibits PP and QQ") takes its items from the
    sentences just before it: an enumeration "a) ... b) ...", a date or number list, or a list of names
    ("with Mr. Ivany and Mr. Duval ..., respectively") of exactly n."""
    before = ws(before)
    en = [x.strip(" ,.;:") for x in re.split(r"(?:^|\s)\(?[a-z]\)\s", before)]
    if len(en) - 1 == n and all(len(x) > 2 for x in en[1:]):
        return [(x, x) for x in en[1:]]
    v = value_run(before, n)
    if v:
        return v
    ps = [m for m in PERSON.finditer(before) if not re.fullmatch(r"(?:The|This|On|In|A|An|I|We|Copies|Exhibits?)", m.group(0))]
    for k in range(len(ps) - n, -1, -1):
        run = ps[k:k + n]
        if all(NGAP.fullmatch(before[a.end():b.start()]) for a, b in zip(run, run[1:])):
            return [(m.group(0), m.group(0)) for m in run]
    return None


def split_items(region, n):
    """region -> n (literal, item) pairs, or None. Enumerated items first, then a date or number list,
    then separators from strongest (";") to weakest (" and "); a piece starting with a modifier
    ("dated ...", "from ...") belongs to the piece before it."""
    region = re.sub(r"(?:[\s,]*\b(?:respectively|and|or)\b)+\W*$", "", ws(region), flags=re.I).strip(" ,.;:")
    if not region:
        return None
    en = [x.strip(" ,.;:") for x in re.split(r"\(\s*(?:\d{1,2}|[a-z]|[ivx]{1,4})\s*\)", region)]
    if len(en) - 1 == n and all(len(x) > 2 for x in en[1:]):
        return [(x, x) for x in en[1:]]
    v = value_run(region, n)
    if v:
        return v
    p = protect(region)
    for lev in LEVELS:
        parts = []
        for x in re.split(lev, p):
            x = x.strip(" ,.;:")
            if not x:
                continue
            if parts and MODIFIER.match(x):
                parts[-1] += ", " + x
            else:
                parts.append(x)
        if len(parts) == n and not any(re.fullmatch(r"(?:\W|\b(?:and|or|the|a|an|of|to|in|is|are)\b)*", x, re.I) for x in parts):
            parts = [unprotect(x) for x in parts]
            return [(x, x) for x in parts]
    return None


def list_items(sent, n):
    """Items of a list mention in its sentence (the mention itself replaced by "§", other mentions by "¤")."""
    s = re.sub(r"\([^()]*[§¤][^()]*\)", " ", sent)
    s = re.sub(r"\s*¤\s*", " ", s)
    v = VERB.search(s)
    cut = min(v.start() if v else len(s), s.find("§") if "§" in s else len(s))
    pre = s[:cut]
    post = s[s.rfind("§") + 1:] if "§" in s else ""
    post = re.split(r"(?<!copy of)(?<!copies of)\s+which\b", post, 1, flags=re.I)[0]
    pre = re.split(r"\brespectively\b", pre, 1, flags=re.I)[0]
    pre = re.split(r",?\s+which\b", pre, 1, flags=re.I)[0]
    obj_after = bool(re.match(r"[\s,]*(?:respectively[\s,]*)?(?:(?:is|are)\b|:)", post, re.I)) or not LEAD.sub("", pre).strip()
    for reg in ((post, pre) if obj_after else (pre, post)):
        reg = LEAD.sub("", ws(reg).replace("§", " "))
        got = split_items(reg, n)
        if got:
            return got
    return None


def clause_item(text, a, b, ss, se, others):
    """A single-label mention that shares its sentence with other mentions owns the clause next to it:
    "A copy of X is attached as Exhibit G, and a copy of Y is attached as Exhibit H". A label used as a
    heading ('Exhibit "A": a loan agreement ...') owns the text after it."""
    nxt = min([o for o, _ in others if o >= b] + [se, b + 500])
    if re.match(r"\s*[\"']?\s*[:\-–—]\s", text[b:b + 6]):
        return ws(re.sub(r"\(\s*[a-z]{1,2}\s*\)\s*$", "", text[b:nxt])).strip(" :-–—;")
    if not others:
        return ""
    prv = max([e for _, e in others if e <= a] + [ss])
    before = ws(text[prv:a])
    after = ws(text[b:nxt])
    # the object follows the label ("Attached as Exhibit F is a document ...") or precedes it ("X is attached as Exhibit A, and ...")
    tail = re.sub(r"^\W*(?:to\s+(?:this|my)\s+(?:\w+\s+)?affidavit|hereto|respectively)?\W*", "", after, flags=re.I)
    obj_after = bool(re.match(r"(?:is|are|was|were|a|an|the|true|copies|copy)\b|[:\-–—]", tail, re.I))
    own = after if obj_after or len(LEAD.sub("", before)) < 12 else before
    return own.strip(" ,.;:")


def definitions(text):
    """Defined term -> the words before it: '... dated May 3, 2024 (the "Appointment Order")'."""
    out = {}
    flat = re.sub(r"\s+", " ", text)
    for m in re.finditer(r"\(\s*(?:the\s+|collectively,?\s+(?:the\s+)?|each\s+(?:a|an)\s+|hereinafter\s+(?:the\s+)?)?[\"']([^\"']{2,60})[\"']\s*\)", flat, re.I):
        out.setdefault(m.group(1).strip().lower(), flat[max(0, m.start() - 260):m.start()])
    return out


def build(r, aff):
    text = clean(aff)
    labels = r["labels"]
    spans = paragraphs(text)
    para_of = lambda pos: next((k for k, (s, e, n) in enumerate(spans) if s <= pos < e), len(spans) - 1)
    ms = mentions(text, labels)
    rows = table_rows(text, labels, {l for m in ms for l in m[2]})
    ms += rows
    rows = {(a, b) for a, b, _, _ in rows}
    terms = definitions(text)
    out = {l: {"mentions": []} for l in labels}
    ms = sorted(ms)
    for idx, (a, b, group, resp) in enumerate(ms):
        k = para_of(a)
        s, e, n = spans[k]
        ss, se = sentence_span(text, a, b)
        sent = ws(text[ss:se])
        others = [(x, y) for j, (x, y, g, _) in enumerate(ms) if j != idx and ss <= x < se]
        marked, cur = [], ss
        for x, y in sorted(others + [(a, b)]):
            if x >= cur:
                marked += [text[cur:x], " § " if (x, y) == (a, b) else " ¤ "]; cur = y
        marked.append(text[cur:se])
        items = list_items(ws("".join(marked)), len(group)) if len(group) > 1 else None
        if LOOK_BACK and len(group) > 1 and not items:
            items = look_back(text[max(s, ss - 600):ss], len(group))
        # a table row is its label's own item; a single label sharing a sentence owns its clause
        clause = ws(text[a:b]) if (a, b) in rows else clause_item(text, a, b, ss, se, others) if len(group) == 1 else ""
        for gi, l in enumerate(group):
            item, sib = clause, []
            if items:
                sib = [lit for j, (lit, _) in enumerate(items) if j != gi]
                shared = sent
                for lit, _ in items:
                    shared = shared.replace(lit, " ")
                item = items[gi][1] + " | " + ws(shared)
            out[l]["mentions"].append({"para": k, "num": n, "sentence": sent, "group": group, "respectively": resp, "pos": a,
                                       "intro": bool(INTRO.search(sent)), "item": item, "sib": sib})
    bounds = sorted((a, b, tuple(g)) for a, b, g, _ in ms)

    def segment(pos, group):
        """Text only this mention owns: from the previous other-exhibit mention to the next one."""
        lo = max([b for a, b, g in bounds if b <= pos and g != group] + [pos - 900])
        end = next(b for a, b, g in bounds if a == pos)
        hi = min([a for a, b, g in bounds if a >= end and g != group] + [end + 600])
        # a table row's mention spans the whole row, which belongs to its label
        start = end
        if end - pos > 80:
            nl = text.find("\n", pos + 1)
            start = nl if 0 < nl < end else end
        return [re.sub(r"\s+", " ", text[x:y]).strip() for x, y in ((lo, pos), (start, max(hi, end)))]

    res = {}
    for l in labels:
        ment = out[l]["mentions"]
        intro = [m for m in ment if m["intro"]] or ment
        main = intro[0] if intro else None
        if main and len(main["group"]) > 1 and not main["item"]:
            # a range header ("Exhibits A to T are the following: (a) Exhibit A: ...") yields to the label's own mention
            main = next((m for m in ment if len(m["group"]) == 1), main)
        paras = []
        for m in ([main] if main else []) + ment:
            if m["para"] not in paras:
                paras.append(m["para"])
        ptxt = lambda k: re.sub(r"\s+", " ", text[spans[k][0]:spans[k][1]]).strip()
        sent = " ".join(dict.fromkeys(m["sentence"] for m in ([main] if main else []) + ment))
        item = main["item"] if main else ""
        desc = item or (main["sentence"] if main else "")
        defs = " ".join(v for k, v in terms.items() if re.search(rf"\b{re.escape(k)}\b", desc, re.I))
        res[l] = {"found": bool(ment), "nums": sorted({m["num"] for m in ment}),
                  "sentence": sent[:1500], "item": item, "sib": main["sib"] if main else [], "main": main["sentence"] if main else "",
                  "paragraph": " ".join(ptxt(k)[:2500] for k in paras[:3])[:4000],
                  "prev": ptxt(paras[0] - 1)[-1200:] if paras and paras[0] > 0 else "",
                  "before": re.sub(r"\s+", " ", text[max(0, main["pos"] - 700):main["pos"]]) if main else "",
                  "after": re.sub(r"\s+", " ", text[main["pos"]:main["pos"] + 500]) if main else "",
                  "seg": segment(main["pos"], tuple(main["group"])) if main else ["", ""],
                  "pos": main["pos"] / max(1, len(text)) if main else -1,
                  "defined": defs[:1200], "group_size": len(main["group"]) if main else 0,
                  "group_pos": main["group"].index(l) if main else 0}
    return res


def main():
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = pos[0] if pos else os.path.join(HERE, "inputs2.json")
    recs = load()
    found = tot = hit = with_gold = 0
    for r in recs:
        aff = open(os.path.join(ROOT, r["record"], "affidavit.txt"), encoding="utf-8").read()
        g = json.load(open(os.path.join(ROOT, r["record"], "gold.json"), encoding="utf-8"))
        gp = {e["label"]: {q.get("paragraph") for q in e.get("references", [])} for e in g["exhibits"]}
        ctx = build(r, aff)
        r["ctx"] = ctx
        for l in r["labels"]:
            tot += 1
            found += ctx[l]["found"]
            if gp.get(l) - {None}:
                with_gold += 1
                hit += bool(set(ctx[l]["nums"]) & gp[l])
    json.dump(recs, open(out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"labels {tot}: mention found {found} ({found / tot:.3f}); gold paragraph among found {hit}/{with_gold} ({hit / max(with_gold, 1):.3f}) -> {out}")


if __name__ == "__main__":
    main()
