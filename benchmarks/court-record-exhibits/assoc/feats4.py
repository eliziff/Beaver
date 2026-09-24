"""Pair features v4: author / recipient agreement (Fellegi-Sunter fields 'from' and 'to').

Affidavit side, in the text the mention owns: "from X", "to Y", "X's letter", and "my email"
(author = the affiant, named in "I, NAME, of ..."). File side, in the opening: email
From:/To: lines, "Dear Y", "Attention: Y", and the letterhead (first 200 characters) as author.

Usage: python feats4.py -> feats_party.npz (+ _names.npy)
"""
import json, os, re
import numpy as np
from common import HERE, ROOT
import fields as F

CAP = r"((?:(?:Mr|Ms|Mrs|Dr|Hon)\.?\s+)?(?:the\s+)?(?:[A-Z][\w'’\-]+(?:\s+|$)){1,4})"
R_FROM = re.compile(rf"\b(?:from|by|sent by|authored by|written by)\s+{CAP}")
R_TO = re.compile(rf"\b(?:to|addressed to|sent to|with)\s+{CAP}")
R_POSS = re.compile(r"\b((?:[A-Z][\w\-]+\s+){0,2}[A-Z][\w\-]+)['’]s\s+(?:e-?mail|letter|correspondence|memo|message|response|reply|report|notice)")
R_MY = re.compile(r"\b(?:my|I)\s+(?:e-?mail(?:ed)?|letter|correspondence|wrote|sent|text(?:ed)?|message|memo|response|reply)", re.I)
AFFIANT = re.compile(r"\bI,\s+([A-Z][A-Za-z.'’\- ]{3,60}?),\s+(?:of|am|the|residing|a|an|in|lawyer|barrister|solicitor|make|MAKE|SWEAR|swear)")
F_FROM = re.compile(r"(?im)^\s*(?:from|de|sender)\s*:\s*(.{0,120})")
F_TO = re.compile(r"(?im)^\s*(?:to|à|a|cc|recipient)\s*:\s*(.{0,160})")
F_DEAR = re.compile(r"\b(?:Dear|Attention:?|Attn:?|ATTENTION:?)\s+((?:(?:Mr|Ms|Mrs|Dr|Sir|Madam)\.?\s*)?(?:[A-Z][\w'’\-]+[\s,:]*){1,4})")


def nameset(chunks):
    out = set()
    for c in chunks:
        out |= F.names(c)
    return out


def affiant(rid):
    t = open(os.path.join(ROOT, rid, "affidavit.txt"), encoding="utf-8").read()[:4000]
    m = AFFIANT.search(re.sub(r"\s+", " ", t))
    return F.names(m[1]) if m else set()


def record_feats(r):
    me = affiant(r["record"])
    labels, texts = r["labels"], r["texts"]
    C = r["ctx"]
    ffrom, fto = [], []
    for t in texts:
        h = t[:1500]
        a = [m[1] for m in F_FROM.finditer(h)]
        b = [m[1] for m in F_TO.finditer(h)] + [m[1] for m in F_DEAR.finditer(h)]
        ffrom.append(nameset(a + [h[:200]])); fto.append(nameset(b))
    X = np.zeros((len(labels), len(texts), 7), np.float32)
    for i, l in enumerate(labels):
        c = C[l]
        own = " ".join(c["seg"]) + " " + (c["item"] or "")
        rf = nameset([m[1] for m in R_FROM.finditer(own)] + [m[1] for m in R_POSS.finditer(own)])
        rt = nameset([m[1] for m in R_TO.finditer(own)])
        if R_MY.search(own):
            rf |= me
        for j in range(len(texts)):
            fm, tm = bool(rf & ffrom[j]), bool(rt & fto[j])
            cross = bool(rf & fto[j]) or bool(rt & ffrom[j])
            X[i, j] = [fm, tm, fm and tm, cross and not (fm or tm), bool(me & ffrom[j]), bool(me & fto[j]), bool(rf or rt)]
    return X


def main():
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    out = {r["record"]: record_feats(r) for r in recs}
    np.savez_compressed(os.path.join(HERE, "feats_party.npz"), **out)
    np.save(os.path.join(HERE, "feats_party_names.npy"), np.array(["from", "to", "from_to", "swapped", "me_from", "me_to", "ref_has_party"]))
    X = np.concatenate([x.reshape(-1, 7) for x in out.values()])
    print("feature means", X.mean(0).round(3))


if __name__ == "__main__":
    main()
