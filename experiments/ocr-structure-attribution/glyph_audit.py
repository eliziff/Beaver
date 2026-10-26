"""Rescore saved readings with core-based row association; preserve every previous report."""
from pathlib import Path
from collections import Counter,defaultdict
from rapidfuzz.distance import Levenshtein
from analyze import DEFAULT_OUT,digest,read,write,folded
from crop_ab import summarize


def character_summary(output):
    review=DEFAULT_OUT/'glyph-projection-review.json'
    if not review.is_file():return
    excluded=read(review)['excluded']
    key=lambda m:tuple(m[k] for k in ['source_sha256','page','line_id','kind','label'])
    keys={key(m) for m in excluded};groups=defaultdict(Counter)
    for mark in read(output/'report.json')['marks']:
        if key(mark) in keys or any(mark[a] in ['unaligned','unobserved','unresolved'] for a in ['baseline','candidate']):continue
        wanted=''.join(folded(mark['label']).split());counts=groups[mark['kind']]
        counts['characters']+=len(wanted);counts['marks']+=1
        for arm in ['baseline','candidate']:
            actual=''.join(mark['glyph_readings'][arm].split())
            operations=Counter(o.tag for o in Levenshtein.editops(wanted,actual))
            counts[arm+'_errors']+=sum(operations.values())
            for tag in ['delete','insert','replace']:counts[arm+'_'+tag]+=operations[tag]
    total=Counter()
    for counts in groups.values():total.update(counts)
    write(output/'character-summary.json',{'scope':'Paired scorable annotated marks; reviewed prose-contaminated projections excluded in both arms.',
        'excluded':excluded,'totals':dict(total),'groups':{k:dict(c) for k,c in groups.items()},
        'source_report_sha256':digest(output/'report.json'),'review_sha256':digest(review)})


def main():
    for name in ['crop-ab','margin-ab']:
        original=DEFAULT_OUT/name;output=original/'glyph-audit';output.mkdir(exist_ok=True)
        jobs=read(original/'jobs.json')
        summarize(DEFAULT_OUT,output,jobs)
        character_summary(output)
        inputs={str(original/'jobs.json'):digest(original/'jobs.json')}
        for j in jobs:
            for path in [Path(j['trace']),Path(j['output'])/'readings.json']:
                inputs[str(path)]=digest(path)
        write(output/'receipt.json',{'inputs':inputs,'scripts':{str(p):digest(p)
            for p in [Path(__file__),Path(__file__).with_name('analyze.py'),Path(__file__).with_name('crop_ab.py')]},
            'association':'Maximum vertical core overlap, frozen for both arms; ambiguous rows unscored'})


if __name__=='__main__':main()
