"""Pair features v2 from inputs2.json: several reference views x file views, field-level
(Fellegi-Sunter style) agreement levels, and the label-order prior.

Usage: python feats2.py   -> feats_sim.npz, feats_fs.npz, feats_order.npz (+ _names.npy)
"""
import datetime as dt, json, math, os, re, sys, time
from collections import Counter
import numpy as np
from common import HERE, ROOT
import fields as F
from baseline import tokens

BOILER = re.compile(r"\b(?:attached|annexed|appended|marked|produced|enclosed)\b(?:\s+(?:hereto|herewith|to\s+(?:this|my)\s+(?:\w+\s+)?affidavit))*(?:\s+(?:and|as))*(?:\s+marked)?(?:\s+as)?\s+exhibits?\s+\"?[A-Z0-9-]{1,5}\"?(?:\s+to\s+(?:this|my)\s+(?:\w+\s+)?affidavit)?|\b(?:is|are)\s+(?:a\s+)?(?:true\s+)?cop(?:y|ies)\s+of\b|\bcop(?:y|ies)\s+of\b|\bexhibits?\s+\"?[A-Z0-9-]{1,5}\"?", re.I)


def desc_of(c):
    s = c["item"] or c["main"]
    return re.sub(r"\s+", " ", BOILER.sub(" ", s)).strip(" .,;:")


def drop_sibs(t, c):
    """Remove the other list items of this label's list mention (their dates, numbers and names are not this label's)."""
    for x in c.get("sib", []):
        if len(x) > 3:
            t = t.replace(x, " ")
    return t


def tfidf_pair(qs, ds):
    """Cosine of TF-IDF vectors, IDF over this record's queries + documents."""
    bags = [Counter(tokens(t)) for t in qs + ds]
    df = Counter(t for b in bags for t in b)
    n = len(bags)
    vocab = {t: i for i, t in enumerate(df)}
    m = np.zeros((n, len(vocab)), np.float32)
    for i, b in enumerate(bags):
        for t, c in b.items():
            m[i, vocab[t]] = (1 + math.log(c)) * math.log((1 + n) / (1 + df[t]))
    m /= np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-9)
    return m[:len(qs)] @ m[len(qs):].T


def char_grams(t, n=4):
    t = re.sub(r"[^a-z0-9]+", " ", t.lower())
    return Counter(t[i:i + n] for i in range(max(0, len(t) - n + 1)))


def chargram_pair(qs, ds):
    bags = [char_grams(t) for t in qs + ds]
    df = Counter(g for b in bags for g in b)
    n = len(bags)
    vocab = {g: i for i, g in enumerate(df)}
    m = np.zeros((n, len(vocab)), np.float32)
    for i, b in enumerate(bags):
        for g, c in b.items():
            m[i, vocab[g]] = (1 + math.log(c)) * math.log((1 + n) / (1 + df[g]))
    m /= np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-9)
    return m[:len(qs)] @ m[len(qs):].T


def rrank(m, axis):
    """1/(1+rank) along an axis (rank 0 = best)."""
    r = (-m).argsort(axis).argsort(axis)
    return 1.0 / (1 + r)


def lab_key(l):
    if l.isdigit():
        return (0, int(l), 0)
    m = re.match(r"([A-Z]+)-?(\d*)$", l)
    return (len(m[1]), m[1], int(m[2] or 0)) if m else (9, l, 0)


def todate(s):
    try:
        return dt.date(int(s[:4]), int(s[5:7]), int(s[8:10]) if len(s) >= 10 else 15)
    except ValueError:
        return None


LONG = {"agreement", "report", "transcript", "affidavit", "filing", "legislation", "search", "minutes"}
SHORT = {"letter", "email", "invoice", "text", "picture", "news"}


def record_feats(r, raw_pages):
    labels, files, texts = r["labels"], r["files"], r["texts"]
    L = len(labels)
    C = r["ctx"]
    desc = [desc_of(C[l]) for l in labels]
    main = [C[l]["main"] or C[l]["sentence"] for l in labels]
    ctx = [drop_sibs(C[l]["before"][-500:] + " " + C[l]["main"] + " " + C[l]["after"][:300] + " " + C[l]["defined"], C[l]) for l in labels]
    para = [C[l]["prev"][-800:] + " " + C[l]["paragraph"] for l in labels]
    allsent = [C[l]["sentence"] for l in labels]
    head1 = [t[:1000] for t in texts]
    head3 = [t[:3000] for t in texts]
    sims = {
        "desc_head1": tfidf_pair(desc, head1),
        "desc_head3": tfidf_pair(desc, head3),
        "main_head3": tfidf_pair(main, head3),
        "ctx_full": tfidf_pair(ctx, texts),
        "para_full": tfidf_pair(para, texts),
        "sent_full": tfidf_pair(allsent, texts),
        "defs_head3": tfidf_pair([C[l]["defined"] or " " for l in labels], head3),
        "cg_desc_head": chargram_pair(desc, [t[:800] for t in texts]),
        "cg_ctx_head": chargram_pair(ctx, [t[:2000] for t in texts]),
    }
    S = []
    names_s = []
    for k, m in sims.items():
        S += [m, rrank(m, 1), rrank(m, 0)]
        names_s += [k, k + "_rrow", k + "_rcol"]
    S = np.stack(S, axis=2)

    # ---- field-level agreement (file side)
    fh = [F.dates(t[:1500]) for t in texts]
    fa = [F.dates(t) for t in texts]
    fh_day, fa_day = [F.dayset(x) for x in fh], [F.dayset(x) for x in fa]
    fh_mon, fh_yr = [F.monthset(x) for x in fh], [F.yearset(x) for x in fh]
    famt = [F.amounts(t) for t in texts]
    fid = [F.idents(t) for t in texts]
    furl = [F.urls(t[:3000]) for t in texts]
    fnh = [F.names(t[:1500]) for t in texts]
    fna = [F.names(t) for t in texts]
    fkind = [F.kinds(t[:2500], F.KIND_FILE) for t in texts]
    garb = [F.garbage(t) for t in texts]
    textless = [len(re.sub(r"\s", "", t)) < 50 for t in texts]
    pages = [raw_pages.get(f, 1) for f in files]
    lowhead = [re.sub(r"\s+", " ", t[:3000].lower()) for t in texts]
    first_day = []
    for x in fh:
        d = [v for _, v in x if len(v) == 10]
        first_day.append(d[0] if d else None)

    names_f = ["dS_H", "dS_A", "dS_miss", "dC_H", "dC_A", "mS_H", "yS_H", "yS_miss", "dS_near", "pos_date_H", "pos_date_A",
               "amt", "amt_n", "ident", "url_dom", "url_seg", "nameS_H", "nameC_H", "nameS_A", "quoted", "kind_agree", "kind_miss",
               "kind_ref_none", "pic_x_textless", "pic_x_garb", "garb", "textless", "long_x_pages", "short_x_pages", "log_pages",
               "email_x_email", "letter_x_letter", "order_x_order", "search_x_search", "web_x_web", "agreement_x_agreement"]
    Fx = np.zeros((L, len(files), len(names_f)), np.float32)
    names_o = ["order_gap", "order_dated", "order_gap_sq"]
    O = np.zeros((L, len(files), len(names_o)), np.float32)
    order = sorted(labels, key=lab_key)
    lpos = {l: (order.index(l) / max(1, L - 1)) for l in labels}
    dated = [j for j in range(len(files)) if first_day[j]]
    drank = {}
    for rank, j in enumerate(sorted(dated, key=lambda j: first_day[j])):
        drank[j] = rank / max(1, len(dated) - 1)
    for i, l in enumerate(labels):
        c = C[l]
        # a list item carries its own dates; the shared sentence would give every sibling all of them
        own = F.dates(desc[i]) if c["item"] else []
        sd = own if F.dayset(own) else F.dates(desc[i] + " " + drop_sibs(c["main"], c))
        cd = F.dates(ctx[i])
        s_day, s_mon, s_yr = F.dayset(sd), F.monthset(sd), F.yearset(sd)
        c_day = F.dayset(cd)
        # a group's k-th date belongs to its k-th label ("letters dated April 27, April 29 and April 30 ... Exhibits I, J and K")
        gd = [v for _, v in F.dates(c["main"]) if len(v) == 10]
        gd = gd if len(gd) == c["group_size"] else list(dict.fromkeys(gd))
        pos_date = gd[c["group_pos"]] if c["group_size"] > 1 and len(gd) == c["group_size"] else None
        camt = F.amounts(ctx[i] + " " + drop_sibs(c["paragraph"], c))
        cid = F.idents(ctx[i] + " " + drop_sibs(c["paragraph"], c))
        curl = F.urls(ctx[i])
        sn = F.names(desc[i])
        cn = F.names(ctx[i])
        rk = F.kinds(desc[i] or c["main"], F.KIND_REF)
        qts = F.quoted(c["main"] + " " + c["item"])
        sdates = [todate(v) for v in s_day]
        for j in range(len(files)):
            near = 0.0
            if sdates and first_day[j]:
                fd = todate(first_day[j])
                if fd:
                    near = max(math.exp(-abs((d - fd).days) / 30) for d in sdates if d)
            qscore = 0.0
            for q in qts:
                qt = set(re.findall(r"[a-z0-9]{3,}", q.lower()))
                if qt:
                    qscore = max(qscore, sum(w in lowhead[j] for w in qt) / len(qt))
            dom = {d for d, _ in curl} & {d for d, _ in furl[j]}
            Fx[i, j] = [bool(s_day & fh_day[j]), bool(s_day & fa_day[j]), bool(s_day) and not (s_day & fa_day[j]),
                        bool(c_day & fh_day[j]), bool(c_day & fa_day[j]),
                        bool(s_mon & fh_mon[j]), bool(s_yr & fh_yr[j]), bool(s_yr) and bool(fh_yr[j]) and not (s_yr & fh_yr[j]), near,
                        bool(pos_date and pos_date in fh_day[j]), bool(pos_date and pos_date in fa_day[j]),
                        bool(camt & famt[j]), math.log1p(len(camt & famt[j])), bool(cid & fid[j]),
                        bool(dom), bool(curl & furl[j]),
                        len(sn & fnh[j]) / (1 + len(sn)), len(cn & fnh[j]) / (1 + len(cn)), len(sn & fna[j]) / (1 + len(sn)),
                        qscore, bool(rk & fkind[j]), bool(rk) and bool(fkind[j]) and not (rk & fkind[j]), not rk,
                        bool(rk & {"picture"}) and textless[j], bool(rk & {"picture"}) * garb[j], garb[j], textless[j],
                        bool(rk & LONG) * math.log(pages[j]), bool(rk & SHORT) * math.log(pages[j]), math.log(pages[j]),
                        "email" in rk and "email" in fkind[j], "letter" in rk and "letter" in fkind[j],
                        "order" in rk and "order" in fkind[j], "search" in rk and "search" in fkind[j],
                        "web" in rk and "web" in fkind[j], "agreement" in rk and "agreement" in fkind[j]]
            if j in drank:
                gap = abs(lpos[l] - drank[j])
                O[i, j] = [-gap, 1.0, -gap * gap]
    return S, Fx, O, names_s, names_f, names_o


def page_counts(rid, files):
    out = {}
    for f in files:
        t = open(os.path.join(ROOT, rid, "files", f.replace(".pdf", ".txt")), encoding="utf-8").read()
        out[f] = max(1, len(re.findall(r"\[page \d+\]", t)))
    return out


def main():
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    out = {"sim": {}, "fs": {}, "order": {}}
    secs = []
    for r in recs:
        pc = page_counts(r["record"], r["files"])
        t0 = time.time()
        S, Fx, O, ns, nf, no = record_feats(r, pc)
        secs.append(time.time() - t0)
        out["sim"][r["record"]], out["fs"][r["record"]], out["order"][r["record"]] = S, Fx, O
    for k, names in (("sim", ns), ("fs", nf), ("order", no)):
        np.savez_compressed(os.path.join(HERE, f"feats_{k}.npz"), **out[k])
        np.save(os.path.join(HERE, f"feats_{k}_names.npy"), np.array(names))
    s = np.array(secs)
    print(f"{len(recs)} records: feature time median {np.median(s):.2f}s max {s.max():.1f}s (Python)")


if __name__ == "__main__":
    main()
