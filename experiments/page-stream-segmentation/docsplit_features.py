"""Page features for the document splitter: what the parser already reads per page.

`own(page)` is one page's dense vector (sizes, weights, positions of its top and bottom lines, fill,
printed/embedded label, keyword cues); `texts(page)` its top-block text, bottom-block text and whole
text for hashing. A page in a sequence is described by its own vector, its neighbours' (r=1), the
style change from the page before, the label sequence, and hashed n-grams of its top block and of
the previous page's bottom block. Pure Python + numpy/scipy; no model calls.
"""
import re

import numpy as np
import scipy.sparse as sp
from sklearn.feature_extraction.text import HashingVectorizer

ROMAN = {'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10}
START_CUES = {
    'court': r'\b(court|tribunal|board|commission|cour|tribunal)\b',
    'between': r'\b(between|entre)\b',
    'file_no': r'\b(court file|file no|no\.|docket|dossier|action no)\b',
    'affidavit': r'\baffidavit|affidavit\b|\bsolemn',
    'notice': r'\bnotice of\b|\bavis\b',
    'order': r'\border\b|\bordonnance\b',
    'agreement': r'\b(agreement|contract|lease|indenture|deed|convention|contrat)\b',
    'schedule': r'\b(schedule|appendix|annex|annexe|exhibit|attachment|tab)\b',
    'memo': r'\b(memorandum|factum|brief|submissions?|mémoire)\b',
    'transcript': r'\b(transcript|proceedings|examination|hearing|cross-examination)\b',
    'reasons': r'\b(reasons|judgment|jugement|decision|décision|endorsement)\b',
    'act': r'\b(act|regulations?|by-law|bylaw|statute|loi|règlement)\b',
    'letter': r'^\s*(dear|re:|subject:|objet)|\b(dear)\b',
    'to_from': r'^\s*(to|from|date|cc|attention)\s*:',
    'title_of': r'\b(table of contents|index|contents)\b',
    'cover': r'\b(volume|record|book of|recueil|dossier)\b',
}
END_CUES = {
    'witness': r'in witness whereof|signed,? sealed|en foi de quoi',
    'sworn': r'\b(sworn|affirmed|declared) before|commissioner for|a notary',
    'closing': r'\b(yours (truly|very truly|sincerely)|sincerely|regards|veuillez agréer)\b',
    'signature': r'_{5,}|\bper:|\bsignature\b|\bsigned\b|\(signed\)',
    'dated': r'\bdated\b|\bfait à\b|\bsigné à\b',
    'all_of': r'all of which is respectfully|respectfully submitted',
    'end': r'^\s*(end|fin|- end -|\*\*\*)\s*$',
    'counsel': r'\b(counsel for|solicitors? for|lawyers? for|avocats?)\b',
}
_START = {k: re.compile(v, re.I | re.M) for k, v in START_CUES.items()}
_END = {k: re.compile(v, re.I | re.M) for k, v in END_CUES.items()}
_PAGE_NO = re.compile(r'^\s*(?:page\s*)?[-–(\[]?\s*(\d{1,4})\s*[-–)\]]?\s*(?:of\s*(\d{1,4}))?\s*$', re.I)
_PAGE_OF = re.compile(r'\bpage\s*(\d{1,4})\s*(?:of|/|de)\s*(\d{1,4})', re.I)
_DIGIT = re.compile(r'\d')

HASH = HashingVectorizer(n_features=2 ** 12, ngram_range=(1, 2), alternate_sign=False, binary=True, norm=None,
                         token_pattern=r'(?u)\b\w+\b', lowercase=True,
                         preprocessor=lambda s: _DIGIT.sub('0', s.lower()))


def label_number(value):
    if value is None:
        return np.nan
    s = str(value).strip().lower()
    if s.isdigit():
        return float(int(s))
    if s in ROMAN:
        return float(ROMAN[s])
    m = re.search(r'(\d+)\s*$', s)
    return float(int(m.group(1))) if m else np.nan


def line_vec(line, median_size):
    if line is None:
        return [np.nan] * 9
    text = line['text']
    letters = [c for c in text if c.isalpha()]
    upper = sum(c.isupper() for c in letters) / len(letters) if letters else 0.0
    centre = (line['x0'] + line['x1']) / 2
    return [line['y0'], abs(centre - 0.5), line['x1'] - line['x0'], line['size'] / median_size if median_size else 1.0,
            line['bold'], upper, min(len(text), 200), float(text.strip().replace('.', '').isdigit()), float(line['furniture'])]


def printed_page_number(lines):
    """A page number printed in a top or bottom line: (number, total or nan)."""
    for line in lines:
        t = line['text'].strip()
        m = _PAGE_OF.search(t)
        if m:
            return float(m.group(1)), float(m.group(2))
        m = _PAGE_NO.match(t)
        if m and len(t) <= 14:
            return float(m.group(1)), float(m.group(2)) if m.group(2) else np.nan
    return np.nan, np.nan


OWN_NAMES = None


def own(page):
    """One page's dense features."""
    med = page['median_size'] or 1.0
    top, bottom = page['top'], page['bottom'] or page['top']
    body_top = [l for l in top if not l['furniture']]
    body_bottom = [l for l in bottom if not l['furniture']]
    f = [np.log1p(page['n_lines']), np.log1p(page['n_chars']), med, page['max_size'], page['max_size'] / med,
         page['quality'], float(page['source'] == 'ocr'), page['width'] / page['height'], float(page['width'] > page['height']),
         page['left'], page['right'], label_number(page['printed_label']), label_number(page['embedded_label'])]
    for k in range(3):
        f += line_vec(top[k] if k < len(top) else None, med)
    for k in range(2):
        f += line_vec(body_top[k] if k < len(body_top) else None, med)
    for k in (1, 2):
        f += line_vec(bottom[-k] if k <= len(bottom) else None, med)
    f += line_vec(body_bottom[-1] if body_bottom else None, med)
    if top:
        sizes = [l['size'] / med for l in top]
        f += [max(sizes), float(np.mean([l['bold'] > .5 for l in top])),
              float(np.mean([abs((l['x0'] + l['x1']) / 2 - .5) < .08 and (l['x1'] - l['x0']) < .7 for l in top])),
              float(np.mean([line_vec(l, med)[5] > .8 for l in top])), top[0]['y0'],
              (top[1]['y0'] - top[0]['y1']) if len(top) > 1 else np.nan]
    else:
        f += [np.nan] * 6
    f.append(max((l['y1'] for l in bottom), default=np.nan))  # how far down the page the text runs
    f.append(max((l['y1'] for l in body_bottom), default=np.nan))
    top_text = '\n'.join(l['text'] for l in top)
    bottom_text = '\n'.join(l['text'] for l in bottom)
    f += [float(bool(r.search(top_text))) for r in _START.values()]
    f += [float(bool(r.search(bottom_text))) for r in _END.values()]
    f += [float(bool(r.search(page['text']))) for r in _END.values()]
    number, total = printed_page_number(top[:3] + bottom[-3:])
    f += [number, total, float(number == 1), float(number == total) if total == total else np.nan]
    return f


def texts(page):
    return ('\n'.join(l['text'] for l in page['top']), '\n'.join(l['text'] for l in page['bottom']), page['text'])


class PageTable:
    """Every page's own vector and hashed texts, computed once; sequences index into it."""

    def __init__(self, pages):
        self.own = np.array([own(p) for p in pages], dtype=np.float32)
        top, bottom, full = zip(*[texts(p) for p in pages]) if pages else ((), (), ())
        self.top = HASH.transform(top).tocsr().astype(np.float32)
        self.bottom = HASH.transform(bottom).tocsr().astype(np.float32)
        self.full = HASH.transform(full).tocsr().astype(np.float32)
        self.fonts = [set(p['fonts']) for p in pages]
        self.size = np.array([[p['width'], p['height'], p['median_size'], p['left'], float(p['source'] == 'ocr'),
                               p['quality'], p['n_lines']] for p in pages], dtype=np.float32)
        self.dim = self.own.shape[1]

    def rows(self, seq, positions, style=True):
        """Feature rows for `positions` of the page sequence `seq` (global page indexes)."""
        seq = np.asarray(seq)
        n = len(seq)
        pos = np.asarray(positions)
        cur = seq[pos]
        has_prev = pos > 0
        has_next = pos < n - 1
        prev = np.where(has_prev, seq[np.maximum(pos - 1, 0)], 0)
        nxt = np.where(has_next, seq[np.minimum(pos + 1, n - 1)], 0)
        nanrow = np.full(self.dim, np.nan, dtype=np.float32)
        o_cur = self.own[cur]
        o_prev = np.where(has_prev[:, None], self.own[prev], nanrow)
        o_next = np.where(has_next[:, None], self.own[nxt], nanrow)
        # label sequence: printed label, embedded label, printed page number (column indexes in own)
        seqf = []
        for col in (11, 12, LABEL_COL):
            a, b, c = o_cur[:, col], o_prev[:, col], o_next[:, col]
            seqf += [np.where(np.isnan(a) | np.isnan(b), np.nan, (a == b + 1).astype(np.float32)),
                     np.where(np.isnan(a) | np.isnan(b), np.nan, (a <= b).astype(np.float32)),
                     np.where(np.isnan(a) | np.isnan(c), np.nan, (c == a + 1).astype(np.float32))]
        dense = [o_cur, o_prev, o_next, np.stack(seqf, 1), has_prev[:, None].astype(np.float32)]
        if style:
            s_cur, s_prev = self.size[cur], self.size[prev]
            fj = np.array([len(self.fonts[a] & self.fonts[b]) / max(1, len(self.fonts[a] | self.fonts[b])) if h else np.nan
                           for a, b, h in zip(cur, prev, has_prev)], dtype=np.float32)
            d = np.abs(s_cur - s_prev)
            d[~has_prev] = np.nan
            dense.append(np.column_stack([d, fj]))
        bottom_prev = self.bottom[prev].multiply(has_prev[:, None].astype(np.float32))
        return sp.hstack([sp.csr_matrix(np.hstack(dense)), self.top[cur], bottom_prev], format='csr')

    def type_rows(self, seq, positions):
        cur = np.asarray(seq)[np.asarray(positions)]
        return sp.hstack([sp.csr_matrix(self.own[cur]), self.top[cur], self.full[cur]], format='csr')


# column of the printed page number inside own(): computed once from a probe page
def _label_col():
    probe = dict(median_size=10, max_size=10, top=[], bottom=[], n_lines=0, n_chars=0, quality=1, source='native',
                 width=612, height=792, left=0, right=1, printed_label=None, embedded_label=None, text='', fonts=[])
    return len(own(probe)) - 4


LABEL_COL = _label_col()
