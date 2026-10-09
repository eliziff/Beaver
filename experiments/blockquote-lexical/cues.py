"""How often each lexical cue holds for block quotations and for running text in a unit set:
`python cues.py <units.jsonl>`. Prints each cue's share in both classes and its lift."""
import json, re, sys
from collections import Counter

CUES = {
    'lead-in ends with colon': lambda u: u['before'].rstrip().endswith(':'),
    'lead-in ends unfinished (no stop)': lambda u: not re.search(r'[.!?]["”’)\]]*$', u['before'].rstrip()),
    'lead-in names a speaker or source': lambda u: bool(re.search(r'\b(?:said|stated|wrote|held|observed|noted|explained|concluded|provides?|reads?|follows|states?|put it|in the words of)\b[^.]{0,60}[:,]?\s*$', u['before'], re.I)),
    'opens with a quotation mark': lambda u: u['text'].lstrip()[:1] in '"“‘\'',
    'opens in lower case or with ellipsis': lambda u: bool(re.match(r'\s*(?:\.\.\.|…|[a-z])', u['text'])),
    'contains an ellipsis': lambda u: '...' in u['text'] or '…' in u['text'] or '. . .' in u['text'],
    'contains a bracketed alteration': lambda u: bool(re.search(r'\[[A-Za-z][^\]]{0,25}\]', u['text'])),
    'emphasis/footnote note': lambda u: bool(re.search(r'\[?(?:emphasis|italics|footnotes?|citations?|references?)\s+(?:added|omitted|in original|mine)', u['text'], re.I)),
    'ends with a closing quotation mark': lambda u: bool(re.search(r'["”’]\s*\.?\s*$', u['text'])),
    'ends with a note number after the stop': lambda u: bool(re.search(r'[.!?"”’]\s*\d{1,3}\s*$', u['text'])),
    'ends with a pinpoint or citation': lambda u: bool(re.search(r'(?:\bat (?:para\.? )?\d+|\bpara\.? \d+|\(\d{4}\)|\[\d{4}\]|\bp\. ?\d+)\W*$', u['text'])),
    'first person (I, we, my)': lambda u: bool(re.search(r'\b(?:I|we|my|our|us)\b', u['text'])),
    'statutory wording (shall, may, section)': lambda u: bool(re.search(r'\b(?:shall|hereby|thereof|herein|subsection|pursuant to)\b', u['text'], re.I)),
    'archaic or judicial voice (Lordship, learned)': lambda u: bool(re.search(r'\b(?:Lordship|learned|plaintiff|defendant|appellant|respondent|counsel|honour)\b', u['text'], re.I)),
    'follow-on resumes in lower case': lambda u: bool(re.match(r'\s*[a-z]', u['after'])),
    'unit is short (<= 40 words)': lambda u: len(u['text'].split()) <= 40,
}


def main():
    hits = {True: Counter(), False: Counter()}
    totals = Counter()
    for line in open(sys.argv[1], encoding='utf-8'):
        unit = json.loads(line)
        label = unit['quote']
        totals[label] += 1
        for name, cue in CUES.items():
            hits[label][name] += cue(unit)
    print(f"units: quotes {totals[True]}, text {totals[False]}")
    print(f"{'cue':45} {'quote':>7} {'text':>7} {'lift':>6}")
    for name in CUES:
        q = hits[True][name] / max(1, totals[True])
        t = hits[False][name] / max(1, totals[False])
        print(f"{name:45} {q:7.3f} {t:7.3f} {q / max(t, 1e-6):6.1f}")


if __name__ == '__main__':
    main()
