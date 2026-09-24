"""Blind audit packets and the quote checker that makes the audit prove its reading.

Usage: python packets.py build <out_dir> <record_id ...>
       python packets.py check <out_dir>

build: per record, <out_dir>/<id>/affidavit.txt (the whole affidavit) and files.txt (every exhibit
file's opening, 2,500 characters, under its anonymous file name). Nothing from gold.json.
check: reads <out_dir>/<id>/answers.json written by the auditor:
  {"mapping": [{"file": "doc-x.pdf", "label": "C", "file_quote": "...", "affidavit_quote": "..."}],
   "events": [{"paragraph": "12", "quote": "...", "date": "YYYY-MM-DD", "exhibits": ["C"], "event": "..."}]}
Quotes must appear verbatim (case and whitespace folded) in the packet; answers whose quotes do not are
discarded. Then the surviving mapping is compared with gold, and each claimed missing event is checked
against the gold events (same exhibit and date means it was not missing).
"""
import json, os, re, sys
from baseline import ROOT

fold = lambda t: re.sub(r"\s+", " ", re.sub(r"[\"'“”‘’«»`]", "'", re.sub(r"\[page \d+\]", " ", t))).lower().strip()


def build(out, ids):
    for rid in ids:
        d = os.path.join(out, rid)
        os.makedirs(d, exist_ok=True)
        rec = os.path.join(ROOT, rid)
        open(os.path.join(d, "affidavit.txt"), "w", encoding="utf-8").write(open(os.path.join(rec, "affidavit.txt"), encoding="utf-8").read())
        parts = []
        for f in sorted(os.listdir(os.path.join(rec, "files"))):
            if f.endswith(".txt"):
                t = open(os.path.join(rec, "files", f), encoding="utf-8").read()
                parts.append(f"===== FILE {f[:-4]}.pdf =====\n{t[:2500].strip() or '(no text: image-only)'}\n")
        open(os.path.join(d, "files.txt"), "w", encoding="utf-8").write("\n".join(parts))
        print(f"{rid}: {len(parts)} files")


def check(out):
    tot = agree = rejected = claimed = confirmed = 0
    for rid in sorted(os.listdir(out)):
        ans_p = os.path.join(out, rid, "answers.json")
        if not os.path.exists(ans_p):
            continue
        ans = json.load(open(ans_p, encoding="utf-8"))
        aff = fold(open(os.path.join(out, rid, "affidavit.txt"), encoding="utf-8").read())
        files_txt = open(os.path.join(out, rid, "files.txt"), encoding="utf-8").read()
        per_file = {m.group(1): fold(m.group(2)) for m in re.finditer(r"===== FILE (\S+) =====\n(.*?)(?=\n===== FILE |\Z)", files_txt, re.S)}
        g = json.load(open(os.path.join(ROOT, rid, "gold.json"), encoding="utf-8"))
        truth = {e["file"]: {e["label"], *e.get("same_text_as", [])} for e in g["exhibits"]}
        bad, dis = [], []
        for m in ans.get("mapping", []):
            fq, aq = fold(m.get("file_quote", "")), fold(m.get("affidavit_quote", ""))
            image_only = per_file.get(m["file"], "").startswith("(no text")
            if (not image_only and (len(fq.split()) < 3 or fq not in per_file.get(m["file"], ""))) or len(aq.split()) < 3 or aq not in aff:
                bad.append(m["file"]); continue
            tot += 1
            if m["label"] in truth.get(m["file"], set()):
                agree += 1
            else:
                dis.append(f"{m['file']}: auditor {m['label']} vs gold {sorted(truth.get(m['file'], {'?'}))}")
        rejected += len(bad)
        gold_ev = {(l, (e.get("date") or "")[:10]) for e in g["events"] for l in e["exhibits"]}
        miss = []
        for ev in ans.get("events", []):
            if fold(ev.get("quote", "")) not in aff or len(fold(ev.get("quote", "")).split()) < 3:
                rejected += 1; continue
            claimed += 1
            if not any((l, (ev.get("date") or "")[:10]) in gold_ev for l in ev.get("exhibits", [])):
                confirmed += 1; miss.append(f"para {ev.get('paragraph')}: {ev.get('date')} {ev.get('exhibits')} {ev.get('event', '')[:90]}")
        print(f"{rid}: mapping {len(ans.get('mapping', [])) - len(bad)} checked, {len(bad)} rejected (quotes not found); "
              f"{len(dis)} disagreements; {len(miss)} events missing from gold")
        for x in dis + miss:
            print("   ", x)
    print(f"\nmapping agreement {agree}/{tot} = {agree / max(tot, 1):.3f}; answers rejected for unfound quotes {rejected}; "
          f"missing events claimed {claimed}, not in gold {confirmed}")


if __name__ == "__main__":
    {"build": lambda: build(sys.argv[2], sys.argv[3:]), "check": lambda: check(sys.argv[2])}[sys.argv[1]]()
