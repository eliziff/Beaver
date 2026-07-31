"""Stage 18 C1 / F2 / F3 scorer (committed instrument, standing corrections applied).

Scores the two C1 coverage-composition arms against the frozen ctx baseline on
BOTH instruments:

  * as-registered  — the recorded `grounded.{precision,recall}` numbers, i.e.
    the same (defective) method the C1 gates were frozen against.  Used only to
    execute the frozen KEEP/DROP arithmetic literally.
  * corrected      — the DECISION basis.  Gold spans for the 17 CRLF maud
    corpus files are mapped from upstream LF coordinates into the raw (CRLF)
    coordinates every receipt uses; retrieved/quoted spans are union-merged
    before overlap; precision and recall are clipped at 1.0.

Also runs the F2 negative control (gold document removed -> false-answer rate)
and the F3 plain-prompt control (prices the three-module grounding contract),
plus the standing reporting amendments: per-source answered-only P/R always, a
strict-answered column (>=1 quotation AND >=1 conclusion claim), the byte-exact
quote rate beside the normalized P1 audit, and all four fair-comparison modes.

stdlib only; deterministic; read-only on receipts.
"""

from __future__ import annotations

import bisect
import collections
import hashlib
import json
import os
import re

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

DIR = os.path.join(
    os.environ["LOCALAPPDATA"],
    "OpenLegalData", "experiments", "legal-grounding", "2026-07-30",
)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAG_DIR = os.path.join(ROOT, "benchmarks", "legalbench_rag")
DATA_DIR = os.path.join(RAG_DIR, "data")
MANIFEST = os.path.join(RAG_DIR, "mini.manifest.json")

CTX = os.path.join(DIR, "stage18-lbrag-grounded-ctx.jsonl")
C1A = os.path.join(DIR, "stage18-lbrag-grounded-coverage.jsonl")
C1B = os.path.join(DIR, "stage18-lbrag-grounded-covspec.jsonl")
F2 = {
    "base": os.path.join(DIR, "stage18-lbrag-f2-base.jsonl"),
    "coverage": os.path.join(DIR, "stage18-lbrag-f2-coverage.jsonl"),
    "covspec": os.path.join(DIR, "stage18-lbrag-f2-covspec.jsonl"),
}
F3 = os.path.join(DIR, "stage18-lbrag-f3-plain.jsonl")

SOURCES = ("contractnli", "cuad", "maud", "privacy_qa")
NOISE_95 = 0.015  # measured paired 95% band; 1-sigma ~ 0.0065

# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load(path):
    """Dedupe resumed receipts: later non-error row supersedes; an error row
    never overwrites a non-error row."""
    final = {}
    for line in open(path, encoding="utf-8", newline=""):
        row = json.loads(line)
        if row["outcome"] != "error" or row["test_id"] not in final:
            final[row["test_id"]] = row
    return final


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()


manifest = json.load(open(MANIFEST, encoding="utf-8"))
corpus = {}
for entry in manifest["corpus"]:
    with open(os.path.join(DATA_DIR, entry["path"]), encoding="utf-8", newline="") as fh:
        corpus[entry["upstream_path"]] = fh.read()

# LF -> raw (CRLF) coordinate maps, one per CRLF corpus file.
crlf_marks = {}  # upstream_path -> sorted LF offsets of collapsed "\r\n"
for path, raw in corpus.items():
    if "\r\n" not in raw:
        continue
    marks, i, lf_off = [], 0, 0
    while True:
        i = raw.find("\r\n", i)
        if i < 0:
            break
        # LF offset of this "\n" == raw offset minus the CRs already collapsed.
        marks.append(i - len(marks))
        i += 2
    crlf_marks[path] = marks


def to_raw(path, lf_offset):
    marks = crlf_marks.get(path)
    if not marks:
        return lf_offset
    return lf_offset + bisect.bisect_left(marks, lf_offset)


# Gold spans: recorded (upstream LF coordinates, what the runner scored) and
# corrected (mapped into raw coordinates for the CRLF files).
gold_recorded, gold_corrected, gold_files = {}, {}, {}
for source in SOURCES:
    bench = json.load(
        open(os.path.join(DATA_DIR, "mini", "benchmarks", f"{source}.json"), encoding="utf-8")
    )
    for i, test in enumerate(bench["tests"]):
        tid = f"{source}:{i:03d}"
        rec, cor = [], []
        for snip in test["snippets"]:
            fp, (s, e) = snip["file_path"], snip["span"]
            rec.append((fp, s, e))
            cor.append((fp, to_raw(fp, s), to_raw(fp, e)))
        gold_recorded[tid] = rec
        gold_corrected[tid] = cor
        gold_files[tid] = {s["file_path"] for s in test["snippets"]}


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def merge(spans):
    """Union-merge spans per file."""
    by_file = collections.defaultdict(list)
    for fp, s, e in spans:
        by_file[fp].append((s, e))
    out = []
    for fp in sorted(by_file):
        cur_s, cur_e = None, None
        for s, e in sorted(by_file[fp]):
            if cur_e is None:
                cur_s, cur_e = s, e
            elif s <= cur_e:
                cur_e = max(cur_e, e)
            else:
                out.append((fp, cur_s, cur_e))
                cur_s, cur_e = s, e
        if cur_e is not None:
            out.append((fp, cur_s, cur_e))
    return out


def score(spans, gold, union=True, clip=True):
    spans = merge(spans) if union else list(spans)
    gold = list(gold)
    slen = sum(e - s for _, s, e in spans)
    glen = sum(e - s for _, s, e in gold)
    common = 0
    for fp, s, e in spans:
        for gfp, gs, ge in gold:
            if fp == gfp:
                common += max(0, min(e, ge) - max(s, gs))
    p = 0.0 if slen == 0 else common / slen
    r = 0.0 if glen == 0 else common / glen
    if clip:
        p, r = min(p, 1.0), min(r, 1.0)
    return p, r


def spans_of(row):
    return [(s["filePath"], s["start"], s["end"]) for s in row["quoted_spans"]]


def corrected(row):
    return score(spans_of(row), gold_corrected[row["test_id"]])


mean = lambda xs: sum(xs) / len(xs) if xs else 0.0


# ---------------------------------------------------------------------------
# Claim helpers (strict-answered, F2 substantive conclusions)
# ---------------------------------------------------------------------------

DECLINE_RE = re.compile(
    r"(do(es)? not (address|contain|mention|specify|provide|state|discuss)"
    r"|no (supplied |provided |retrieved )?passage"
    r"|none of the (supplied|provided|retrieved) passages"
    r"|not (addressed|answerable|provided|present|contained|found|available)"
    r"|cannot be (determined|answered|established)"
    r"|is silent|are silent|unable to answer|insufficient (to|evidence)"
    r"|do not (address|contain|mention|speak|support|answer))",
    re.I,
)


def claims(row):
    return (row.get("legal_evidence_receipt") or {}).get("claims") or []


def kinds(row):
    return collections.Counter(c["kind"] for c in claims(row))


def is_strict(row):
    k = kinds(row)
    return row["outcome"] == "answered" and k["quotation"] >= 1 and k["conclusion"] >= 1


def has_substantive_conclusion(row):
    conc = [c["text"] for c in claims(row) if c["kind"] == "conclusion"]
    return any(not DECLINE_RE.search(t) for t in conc)


def dup_rescued(row, thresh=0.5):
    """F2 caveat: the gold DOCUMENT was removed, but the mini corpus carries
    near-duplicate boilerplate.  True when the cell's quotes (necessarily from
    non-gold documents) still recover >= `thresh` of a gold snippet's tokens —
    i.e. the cell was answerable after all and the 'false answer' is content-
    correct."""
    golds = [corpus[fp][s:e] for fp, s, e in gold_corrected[row["test_id"]]]
    quoted = " ".join(
        norm(corpus[s["filePath"]][s["start"]:s["end"]]).lower()
        for s in row["quoted_spans"]
    )
    qset = set(quoted.split())
    for g in golds:
        gs = set(norm(g).lower().split())
        if gs and len(gs & qset) / len(gs) >= thresh:
            return True
    return False


# ---------------------------------------------------------------------------
# P1 verbatim audit
# ---------------------------------------------------------------------------


def norm(s):
    s = (s.replace("‘", "'").replace("’", "'")
          .replace("“", '"').replace("”", '"')
          .replace("–", "-").replace("—", "-")
          .replace("\xa0", " "))
    return re.sub(r"\s+", " ", s).strip()


def classify(raw_slice, texts):
    """Why a located span is not byte-identical to its claim text."""
    cand = [t for t in texts if norm(t) == norm(raw_slice)]
    if not cand:
        cand = [t for t in texts if norm(raw_slice) in norm(t) or norm(t) in norm(raw_slice)]
    t = cand[0] if cand else ""
    if re.sub(r"\s+", " ", raw_slice) == re.sub(r"\s+", " ", t):
        return "whitespace-run"
    if raw_slice.replace("\xa0", " ") == t or raw_slice == t.replace("\xa0", " "):
        return "nbsp"
    if raw_slice in t or t in raw_slice:
        return "edge-glyph-trim"  # locator dropped a leading/trailing glyph (D5 class)
    if norm(raw_slice) == norm(t):
        return "glyph"
    return "other"


def p1_audit(cells):
    """P1 soundness (normalized equivalence class) + two byte-exact rates:
    `exact`   -- located span text == the claim text, byte for byte;
    `sub`     -- span text is a byte-identical contiguous run of the claim text
                 (i.e. exact modulo a wrapper the model put around its quote);
                 this is the convention the 2026-07-31 receipt-only audit used.
    """
    answered = [r for r in cells if r["outcome"] == "answered"]
    mismatches, spans, exact, sub = [], 0, 0, 0
    why = collections.Counter()
    for r in answered:
        texts = {norm(c["text"]) for c in claims(r)}
        raw_texts = [c["text"] for c in claims(r)]
        for span in r["quoted_spans"]:
            spans += 1
            doc = corpus.get(span["filePath"])
            if doc is None:
                mismatches.append((r["test_id"], span["filePath"], "missing-doc"))
                continue
            raw_slice = doc[span["start"]:span["end"]]
            if raw_slice in raw_texts:
                exact += 1
                sub += 1
            else:
                if any(raw_slice in t for t in raw_texts):
                    sub += 1
                why[classify(raw_slice, raw_texts)] += 1
            sliced = norm(raw_slice)
            if sliced not in texts and not any(sliced in t or t in sliced for t in texts):
                mismatches.append((r["test_id"], span["filePath"], sliced[:60]))
    unlocated = sum(r["unlocated_quotes"] for r in cells if r["outcome"] != "error")
    raw_miss = [r for r in answered if not r["grounded"]["doc_hit"]]
    true_miss, dup_miss = [], []
    for r in raw_miss:
        quoted = {s["filePath"] for s in r["quoted_spans"]}
        golds = gold_files[r["test_id"]]
        dup = bool(quoted) and all(
            any(corpus.get(q) is not None and corpus.get(g) is not None and corpus[q] == corpus[g]
                for g in golds)
            for q in quoted
        )
        (dup_miss if dup else true_miss).append(r)
    return {
        "spans": spans, "mismatches": mismatches, "byte_exact": exact,
        "byte_exact_sub": sub, "why": why,
        "unlocated": unlocated, "raw_doc_miss": len(raw_miss),
        "dup_doc_miss": len(dup_miss), "true_doc_miss": true_miss,
        "clean": not mismatches and unlocated == 0 and not true_miss,
    }


# ---------------------------------------------------------------------------
# Table helpers
# ---------------------------------------------------------------------------


def hdr(title):
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


def per_source_table(cells, mode, label):
    """mode: 'recorded' | 'corrected'"""
    print(f"\n{label}  [{mode} instrument]")
    print(f"{'source':12} {'n':>4} {'ans':>4} {'ans%':>6} {'strict':>6} {'str%':>6} "
          f"{'ansP':>7} {'ansR':>7}")
    rows = {}
    for source in list(SOURCES) + ["OVERALL"]:
        sub = [r for r in cells if source == "OVERALL" or r["source"] == source]
        ok = [r for r in sub if r["outcome"] != "error"]
        ans = [r for r in sub if r["outcome"] == "answered"]
        strict = [r for r in ans if is_strict(r)]
        if mode == "recorded":
            ps = [r["grounded"]["precision"] for r in ans]
            rs = [r["grounded"]["recall"] for r in ans]
        else:
            pr = [corrected(r) for r in ans]
            ps = [p for p, _ in pr]
            rs = [r for _, r in pr]
        rows[source] = {"n": len(ok), "ans": len(ans), "strict": len(strict),
                        "P": mean(ps), "R": mean(rs)}
        print(f"{source:12} {len(ok):>4} {len(ans):>4} {100*len(ans)/max(1,len(ok)):>5.1f}% "
              f"{len(strict):>6} {100*len(strict)/max(1,len(ok)):>5.1f}% "
              f"{mean(ps):>7.4f} {mean(rs):>7.4f}")
    return rows


def paired(arm_cells, base_cells, mode="corrected", ids=None):
    a = {r["test_id"]: r for r in arm_cells if r["outcome"] == "answered"}
    b = {r["test_id"]: r for r in base_cells if r["outcome"] == "answered"}
    keys = sorted(set(a) & set(b))
    if ids is not None:
        keys = [k for k in keys if k in ids]
    if mode == "recorded":
        ap = [a[k]["grounded"]["precision"] for k in keys]
        ar = [a[k]["grounded"]["recall"] for k in keys]
        bp = [b[k]["grounded"]["precision"] for k in keys]
        br = [b[k]["grounded"]["recall"] for k in keys]
    else:
        ap, ar = zip(*[corrected(a[k]) for k in keys]) if keys else ([], [])
        bp, br = zip(*[corrected(b[k]) for k in keys]) if keys else ([], [])
    return {"n": len(keys), "keys": keys,
            "aP": mean(ap), "aR": mean(ar), "bP": mean(bp), "bR": mean(br),
            "dP": mean(ap) - mean(bp), "dR": mean(ar) - mean(br)}


def flag(delta):
    return "NOISE" if abs(delta) < NOISE_95 else ("+" if delta > 0 else "-")


def fair_modes(cells, label, mode="corrected"):
    ok = [r for r in cells if r["outcome"] != "error"]
    if mode == "recorded":
        g = {r["test_id"]: (r["grounded"]["precision"], r["grounded"]["recall"]) for r in ok}
    else:
        g = {r["test_id"]: corrected(r) for r in ok}
    ret = {r["test_id"]: (min(r["retrieval_baseline"]["precision"], 1.0),
                          min(r["retrieval_baseline"]["recall"], 1.0)) for r in ok}
    ansd = [r for r in ok if r["outcome"] == "answered"]
    ap = mean([g[r["test_id"]][0] for r in ansd])
    ar = mean([g[r["test_id"]][1] for r in ansd])
    fp = mean([g[r["test_id"]][0] if r["outcome"] == "answered" else ret[r["test_id"]][0] for r in ok])
    fr = mean([g[r["test_id"]][1] if r["outcome"] == "answered" else ret[r["test_id"]][1] for r in ok])
    zp = mean([g[r["test_id"]][0] if r["outcome"] == "answered" else 0.0 for r in ok])
    zr = mean([g[r["test_id"]][1] if r["outcome"] == "answered" else 0.0 for r in ok])
    rp = mean([ret[r["test_id"]][0] for r in ok])
    rr = mean([ret[r["test_id"]][1] for r in ok])
    print(f"{label:26} answered-only P={ap:.4f} R={ar:.4f} | forced P={fp:.4f} R={fr:.4f} | "
          f"zero-credit P={zp:.4f} R={zr:.4f} | retrieval-only(clip) P={rp:.4f} R={rr:.4f}")


# ---------------------------------------------------------------------------
# 0. Instrument verification
# ---------------------------------------------------------------------------

hdr("0. INSTRUMENT VERIFICATION (CRLF correction)")
crlf_files = sorted(crlf_marks)
print(f"CRLF corpus files: {len(crlf_files)} of {len(corpus)} "
      f"(sources: {sorted({p.split('/')[0] for p in crlf_files})})")
_bench = json.load(open(os.path.join(DATA_DIR, "mini", "benchmarks", "maud.json"), encoding="utf-8"))
_sn = _bench["tests"][0]["snippets"][0]
_fp = _sn["file_path"]
_raw = corpus[_fp]
_lf = _raw.replace("\r\n", "\n")
_s, _e = _sn["span"]
print(f"maud test 0 snippet 0: lf[{_s}:{_e}] == answer -> {_lf[_s:_e] == _sn['answer']}")
print(f"                       raw[{_s}:{_e}] == answer -> {_raw[_s:_e] == _sn['answer']}")
_rs, _re = to_raw(_fp, _s), to_raw(_fp, _e)
print(f"                       mapped raw[{_rs}:{_re}] == answer (mod \\r\\n) -> "
      f"{_raw[_rs:_re].replace(chr(13) + chr(10), chr(10)) == _sn['answer']}")
_drift = sorted(to_raw(fp, s) - s for tid in gold_recorded if tid.startswith("maud")
                for fp, s, _e in gold_recorded[tid])
print(f"maud gold spans: {len(_drift)}  LF->raw drift median={_drift[len(_drift)//2]} "
      f"max={max(_drift)}")
_snips = [sn for t in _bench["tests"] for sn in t["snippets"]]
_lf_ok = sum(1 for sn in _snips
             if corpus[sn["file_path"]].replace("\r\n", "\n")[sn["span"][0]:sn["span"][1]]
             == sn["answer"])
_raw_ok = sum(1 for sn in _snips
              if corpus[sn["file_path"]][sn["span"][0]:sn["span"][1]] == sn["answer"])
print(f"maud snippets slicing to their `answer`: LF {_lf_ok}/{len(_snips)}  "
      f"raw {_raw_ok}/{len(_snips)}  (gold offsets are LF coordinates)")

# ---------------------------------------------------------------------------
# 1. Load receipts
# ---------------------------------------------------------------------------

hdr("1. RECEIPTS")
ctx = load(CTX)
c1a = load(C1A)
c1b = load(C1B)
f3 = load(F3)
f2 = {k: load(v) for k, v in F2.items()}
assert len(c1a) == 776, f"C1a expected 776 unique, got {len(c1a)}"
assert len(c1b) == 776, f"C1b expected 776 unique, got {len(c1b)}"
for name, path in [("ctx", CTX), ("C1a coverage", C1A), ("C1b covspec", C1B),
                   ("F2 base", F2["base"]), ("F2 coverage", F2["coverage"]),
                   ("F2 covspec", F2["covspec"]), ("F3 plain", F3)]:
    cells = load(path)
    outs = collections.Counter(r["outcome"] for r in cells.values())
    print(f"{name:14} unique={len(cells):>4} {dict(outs)}")
    print(f"{'':14} sha256={sha256(path)}")

ctx_cells, c1a_cells, c1b_cells = list(ctx.values()), list(c1a.values()), list(c1b.values())

# ---------------------------------------------------------------------------
# 2. P1 verbatim audit + byte-exact rate
# ---------------------------------------------------------------------------

hdr("2. P1 SOUNDNESS AUDIT (unconditional) + byte-exact quote rate")
p1 = {}
for name, cells in [("ctx", ctx_cells), ("C1a coverage", c1a_cells), ("C1b covspec", c1b_cells),
                    ("F3 plain", list(f3.values()))]:
    a = p1_audit(cells)
    p1[name] = a
    print(f"{name:14} spans={a['spans']:>5} mismatches={len(a['mismatches']):>3} "
          f"unlocated={a['unlocated']:>3} doc-miss raw={a['raw_doc_miss']} "
          f"(dup={a['dup_doc_miss']} TRUE={len(a['true_doc_miss'])})  "
          f"byte-exact strict={100*a['byte_exact']/max(1,a['spans']):.2f}% "
          f"({a['byte_exact']}/{a['spans']})  sub-rule="
          f"{100*a['byte_exact_sub']/max(1,a['spans']):.2f}% ({a['byte_exact_sub']}/{a['spans']})  "
          f"P1={'PASS' if a['clean'] else 'FAIL'}")
    print(f"{'':14} non-exact breakdown: {dict(a['why'])}")
    for m in a["mismatches"][:5]:
        print("      MISMATCH", m)
    for r in a["true_doc_miss"][:5]:
        print("      TRUE doc-miss:", r["test_id"])

# ---------------------------------------------------------------------------
# 3. As-registered instrument + frozen gates
# ---------------------------------------------------------------------------

hdr("3. AS-REGISTERED INSTRUMENT (recorded coordinates) + FROZEN C1 GATES")
rec = {}
rec["ctx"] = per_source_table(ctx_cells, "recorded", "ctx baseline (frozen config)")
rec["C1a"] = per_source_table(c1a_cells, "recorded", "C1a required_slot+coverage")
rec["C1b"] = per_source_table(c1b_cells, "recorded", "C1b required_slot+coverage+spec")

print("\nfrozen gates: KEEP iff ansR>=0.6032 AND ansP>=0.5435 AND maud ansR>=0.1485")
print("              DROP if  ansR<0.5832  OR  ansP<0.5335  OR  maud ansR<0.1285")
print("              middle band -> DROP; P1 unconditional\n")
verdicts = {}
P1_KEY = {"C1a": "C1a coverage", "C1b": "C1b covspec"}
for arm in ("C1a", "C1b"):
    R, P, M = rec[arm]["OVERALL"]["R"], rec[arm]["OVERALL"]["P"], rec[arm]["maud"]["R"]
    keep = R >= 0.6032 and P >= 0.5435 and M >= 0.1485
    drop = R < 0.5832 or P < 0.5335 or M < 0.1285
    clean = p1[P1_KEY[arm]]["clean"]
    v = "DROP (P1 FAIL)" if not clean else ("KEEP" if keep else ("DROP" if drop else "MIDDLE -> DROP"))
    verdicts[arm] = v
    print(f"{arm}: ansR={R:.4f} (KEEP>=0.6032 {'Y' if R>=0.6032 else 'N'}, DROP<0.5832 {'Y' if R<0.5832 else 'N'})")
    print(f"     ansP={P:.4f} (KEEP>=0.5435 {'Y' if P>=0.5435 else 'N'}, DROP<0.5335 {'Y' if P<0.5335 else 'N'})")
    print(f"     maud ansR={M:.4f} (KEEP>=0.1485 {'Y' if M>=0.1485 else 'N'}, DROP<0.1285 {'Y' if M<0.1285 else 'N'})")
    print(f"     P1 {'PASS' if clean else 'FAIL'} -> VERDICT {v}\n")

print("paired (answered in both arm and ctx), as-registered:")
for arm, cells in [("C1a", c1a_cells), ("C1b", c1b_cells)]:
    pr = paired(cells, ctx_cells, "recorded")
    print(f"  {arm}: n={pr['n']} P {pr['bP']:.4f}->{pr['aP']:.4f} (d={pr['dP']:+.4f} {flag(pr['dP'])})"
          f"  R {pr['bR']:.4f}->{pr['aR']:.4f} (d={pr['dR']:+.4f} {flag(pr['dR'])})")

# ---------------------------------------------------------------------------
# 4. Corrected instrument — the decision basis
# ---------------------------------------------------------------------------

hdr("4. CORRECTED INSTRUMENT (CRLF-mapped gold, union-merged, clipped) - DECISION BASIS")
cor = {}
cor["ctx"] = per_source_table(ctx_cells, "corrected", "ctx baseline (frozen config)")
cor["C1a"] = per_source_table(c1a_cells, "corrected", "C1a required_slot+coverage")
cor["C1b"] = per_source_table(c1b_cells, "corrected", "C1b required_slot+coverage+spec")

print("\ncross-check vs published corrected ctx: maud ansR 0.4985 / overall ansP 0.6140 / ansR 0.6622")
print(f"  recomputed:  maud ansR {cor['ctx']['maud']['R']:.4f} / overall ansP "
      f"{cor['ctx']['OVERALL']['P']:.4f} / ansR {cor['ctx']['OVERALL']['R']:.4f}")

print("\nanswered-only deltas vs ctx (corrected, unpaired):")
print(f"{'arm':6} {'source':12} {'ctxP':>7} {'armP':>7} {'dP':>8} {'ctxR':>7} {'armR':>7} {'dR':>8}")
for arm in ("C1a", "C1b"):
    for source in list(SOURCES) + ["OVERALL"]:
        b, a = cor["ctx"][source], cor[arm][source]
        print(f"{arm:6} {source:12} {b['P']:>7.4f} {a['P']:>7.4f} {a['P']-b['P']:>+8.4f} "
              f"{b['R']:>7.4f} {a['R']:>7.4f} {a['R']-b['R']:>+8.4f}")

print("\nPAIRED subset (answered in BOTH arm and ctx), corrected; noise 95% band = +/-0.015:")
print(f"{'arm':6} {'source':12} {'n':>4} {'ctxP':>7} {'armP':>7} {'dP':>8} {'flag':>6} "
      f"{'ctxR':>7} {'armR':>7} {'dR':>8} {'flag':>6}")
for arm, cells in [("C1a", c1a_cells), ("C1b", c1b_cells)]:
    for source in list(SOURCES) + ["OVERALL"]:
        sub_a = [r for r in cells if source == "OVERALL" or r["source"] == source]
        sub_b = [r for r in ctx_cells if source == "OVERALL" or r["source"] == source]
        pr = paired(sub_a, sub_b, "corrected")
        print(f"{arm:6} {source:12} {pr['n']:>4} {pr['bP']:>7.4f} {pr['aP']:>7.4f} "
              f"{pr['dP']:>+8.4f} {flag(pr['dP']):>6} {pr['bR']:>7.4f} {pr['aR']:>7.4f} "
              f"{pr['dR']:>+8.4f} {flag(pr['dR']):>6}")

print("\nC1b vs C1a paired (corrected):")
pr = paired(c1b_cells, c1a_cells, "corrected")
print(f"  n={pr['n']} P {pr['bP']:.4f}->{pr['aP']:.4f} (d={pr['dP']:+.4f} {flag(pr['dP'])})"
      f"  R {pr['bR']:.4f}->{pr['aR']:.4f} (d={pr['dR']:+.4f} {flag(pr['dR'])})")

print("\nquoted-char volume per answered cell (composition cost):")
print(f"{'arm':6} {'source':12} {'meanChars':>10} {'meanSpans':>10}")
for name, cells in [("ctx", ctx_cells), ("C1a", c1a_cells), ("C1b", c1b_cells)]:
    for source in list(SOURCES) + ["OVERALL"]:
        ans = [r for r in cells if r["outcome"] == "answered"
               and (source == "OVERALL" or r["source"] == source)]
        print(f"{name:6} {source:12} {mean([r['grounded']['chars'] for r in ans]):>10.0f} "
              f"{mean([len(r['quoted_spans']) for r in ans]):>10.2f}")

hdr("5. FAIR-COMPARISON MODES (all four; retrieval-only clipped at 1.0)")
print("[corrected instrument for the composed side; retrieval_baseline is recorded+clipped]")
for name, cells in [("ctx", ctx_cells), ("C1a coverage", c1a_cells), ("C1b covspec", c1b_cells)]:
    fair_modes(cells, name, "corrected")
print("\n[as-registered instrument]")
for name, cells in [("ctx", ctx_cells), ("C1a coverage", c1a_cells), ("C1b covspec", c1b_cells)]:
    fair_modes(cells, name, "recorded")

# ---------------------------------------------------------------------------
# 6. F2 negative control
# ---------------------------------------------------------------------------

hdr("6. F2 NEGATIVE CONTROL (gold document removed; honest outcome = decline)")
f2rows = {}
for arm in ("base", "coverage", "covspec"):
    cells = list(f2[arm].values())
    print(f"\nF2 {arm}: n={len(cells)}  outcomes="
          f"{dict(collections.Counter(r['outcome'] for r in cells))}")
    print(f"{'source':12} {'n':>3} {'ans':>4} {'strictFA':>9} {'strict%':>8} "
          f"{'looseQ':>7} {'loose%':>7} {'subFA':>6} {'sub%':>7} {'dupResc':>8} "
          f"{'adjFA%':>7} {'decl':>5}")
    tot = {}
    for source in list(SOURCES) + ["OVERALL"]:
        sub = [r for r in cells if source == "OVERALL" or r["source"] == source]
        ans = [r for r in sub if r["outcome"] == "answered"]
        strict = [r for r in ans if kinds(r)["conclusion"] >= 1]
        loose = [r for r in ans if kinds(r)["conclusion"] == 0]
        subst = [r for r in strict if has_substantive_conclusion(r)]
        resc = [r for r in strict if dup_rescued(r)]
        adj = len(strict) - len(resc)
        decl = [r for r in sub if r["outcome"] in ("declined", "abstained")]
        n = len(sub)
        tot[source] = {"n": n, "ans": len(ans), "strict": len(strict) / max(1, n),
                       "loose": len(loose) / max(1, n), "sub": len(subst) / max(1, n),
                       "adj": adj / max(1, n), "resc": len(resc), "decl": len(decl)}
        print(f"{source:12} {n:>3} {len(ans):>4} {len(strict):>9} {100*len(strict)/max(1,n):>7.1f}% "
              f"{len(loose):>7} {100*len(loose)/max(1,n):>6.1f}% {len(subst):>6} "
              f"{100*len(subst)/max(1,n):>6.1f}% {len(resc):>8} {100*adj/max(1,n):>6.1f}% "
              f"{len(decl):>5}")
    f2rows[arm] = tot

print("\nregistered adoption condition: strict F2 false-answer rate <= base + 5 points absolute")
base_fa = f2rows["base"]["OVERALL"]["strict"]
f2_ok = {}
for arm in ("coverage", "covspec"):
    fa = f2rows[arm]["OVERALL"]["strict"]
    ok = fa <= base_fa + 0.05
    f2_ok[arm] = ok
    print(f"  {arm:9} strict FA = {100*fa:.1f}%  vs base {100*base_fa:.1f}% + 5.0 = "
          f"{100*(base_fa+0.05):.1f}%  -> {'PASS' if ok else 'FAIL'} (delta "
          f"{100*(fa-base_fa):+.1f} pts)")
print("  sensitivity (not the registered metric): same condition on the dup-rescue-adjusted "
      "and substantive-conclusion variants")
for arm in ("coverage", "covspec"):
    for key, name in (("adj", "adjFA"), ("sub", "subFA")):
        fa, bfa = f2rows[arm]["OVERALL"][key], f2rows["base"]["OVERALL"][key]
        print(f"    {arm:9} {name}: {100*fa:.1f}% vs base {100*bfa:.1f}% "
              f"(delta {100*(fa-bfa):+.1f} pts) -> {'PASS' if fa <= bfa + 0.05 else 'FAIL'}")

# ---------------------------------------------------------------------------
# 7. F3 plain control
# ---------------------------------------------------------------------------

hdr("7. F3 PLAIN-PROMPT CONTROL (prices the three-module grounding contract)")
f3_cells = list(f3.values())
f3_ids = set(f3)
ctx_sub = [r for r in ctx_cells if r["test_id"] in f3_ids]
per_source_table(f3_cells, "corrected", "F3 plain (196 cells)")
per_source_table(ctx_sub, "corrected", "ctx on the SAME 196 test_ids")
per_source_table(f3_cells, "recorded", "F3 plain (196 cells)")
per_source_table(ctx_sub, "recorded", "ctx on the SAME 196 test_ids")

print("\nPAIRED F3-plain vs ctx on the same 196 test_ids (corrected):")
print(f"{'source':12} {'n':>4} {'ctxP':>7} {'plainP':>7} {'dP':>8} {'flag':>6} "
      f"{'ctxR':>7} {'plainR':>7} {'dR':>8} {'flag':>6}")
for source in list(SOURCES) + ["OVERALL"]:
    a = [r for r in f3_cells if source == "OVERALL" or r["source"] == source]
    b = [r for r in ctx_sub if source == "OVERALL" or r["source"] == source]
    pr = paired(a, b, "corrected")
    print(f"{source:12} {pr['n']:>4} {pr['bP']:>7.4f} {pr['aP']:>7.4f} {pr['dP']:>+8.4f} "
          f"{flag(pr['dP']):>6} {pr['bR']:>7.4f} {pr['aR']:>7.4f} {pr['dR']:>+8.4f} "
          f"{flag(pr['dR']):>6}")

print("\nF3 registered prediction bands: plain ansP 0.45-0.60, ansR 0.55-0.70, declines <5%")
f3_ok = [r for r in f3_cells if r["outcome"] != "error"]
f3_ans = [r for r in f3_ok if r["outcome"] == "answered"]
f3p, f3r = mean([corrected(r)[0] for r in f3_ans]), mean([corrected(r)[1] for r in f3_ans])
f3rp = mean([r["grounded"]["precision"] for r in f3_ans])
f3rr = mean([r["grounded"]["recall"] for r in f3_ans])
declines = len([r for r in f3_ok if r["outcome"] in ("declined", "abstained")])
print(f"  corrected ansP={f3p:.4f} ansR={f3r:.4f} | as-registered ansP={f3rp:.4f} ansR={f3rr:.4f} "
      f"| declines={declines}/{len(f3_ok)} = {100*declines/len(f3_ok):.1f}%")

# ---------------------------------------------------------------------------
# 8. Verdict
# ---------------------------------------------------------------------------

hdr("8. VERDICT")
print("as-registered (frozen gates, literal):")
for arm in ("C1a", "C1b"):
    print(f"  {arm}: {verdicts[arm]}")
keepers = [a for a in ("C1a", "C1b") if verdicts[a] == "KEEP"]
if keepers:
    best = max(keepers, key=lambda a: (rec[a]["OVERALL"]["R"], a == "C1a"))
    cond = f2_ok["coverage" if best == "C1a" else "covspec"]
    print(f"  adoption rule -> higher-ansR KEEP arm = {best} "
          f"(ansR {rec[best]['OVERALL']['R']:.4f}); F2 condition {'PASS' if cond else 'FAIL'}")
    print(f"  => {'ADOPT ' + best if cond else 'BLOCKED by F2; frozen config unchanged'}")
else:
    print("  no arm KEEPs -> Stage 19 holdout burns the unmodified frozen config")

print("\ncorrected-instrument decision basis (paired, noise-aware):")
for arm, cells in [("C1a", c1a_cells), ("C1b", c1b_cells)]:
    pr = paired(cells, ctx_cells, "corrected")
    verdict = ("better than ctx" if pr["dR"] >= NOISE_95 and pr["dP"] > -NOISE_95
               else ("not distinguishable" if abs(pr["dR"]) < NOISE_95 and abs(pr["dP"]) < NOISE_95
                     else "worse / mixed"))
    print(f"  {arm}: paired n={pr['n']} dP={pr['dP']:+.4f} dR={pr['dR']:+.4f} -> {verdict}")
