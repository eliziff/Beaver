"""Complete-body exclusion and provenance inventory for the private author lane."""
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone

from third_prairies_sources import OUT, ROOT, dump, sha, provenance
from data import PRIVATE, BENCH, RECORDS


def grams(text):
    words = re.findall(r'\w+', text.casefold())
    return {hash(tuple(words[i:i + 8])) for i in range(max(0, len(words) - 7))}


def main():
    baseline_path = OUT.parent / 'baseline.json'
    baseline = json.loads(baseline_path.read_text(encoding='utf-8'))
    ids = {row['record_id'] for row in baseline['records']}
    previous = defaultdict(list)
    for root in [BENCH / 'records', RECORDS, PRIVATE / 'expansion', PRIVATE / 'expansion-2']:
        for path in root.rglob('affidavit.txt'):
            if path.parent.name in ids:
                previous[path.parent.name].append(path)
    current, index = {}, defaultdict(list)
    for path in sorted((OUT / 'records').glob('*/affidavit.txt')):
        rid = path.parent.name
        current[rid] = grams(path.read_text(encoding='utf-8-sig'))
        for gram in current[rid]: index[gram].append(rid)
    nearest, exact, bodies = {}, [], []
    seen = set()
    for rid, paths in sorted(previous.items()):
        for path in paths:
            digest = sha(path)
            if (rid, digest) in seen: continue
            seen.add((rid, digest))
            prior = grams(path.read_text(encoding='utf-8-sig'))
            bodies.append(dict(record_id=rid, text_sha256=digest, path=str(path)))
            common = Counter()
            for gram in prior: common.update(index.get(gram, ()))
            for new_id, count in common.items():
                score = count / max(1, len(current[new_id]))
                if score > nearest.get(new_id, {}).get('containment', 0):
                    nearest[new_id] = dict(prior_record_id=rid, containment=score,
                        common_eightgrams=count, new_eightgrams=len(current[new_id]), prior_eightgrams=len(prior))
                if score == 1 and len(prior) == len(current[new_id]): exact.append([new_id, rid])
    authored = []
    for path in sorted((OUT / 'records').glob('*/source-gold.json')):
        gold = json.loads(path.read_text(encoding='utf-8'))
        authored.append(dict(record_id=path.parent.name, source_gold_path=path.relative_to(OUT).as_posix(),
            source_gold_sha256=sha(path), review_status=gold.get('independent_source_review', {}).get('status', 'pending'),
            family=gold.get('family'), labels=len(gold['exhibits']), events=len(gold['events'])))
    report = dict(provenance(), recorded_at_utc=datetime.now(timezone.utc).isoformat(),
        baseline_sha256=sha(baseline_path), baseline_unique_ids=len(ids),
        baseline_ids_with_available_bodies=len(previous), baseline_bodies_unavailable=sorted(ids-previous.keys()),
        baseline_body_hashes=bodies, nearest_prior_bodies=nearest, exact_body_duplicates=exact,
        authored=authored, accepted=[],
        duplicate_method='Complete referring-body casefolded word eight-gram containment; every distinct available historical body hash retained. Overlap is a review lead, not automatic acceptance.')
    dump(OUT / 'author-audit.json', report)
    print(json.dumps(dict(authored=len(authored), available_prior_ids=len(previous), exact_duplicates=exact, nearest=nearest)))


if __name__ == '__main__':
    main()
