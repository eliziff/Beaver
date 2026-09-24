"""Validate a record's gold.json against its affidavit text and split.

Usage: python verify.py <record_dir> [<record_dir> ...]   (or: --all [ROOT])

Checks: every split exhibit has exactly one gold exhibit and vice versa;
every quote occurs in affidavit.txt (quote/space/dash normalized); every
cited paragraph number occurs as a numbered paragraph; dates are ISO; event
exhibit links name real exhibits; the leak audit is empty or waived.
Exit status 1 when any record fails.
"""
import json, os, re, sys

KINDS = {"email", "email_chain", "letter", "text_messages", "photograph", "invoice", "contract", "agreement",
         "court_order", "court_filing", "affidavit", "transcript", "report", "financial_statement", "corporate_record",
         "public_record", "notice", "minutes", "spreadsheet", "webpage", "chart", "map", "other"}
ISO = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")


def fold(t):
    t = re.sub(r"[\"'“”‘’«»`�]", "'", t)
    t = re.sub(r"[‐-―−-]", "-", t)
    t = re.sub(r"\[page \d+\]", " ", t)
    t = re.sub(r"(?m)^\s*-\s*\d+\s*-\s*$", " ", t)  # running page numbers
    return re.sub(r"\s+", " ", t).strip().lower()


def check(record):
    errors = []
    gold = json.load(open(os.path.join(record, "gold.json"), encoding="utf-8"))
    split = json.load(open(os.path.join(record, "split.json"), encoding="utf-8"))
    text = fold(open(os.path.join(record, "affidavit.txt"), encoding="utf-8").read())
    aff_text = open(os.path.join(record, "affidavit.txt"), encoding="utf-8").read()
    # OCR of a scanned page can read "7." alone on its line as "7:".
    paras = set(re.findall(r"(?:^|\s)(\d{1,3})\.(?=\s)", aff_text)) | set(re.findall(r"(?m)^(\d{1,3}):$", aff_text))
    for key in ("record_id", "court", "court_level", "jurisdiction", "subject", "proceeding", "document", "deponent", "sworn_date", "exhibits", "events"):
        if key not in gold:
            errors.append(f"missing {key}")
    if gold.get("subject") in ("", "other"):
        errors.append("subject must name the area of law (insolvency, charter, class_action, ...)")
    for ex in gold.get("exhibits", []):
        twins = {e["label"] for e in gold.get("exhibits", [])}
        if set(ex.get("same_text_as", [])) - twins:
            errors.append(f"exhibit {ex.get('label')} same_text_as names an unknown label")
    if gold.get("sworn_date") and not ISO.match(gold["sworn_date"]):
        errors.append("sworn_date is not ISO")
    split_labels = {e["label"]: e["file"] for e in split["exhibits"]}
    gold_labels = {}
    for ex in gold.get("exhibits", []):
        lab = ex.get("label")
        if lab in gold_labels:
            errors.append(f"exhibit {lab} duplicated")
        gold_labels[lab] = ex
        if split_labels.get(lab) != ex.get("file"):
            errors.append(f"exhibit {lab}: file {ex.get('file')} != split {split_labels.get(lab)}")
        if ex.get("kind") not in KINDS:
            errors.append(f"exhibit {lab}: kind {ex.get('kind')!r} not in vocabulary")
        if not ex.get("description"):
            errors.append(f"exhibit {lab}: empty description")
        if ex.get("date") and not ISO.match(ex["date"]):
            errors.append(f"exhibit {lab}: date {ex['date']} not ISO")
        if not ex.get("references"):
            errors.append(f"exhibit {lab}: no affidavit reference")
        for ref in ex.get("references", []):
            if fold(ref.get("quote", "")) not in text:
                errors.append(f"exhibit {lab}: quote not in affidavit: {ref.get('quote', '')[:80]!r}")
            if ref.get("paragraph") and str(ref["paragraph"]) not in paras:
                errors.append(f"exhibit {lab}: paragraph {ref['paragraph']} not found")
        if not ex.get("content_check"):
            errors.append(f"exhibit {lab}: content_check missing (read the file and confirm it is what the affidavit says)")
    for lab in split_labels.keys() - gold_labels.keys():
        errors.append(f"exhibit {lab} in split but not in gold")
    for lab in gold_labels.keys() - split_labels.keys():
        errors.append(f"exhibit {lab} in gold but not in split")
    ids = set()
    for ev in gold.get("events", []):
        eid = ev.get("id")
        if eid in ids:
            errors.append(f"event {eid} duplicated")
        ids.add(eid)
        for k in ("date", "end_date"):
            if ev.get(k) and not ISO.match(ev[k]):
                errors.append(f"event {eid}: {k} {ev[k]} not ISO")
        if ev.get("precision") not in {"day", "month", "year", "range", "approximate", "undated"}:
            errors.append(f"event {eid}: precision {ev.get('precision')!r}")
        if not ev.get("description"):
            errors.append(f"event {eid}: empty description")
        if fold(ev.get("quote", "")) not in text:
            errors.append(f"event {eid}: quote not in affidavit: {ev.get('quote', '')[:80]!r}")
        for lab in ev.get("exhibits", []):
            if lab not in gold_labels:
                errors.append(f"event {eid}: unknown exhibit {lab}")
    if not gold.get("events"):
        errors.append("no events")
    waived = set(gold.get("leak_waivers", []))
    for leak in split.get("leak_audit", []):
        if leak.get("label") not in waived:
            errors.append(f"unwaived leak: {leak}")
    return errors


def main():
    args = sys.argv[1:]
    if args and args[0] == "--all":
        root = args[1] if len(args) > 1 else os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", "benchmarks", "court-record-exhibits", "records")
        args = [os.path.join(root, d) for d in sorted(os.listdir(root)) if os.path.exists(os.path.join(root, d, "gold.json"))]
    bad = 0
    for record in args:
        errors = check(record)
        bad += bool(errors)
        print(f"{'FAIL' if errors else 'ok  '} {os.path.basename(record)}" + "".join(f"\n     - {e}" for e in errors))
    print(f"{len(args) - bad}/{len(args)} records valid")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
