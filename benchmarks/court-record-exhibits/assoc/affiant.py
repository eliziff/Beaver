"""The affiant's name from the affidavit alone: "I, NAME, of ...", the title "AFFIDAVIT OF NAME", or the
signature line above the commissioner in the jurat.

Usage: python affiant.py   (coverage against gold deponent names; gold is used only to score)
"""
import json, os, re
from common import ROOT

TOK = r"[A-ZÀ-Ý][\w'’\-]+\.?"
NAME = rf"((?:{TOK}|[A-Z]\.)(?:\s+(?:{TOK}|[A-Z]\.|de|van|von|da|la|le|du)){{1,4}})"
PATS = [re.compile(rf"\bI,?\s+{NAME}\s*,", re.S),
        re.compile(rf"\bI,?\s+{NAME}\s+(?:of|am|make|MAKE|SWEAR|swear|AFFIRM|affirm|solemnly)\b", re.S),
        re.compile(rf"\bAFFIDAVIT\s+OF\s+{NAME}", re.S | re.I),
        re.compile(rf"{NAME}\s*\n[^\n]{{0,40}}\n?[^\n]{{0,40}}(?:Commissioner|Notary|A Commissioner)", re.S)]
STOP = {"Dated", "DATED", "Name", "NAME", "Affirmed", "AFFIRMED", "The", "This", "Affidavit", "AFFIDAVIT", "Sworn", "SWORN", "Court", "Province", "City", "In", "Exhibit", "Before", "BEFORE", "Me", "ME"}


def affiant(text):
    """Name tokens (lower-case) of the affiant, or an empty set."""
    head = re.sub(r"[ \t]+", " ", text[:6000])
    tail = text[-3000:]
    for k, p in enumerate(PATS):
        for m in p.finditer(tail if k == 3 else head):
            toks = [t.strip(".") for t in m[1].split() if t.strip(".") not in STOP]
            toks = [t for t in toks if len(t) > 1 and t.lower() not in {"of", "de", "van", "von", "da", "la", "le", "du", "mr", "ms", "mrs", "dr"}]
            if len(toks) >= 2:
                return {t.lower() for t in toks}
    return set()


def main():
    ok = got = n = 0
    miss = []
    for rid in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, rid, "affidavit.txt")
        if not os.path.exists(p):
            continue
        g = json.load(open(os.path.join(ROOT, rid, "gold.json"), encoding="utf-8"))
        if not g.get("exhibits"):
            continue
        n += 1
        a = affiant(open(p, encoding="utf-8").read())
        gold = {t.lower().strip(".,") for t in re.split(r"\s+", g.get("deponent") or "") if len(t.strip(".,")) > 1}
        got += bool(a)
        hit = bool(a & gold)
        ok += hit
        if not hit:
            miss.append((rid, sorted(a), g.get("deponent")))
    print(f"records {n}: name found {got}, shares a token with the gold deponent {ok}")
    for x in miss[:30]:
        print("  ", x)


if __name__ == "__main__":
    main()
