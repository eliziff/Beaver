"""Affidavit side: find every mention of every exhibit label and build its context.

Handles quoted/unquoted labels with stray spaces or line breaks, label lists
("Exhibits "C", "D" and "E" respectively"), ranges ("Exhibits A to D"),
multi-letter and numeric labels, and exhibit tables (a label alone on a line
followed by its row). Only labels the record actually has are accepted.

Usage: python refs.py [out.json]   (default inputs2.json; prints recall against gold paragraphs)
"""
import json, os, re, sys
from common import HERE, ROOT, load

QUOTES = str.maketrans({c: '"' for c in "“”«»�„‟"} | {c: "'" for c in "‘’‚‛"})
LAB = r"(?:[A-Z]{1,4}-?\d{1,3}|[A-Z]{1,4}|\d{1,3}(?:-\d{1,3})?)"
QL = rf"[\"']?\s?({LAB})\s?[\"']?(?![A-Za-z0-9])"
SEP = r"\s*(?:,\s*(?:and\s+|&\s*)?|\band\b|&|\bto\b|\bthrough\b|[-–—])\s*(?:exhibits?\s*)?"
LIST = re.compile(rf"\b(?:exhibits?|pi[eè]ces?)\s*(?:nos?\.?\s*)?{QL}((?:{SEP}{QL})*)", re.I)
ONE = re.compile(rf"({SEP}){QL}", re.I)
INTRO = re.compile(r"\battached\b|\bmarked\b|\bannexed\b|\bappended\b|\benclosed\b|\bproduced\b|\bis a (?:true )?copy\b|\bare (?:true )?copies\b|\bnow shown\b", re.I)
PARA = re.compile(r"(?:^|\n)[ \t]*\(?(\d{1,3})[.)](?=\s)")
OCR = {"0": "O", "1": "I", "L": "I"}  # text-layer misreads of a one-letter label


def canon(raw, L):
    """The record label a mention names, allowing "F-1" for F1 and OCR's "0" for O."""
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
    t = re.sub(r"\[page \d+\]", "\n", aff).translate(QUOTES).replace("­", "")
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
    for m in LIST.finditer(text):
        first = canon(m.group(1), L)
        got = [first] if first else []
        prev = first
        for s in ONE.finditer(m.group(2) or ""):
            lab = canon(s.group(2), L)
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


SENT_ABBR = re.compile(r"\b(Mr|Ms|Mrs|Dr|No|Nos|Inc|Ltd|Co|Corp|St|Ave|para|paras|s|ss|Hon|Jr|Sr|vs|v|Reg|c|ch|art|arts)\.\s")


def sentence_at(text, a, b):
    """The sentence containing text[a:b]."""
    left = text[max(0, a - 700):a]
    right = text[b:b + 700]
    lm = [m.end() for m in re.finditer(r"[.;:!?]\s+(?=[\"(]?[A-Z0-9])|\n\s*\n|\n\s*\(?\d{1,3}[.)]\s", SENT_ABBR.sub(lambda x: x.group(0).replace(".", "~"), left))]
    rm = re.search(r"[.;!?](?=\s+[\"(]?[A-Z0-9]|\s*$)|\n\s*\n|\n\s*\(?\d{1,3}[.)]\s", SENT_ABBR.sub(lambda x: x.group(0).replace(".", "~"), right))
    s = left[lm[-1]:] if lm else left
    return re.sub(r"\s+", " ", s + text[a:b] + (right[:rm.end()] if rm else right)).strip()


ITEM_SPLIT = re.compile(r";\s*(?:and\s+)?|,\s*(?:and\s+)?(?=(?:a|an|the|my|his|her|its|their|copies|copy|two|three|four|five|\d)\b)|\s+and\s+(?=(?:a|an|the|my|his|her|its|their|copies|copy)\b)", re.I)


def item_for(sentence, label, group):
    """For "X, Y and Z are attached as Exhibits A, B and C respectively", the item matching the label."""
    if len(group) < 2:
        return ""
    s = re.split(r"\b(?:is|are)\s+(?:attached|marked|appended|annexed|produced)|\battached\b", sentence, 1, flags=re.I)
    for cand in (s[0], s[-1] if len(s) > 1 else ""):
        body = re.sub(r"^.*?\b(?:cop(?:y|ies) of|are|is)\s+", "", cand, 1, flags=re.I) if cand is s[-1] else cand
        items = [x.strip(" .,:") for x in ITEM_SPLIT.split(re.sub(r"\(\s*[a-z0-9]{1,3}\s*\)", ";", body)) if len(x.strip(" .,:")) > 3]
        if len(items) == len(group):
            return items[group.index(label)]
    return ""


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
    ms += table_rows(text, labels, {l for m in ms for l in m[2]})
    terms = definitions(text)
    out = {l: {"mentions": []} for l in labels}
    for a, b, group, resp in sorted(ms):
        k = para_of(a)
        s, e, n = spans[k]
        sent = sentence_at(text, a, b)
        for l in group:
            out[l]["mentions"].append({"para": k, "num": n, "sentence": sent, "group": group, "respectively": resp, "pos": a,
                                       "intro": bool(INTRO.search(sent)), "item": item_for(sent, l, group) if resp or len(group) > 1 else ""})
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
                  "sentence": sent[:1500], "item": item, "main": main["sentence"] if main else "",
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
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "inputs2.json")
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
