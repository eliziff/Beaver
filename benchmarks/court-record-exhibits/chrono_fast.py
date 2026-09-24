"""Model-free chronology baseline: one dated entry per document, plus dated sentences.

Usage: python chrono_fast.py <out_predictions.json> [--sentences] [record_id ...]

For each exhibit file: its own date (email header Date/Sent line, a letter's
standalone date line, an order's "this Nth day of Month, YYYY", else the
first full date in its opening 1,500 characters) and a short description (the
email subject or the document's first title-like line). With --sentences,
every sentence stating a full date and reading as a happening (a past-tense
or action verb) is added too. Writes score.py chronology predictions.
"""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit import iso_dates, DATES, NAMES
from baseline import ROOT

HEADER_DATE = re.compile(r"^\s*(?:sent|date|envoy[ée])\s*:?\s+(.+)$", re.I | re.M)
SUBJECT = re.compile(r"^\s*(?:subject|objet|re)\s*:\s*(.+)$", re.I | re.M)
DAY_OF = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+day\s+of\s+({'|'.join(NAMES)})\.?,?\s+(\d{{4}})", re.I)
ACTION = re.compile(r"\b\w{3,}ed\b|\b(?:sent|met|paid|signed|made|gave|took|told|wrote|spoke|went|came|began|issued|filed|served|held|sold|bought|won|lost|left|found|said|brought|ran|became)\b", re.I)


def first_date(text):
    ds = []
    t = re.sub(r"\s+", " ", text)
    for rx in DATES[:2]:
        for m in rx.finditer(t):
            d = sorted(iso_dates(m.group(0)))
            if d:
                ds.append((m.start(), d[0]))
    return min(ds)[1] if ds else ""


def doc_date(text):
    head = text[:1500]
    m = HEADER_DATE.search(head)
    if m and iso_dates(m.group(1)):
        return sorted(iso_dates(m.group(1)))[0]
    m = DAY_OF.search(re.sub(r"\s+", " ", head))
    if m:
        return sorted(iso_dates(m.group(0)))[0]
    return first_date(head)


def doc_title(text):
    m = SUBJECT.search(text[:1500])
    if m:
        return "Email: " + m.group(1).strip()[:120]
    for line in text[:1200].splitlines():
        s = line.strip()
        if 12 <= len(s) <= 120 and sum(c.isalpha() for c in s) > 0.6 * len(s) and not re.search(r"court file|page \d|^\d", s, re.I):
            return s
    return re.sub(r"\s+", " ", text[:100]).strip() or "(image only)"


def sentences_with_dates(text):
    t = re.sub(r"\s+", " ", text)
    for s in re.split(r"(?<=[.!?])\s+(?=[A-Z])", t):
        if 30 < len(s) < 500 and ACTION.search(s):
            d = first_date(s)
            if d:
                yield d, s[:200]


def file_text(path):
    """Text of a PDF, .eml or .docx file as a reader would get it."""
    if path.endswith(".eml"):
        import email
        m = email.message_from_binary_file(open(path, "rb"))
        body = next((p.get_payload(decode=True).decode("utf-8", "replace") for p in m.walk() if p.get_content_type() == "text/plain"), "")
        return "".join(f"{k}: {m[k]}\n" for k in ("From", "Date", "To", "Cc", "Subject") if m[k]) + "\n" + body
    if path.endswith(".docx"):
        import docx
        return "\n".join(p.text for p in docx.Document(path).paragraphs)
    import fitz
    return "\n".join(p.get_text() for p in fitz.open(path))


def haystack(out, rids, use_sent):
    base = os.path.join(os.path.dirname(ROOT), "haystack")
    preds = {}
    for rid in rids:
        rows = []
        for e in json.load(open(os.path.join(base, rid, "manifest.json"), encoding="utf-8"))["files"]:
            text = file_text(os.path.join(base, rid, "files", e["file"]))
            rows.append({"date": doc_date(text), "description": doc_title(text), "files": [e["file"]]})
            if use_sent:
                seen = {rows[-1]["date"]}
                for d, s in sentences_with_dates(text[:20000]):
                    if d not in seen:
                        seen.add(d)
                        rows.append({"date": d, "description": s, "files": [e["file"]]})
        preds[rid] = [r for r in rows if r["date"]]
    json.dump(preds, open(out, "w", encoding="utf-8"), indent=0)
    print(f"haystack: {sum(len(v) for v in preds.values())} rows")


def main():
    args = sys.argv[1:]
    out, use_sent = args[0], "--sentences" in args
    if "--haystack" in args:
        return haystack(out, [a for a in args[1:] if not a.startswith("--")], use_sent)
    ids = [a for a in args[1:] if not a.startswith("--")] or sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "gold.json")))
    preds, t0, rows = {}, time.time(), 0
    for rid in ids:
        gold = json.load(open(os.path.join(ROOT, rid, "gold.json"), encoding="utf-8"))
        out_rows = []
        for e in gold["exhibits"]:  # the files only; labels are never used
            text = open(os.path.join(ROOT, rid, "files", e["file"].replace(".pdf", ".txt")), encoding="utf-8").read()
            text = re.sub(r"\[page \d+\]", "", text)
            title = doc_title(text)
            out_rows.append({"date": doc_date(text), "description": title, "title": title, "files": [e["file"]]})
            if use_sent:
                seen = {out_rows[-1]["date"]}
                for d, s in sentences_with_dates(text[:20000]):
                    if d not in seen:
                        seen.add(d)
                        out_rows.append({"date": d, "description": s, "title": title, "files": [e["file"]]})
        preds[rid] = out_rows
        rows += len(out_rows)
    json.dump(preds, open(out, "w", encoding="utf-8"), indent=0)
    print(f"{len(ids)} records, {rows} rows, {1000 * (time.time() - t0) / len(ids):.0f} ms/record")


if __name__ == "__main__":
    main()
