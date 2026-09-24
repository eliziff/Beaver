"""Event extraction from the affidavit's own narrative (the --with-affidavit chronology).

Usage:
  python affidavit_events.py paragraphs <out.json> [record_id ...]   dump numbered paragraphs for model runs
  python affidavit_events.py rules <out_predictions.json> [record_id ...]

`rules` is the model-free baseline: every sentence that states a date (full,
month-year, or year) and reads as a happening becomes a row. Predictions are
scored with: python score.py chronology <file> --with-affidavit
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from baseline import ROOT
from chrono_fast import ACTION, first_date
from audit import NAMES

MONTH_YEAR = re.compile(rf"\b({'|'.join(NAMES)})\.?,?\s+(\d{{4}})\b", re.I)


def paragraphs(text):
    text = re.sub(r"\[page \d+\]", " ", text)
    parts = re.split(r"(?:^|\n)\s*(\d{1,3})\.\s", text)
    out = []
    for i in range(1, len(parts) - 1, 2):
        body = re.sub(r"\s+", " ", parts[i + 1]).strip()
        if body:
            out.append({"n": int(parts[i]), "text": body[:2500]})
    return out


def coarse_date(s):
    d = first_date(s)
    if d:
        return d
    m = MONTH_YEAR.search(s)
    if m:
        return f"{m[2]}-{NAMES[m[1].lower()]:02d}"
    m = re.search(r"\b(?:in|during|since|by)\s+((?:19|20)\d{2})\b", s)
    return m[1] if m else ""


def ids_from(args):
    return args or sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "gold.json")))


def main():
    mode, out, ids = sys.argv[1], sys.argv[2], ids_from(sys.argv[3:])
    if mode == "paragraphs":
        data = {rid: paragraphs(open(os.path.join(ROOT, rid, "affidavit.txt"), encoding="utf-8").read()) for rid in ids}
        json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"{len(data)} records, {sum(len(v) for v in data.values())} paragraphs")
        return
    preds = {}
    for rid in ids:
        rows = []
        for p in paragraphs(open(os.path.join(ROOT, rid, "affidavit.txt"), encoding="utf-8").read()):
            for s in re.split(r"(?<=[.;])\s+(?=[A-Z])", p["text"]):
                if ACTION.search(s):
                    d = coarse_date(s)
                    if d:
                        rows.append({"date": d, "description": s[:300], "files": []})
        preds[rid] = rows
    json.dump(preds, open(out, "w", encoding="utf-8"), indent=0)
    print(f"{len(preds)} records, {sum(len(v) for v in preds.values())} rows")


if __name__ == "__main__":
    main()
