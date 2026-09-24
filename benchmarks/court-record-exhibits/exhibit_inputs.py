"""Dump model-agnostic inputs for the exhibits task (for browser-model runs).

Usage: python exhibit_inputs.py <out.json> [record_id ...]

Per record: each exhibit label's reference text from the affidavit (the
sentence(s) mentioning it, and its whole paragraph), and each file's text
(first 6,000 characters of its text layer; empty for image-only files).
The truth mapping is included for scoring and must not be shown to a model.
"""
import json, os, re, sys
from baseline import ROOT, MENTION, contexts


def sentences(paragraph, label):
    """Sentences of a paragraph that mention this exhibit label."""
    text = re.sub(r"\s+", " ", paragraph)
    text = re.sub(r"\b(Mr|Ms|Mrs|Dr|No|Nos|Inc|Ltd|Co|Corp|St|Ave|para|paras|s|ss|Hon|Jr|Sr|vs|v)\.\s", r"\1<dot> ", text)
    parts = [p.replace("<dot>", ".") for p in re.split(r"(?<=[.;:])\s+(?=[A-Z(])", text)]
    hit = [p for p in parts if any(m.group(1).upper() == label for m in MENTION.finditer(p))]
    return " ".join(hit) or re.sub(r"\s+", " ", paragraph)[:600]


QUOTES = re.compile(r"[\"“”«»�]")
ITEM_SPLIT = re.compile(r",\s*(?:and\s+)?|\s+and\s+", re.I)


def description(sentence, label):
    """What the affidavit calls this exhibit: the noun phrase attached as it,
    taking the matching item of an "X and Y ... Exhibits A and B, respectively" list."""
    s = QUOTES.sub('"', sentence)
    m = re.search(r"(?:cop(?:y|ies) of\s+)?(.+?)\s+(?:is|are)\s+(?:attached|marked|appended|produced)(?:.*?)\bexhibits?\s+(.+?),?\s+respectively", s, re.I)
    if m:
        items = [x.strip() for x in ITEM_SPLIT.split(m.group(1)) if x.strip()]
        order = [x.group(1).upper() for x in MENTION.finditer("exhibit " + m.group(2))]
        order = order or [x.upper() for x in re.findall(r'"?([A-Z]{1,3}|\d{1,3})"?', m.group(2))]
        if label in order and len(items) == len(order):
            return items[order.index(label)]
    for rx in (rf"cop(?:y|ies) of\s+(.+?)\s+(?:is|are)\s+(?:attached|marked|appended|produced)",
               rf"attached\s+(?:hereto\s+)?(?:and\s+marked\s+)?as\s+exhibits?\s+\"?{re.escape(label)}\"?\s*(?:to\s+this\s+(?:my\s+)?affidavit\s+)?(?:is|are)\s+(?:a\s+)?(?:true\s+)?(?:cop(?:y|ies)\s+of\s+)?(.+?)(?:[.;]|$)",
               rf"(.+?)\s+(?:is|are)\s+(?:attached|marked|appended)"):
        m = re.search(rx, s, re.I)
        if m and len(m.group(1)) > 3:
            return m.group(1).strip()[-300:]
    return s[-300:]


def definitions(affidavit):
    """Defined terms -> the words that define them: "... dated May 3, 2024 (the "Appointment Order")"."""
    text = QUOTES.sub('"', re.sub(r"\s+", " ", re.sub(r"\[page \d+\]", " ", affidavit)))
    out = {}
    text = re.sub(r"[‘’]", "'", text)
    for m in re.finditer(r"\(\s*(?:the\s+|collectively,?\s+(?:the\s+)?|each\s+(?:a|an)\s+)?[\"']([^\"']{2,60})[\"']\s*\)", text, re.I):
        out.setdefault(m.group(1).strip().lower(), text[max(0, m.start() - 260):m.start()])
    return out


def main():
    out, ids = sys.argv[1], sys.argv[2:]
    ids = ids or sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "gold.json")))
    records = []
    for rid in ids:
        rec = os.path.join(ROOT, rid)
        gold = json.load(open(os.path.join(rec, "gold.json"), encoding="utf-8"))
        labels = sorted({e["label"] for e in gold["exhibits"]})
        affidavit = open(os.path.join(rec, "affidavit.txt"), encoding="utf-8").read()
        ctx = contexts(affidavit, labels)
        terms = definitions(affidavit)
        refs = {l: sentences(ctx[l], l) for l in labels}
        desc = {l: description(refs[l], l) for l in labels}
        defined = {l: " ".join(v for k, v in terms.items() if re.search(rf"\b{re.escape(k)}\b", desc[l], re.I)) for l in labels}
        files = sorted(e["file"] for e in gold["exhibits"])
        texts = []
        for f in files:
            t = open(os.path.join(rec, "files", f.replace(".pdf", ".txt")), encoding="utf-8").read()
            texts.append(re.sub(r"[ \t]+", " ", re.sub(r"\[page \d+\]\n?", "", t)).strip()[:6000])
        records.append({"record": rid, "labels": labels,
                        "reference": refs, "description": desc, "defined": defined,
                        "paragraph": {l: re.sub(r"\s+", " ", ctx[l])[:2500] for l in labels},
                        "files": files, "texts": texts,
                        "truth": {e["file"]: e["label"] for e in gold["exhibits"]}})
    json.dump(records, open(out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{len(records)} records, {sum(len(r['files']) for r in records)} files -> {out}")


if __name__ == "__main__":
    main()
