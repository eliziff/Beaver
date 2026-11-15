"""Private document-review experiment. Existing filed exhibits are the review units."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import hmac
import json
import os
from pathlib import Path
import random
import re
import sqlite3
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PRIVATE = ROOT / 'benchmarks/local-data/document-review'
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(ROOT / 'experiments/affidavit-association'))
sys.path.insert(0, str(ROOT / 'experiments/legal_pdf_corpus'))
from codex_runner.artifacts import atomic_json as dump, digest, read_json as read
from data import source_mapping, text_key, visible_text
import corpus_store

RECORDS = corpus_store.COURT_RECORDS / 'records'
RUN = 'document-review-v1'
LABELS = ('relevant', 'irrelevant', 'uncertain')
PRIVILEGE = ('none', 'withhold', 'redact', 'uncertain')


def spec():
    return read(HERE / 'sets.json') + read(HERE / 'sets-batch-2.json')


def brief(item):
    return (item['focus'] + '\n\n'
        'Review the factual issues stated above. A document is relevant if any part materially '
        'helps establish, rebut or understand one of them; adverse evidence counts. A common '
        'name or keyword alone does not establish relevance. Do not treat a document as '
        'irrelevant merely because another copy is present. Assess each supplied file, including '
        'every component of a bundle.\n\n'
        'Privilege protocol for this exercise: assess the reviewing client\'s confidential '
        'communications seeking or giving legal advice and confidential work prepared principally '
        'for this litigation. A lawyer participating in ordinary business, a scheduling message, '
        'an underlying pre-existing attachment, a confidentiality heading, and an unaccepted '
        'claim of privilege do not alone establish protection. The public filed source material '
        'in this exercise is available for review and is not to be withheld merely because it '
        'mentions lawyers. Additional unfiled communications are assessed on their own content '
        'and the roles and disclosure facts supplied with them. Withhold a wholly protected file; '
        'use redact when protected and unprotected material coexist. Do not assume forwarding '
        'to a necessary confidential legal assistant waives protection; disclosure to an unrelated '
        'third party is outside confidentiality for this exercise. This is a stipulated review '
        'protocol, not a claim that all jurisdictions have identical privilege rules.\n\n'
        'Return one entry for every file: document_id, relevance (relevant/irrelevant/uncertain), '
        'privilege (none/withhold/redact/uncertain), date (YYYY-MM-DD, YYYY-MM, YYYY or null), '
        'title (a useful filename stem), description (one sentence), reason (one or two plain '
        'sentences explaining the decisions), and evidence (short quotations or page references). '
        'Use the document\'s meaningful date, not a download or export date. Keep uncertainty '
        'explicit. Do not invent dates or resolve genuinely unreadable evidence by guessing.')


def intake(out=PRIVATE):
    """Read existing full text and reviewed SHA/page maps; do not re-extract or split PDFs."""
    pool = []
    with sqlite3.connect('file:' + corpus_store.DB.as_posix() + '?mode=ro', uri=True) as db:
        stored = dict(db.execute('select sha256,path from files'))
    for path in sorted(RECORDS.glob('*/gold.json')):
        gold = read(path)
        directory = path.parent
        source_path, split_path = directory / 'source.json', directory / 'split.json'
        if not source_path.exists() or not split_path.exists():
            continue
        source, split = read(source_path), read(split_path)
        maps = {e['file']: e for e in split['exhibits']}
        group = source.get('family') or gold.get('family') or gold.get('court_file') or gold['record_id']
        for exhibit in gold['exhibits']:
            pdf = directory / 'files' / exhibit['file']
            txt = pdf.with_suffix('.txt')
            if not txt.exists() or exhibit['file'] not in maps:
                continue
            text = visible_text(txt.read_text('utf-8-sig'))
            # Keep complete filed documents. Long exhibits need their own long-context lane.
            if len(text) > 24000 or not text.strip():
                continue
            mapping = maps[exhibit['file']]
            parts = mapping.get('source_files') or [dict(mapping,pages=mapping.get('source_pages',[]))]
            originals = [source_mapping(source, p) for p in parts]
            for original_part, reviewed_part in zip(originals, parts):
                original_part['pages']=list(reviewed_part.get('pages') or reviewed_part.get('source_pages') or [])
                masks = {}
                for field in ('blank','folio_rects','folio_pixel_masks','redact_rects'):
                    value = reviewed_part.get(field,{})
                    if isinstance(value,dict):
                        for number,rectangles in value.items():
                            masks.setdefault(str(number),[]).extend(rectangles)
                for number,rectangle in reviewed_part.get('source_correlated_folio_margin_masks',{}).items():
                    masks.setdefault(str(number),[]).append(rectangle)
                for number,rectangles in split.get('outer_folio_rects',{}).items():
                    if int(number) in original_part['pages']:
                        masks.setdefault(str(number),[]).extend(rectangles)
                original_part['reviewed_masks'] = masks
            if any(not p.get('sha256') or not p.get('url') or not p.get('pages') for p in originals):
                continue
            if any(p['sha256'] not in stored or not (corpus_store.HOME / stored[p['sha256']]).exists() for p in originals):
                continue
            for part in originals:
                part['corpus_path'] = stored[part['sha256']]
            pool.append({'record': gold['record_id'], 'group': group,
                'pdf': str(pdf.relative_to(corpus_store.HOME)).replace('\\', '/') if pdf.exists() else None,
                'text': text, 'text_key': text_key(text) or hashlib.sha256(text.encode()).hexdigest(),
                'pdf_sha256': digest(pdf) if pdf.exists() else None, 'source_files': originals,
                'source_gold_sha256': digest(path), 'source_gold': exhibit,
                'proceeding': gold.get('proceeding'), 'kind': exhibit.get('kind', 'unknown')})
    additions=out/'sourcing/additional-case-documents.json'
    if additions.exists():
        pool.extend(read(additions)['documents'])
    dump(out / 'intake.json', {'origin': 'machine_test', 'run_id': RUN, 'documents': pool})
    summary = []
    for item in spec():
        primary = [p for p in pool if p['record'] == item['seed']]
        if not primary:
            raise ValueError('No complete local sources for ' + item['seed'])
        family = primary[0]['group']
        siblings = [p for p in pool if p['group'] == family and p['record'] != item['seed']]
        summary.append({'set': item['id'], 'seed': item['seed'], 'target_size': item['size'],
                        'same_filing': len(primary), 'same_litigation': len(siblings), 'group': family})
    dump(out / 'intake-summary.json', summary)
    return summary


def shuffled(values, seed):
    values = list(values)
    random.Random(seed).shuffle(values)
    return values


def opaque_id(seed, value):
    return hmac.new(bytes.fromhex(seed),value.encode(),hashlib.sha256).hexdigest()[:16]


def reviewed_word_masks(pages, masks):
    """Replay reviewed text redactions against parser words; identify no new masks."""
    result={}
    for number,rectangles in masks.items():
        words=[word['bbox'] for line in pages[number]['lines'] for word in line['words']]
        expanded=list(rectangles)
        for x0,y0,x1,y1 in rectangles:
            for a,b0,c,d in words:
                if a<x1 and c>x0 and b0<y1 and d>y0:
                    expanded.append([a-1,b0-1,c+1,d+1])
        result[number]=expanded
    return result


def choose(item, pool):
    filing = shuffled([p for p in pool if p['record'] == item['seed']], item['id'])
    same_case = [p for p in pool if filing and p['group'] == filing[0]['group'] and p['record'] != item['seed']]
    primary = filing[:16]
    if not primary:
        raise ValueError('Missing seed ' + item['seed'])
    group = primary[0]['group']
    used = {p['text_key'] for p in primary}
    sibling = []
    for row in shuffled(same_case, item['id'] + ':siblings'):
        if row['text_key'] not in used:
            sibling.append(row)
            used.add(row['text_key'])
        if len(sibling) == 8:
            break
    if not sibling:
        raise ValueError('Insufficient distinct sibling sources: ' + item['id'])
    return primary, sibling


def validate_entry(entry):
    if entry.get('relevance') not in LABELS or entry.get('privilege') not in PRIVILEGE:
        raise ValueError('Invalid review designation')
    date = entry.get('date')
    if date is not None:
        import datetime
        if not isinstance(date, str) or not re.fullmatch(r'\d{4}(?:-\d{2}(?:-\d{2})?)?', date):
            raise ValueError('Invalid date')
        datetime.date.fromisoformat(date + ('-01-01' if len(date) == 4 else '-01' if len(date) == 7 else ''))
    for field in ('title', 'description', 'reason'):
        if not isinstance(entry.get(field), str) or not entry[field].strip():
            raise ValueError('Missing ' + field)
    if not isinstance(entry.get('evidence'), list):
        raise ValueError('Missing evidence')


def evidence_matches(text, quotations, *, page_count=0):
    normalized = ' '.join(text.split()).casefold()
    for quotation in quotations:
        candidates = [quotation.strip(' \t\n\"“”‘’')] + re.findall(r'[\"“]([^\"”]+)[\"”]', quotation)
        if any(value and ' '.join(value.split()).casefold() in normalized for value in candidates):
            return True
        if any(1<=int(number)<=page_count for number in re.findall(r'\b(?:page|p\.)\s*(\d+)\b',quotation,re.I)):
            return True
    return False


def f1(rows, field, positive):
    tp = sum(g[field] in positive and p.get(field) in positive for g, p in rows)
    fp = sum(p.get(field) in positive and g[field] not in positive for g, p in rows)
    fn = sum(g[field] in positive and p.get(field) not in positive for g, p in rows)
    return {'precision': tp / (tp + fp) if tp + fp else None,
            'recall': tp / (tp + fn) if tp + fn else None,
            'f1': 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
            'support': sum(g[field] in positive for g, _ in rows)}


def level_gold(gold, level):
    return dict(gold, documents=[row for row in gold['documents'] if row['level']<=level])


def score(gold, predictions, *, allow_provisional=False):
    """Missing predictions count as errors. Duplicate IDs and foreign IDs invalidate a run."""
    if gold.get('status') != 'accepted' and not allow_provisional:
        raise ValueError('Gold has not passed independent review')
    expected = {d['document_id']: d for d in gold['documents']}
    actual = {}
    for entry in predictions:
        validate_entry(entry)
        identity = entry['document_id']
        if identity in actual or identity not in expected:
            raise ValueError('Duplicate or unknown prediction ID: ' + identity)
        actual[identity] = entry
    rows = [(g, actual.get(k, {})) for k, g in expected.items()]
    rel_rows = [(g, p) for g, p in rows if g['relevance'] != 'uncertain']
    priv_rows = [(g, p) for g, p in rows if g['privilege'] != 'uncertain']
    eligible = [(g, p) for g, p in rows if g['relevance'] != 'uncertain' and g['privilege'] != 'uncertain']
    if not rel_rows or not priv_rows:
        raise ValueError('No adjudicated documents')
    joint = lambda g, p: g['relevance'] == p.get('relevance') and g['privilege'] == p.get('privilege')
    families = defaultdict(list)
    for g, p in eligible:
        families[g['family_id']].append(joint(g, p))
    relevance = f1(rel_rows, 'relevance', {'relevant'})
    privilege = f1(priv_rows, 'privilege', {'withhold', 'redact'})
    rel_f1s = [f1(rel_rows, 'relevance', {label})['f1'] for label in ('relevant', 'irrelevant')]
    priv_f1s = [f1(priv_rows, 'privilege', {label})['f1'] for label in ('none', 'withhold', 'redact')]
    mean_present = lambda xs: sum(x for x in xs if x is not None) / sum(x is not None for x in xs)
    return {'designation_score': 100 * (mean_present(rel_f1s) + mean_present(priv_f1s)) / 2,
        'joint_accuracy': sum(joint(g, p) for g, p in eligible) / len(eligible) if eligible else None,
        'family_balanced_joint_accuracy': sum(sum(v) / len(v) for v in families.values()) / len(families) if families else None,
        'relevance': relevance, 'privilege': privilege,
        'privilege_release_errors': sum(g['privilege'] in ('withhold', 'redact') and p.get('privilege') == 'none' for g, p in priv_rows),
        'missing_privilege_decisions': sum(g['privilege'] in ('withhold', 'redact') and 'privilege' not in p for g, p in priv_rows),
        'missing_documents': len(expected.keys() - actual.keys()), 'documents': len(rows),
        'adjudicated': len(eligible), 'uncertain_gold': len(rows) - len(eligible),
        'relevance_adjudicated': len(rel_rows), 'privilege_adjudicated': len(priv_rows),
        'review_entry_quality_score': None,
        'review_entry_quality_status': 'requires independent rubric judgments against source evidence'}


def quality_score(gold, predictions, judgments):
    expected = {r['document_id']: r for r in gold['documents']}
    predicted = {r['document_id']: r for r in predictions}
    seen, total = set(), 0
    for row in judgments:
        key = row['document_id']
        if key in seen or key not in expected or key not in predicted:
            raise ValueError('Duplicate, unknown or unsubmitted quality judgment')
        seen.add(key)
        for field in ('date', 'title', 'description', 'explanation'):
            value = row[field]
            if type(value) is not int or not 0 <= value <= 2:
                raise ValueError('Quality scores must be integers between 0 and 2')
            if field == 'explanation' and any(expected[key][f] != predicted[key][f] for f in ('relevance', 'privilege')):
                value = min(value, 1)
            total += value
    if seen != predicted.keys():
        raise ValueError('Missing quality judgments for submitted entries')
    return 100 * total / (8 * len(expected)) if expected else None


def report():
    """Report every registered matter; incomplete levels never become suite averages."""
    items=spec()
    cases=[]
    for item in items:
        folder=PRIVATE/'sets'/item['id']
        inventory,gold_path=folder/'inventory.json',folder/'gold.json'
        case={'set':item['id'],'levels':[]}
        cases.append(case)
        if not inventory.exists() or not gold_path.exists():
            case['status']='reference_not_completed'
            continue
        gold=read(gold_path)
        if gold['inventory_sha256']!=digest(inventory) or gold['status']!='accepted':
            case['status']='reference_not_accepted_for_current_inputs'
            continue
        case['status']='development_scores'
        for level in (1,2,3):
            prediction_path=folder/f'candidate-level-{level}.json'
            if not prediction_path.exists():
                case['levels'].append({'level':level,'status':'not_run'})
                continue
            submission=read(prediction_path)
            if submission['inventory_sha256']!=gold['inventory_sha256']:
                case['levels'].append({'level':level,'status':'submission_input_mismatch'})
                continue
            selected=level_gold(gold,level)
            result=dict(level=level,status='scored',**score(selected,submission['documents']))
            quality_path=folder/f'quality-level-{level}.json'
            if quality_path.exists():
                quality=read(quality_path)
                if (quality['gold_sha256']==digest(gold_path) and
                    quality['predictions_sha256']==digest(prediction_path) and
                    quality.get('rubric_sha256')==digest(HERE/'prompts/quality.txt')):
                    result.update(review_entry_quality_score=quality_score(selected,submission['documents'],quality['judgments']),
                                  review_entry_quality_status='model rubric assessment; not human-certified')
            case['levels'].append(result)
    aggregate=[]
    for level in (1,2,3):
        rows=[row for case in cases for row in case['levels'] if row['level']==level and row['status']=='scored']
        qualities=[row['review_entry_quality_score'] for row in rows if row['review_entry_quality_score'] is not None]
        aggregate.append({'level':level,'scored_sets':len(rows),'quality_scored_sets':len(qualities),'target_sets':len(items),
            'designation_score':sum(row['designation_score'] for row in rows)/len(items) if len(rows)==len(items) else None,
            'review_entry_quality_score':sum(qualities)/len(items) if len(qualities)==len(items) else None})
    return {'origin':'machine_test','run_id':RUN,'qualification':'Development results; scores do not assert corpus release readiness.',
            'scorer_sha256':digest(Path(__file__)),'sets':cases,'aggregate':aggregate}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('intake')
    sub.add_parser('report')
    s = sub.add_parser('score')
    s.add_argument('gold', type=Path)
    s.add_argument('predictions', type=Path)
    s.add_argument('--allow-provisional', action='store_true')
    s.add_argument('--level', type=int, choices=(1,2,3), default=3)
    args = parser.parse_args()
    if args.command=='report':
        result=report()
        dump(PRIVATE/'development-results.json',result)
    else:
        result = intake() if args.command == 'intake' else dict(level=args.level,**score(level_gold(read(args.gold),args.level), read(args.predictions)['documents'], allow_provisional=args.allow_provisional))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
