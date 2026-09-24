"""Audit gold records against their original PDFs (beyond verify.py's schema checks).

Usage: python audit.py [record_id ...]    (default: every record with gold.json)

Per record it reports:
  cover     each exhibit's cover (or stamp) page in the ORIGINAL PDF names that label
  mentions  every exhibit label the affidavit mentions is a gold exhibit, or is
            explained (referenced_not_attached / another affidavit's exhibit)
  dated     affidavit paragraphs stating a full date that no event cites
  exdate    gold exhibit dates not found in the exhibit file's text layer
  jurat     stripped files whose first page still carries jurat wording
Findings are leads for review, not verdicts: an uncited dated paragraph may be
background, and image-only files cannot show their dates.
"""
import json, os, re, sys
import fitz

ROOT = os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", "benchmarks", "court-record-exhibits")
MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre"
FULL_DATE = re.compile(rf"\b(?:\d{{1,2}}(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?(?:{MONTHS}),?\s+\d{{4}}|(?:{MONTHS})\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}|\d{{4}}-\d{{2}}-\d{{2}})\b", re.I)
MONTH_NUM = {m: i % 12 + 1 for i, m in enumerate("january february march april may june july august september october november december".split())}
Q = r"[\"'“”‘’«»�]?"
MENTION = re.compile(rf"\bexhibits?\s+{Q}([A-Z]{{1,3}}(?:-\d{{1,3}})?|\d{{1,3}})\b{Q}", re.I)
JURAT = re.compile(r"sworn before me|affirmed before me|commissioner for taking|a commissioner, etc|this is exhibit|ceci est la pi[èe]ce", re.I)


def fold(t):
    return re.sub(r"\s+", " ", re.sub(r"[\"'“”‘’«»`�]", "'", t)).lower()


def paragraphs(text):
    """Numbered affidavit paragraphs: number -> text."""
    text = re.sub(r"\[page \d+\]", " ", text)
    parts = re.split(r"(?:^|\n)\s*(\d{1,3})\.\s", text)
    out = {}
    for i in range(1, len(parts) - 1, 2):
        out.setdefault(int(parts[i]), parts[i + 1])
    return out


NAMES = {**MONTH_NUM, **{m[:3]: n for m, n in MONTH_NUM.items()}, "sept": 9, "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
         "juillet": 7, "août": 8, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12}
MN = "|".join(sorted(NAMES, key=len, reverse=True))
DATES = [re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th|er)?\s*(?:day\s+of\s+)?({MN})\.?,?\s+(\d{{4}})", re.I),
         re.compile(rf"\b({MN})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})", re.I),
         re.compile(r"\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b"), re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b"),
         re.compile(rf"\b(\d{{1,2}})-({MN})-(\d{{2,4}})\b", re.I)]


def iso_dates(text):
    """Every calendar date in the text as ISO (both readings of an ambiguous numeric date)."""
    out = set()
    t = re.sub(r"\s+", " ", text)
    def add(y, m, d):
        if 1 <= m <= 12 and 1 <= d <= 31:
            out.add(f"{y:04d}-{m:02d}-{d:02d}")
    for m in DATES[0].finditer(t): add(int(m[3]), NAMES[m[2].lower()], int(m[1]))
    for m in DATES[1].finditer(t): add(int(m[3]), NAMES[m[1].lower()], int(m[2]))
    for m in DATES[2].finditer(t): add(int(m[1]), int(m[2]), int(m[3]))
    for m in DATES[3].finditer(t): add(int(m[3]), int(m[2]), int(m[1])); add(int(m[3]), int(m[1]), int(m[2]))
    for m in DATES[4].finditer(t): y = int(m[3]); add(y + 2000 if y < 100 else y, NAMES[m[2].lower()], int(m[1]))
    return out


def audit(rid):
    rec = os.path.join(ROOT, "records", rid)
    gold = json.load(open(os.path.join(rec, "gold.json"), encoding="utf-8"))
    split = json.load(open(os.path.join(rec, "split.json"), encoding="utf-8"))
    source = json.load(open(os.path.join(rec, "source.json"), encoding="utf-8"))
    findings = []
    raw = os.path.join(ROOT, "raw", source["source_file"])
    src = fitz.open(raw) if os.path.exists(raw) else None
    if not src:
        findings.append(("cover", f"source PDF missing: {source['source_file']}"))
    for ex in split["exhibits"]:
        page = ex["cover_page"] or ex["stamp_page"]
        if src and page:
            t = fold(src[page - 1].get_text())
            lab = ex["label"].lower()
            if not re.search(rf"(?:exhibit|pi[èe]ce)\s*'?\s*'?{re.escape(lab)}\b", t) and len(t.strip()) > 30:
                findings.append(("cover", f"{ex['label']}: cover page {page} text does not name it: {t[:120]!r}"))
    aff_raw = open(os.path.join(rec, "affidavit.txt"), encoding="utf-8").read()
    labels = {e["label"] for e in gold["exhibits"]}
    explained = fold(" ".join(gold.get("referenced_not_attached", []) + [x for e in gold["events"] for x in e.get("referenced_not_attached", [])]))
    for m in MENTION.finditer(aff_raw):
        lab = m.group(1).upper()
        if lab in labels or lab == "S":
            continue
        ctx = fold(aff_raw[max(0, m.start() - 160):m.end() + 60])
        if re.search(r"affidavit of|report|to the .{0,40}affidavit|appendix|schedule|tab \d|motion record|application record", ctx) or f"exhibit {lab.lower()}" in explained:
            continue
        findings.append(("mentions", f"affidavit mentions Exhibit {lab} but gold has no such exhibit: …{ctx[-150:]}"))
    paras = paragraphs(aff_raw)
    cited = {p for e in gold["events"] for p in e.get("paragraphs", [])}
    for n, body in paras.items():
        if FULL_DATE.search(body) and n not in cited and not re.search(r"sworn|affirmed|commissioner", body, re.I):
            findings.append(("dated", f"para {n} states {FULL_DATE.search(body).group(0)!r} but no event cites it: {fold(body)[:110]!r}"))
    for ex in gold["exhibits"]:
        if not ex.get("date") or len(ex["date"]) < 10:
            continue
        txt = os.path.join(rec, "files", ex["file"].replace(".pdf", ".txt"))
        body = fold(open(txt, encoding="utf-8").read()) if os.path.exists(txt) else ""
        if len(body) > 200 and ex["date"] not in iso_dates(open(txt, encoding="utf-8").read()):
            findings.append(("exdate", f"{ex['label']} dated {ex['date']} but the file text never states that date"))
    for ex in split["exhibits"]:
        doc = fitz.open(os.path.join(rec, "files", ex["file"]))
        if JURAT.search(doc[0].get_text()):
            findings.append(("jurat", f"{ex['label']} ({ex['file']}) page 1 still has jurat wording: {fold(JURAT.search(doc[0].get_text()).group(0))}"))
    return findings


def main():
    ids = sys.argv[1:] or sorted(d for d in os.listdir(os.path.join(ROOT, "records")) if os.path.exists(os.path.join(ROOT, "records", d, "gold.json")))
    totals = {}
    for rid in ids:
        f = audit(rid)
        for kind, _ in f:
            totals[kind] = totals.get(kind, 0) + 1
        print(f"== {rid}: {len(f)} findings")
        for kind, msg in f:
            print(f"   [{kind}] {msg}"[:260])
    print("totals:", totals)


if __name__ == "__main__":
    main()
