"""No-model baselines for the exhibits task, and a label-leak probe.

Usage: python baseline.py [record_id ...]

For each record, the affidavit's own mentions of each exhibit (the numbered
paragraph around "Exhibit X") are matched to the unlabelled files by TF-IDF
cosine over their text layers:
  argmax    each label takes its most similar file (no elimination)
  assigned  one-to-one assignment (Hungarian) over the same similarities
  chance    expected accuracy of a random one-to-one assignment (1/N)
  leak      files whose own text names an exhibit label (Exhibit/Tab/Pièce X)
            equal to their true label: a labelling leak if well above zero
Image-only files have empty text layers, so a lexical matcher cannot place them.
"""
import json, math, os, re, sys
from collections import Counter
import numpy as np
from scipy.optimize import linear_sum_assignment

ROOT = os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", "benchmarks", "court-record-exhibits", "records")
Q = r"[\"'“”‘’«»�]?"
MENTION = re.compile(rf"\bexhibits?\s+{Q}([A-Z]{{1,3}}(?:-\d{{1,3}})?|\d{{1,3}})\b{Q}", re.I)
OWN = re.compile(rf"\b(?:exhibit|tab|pi[èe]ce)\s+{Q}([A-Z]{{1,3}}|\d{{1,3}})\b{Q}", re.I)
WORD = re.compile(r"[a-z][a-z0-9'-]{2,}|\d[\d,.$/-]*\d")
STOP = set("the and for that this with was were are has have had not but from into its his her their they them which who been being will would shall may also any all our out per via upon such than then there these those what when where while about after before between during under over other more most some only same very can could should each exhibit affidavit attached hereto copy marked sworn".split())


def tokens(text):
    return [w for w in WORD.findall(text.lower()) if w not in STOP]


def contexts(aff, labels):
    """Paragraph text around each mention of each label in the affidavit."""
    text = re.sub(r"\[page \d+\]", " ", aff)
    starts = [m.start() for m in re.finditer(r"(?:^|\n)\s*\d{1,3}\.\s", text)] + [len(text)]
    out = {lab: [] for lab in labels}
    for m in MENTION.finditer(text):
        lab = m.group(1).upper()
        if lab not in out:
            continue
        a = max([s for s in starts if s <= m.start()] or [max(0, m.start() - 600)])
        b = min([s for s in starts if s > m.start()] or [m.end() + 600])
        out[lab].append(text[a:min(b, a + 3000)])
    return {lab: " ".join(v) for lab, v in out.items()}


def tfidf(docs):
    bags = [Counter(tokens(d)) for d in docs]
    df = Counter(t for b in bags for t in b)
    n = len(docs)
    vocab = {t: i for i, t in enumerate(df)}
    m = np.zeros((n, len(vocab)))
    for i, b in enumerate(bags):
        for t, c in b.items():
            m[i, vocab[t]] = (1 + math.log(c)) * math.log((1 + n) / (1 + df[t]))
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    return m / np.where(norms == 0, 1, norms)


def run(rid):
    rec = os.path.join(ROOT, rid)
    gold = json.load(open(os.path.join(rec, "gold.json"), encoding="utf-8"))
    truth = {e["file"]: e["label"] for e in gold["exhibits"]}
    files = sorted(truth)
    labels = sorted({e["label"] for e in gold["exhibits"]})
    ftext = [open(os.path.join(rec, "files", f.replace(".pdf", ".txt")), encoding="utf-8").read() for f in files]
    ctx = contexts(open(os.path.join(rec, "affidavit.txt"), encoding="utf-8").read(), labels)
    m = tfidf([ctx[l] for l in labels] + ftext)
    sim = m[:len(labels)] @ m[len(labels):].T
    argmax = sum(truth[files[int(np.argmax(sim[i]))]] == l for i, l in enumerate(labels) if sim[i].max() > 0)
    rows, cols = linear_sum_assignment(-sim)
    assigned = sum(truth[files[c]] == labels[r] for r, c in zip(rows, cols))
    leak = 0
    for f, t in zip(files, ftext):
        named = {x.upper() for x in OWN.findall(t)}
        leak += truth[f] in named and len(named) == 1
    textless = sum(len(re.sub(r"\[page \d+\]|\s", "", t)) < 50 for t in ftext)
    return len(files), argmax, assigned, leak, textless


def main():
    ids = sys.argv[1:] or sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "gold.json")))
    tot = np.zeros(5)
    chance = 0.0
    print(f"{'record':32} {'files':>5} {'argmax':>6} {'assign':>6} {'leak':>4} {'noText':>6}")
    for rid in ids:
        r = run(rid)
        tot += r
        chance += 1
        print(f"{rid:32} {r[0]:5} {r[1]:6} {r[2]:6} {r[3]:4} {r[4]:6}")
    n = tot[0]
    print(f"{'TOTAL':32} {int(n):5} {int(tot[1]):6} {int(tot[2]):6} {int(tot[3]):4} {int(tot[4]):6}")
    print(f"accuracy: argmax {tot[1] / n:.3f}  assigned {tot[2] / n:.3f}  chance {chance / n:.3f}  leak {tot[3] / n:.3f}  text-less files {tot[4] / n:.3f}")


if __name__ == "__main__":
    main()
