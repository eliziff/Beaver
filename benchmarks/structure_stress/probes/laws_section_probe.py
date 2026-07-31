"""A2AJ laws section-label detector probe — weak-set rendering catalog + scoring.

Self-contained (duckdb + stdlib only). Single-threaded on purpose: it is a
diagnostic probe, not the sweep. Reads the A2AJ laws parquets and their
per-document oracle (unofficial_sections_<lang>: {label: text}).

  python -X utf8 laws_section_probe.py catalog --set REGULATIONS-SK --limit 40
  python -X utf8 laws_section_probe.py sanity  --limit 60
  python -X utf8 laws_section_probe.py score   --limit 60
  python -X utf8 laws_section_probe.py alphabet
  python -X utf8 laws_section_probe.py giants

Modes
  catalog   per-set rendering evidence: how each oracle label is rendered at
            the point where its body text starts.
  sanity    oracle sanity: does each label's body head appear in the markdown
            at all, and how many labels are range-collapsed onto one rendered
            line (unrecoverable by any label detector without range expansion).
  score     recovery (recall) + precision per detector variant per set, split
            derive/validate by a stable hash of the citation.
  alphabet  oracle label shape distribution (bounds any detector's ceiling).
  giants    v1-regex-only timing on the largest documents (size linearity).

Nothing here writes to the corpus or to production tables.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")
LAWS = A2AJ / "laws"

# ALR-Quote-Verifier is a READ-ONLY reference implementation: imported here as
# a differential oracle only. Never runtime-coupled, never edited.
ALR_STRUCTURE = Path(
    r"C:\Users\elias\Desktop\Martys Qote Verifier\ALR-Quote-Verifier"
    r"\verifier_core\a2aj_structure.py"
)


def _load_alr():
    import importlib.util  # noqa: PLC0415

    if not ALR_STRUCTURE.exists():
        return None
    spec = importlib.util.spec_from_file_location(
        "alr_a2aj_structure", ALR_STRUCTURE
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ALR = _load_alr()

WEAK_SETS = [
    "REGULATIONS-SK",
    "LEGISLATION-MB",
    "LEGISLATION-NB",
    "LEGISLATION-SK",
    "REGULATIONS-NS",
    "REGULATIONS-NB",
    "LEGISLATION-NS",
    "REGULATIONS-MB",
    "REGULATIONS-NL",
    "LEGISLATION-FED",
]

# ── detectors ────────────────────────────────────────────────────────

# sweep.py v1 (verbatim)
V1_BOLD = re.compile(r"\*\*(\d{1,4}(?:\.\d{1,4})*)\*\*")
V1_LINE = re.compile(r"^(\d{1,4}(?:\.\d{1,4})*)[ .]", re.M)

# c1: v1-line, but the label may be glued to its subsection number, or stand
# alone on its own line (NS), or be followed by a tab / en-dash.
C1_LINE_GLUED = re.compile(
    r"^(\d{1,4}(?:\.\d{1,4})*)(?=[ \t.(\u2013\u2014]|$)", re.M
)
# c2: Saskatchewan Part-Section labels: 1-1, 3-12, 10-4.1
C2_HYPHEN = re.compile(
    r"^(\d{1,4}-\d{1,4}(?:\.\d{1,4})*)(?=[ \t.(\u2013\u2014]|$)", re.M
)
# c3: letter-suffixed labels: 2A, 12AB, 3.1A  (uppercase only: "1st" is prose)
C3_ALNUM = re.compile(
    r"^(\d{1,4}(?:\.\d{1,4})*[A-Z]{1,2})(?=[ \t.(\u2013\u2014]|$)", re.M
)
# c4: bold label admitting hyphen-part and letter suffix
C4_BOLD_ANY = re.compile(r"\*\*(\d{1,4}(?:[.\-]\d{1,4})*[A-Z]{0,2})\*\*")
# c5: range-collapsed labels — "2 to 6 [Repealed]", "**2 to 186** [Repealed…]",
#     "1 to 9 Repealed.", "2 and 3 [Repealed]", FR "2 à 6", "2 et 3".
C5_RANGE = re.compile(
    r"^(?:\*\*)?(\d{1,4})(?:\*\*)?\s*(?:to|and|\u00e0|et)\s*"
    r"(?:\*\*)?(\d{1,4})(?:\*\*)?(?=[\s\*\[]|$)",
    re.M | re.I,
)
# c6: named labels carried by markdown headings (schedules/forms/etc).
NAMED_KINDS = {
    "schedule": "Schedule", "schedules": "Schedule", "sched": "Schedule",
    "annexe": "Annexe", "annex": "Annex",
    "form": "Form", "forms": "Form", "formule": "Formule",
    "appendix": "Appendix", "appendice": "Appendice",
    "table": "Table", "tableau": "Tableau",
    "preamble": "Preamble", "pr\u00e9ambule": "Pr\u00e9ambule",
    "order": "Order",
}
C6_HEADING = re.compile(r"^#{1,6}[ \t]*(.+?)[ \t]*$", re.M)
_QUOTES = str.maketrans({"\u201c": "", "\u201d": "", "\u2018": "", "\u2019": "",
                         '"': "", "'": ""})


def _heading_named(text: str) -> set[str]:
    """Named labels from headings, with the oracle's (n) occurrence suffix."""
    seen: Counter[str] = Counter()
    out: set[str] = set()
    for m in C6_HEADING.finditer(text):
        raw = m.group(1).translate(_QUOTES).strip().strip("*").strip()
        parts = raw.split()
        if not parts:
            continue
        kind = NAMED_KINDS.get(parts[0].lower())
        if kind is None:
            continue
        ident = ""
        if len(parts) > 1:
            cand = parts[1].rstrip(".,;:")
            # oracle keeps only simple identifiers (A, 12, IV); anything else
            # collapses onto the bare kind (observed: NB Reg 2000-47).
            if re.fullmatch(r"[A-Za-z]|\d{1,4}|[IVXLCDM]{1,6}", cand):
                ident = cand.upper() if len(cand) <= 2 else cand
        label = f"{kind} {ident}".strip() if ident else kind
        seen[label] += 1
        out.add(label if seen[label] == 1 else f"{label} ({seen[label]})")
    return out


# c7: "Order" — an unnumbered operative blob between the front matter
#     (title / citation / *Made under …*) and the first ## heading.
C7_MADE_UNDER = re.compile(r"^\*(?:Made|Under|Pris)\b.*\*$", re.M | re.I)


def _order_label(text: str) -> set[str]:
    head = text[:6000]
    m = C7_MADE_UNDER.search(head)
    start = m.end() if m else None
    if start is None:
        # fall back: after the citation block (H1 + 2 blank-line-separated bits)
        m2 = re.match(r"^#[^\n]*\n\n[^\n]+\n\n", text)
        start = m2.end() if m2 else None
    if start is None:
        return set()
    rest = text[start:]
    nxt = re.search(r"^#{1,6}[ \t]", rest, re.M)
    body = rest[: nxt.start()] if nxt else rest
    body = body.strip()
    if len(body) < 40:
        return set()
    # only if that blob is not itself numbered
    if re.match(r"^\d{1,4}[ .(]", body):
        return set()
    return {"Order"}


def det_v1_bold(t, n=""): return {m.group(1) for m in V1_BOLD.finditer(t)}
def det_v1_line(t, n=""): return {m.group(1) for m in V1_LINE.finditer(t)}
def det_c1(t, n=""): return {m.group(1) for m in C1_LINE_GLUED.finditer(t)}
def det_c2(t, n=""): return {m.group(1) for m in C2_HYPHEN.finditer(t)}
def det_c3(t, n=""): return {m.group(1) for m in C3_ALNUM.finditer(t)}
def det_c4(t, n=""): return {m.group(1) for m in C4_BOLD_ANY.finditer(t)}


# ── ALR reference detectors (read-only differential oracle) ──────────


def det_alr_markre(t, n=""):
    """SECTION_MARK_RE alone: ALR's label alphabet, no spine selection."""
    if ALR is None:
        return set()
    return {m.group(1) for m in ALR.SECTION_MARK_RE.finditer(t)}


def det_alr_sections(t, n=""):
    """section_structure() exactly as ALR calls it (name-gated hyphen)."""
    if ALR is None:
        return set()
    gate = ALR.allows_hyphenated_provisions(n or "")
    return {lab for lab, _s, _e, _b in
            ALR.section_structure(t, allow_hyphen=gate)}


def det_alr_sections_hyphen(t, n=""):
    """section_structure() with the hyphen hypothesis forced on."""
    if ALR is None:
        return set()
    return {lab for lab, _s, _e, _b in
            ALR.section_structure(t, allow_hyphen=True)}


# alr-ext: ALR's SECTION_MARK_RE plus exactly three additions, each traced to a
# rendering convention in the catalog that ALR's pattern cannot reach:
#   [A-Z]{0,2}     letter-suffixed provisions (LEGISLATION-NS '5A (1)', '17W No…')
#   [ \t]*$        label alone on its line    (LEGISLATION-NS '1\nThis Act may…')
#   [\[*“"«]       repeal/italic stub follows (LEGISLATION-MB '2 and 3 [Repealed]',
#                  LEGISLATION-NS '6 to 8 *repealed 2011, c. 56, s. 1.*',
#                  LEGISLATION-FED '2 [Repealed, 1950, c. 50, s. 10]')
# ALR's deliberate rejection of "N." is kept: the catalog shows line-start
# "1. …" in these corpora is overwhelmingly a form/table list item.
ALR_EXT = re.compile(
    r"^[ \t]*(\d{1,8}(?:[.-]\d{1,8}){0,3}[A-Z]{0,2})"
    r"(?=[ \t]+(?:\(?\d|[A-Za-zÀ-ÿ]|[\[*“\"«])|[ \t]*\(|[ \t]*$)",
    re.M,
)


def det_alr_ext(t, n=""):
    return {m.group(1) for m in ALR_EXT.finditer(t)}


def det_alr_blocks(t, n=""):
    """legislation_blocks(): section labels reachable with nested locators."""
    if ALR is None:
        return set()
    return {sec for sec, _loc, _s, _e in
            ALR.legislation_blocks(t, allow_hyphen=True)}


def det_c5(t, n=""):
    out = set()
    for m in C5_RANGE.finditer(t):
        a, b = int(m.group(1)), int(m.group(2))
        if 0 < b - a <= 400:
            out |= {str(n) for n in range(a, b + 1)}
        elif a == b:
            out.add(str(a))
    return out


def det_c6(t, n=""): return _heading_named(t)
def det_c7(t, n=""): return _order_label(t)


SINGLES = {
    "v1-bold": det_v1_bold,
    "v1-line": det_v1_line,
    "alr-markre": det_alr_markre,
    "alr-ext": det_alr_ext,
    "alr-sections": det_alr_sections,
    "alr-sect-hyph": det_alr_sections_hyphen,
    "alr-blocks": det_alr_blocks,
    "c1-line-glued": det_c1,
    "c2-hyphen-part": det_c2,
    "c3-letter-suffix": det_c3,
    "c4-bold-any": det_c4,
    "c5-range-expand": det_c5,
    "c6-heading-named": det_c6,
    "c7-order-blob": det_c7,
}

PROFILES: dict[str, list[str]] = {
    "v1-best": ["v1-bold", "v1-line"],
    "alr+bold": ["alr-markre", "v1-bold"],
    "alr+bold+ext": ["alr-markre", "v1-bold", "c3-letter-suffix",
                     "c5-range-expand", "c6-heading-named", "c7-order-blob"],
    # the proposal: ALR's algorithm + bold-markdown + range + named labels
    "PROPOSED": ["alr-ext", "v1-bold", "c5-range-expand", "c6-heading-named",
                 "c7-order-blob"],
    "p-num": ["v1-bold", "c1-line-glued", "c2-hyphen-part",
              "c3-letter-suffix", "c4-bold-any"],
    "p-num+range": ["v1-bold", "c1-line-glued", "c2-hyphen-part",
                    "c3-letter-suffix", "c4-bold-any", "c5-range-expand"],
    "p-all": ["v1-bold", "c1-line-glued", "c2-hyphen-part", "c3-letter-suffix",
              "c4-bold-any", "c5-range-expand", "c6-heading-named",
              "c7-order-blob"],
}


# ── corpus access ────────────────────────────────────────────────────


def sets_available() -> list[str]:
    return sorted(p.parent.name for p in LAWS.glob("*/train.parquet"))


CITE_LIKE: str | None = None  # set from --cite-like; narrows the sample
ORDERED = False  # set from --ordered; reproduces the sweep's smoke population


def rows_for(con, name: str, lang: str, limit: int, cols: str = "text",
             ordered: bool | None = None):
    """Sampled rows. ordered=False on purpose: `order by` forces duckdb to scan
    the whole parquet to sort (LEGISLATION-FED is 100+ MB), while a bare LIMIT
    reads only the leading row groups. File order is still deterministic."""
    pq = (LAWS / name / "train.parquet").as_posix()
    text_col = f"unofficial_text_{lang}" if cols == "text" else "NULL"
    lim = f"limit {limit}" if limit else ""
    order = (f"order by citation_{lang}"
             if (ORDERED if ordered is None else ordered) else "")
    narrow = (
        f"and citation_{lang} similar to '{CITE_LIKE}'" if CITE_LIKE else ""
    )
    return con.execute(
        f"""select citation_{lang}, name_{lang}, {text_col},
                   unofficial_sections_{lang}, num_sections_{lang}
            from read_parquet('{pq}')
            where unofficial_text_{lang} is not null
            {narrow} {order} {lim}"""
    ).fetchall()


def oracle(sj: str | None) -> dict:
    try:
        d = json.loads(sj or "{}")
        return d if isinstance(d, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def split_of(cite: str) -> str:
    h = hashlib.md5((cite or "").encode("utf-8")).hexdigest()
    return "derive" if int(h[:8], 16) % 2 == 0 else "validate"


_WS = re.compile(r"\s+")


def norm(s: str) -> str:
    return _WS.sub(" ", s or "").strip()


# ── modes ────────────────────────────────────────────────────────────


REPEAL = re.compile(r"repeal|abrog|spent|not in force", re.I)


def _raw_forms(text: str, label: str) -> list[tuple[str, int]]:
    """How is `label` rendered in the RAW markdown? Whitespace matters here:
    'N' alone on its line is a different convention from 'N text' and is
    exactly what defeats sweep.py's `^(\\d+)[ .]`. The `(?![\\d]|[.-]\\d)`
    guard stops label '1' from claiming '10 \u2026', '1.1 \u2026' or '1A \u2026' (all of which
    are *different* provisions, often oracle labels in their own right)."""
    forms: list[tuple[str, int]] = []
    lab = re.escape(label)
    m = re.search(rf"\*\*{lab}\*\*", text)
    if m:
        forms.append(("bold **N**", m.start()))
    seen: set[str] = set()
    for m in re.finditer(rf"^{lab}(?![\dA-Za-z]|[.\-]\d)(.|$)", text, re.M):
        nxt = m.group(1)
        form = (
            "line N <EOL>" if nxt in ("", "\n")
            else "line N + space" if nxt == " "
            else "line N + dot" if nxt == "."
            else "line N( glued-sub" if nxt == "("
            else "line N + tab" if nxt == "\t"
            else "line N + dash" if nxt in "-\u2013\u2014"
            else f"line N + {nxt!r}"
        )
        if form not in seen:
            seen.add(form)
            forms.append((form, m.start()))
    m = re.search(rf"^#{{1,6}}[ \t]*\**{lab}\b", text, re.M)
    if m:
        forms.append(("heading '## N'", m.start()))
    return forms


def _range_covers(text: str, label: str) -> bool:
    if not label.isdigit():
        return False
    n = int(label)
    for m in C5_RANGE.finditer(text):
        a, b = int(m.group(1)), int(m.group(2))
        if a <= n <= b and 0 < b - a <= 400:
            return True
    return False


def mode_catalog(con, args) -> None:
    """Per set: how the raw markdown renders each oracle label, quantified,
    with a verbatim example line for every convention found."""
    for name in args.sets:
        for lang in args.langs:
            rows = rows_for(con, name, lang, args.limit)
            print(f"\n{'=' * 78}\n=== {name}:{lang}  ({len(rows)} docs) ===")
            forms: Counter[str] = Counter()
            ex: dict[str, tuple[str, str]] = {}
            for cite, _nm, text, sj, _num in rows:
                secs = oracle(sj)
                if not secs or not text:
                    continue
                for label, body in list(secs.items())[: args.per_doc]:
                    found = _raw_forms(text, label)
                    if not found:
                        if not label[:1].isdigit() and label in _heading_named(text):
                            found = [("named heading (normalized)", -1)]
                        elif _range_covers(text, label):
                            m = C5_RANGE.search(text)
                            found = [("range line 'N to M'",
                                      m.start() if m else -1)]
                        elif norm(body) == "[blank]":
                            found = [("oracle body '[blank]'", -1)]
                        else:
                            found = [("label absent from markdown", -1)]
                    for f, pos in found:
                        forms[f] += 1
                        if f not in ex:
                            snip = (f"label={label!r}" if pos < 0 else
                                    repr(text[max(0, pos - 34): pos + 62]))
                            ex[f] = (cite, snip)
            tot = sum(forms.values()) or 1
            for f, n in forms.most_common():
                cite, snip = ex.get(f, ("", ""))
                print(f"  {f:28s} {n:6d} {100 * n / tot:6.2f}%  [{cite}] {snip}")


RANGE_PRE = re.compile(
    r"(?:^|[\s*>])\d{1,4}\s*(?:to|and|à|et)\s*\d{1,4}(?:\*\*)?[\s\[]*$", re.I
)


def mode_sanity(con, args) -> None:
    """Per set, per oracle label:
      head_seen  body's first 40 chars (ws-normalized) present in the markdown
      blank      body is the literal '[blank]' placeholder (no text at all)
      adj        the label token is rendered within 40 chars before its body
                 -> the ceiling for any positional label detector
      range_pre  what precedes the body is a collapsed range (N to M / N et M)
      dupbody    body shared with >=1 other label in the same document
    """
    print(f"{'set:lang':24s} {'docs':>5s} {'labels':>7s} {'head_seen':>9s} "
          f"{'blank':>6s} {'adj':>6s} {'range_pre':>9s} {'dupbody':>8s}")
    for name in args.sets:
        for lang in args.langs:
            rows = rows_for(con, name, lang, args.limit)
            labels = seen = dup = blank = adj = rng = 0
            docs = 0
            for _cite, _nm, text, sj, _num in rows:
                secs = oracle(sj)
                if not secs or not text:
                    continue
                docs += 1
                ntext = norm(text)
                bodies: Counter[str] = Counter(norm(v)[:120] for v in secs.values())
                for label, body in secs.items():
                    labels += 1
                    nb = norm(body)
                    if nb == "[blank]" or not nb:
                        blank += 1
                        continue
                    if bodies[nb[:120]] > 1:
                        dup += 1
                    probe = nb[:40]
                    idx = ntext.find(probe)
                    if idx < 0:
                        continue
                    seen += 1
                    pre = ntext[max(0, idx - 40): idx]
                    if label in pre:
                        adj += 1
                    elif RANGE_PRE.search(pre):
                        rng += 1
            if not labels:
                continue
            print(f"{name+':'+lang:24s} {docs:5d} {labels:7d} "
                  f"{seen/labels:9.3f} {blank/labels:6.3f} {adj/labels:6.3f} "
                  f"{rng/labels:9.3f} {dup/labels:8.3f}")


def mode_alphabet(con, args) -> None:
    SHAPES = [
        ("dotted-numeric", re.compile(r"^\d{1,4}(\.\d{1,4})*$")),
        ("hyphen-part", re.compile(r"^\d{1,4}-\d{1,4}(\.\d{1,4})*$")),
        ("num-letter", re.compile(r"^\d{1,4}[A-Za-z]{1,3}(\.\d{1,4})*$")),
        ("num-dot-letter", re.compile(r"^\d{1,4}(\.\d{1,4})*[A-Za-z]{1,3}$")),
        ("num-range", re.compile(r"^\d[\d.]*\s*(?:to|and|\u00e0|et|-)\s*\d")),
        ("num-trailing-punct", re.compile(r"^\d{1,4}(\.\d{1,4})*[.*]$")),
        ("schedule", re.compile(r"^(schedules?|annexe?s?|sched\.?)\b", re.I)),
        ("form", re.compile(r"^(forms?|formule|formulaire)\b", re.I)),
        ("preamble", re.compile(r"^(preamble|pr\u00e9ambule)$", re.I)),
        ("order", re.compile(r"^(order|arr[\u00ea e]t[\u00e9e]|d[\u00e9e]cret|"
                             r"ordonnance)$", re.I)),
        ("appendix-table-part", re.compile(
            r"^(appendix|appendice|table|tableau|part|partie|division)\b", re.I)),
        ("roman", re.compile(r"^[IVXLCDM]{1,7}$")),
        ("letter", re.compile(r"^[A-Za-z]{1,3}$")),
        ("latin-suffix", re.compile(r"^\d+\.?\s?(bis|ter|quater)\b", re.I)),
    ]

    def shape(s: str) -> str:
        s = (s or "").strip()
        if not s:
            return "empty"
        for nm, rx in SHAPES:
            if rx.match(s):
                return nm
        return "other"

    # What each detector's label ALPHABET can even express (a hard ceiling,
    # independent of where the label sits in the markdown).
    ALPHABETS = {
        "v1 \\d{1,4}(\\.\\d{1,4})*": re.compile(r"\d{1,4}(?:\.\d{1,4})*"),
        "ALR \\d{1,8}([.-]\\d{1,8}){0,3}": re.compile(
            r"\d{1,8}(?:[.-]\d{1,8}){0,3}"
        ),
        "+letter suffix": re.compile(r"\d{1,8}(?:[.-]\d{1,8}){0,3}[A-Za-z]{0,2}"),
    }
    accept: Counter[str] = Counter()

    glob: Counter[str] = Counter()
    per: dict[str, Counter] = defaultdict(Counter)
    for name in args.sets:
        for lang in args.langs:
            for _c, _n, _t, sj, _num in rows_for(con, name, lang, args.limit,
                                                 cols="nulltext"):
                for k in oracle(sj):
                    sh = shape(k)
                    glob[sh] += 1
                    per[f"{name}:{lang}"][sh] += 1
                    for aname, arx in ALPHABETS.items():
                        if arx.fullmatch(k.strip()):
                            accept[aname] += 1
    tot = sum(glob.values()) or 1
    print(f"labels={tot}")
    print("alphabet acceptance (fullmatch on oracle label):")
    for aname in ALPHABETS:
        print(f"  {aname:34s} {accept[aname]:9d} {100 * accept[aname] / tot:7.3f}%")
    print()
    for sh, n in glob.most_common():
        print(f"  {sh:22s} {n:9d} {100*n/tot:7.3f}%")
    print(f"\noutside dotted-numeric: {100*(tot-glob['dotted-numeric'])/tot:.3f}%")
    print("\nper set:lang, share outside dotted-numeric:")
    out = []
    for key, c in per.items():
        t = sum(c.values())
        if t:
            out.append((1 - c["dotted-numeric"] / t, key, t, c))
    for frac, key, t, c in sorted(out, reverse=True):
        top = ", ".join(f"{k}={v}" for k, v in c.most_common(4)
                        if k != "dotted-numeric")
        print(f"  {key:26s} n={t:7d} outside={frac:6.3f}  {top}")


def mode_score(con, args) -> None:
    names = list(SINGLES) + list(PROFILES)
    per_set: dict[str, dict[str, dict[str, list]]] = {}
    for name in args.sets:
        for lang in args.langs:
            key = f"{name}:{lang}"
            acc = {sp: {n: [] for n in names} for sp in ("derive", "validate")}
            prec = {sp: {n: [] for n in names} for sp in ("derive", "validate")}
            for cite, dnm, text, sj, _num in rows_for(con, name, lang,
                                                      args.limit):
                secs = oracle(sj)
                want = {
                    label
                    for label, value in secs.items()
                    if norm(value).casefold() != "[blank]"
                }
                if not want or not text:
                    continue
                sp = split_of(cite)
                found = {n: fn(text, dnm or "") for n, fn in SINGLES.items()}
                for pname, members in PROFILES.items():
                    u: set[str] = set()
                    for m in members:
                        u |= found[m]
                    found[pname] = u
                for n in names:
                    f = found[n]
                    acc[sp][n].append(len(want & f) / len(want))
                    prec[sp][n].append(len(want & f) / len(f) if f else 0.0)
            per_set[key] = {"rec": acc, "prec": prec}

    hdr = f"{'set:lang':26s} {'split':9s} {'n':>4s} " + " ".join(
        f"{n[:15]:>15s}" for n in names
    )
    print(hdr)
    for key, d in per_set.items():
        for sp in ("derive", "validate"):
            vals = d["rec"][sp]
            n = len(vals[names[0]])
            if not n:
                continue
            line = f"{key:26s} {sp:9s} {n:4d} " + " ".join(
                f"{sum(vals[x])/n:15.3f}" for x in names
            )
            print(line)
    print("\n--- precision (same order) ---")
    for key, d in per_set.items():
        for sp in ("validate",):
            vals = d["prec"][sp]
            n = len(vals[names[0]])
            if not n:
                continue
            print(f"{key:26s} {sp:9s} {n:4d} " + " ".join(
                f"{sum(vals[x])/n:15.3f}" for x in names
            ))
    if args.json_out:
        payload = {
            k: {
                m: {
                    sp: {
                        n: round(sum(v[sp][n]) / len(v[sp][n]), 4)
                        for n in names if v[sp][n]
                    }
                    for sp in ("derive", "validate")
                }
                for m, v in d.items()
            }
            for k, d in per_set.items()
        }
        Path(args.json_out).write_text(
            json.dumps(payload, indent=2), encoding="utf-8"
        )
        print(f"\nwrote {args.json_out}")


def mode_giants(con, args) -> None:
    """v1-regex-only timing on the biggest docs: is >2s size-linear?"""
    targets = [
        ("LEGISLATION-FED", "en", "RSC 1985, c 1 (5th Supp)"),
        ("LEGISLATION-FED", "fr", "LC 1991, c 46"),
        ("LEGISLATION-FED", "fr", "LC 1991, c 47"),
        ("LEGISLATION-ON", "en", "RSO 1990, c C40"),
        ("LEGISLATION-ON", "en", "RSO 1990, c E2"),
        ("LEGISLATION-MB", "en", "CCSM c C225"),
        ("LEGISLATION-NB", "en", "RSNB 1973, c I-12"),
    ]
    print(f"{'doc':44s} {'MB':>7s} {'bold_s':>8s} {'line_s':>8s} "
          f"{'both_s':>8s} {'MB/s':>8s} {'hits':>7s} {'alr_s':>7s} "
          f"{'alrspine_s':>10s}")
    for name, lang, cite in targets:
        pq = (LAWS / name / "train.parquet").as_posix()
        row = con.execute(
            f"""select unofficial_text_{lang} from read_parquet('{pq}')
                where citation_{lang} = ? limit 1""",
            [cite],
        ).fetchone()
        if not row or not row[0]:
            print(f"{name}:{cite}:{lang}  MISSING")
            continue
        text = row[0]
        mb = len(text) / 1e6
        best_b = best_l = 1e9
        for _ in range(3):
            t0 = time.perf_counter()
            nb = sum(1 for _ in V1_BOLD.finditer(text))
            best_b = min(best_b, time.perf_counter() - t0)
            t0 = time.perf_counter()
            nl = sum(1 for _ in V1_LINE.finditer(text))
            best_l = min(best_l, time.perf_counter() - t0)
        both = best_b + best_l
        alr_s = alr_spine = float("nan")
        if ALR is not None:
            best_a = 1e9
            for _ in range(3):
                t0 = time.perf_counter()
                sum(1 for _ in ALR.SECTION_MARK_RE.finditer(text))
                best_a = min(best_a, time.perf_counter() - t0)
            alr_s = best_a
            t0 = time.perf_counter()
            ALR.section_structure(text, allow_hyphen=True)
            alr_spine = time.perf_counter() - t0
        print(f"{name+':'+cite+':'+lang:44s} {mb:7.3f} {best_b:8.4f} "
              f"{best_l:8.4f} {both:8.4f} {mb/both if both else 0:8.2f} "
              f"{nb+nl:7d} {alr_s:7.4f} {alr_spine:10.4f}")


def _below_normal() -> None:
    """Never fight the desktop for CPU: this is a background diagnostic."""
    try:
        if sys.platform == "win32":
            import ctypes  # noqa: PLC0415

            ctypes.windll.kernel32.SetPriorityClass(
                ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000
            )
        else:
            import os  # noqa: PLC0415

            os.nice(10)
    except Exception:  # noqa: BLE001 - best effort only
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=["catalog", "sanity", "score", "alphabet",
                                     "giants"])
    ap.add_argument("--set", action="append", dest="sets",
                    help="repeatable; default: the weak sets")
    ap.add_argument("--all-sets", action="store_true")
    ap.add_argument("--langs", default="en")
    ap.add_argument("--limit", type=int, default=60,
                    help="docs per set per lang (0 = all)")
    ap.add_argument("--per-doc", type=int, default=25,
                    help="catalog: oracle labels inspected per doc")
    ap.add_argument("--json-out", default=None)
    ap.add_argument("--ordered", action="store_true",
                    help="order by citation (matches sweep smoke sampling; "
                         "costs a full-parquet sort)")
    ap.add_argument("--cite-like", default=None,
                    help="SQL SIMILAR TO pattern on citation_<lang>, "
                         r"e.g. 'RSC 19(27|52|70).*'")
    args = ap.parse_args()

    global CITE_LIKE, ORDERED
    CITE_LIKE = args.cite_like
    ORDERED = args.ordered

    _below_normal()

    import duckdb  # noqa: PLC0415

    avail = sets_available()
    if args.all_sets:
        args.sets = avail
    elif not args.sets:
        args.sets = [s for s in WEAK_SETS if s in avail]
    args.langs = [x.strip() for x in args.langs.split(",") if x.strip()]

    con = duckdb.connect()
    con.execute("set threads to 2")
    {"catalog": mode_catalog, "sanity": mode_sanity, "score": mode_score,
     "alphabet": mode_alphabet, "giants": mode_giants}[args.mode](con, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
