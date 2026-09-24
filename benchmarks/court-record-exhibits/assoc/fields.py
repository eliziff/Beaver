"""Field extractors shared by both sides: dates, amounts, identifiers, URLs, names, kinds, garbage text."""
import math, re
from collections import Counter

MONTHS = {m: i + 1 for i, m in enumerate("january february march april may june july august september october november december".split())}
MONTHS |= {m[:3]: n for m, n in MONTHS.items()} | {"sept": 9, "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
                                                  "juillet": 7, "août": 8, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12}
MN = "|".join(sorted(MONTHS, key=len, reverse=True))
D_DMY = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th|er)?\s*(?:day\s+of\s+)?({MN})\.?,?\s*(\d{{4}})\b", re.I)
D_MDY = re.compile(rf"\b({MN})\.?\s*(\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s*(\d{{4}})\b", re.I)
D_ISO = re.compile(r"\b((?:19|20)\d\d)[-/.](\d{1,2})[-/.](\d{1,2})\b")
D_NUM = re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.]((?:19|20)\d\d)(?:\b|(?=\d{1,2}:\d\d))")  # "8/12/202410:10 PM" (OCR drops the space)
D_RANGE = re.compile(rf"\b({MN})\.?\s*(\d{{1,2}})\s*[-–]\s*\d{{1,2}},?\s*((?:19|20)\d\d)\b", re.I)  # "September 3-5, 2025"
D_SQZ = re.compile(rf"\b(\d{{1,2}})({MN})((?:19|20)\d\d)\b", re.I)
D_MY = re.compile(rf"\b({MN})\.?,?\s+((?:19|20)\d\d)\b", re.I)
# a list of dates sharing one trailing year: "May 8, June 4, June 16, and September 25, 2025", "8 May and 4 June 2025"
T_MD = re.compile(rf"\b({MN})\.?\s?(\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s?((?:19|20)\d\d)\b)?", re.I)
T_DM = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s(?:day\sof\s)?({MN})\b\.?(?:,?\s?((?:19|20)\d\d)\b)?", re.I)
LIST_GAP = re.compile(r"[\s,]*(?:and|&)?[\s,]*")


def list_dates(text, pat, mi, di):
    """Dates in a run whose year is written once, at the end."""
    out, run, last = [], [], None
    for m in pat.finditer(text):
        if run and not LIST_GAP.fullmatch(text[last:m.start()]):
            run = []
        run.append(m); last = m.end()
        if m[3]:
            if len(run) > 1:
                out += [(x.start(), m[3], MONTHS[x[mi].lower()], x[di]) for x in run[:-1] if not x[3]]
            run = []
    return out


def dates(text):
    """[(pos, 'YYYY-MM-DD' or 'YYYY-MM')] in reading order; ambiguous numeric dates give both readings."""
    out = []

    def add(pos, y, m, d=None):
        y, m = int(y), int(m)
        if 1900 <= y <= 2100 and 1 <= m <= 12:
            if d is None:
                out.append((pos, f"{y:04d}-{m:02d}"))
            elif 1 <= int(d) <= 31:
                out.append((pos, f"{y:04d}-{m:02d}-{int(d):02d}"))
    day_spans = []
    for m in D_DMY.finditer(text):
        add(m.start(), m[3], MONTHS[m[2].lower()], m[1]); day_spans.append(m.span())
    for m in D_MDY.finditer(text):
        add(m.start(), m[3], MONTHS[m[1].lower()], m[2]); day_spans.append(m.span())
    for m in D_RANGE.finditer(text):
        add(m.start(), m[3], MONTHS[m[1].lower()], m[2]); day_spans.append(m.span())
    for m in D_ISO.finditer(text):
        add(m.start(), m[1], m[2], m[3])
    for m in D_NUM.finditer(text):
        add(m.start(), m[3], m[2], m[1]); add(m.start(), m[3], m[1], m[2])
    for pos, y, mo, d in list_dates(text, T_MD, 1, 2) + list_dates(text, T_DM, 2, 1):
        add(pos, y, mo, d); day_spans.append((pos, pos + 1))
    for m in D_SQZ.finditer(text):
        add(m.start(), m[3], MONTHS[m[2].lower()], m[1])
    for m in D_MY.finditer(text):
        if not any(a <= m.start() < b for a, b in day_spans):
            add(m.start(), m[2], MONTHS[m[1].lower()])
    out.sort()
    return out


def dayset(ds):
    return {d for _, d in ds if len(d) == 10}


def monthset(ds):
    return {d[:7] for _, d in ds}


def yearset(ds):
    return {d[:4] for _, d in ds}


AMOUNT = re.compile(r"\$\s?(\d{1,3}(?:[, ]\d{3})+(?:\.\d\d)?|\d+(?:\.\d\d)?)")


def amounts(text):
    return {re.sub(r"[, ]", "", m[1]).rstrip("0").rstrip(".") for m in AMOUNT.finditer(text) if len(re.sub(r"\D", "", m[1])) >= 3}


IDENT = re.compile(r"\b(?:[A-Z]{0,4}[-‐]?)?\d[\d\-/.]{2,}[\dA-Z]\b")


def idents(text):
    """Distinctive number tokens: file/invoice/registration numbers, not dates or years or amounts."""
    out = set()
    for m in IDENT.finditer(text):
        t = m.group(0)
        digits = re.sub(r"\D", "", t)
        if len(digits) < 4 or re.fullmatch(r"(19|20)\d\d", t) or D_ISO.fullmatch(t) or D_NUM.fullmatch(t):
            continue
        if text[max(0, m.start() - 2):m.start()].strip().endswith("$"):
            continue
        out.add(re.sub(r"[‐]", "-", t).upper())
    return out


URL = re.compile(r"(?:https?://|www\.)([a-z0-9.-]+\.[a-z]{2,})(/[^\s<>\"')]*)?", re.I)


def urls(text):
    """(domain, first path segment) pairs."""
    out = set()
    for m in URL.finditer(text):
        dom = m[1].lower().removeprefix("www.")
        seg = re.sub(r"[^a-z0-9-]", "", (m[2] or "/").lower().split("/")[1] if (m[2] or "/").count("/") else "")[:40]
        out.add((dom, seg))
    return out


NAME = re.compile(r"\b(?:[A-Z][a-zA-Z'’\-]{2,}|[A-Z]{2,})(?:\s+(?:of\s+|de\s+|la\s+|&\s+)?(?:[A-Z][a-zA-Z'’\-]{1,}|[A-Z]{2,}))*")
STOPNAMES = set("""The This That These Those Exhibit Exhibits Attached Affidavit Court Ontario Canada Inc Ltd Limited Corporation Company
January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday
Page Dear Regards Copy Copies Schedule Appendix Tab Re Subject From To Date Sent Cc And For In On Of At By As An A I My Our It He She We They Mr Ms Mrs Dr
True Attachment Attachments Hereto Sworn Commissioner""".split())


def names(text):
    out = set()
    for m in NAME.finditer(text):
        n = m.group(0)
        words = [w for w in re.split(r"\s+", n) if w not in STOPNAMES and w.lower() not in ("of", "de", "la", "&")]
        if not words:
            continue
        for w in words:
            if len(w) >= 3 and w.lower() not in STOPLOW:
                out.add(w.lower())
    return out


STOPLOW = {w.lower() for w in STOPNAMES} | set("letter email agreement order report notice copy application motion statement".split())

KIND_REF = {
    "email": r"\be-?mails?\b|\bcorrespondence\b",
    "letter": r"\bletters?\b",
    "text": r"\btext messages?\b|\bsms\b|\bwhatsapp\b",
    "picture": r"\bphoto(?:graph)?s?\b|\bpictures?\b|\bimages?\b|\bscreen ?shots?\b|\bgraph\b|\bmap\b|\bposter\b|\binfographic\b",
    "order": r"\border\b|\bendorsement\b|\bjudgment\b|\breasons\b|\bdecision\b|\bruling\b",
    "agreement": r"\bagreement\b|\bcontract\b|\bterm sheet\b|\blease\b|\bindenture\b|\bdebenture\b|\bguarantee\b|\bmortgage\b|\bcommitment letter\b|\bpledge\b",
    "invoice": r"\binvoices?\b|\bstatements? of account\b|\bbills?\b|\baccounts?\b|\bdocket\b",
    "affidavit": r"\baffidavit\b|\bdeclaration\b|\bstatutory declaration\b",
    "report": r"\breport\b|\bmemorand|\bstudy\b|\bpresentation\b|\bbriefing\b|\bsurvey\b",
    "search": r"\bsearch(?:es)?\b|\bregistry\b|\bcorporate profile\b|\bppsa\b|\bppr\b|\btitle\b|\bprofile\b",
    "filing": r"\bnotice of\b|\bstatement of claim\b|\bpleading\b|\bapplication\b|\bmotion\b|\bfactum\b|\bpetition\b",
    "financial": r"\bfinancial statements?\b|\bcash ?flow\b|\bbudget\b|\bspreadsheet\b|\bledger\b|\bbreakdown\b|\bsummary\b|\bchart\b|\btable\b",
    "news": r"\barticle\b|\bnews\b|\bpress release\b|\bnews release\b|\bpublication\b|\bblog\b",
    "web": r"\bweb ?page\b|\bwebsite\b|\bonline\b|\bhttps?://|\bwww\.",
    "transcript": r"\btranscript\b|\bexamination\b|\bhearing\b|\bcross-examination\b",
    "minutes": r"\bminutes\b|\bresolution\b|\bby-?law\b",
    "legislation": r"\bregulation\b|\bact\b|\bstatute\b|\bby-?law\b|\bo\. reg\b",
    "cv": r"\bcurriculum vitae\b|\bcv\b|\br[ée]sum[ée]\b",
}
KIND_FILE = {
    "email": r"^\s*(?:from|sent|to|subject|date|cc)\s*:|\boutlook\b|\bsubject:|@\w+\.\w+",
    "letter": r"\bdear\b|\byours (?:truly|very truly)\b|\bsincerely\b|\bre:\s",
    "text": r"\bimessage\b|\bdelivered\b|\btext message\b",
    "order": r"\bthis court orders\b|\bit is (?:hereby )?ordered\b|\bthe court orders\b|\bendorsement\b|\bjustice\b|\breasons for (?:judgment|decision)\b|\bcitation:",
    "agreement": r"\bagreement\b|\bwhereas\b|\bin witness whereof\b|\bparties\b|\bcovenant",
    "invoice": r"\binvoice\b|\bamount due\b|\bsubtotal\b|\bhst\b|\bgst\b|\bbalance\b",
    "affidavit": r"\baffidavit\b|\bmake oath\b|\bsworn\b|\baffirmed\b",
    "report": r"\breport\b|\bexecutive summary\b|\btable of contents\b",
    "search": r"\bsearch\b|\bregistry\b|\bregistration\b|\bsearch criteria\b",
    "filing": r"\bnotice of\b|\bstatement of claim\b|\bcourt file no\b|\bapplicant\b|\bplaintiff\b|\bcourt file number\b",
    "financial": r"\bbalance sheet\b|\bcash flow\b|\btotal\b",
    "news": r"\breporter\b|\bnews\b|\bpress release\b|\bupdated\b|\bpublished\b",
    "web": r"https?://|\bwww\.|\b\d{1,2}/\d{1,2}/\d{4},? \d{1,2}:\d\d\b",
    "transcript": r"\bq\.\s|\ba\.\s|\bproceedings\b|\btranscript\b|\breporting\b",
    "minutes": r"\bminutes\b|\bresolution\b|\bmoved\b|\bseconded\b|\bby-?law\b",
    "legislation": r"\bregulation\b|\bo\. reg\b|\bact\b|\bsection\b|\bsubsection\b",
    "cv": r"\beducation\b|\bexperience\b|\bpublications\b|\bcurriculum\b",
}
KINDS = sorted(KIND_REF)


def kinds(text, table):
    t = text.lower()
    return {k for k, p in table.items() if re.search(p, t, re.M)}


def garbage(text):
    """Share of the text that is not plausible words (broken font encodings, OCR soup)."""
    t = text[:3000]
    if not t.strip():
        return 1.0
    words = re.findall(r"\S+", t)
    good = sum(1 for w in words if re.fullmatch(r"[A-Za-zÀ-ÿ][a-zà-ÿ'’\-]{1,}[.,;:]?|[A-Z]{2,}[.,;:]?|\d[\d,.$/%-]*", w))
    return 1 - good / max(1, len(words))


def quoted(text):
    """Quoted titles in a reference: 'titled "Ontario looking to adjust ..."'."""
    return [q for q in re.findall(r"\"([^\"]{12,200})\"", text) if len(q.split()) >= 3]
