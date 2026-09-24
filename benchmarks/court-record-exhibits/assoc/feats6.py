"""Pair features v6: correspondence direction resolved to the affiant's name.

Mention side, in the label's own text (its list item or clause, else its sentence): the affiant sends
("my email to X", "I wrote to X", "a letter from <affiant>") or receives ("X's email to me", "X wrote
to me", "I received", "a letter to <affiant>"). File side, in the opening: the first From: line, the
first To:/Cc: line, the salutation ("Dear ..."), and the sign-off block at the end. The affiant's name
comes from the affidavit (`affiant.py`); its surname is what is matched.

Usage: python feats6.py -> feats_dir.npz (+ _names.npy)
"""
import json, os, re
import numpy as np
from common import HERE, ROOT
from affiant import affiant

DOC = r"(?:e-?mails?|letters?|correspondence|messages?|memo(?:randum)?|texts?|text messages?|responses?|repl(?:y|ies)|notes?|notices?|demands?|requests?)"
M_SEND = [rf"\b(?:my|our)\s+(?:[\w,]+\s+){{0,4}}{DOC}\b", r"\bI\s+(?:then\s+|also\s+|subsequently\s+|again\s+)?(?:wrote|sent|e-?mailed|replied|responded|texted|delivered|forwarded|followed up)\b",
          r"\bfrom\s+me\b"]
M_RECV = [r"\b(?:to|addressed to|sent to|copied to|with)\s+me\b", r"\bI\s+(?:then\s+|also\s+|subsequently\s+)?received\b",
          r"\b(?:sent|wrote|e-?mailed|texted|replied to|responded to|advised|told|informed|asked|contacted)\s+me\b", rf"\b{DOC}\s+(?:\w+\s+){{0,3}}to\s+me\b"]
F_FROM = re.compile(r"(?im)^\s*(?:from|de|sender|sent by)\s*:\s*(.{0,160})")
F_TO = re.compile(r"(?im)^\s*(?:to|à|cc|recipient)\s*:\s*(.{0,200})")
F_DEAR = re.compile(r"\b(?:Dear|Attention:?|Attn:?|Hi|Hello)\s+((?:(?:Mr|Ms|Mrs|Dr)\.?\s*)?(?:[A-Z][\w'’\-]+[\s,:]*){1,3})")
F_SIGN = re.compile(r"(?is)(?:yours\s+(?:truly|very truly|sincerely)|sincerely|regards|thank you)[,.]?\s*(.{0,160})")
NAMES = ["m_send", "m_recv", "f_from_me", "f_to_me", "send_x_from", "send_x_to", "recv_x_to", "recv_x_from", "dir_agree", "dir_conflict",
         "c_send", "c_recv", "c_agree", "c_conflict"]


def own_text(c):
    return (c["item"] or c["main"] or "")[:600]


def mention_dir(t, me):
    send = any(re.search(p, t, re.I if "I\\s" not in p else 0) for p in M_SEND)
    recv = any(re.search(p, t, re.I if "I\\s" not in p else 0) for p in M_RECV)
    if me:
        s = re.escape(me)
        send |= bool(re.search(rf"\b(?:from|by|of)\s+(?:(?:Mr|Ms|Mrs|Dr)\.?\s+)?(?:\w+\s+)?{s}\b|\b{s}['’]s\s+(?:\w+\s+)?{DOC}", t, re.I))
        recv |= bool(re.search(rf"\b(?:to|addressed to)\s+(?:(?:Mr|Ms|Mrs|Dr)\.?\s+)?(?:\w+\s+)?{s}\b", t, re.I))
    return send, recv


def file_dir(t, me):
    if not me:
        return False, False
    h = t[:1500]
    fr = F_FROM.search(h)
    to = [m[1] for m in F_TO.finditer(h)][:2] + [m[1] for m in F_DEAR.finditer(h)][:1]
    sig = [m[1] for m in F_SIGN.finditer(t[-1200:])][-1:]
    has = lambda s: bool(re.search(rf"\b{re.escape(me)}\b|{re.escape(me)}@|[.@]{re.escape(me)}\b", s or "", re.I))
    return has(fr[1] if fr else "") or (not fr and any(has(x) for x in sig)), any(has(x) for x in to)


def record_feats(r):
    toks = affiant(open(os.path.join(ROOT, r["record"], "affidavit.txt"), encoding="utf-8").read())
    text = open(os.path.join(ROOT, r["record"], "affidavit.txt"), encoding="utf-8").read()
    # the surname: the affiant token written last in the name
    me = None
    if toks:
        pos = {t: max(m.start() for m in re.finditer(re.escape(t), text[:8000], re.I)) if re.search(re.escape(t), text[:8000], re.I) else -1 for t in toks}
        me = max((t for t in toks if len(t) > 2), key=lambda t: (len(t) > 2, pos[t]), default=None)
    labels, texts = r["labels"], r["texts"]
    fd = [file_dir(t, me) for t in texts]
    X = np.zeros((len(labels), len(texts), len(NAMES)), np.float32)
    for i, l in enumerate(labels):
        send, recv = mention_dir(own_text(r["ctx"][l]), me)
        # the sentences before the mention ("On May 1, I wrote to X ... A copy of this correspondence is attached")
        cs, cr = mention_dir((r["ctx"][l]["seg"] or [""])[0][-400:], me)
        for j, (ff, ft) in enumerate(fd):
            agree = (send and ff and not recv) or (recv and ft and not send)
            conflict = (send and ft and not ff and not recv) or (recv and ff and not ft and not send)
            cagree = (cs and ff and not cr) or (cr and ft and not cs)
            cconf = (cs and ft and not ff and not cr) or (cr and ff and not ft and not cs)
            X[i, j] = [send, recv, ff, ft, send and ff, send and ft, recv and ft, recv and ff, agree, conflict, cs, cr, cagree, cconf]
    return X, me


def main():
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    out, found = {}, 0
    stat = np.zeros(4)
    for r in recs:
        out[r["record"]], me = record_feats(r)
        found += bool(me)
        X = out[r["record"]]
        T = np.array([[r["truth"][f] == l for f in r["files"]] for l in r["labels"]])
        k = NAMES.index("dir_agree"), NAMES.index("dir_conflict")
        stat += [X[..., k[0]][T].sum(), X[..., k[0]].sum(), X[..., k[1]][T].sum(), X[..., k[1]].sum()]
    np.savez_compressed(os.path.join(HERE, "feats_dir.npz"), **out)
    np.save(os.path.join(HERE, "feats_dir_names.npy"), np.array(NAMES))
    X = np.concatenate([x.reshape(-1, len(NAMES)) for x in out.values()])
    print(f"affiant surname found in {found}/{len(recs)} records; feature means", dict(zip(NAMES, X.mean(0).round(4))))
    print(f"dir_agree on gold pairs {stat[0]:.0f} of {stat[1]:.0f} pairs; dir_conflict on gold pairs {stat[2]:.0f} of {stat[3]:.0f}")


if __name__ == "__main__":
    main()
