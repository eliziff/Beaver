"""Bind existing supra judgments to a whole DOCX; score origins separately from URLs."""
from __future__ import annotations

import argparse
import collections
from pathlib import Path
import re
import sys

from compare_versions import read, rows, iter_rows, write, sha, below_normal


def normalized(text):
    return ' '.join(str(text or '').split())


def align_reference(note, reference, parts):
    """Align literal source text, preserving split/merge differences and repeated text."""
    note, reference = normalized(note), normalized(reference)
    if not reference or note.count(reference) != 1:
        return 'source_absent_or_repeated', []
    start = note.index(reference)
    end = start + len(reference)
    matches, cursor = [], 0
    for part in parts:
        text = normalized(part['citation_part_text'])
        at = note.find(text, cursor) if text else -1
        if at < 0:
            return 'output_not_source_aligned', []
        cursor = at + len(text)
        if at < end and cursor > start:
            matches.append(part)
    if not matches:
        return 'missing', []
    if len(matches) > 1:
        return 'split_reference', matches
    return ('exact' if normalized(matches[0]['citation_part_text']) == reference else 'merged_context'), matches


def origin_matches(part, target, *, root_only=False, notes=None):
    fields = ['ref_chain_origin'] if root_only else ['ref_target', 'ref_chain_origin']
    for prefix in fields:
        number = str(part.get(prefix + '_footnote_id') or '')
        text = normalized(part.get(prefix + '_citation_part_text'))
        evidence = normalized(target['evidence'])
        if evidence and number == str(target['note']) and evidence in text:
            return True
        if root_only and notes and evidence and evidence.rstrip(' .;') == text.rstrip(' .;'):
            if text in normalized(notes.get(number, '')):
                return True  # Same full source cited again, independently checked in that note.
    return False


def targets_for(item):
    if 'root_targets' in item:
        return item['root_targets'], True, bool(item['root_targets']) or item.get('root_action') == 'abstain'
    if item.get('judgment'):
        return item['judgment']['targets'], True, True
    gold = item['existing']
    origin = gold.get('expected_origin') or {}
    return ([{'note': str(origin.get('footnote')), 'evidence': origin.get('verbatim', '')}],
            False, gold['status'] in ('auto', 'agent') and item['existing_origin_present'])


def build_roots(args):
    """Follow accepted original gold edges, not either parser's predicted chains."""
    bundle = read(args.gold)
    sys.path.insert(0, read(args.manifest)['sources']['baseline']['path'])
    import alr_quote_verifier as original
    index = collections.defaultdict(list)
    for item in bundle['references']:
        gold = item['existing']
        index[(str(gold['footnote_number']), gold['part_index'])].append(item)
    for item in bundle['references']:
        item['root_targets'], item['gold_chain'] = [], []
        current, seen = item, set()
        while True:
            gold = current['existing']
            if gold['id'] in seen:
                item['root_status'] = 'gold_cycle'
                break
            seen.add(gold['id'])
            item['gold_chain'].append(gold['id'])
            if current.get('judgment'):
                item['root_targets'] = current['judgment']['targets']
                item['root_action'] = current['judgment'].get('expected_action', 'resolve')
                item['root_status'] = 'source_adjudicated_chain'
                break
            if not current['reference_present'] or gold['status'] not in ('auto', 'agent') or not current['existing_origin_present']:
                item['root_status'] = 'unaccepted_or_source_mismatched_edge'
                break
            origin = gold.get('expected_origin') or {}
            if not original._detect_ref_kind(origin['verbatim']):
                item['root_targets'] = [{'note': str(origin['footnote']), 'evidence': origin['verbatim']}]
                item['root_status'] = 'accepted_gold_chain'
                break
            edges = [edge for edge in index[(str(origin['footnote']), origin.get('part_index'))]
                     if normalized(edge['existing']['part_text']) == normalized(origin['verbatim'])]
            if len(edges) != 1:
                item['root_status'] = 'missing_or_ambiguous_gold_edge'
                break
            current = edges[0]
    if args.output.exists():
        raise FileExistsError(args.output)
    bundle['root_derivation'] = {'input_gold_sha256': sha(args.gold), 'harness_sha256': sha(__file__),
        'rule': 'Follow unique accepted, source-matched original gold edges to a non-reference or authored root judgment.',
        'counts': dict(collections.Counter(item['root_status'] for item in bundle['references']))}
    write(args.output, bundle)


def source_span(text, evidence):
    """Literal evidence, allowing only whitespace differences; never choose a repeated match."""
    words = str(evidence or '').split()
    if not words:
        return None
    matches = list(re.finditer(r'\s+'.join(re.escape(word) for word in words), text))
    return matches[0].span() if len(matches) == 1 else None


def score_core(args):
    bundle = read(args.gold)
    source = args.run / ('candidate.jsonl' if args.mode == 'safe' else 'candidate-aggressive.jsonl')
    result = next((r for r in iter_rows(source)
                   if r['id'] == 'docx:' + bundle['document']['sha256']), None)
    details = []
    if result and result['status'] == 'ok':
        citations = result['resolved']['citations']
        by_index = {c['index']: c for c in citations}
        ranges = {str(n['number']): n for n in result['notes']}
        methods = {r['index']: r['reason'] for r in result['resolved']['resolutions']}
        for item in bundle['references']:
            gold = item['existing']
            record = {'id': gold['id'], 'outcome': 'excluded'}
            targets, root_only, accepted = targets_for(item)
            abstain = item.get('root_action', (item.get('judgment') or {}).get('expected_action')) == 'abstain'
            eligible = item['reference_present'] and accepted
            record['eligible'] = eligible
            if not eligible:
                details.append(record)
                continue
            number = str(gold['footnote_number'])
            local = source_span(bundle['notes'].get(number, ''), gold['part_text'])
            target_spans = []
            for target in targets:
                note = str(target['note'])
                span = source_span(bundle['notes'].get(note, ''), target['evidence'])
                if span and note in ranges:
                    target_spans.append((ranges[note]['start'] + span[0], ranges[note]['start'] + span[1]))
            if not local or number not in ranges or len(target_spans) != len(targets):
                record['outcome'] = 'source_alignment_unavailable'
                details.append(record)
                continue
            start, end = (ranges[number]['start'] + point for point in local)
            references = [c for c in citations if c['form'] != 'full'
                          and c['span']['start'] < end and c['span']['end'] > start]
            actual = [by_index[c['antecedent']] for c in references if c.get('antecedent') in by_index]
            overlaps = lambda c, span: c['span']['start'] < span[1] and c['span']['end'] > span[0]
            # Resolution may return an earlier occurrence of the same authority.
            # Establish equivalence from literal source style/core, never candidate keys.
            signature = lambda c: (normalized(c.get('style', {}).get('text', '')),
                                   normalized(c['span']['text']))
            def hits(citation, span):
                return overlaps(citation, span) or any(
                    other['form'] == 'full' and overlaps(other, span)
                    and signature(citation) == signature(other) for other in citations)
            record['outcome'] = ('missing_reference' if not references
                else ('unsupported_resolution' if actual else 'correct_abstention') if abstain
                else 'unresolved' if not actual
                else 'target_mismatch' if any(not any(hits(c, span) for span in target_spans) for c in actual)
                else 'partial_targets' if not all(any(hits(c, span) for c in actual) for span in target_spans)
                else 'correct')
            record.update(expected_targets=targets, references=references, actual_targets=actual,
                          methods=[methods.get(c['index']) for c in references],
                          source_candidates=[[{key: c.get(key) for key in ('index', 'authority', 'span', 'style', 'interpretations')}
                              for c in citations if c['form'] == 'full' and overlaps(c, span)] for span in target_spans])
            details.append(record)
    if args.output.exists():
        raise FileExistsError(args.output)
    write(args.output, {'gold_sha256': sha(args.gold), 'scorer_sha256': sha(__file__),
        'mode': args.mode, 'raw_output_sha256': sha(source),
        'document_status': result['status'] if result else 'missing', 'details': details,
        'counts': dict(collections.Counter(r['outcome'] for r in details)),
        'limits': ['Targets are compared to literal source locations from existing gold.',
                   'A target mismatch needs source adjudication when old gold names an intermediate chain node.']})


def build(args):
    manifest = read(args.manifest)
    document = next(d for d in manifest['documents'] if d['sha256'] == args.document_hash)
    if sha(document['path']) != args.document_hash:
        raise ValueError('Document changed since freeze')
    if args.saved_documents:
        saved = next(r for r in iter_rows(args.saved_documents) if r['id'] == 'docx:' + args.document_hash)
        if saved['status'] != 'ok':
            raise ValueError('Saved extraction failed')
        output = saved['output']
        note_map = {int(k): v for k, v in output['notes'].items()}
        order = output['order']
        display = {int(k): v for k, v in output['display'].items()}
    else:
        sys.path.insert(0, manifest['sources']['baseline']['path'])
        from dev.supra_bench import parse_docx_footnotes
        note_map, order, display = parse_docx_footnotes(Path(document['path']))
    notes = {display[fid]: note_map[fid] for fid in order}
    gold_path = args.manifest.parent / 'gold/supra_gold_candidates.jsonl'
    selected = [r for r in rows(gold_path) if r['source_doc'] == args.gold_source]
    if not selected:
        raise ValueError('No gold rows for selected source')
    additions = read(args.adjudications) if args.adjudications else {'judgments': []}
    if additions.get('document_sha256', args.document_hash) != args.document_hash:
        raise ValueError('Adjudications belong to a different document')
    by_id = {r['id']: r for r in additions['judgments']}
    if not by_id.keys() <= {r['id'] for r in selected}:
        raise ValueError('Adjudication does not match an existing reference')
    bound = []
    for row in selected:
        item = {'existing': row, 'reference_present': normalized(row['part_text']) in normalized(notes.get(str(row['footnote_number']), '')),
                'judgment': by_id.get(row['id'])}
        origin = row.get('expected_origin') or {}
        item['existing_origin_present'] = bool(origin.get('verbatim')) and normalized(origin['verbatim']) in normalized(notes.get(str(origin.get('footnote')), ''))
        if item['judgment']:
            for target in item['judgment']['targets'] + item['judgment'].get('alternatives', []):
                if normalized(target['evidence']) not in normalized(notes.get(str(target['note']), '')):
                    raise ValueError(f'Adjudicated origin evidence absent: {row["id"]}')
            if not item['reference_present']:
                raise ValueError(f'Adjudicated reference absent: {row["id"]}')
        bound.append(item)
    if args.output.exists():
        raise FileExistsError(args.output)
    write(args.output, {'document': document, 'gold_source': args.gold_source, 'gold_sha256': sha(gold_path),
                        'adjudications_sha256': sha(args.adjudications) if args.adjudications else None,
                        'saved_documents_sha256': sha(args.saved_documents) if args.saved_documents else None,
                        'notes': notes, 'order': [display[fid] for fid in order], 'references': bound,
                        'coverage': dict(collections.Counter('source_matched' if x['reference_present'] else 'source_mismatch' for x in bound)),
                        'scope': 'Existing reference inventory; not a claim that every reference in the document was inventoried.'})
    print(args.output, len(bound), 'references')


def score(args):
    bundle = read(args.gold)
    sys.path.insert(0, read(args.manifest)['sources']['baseline']['path'])
    from dev import link_truth
    link_truth._LIVE_MAP_PATH = args.manifest.parent / 'gold/gold_link_verification.json'
    link_truth._REPAIRS_PATH = args.manifest.parent / 'gold/link_repairs.json'
    if args.link_db:
        link_truth._CANLII_DB_PATH = args.link_db
    outputs = []
    for path in sorted(args.run.glob('*-*.jsonl')):
        if not path.name.startswith(('baseline-', 'candidate-')):
            continue
        results = [r for r in iter_rows(path) if r['id'] == 'docx:' + bundle['document']['sha256']]
        if len(results) != 1 or results[0]['status'] != 'ok':
            outputs.append({'arm': path.stem, 'status': 'missing_or_failed_document'})
            continue
        result = results[0]['output']
        display = result['display']
        for item in bundle['references']:
            gold = item['existing']
            record = {'arm': path.stem, 'id': gold['id'], 'source_matched': item['reference_present']}
            parts = [p for p in result['parts'] if display.get(str(p['footnote_id'])) == str(gold['footnote_number'])]
            note = bundle['notes'].get(str(gold['footnote_number']), '')
            record['alignment'], matches = align_reference(note, gold['part_text'], parts)
            record['matching_parts'] = matches
            judgment = item.get('judgment')
            origin = gold.get('expected_origin') or {}
            targets, root_only, accepted = targets_for(item)
            abstain = item.get('root_action', (judgment or {}).get('expected_action')) == 'abstain'
            record['origin_eligible'] = item['reference_present'] and accepted
            record['root_only'] = root_only
            record['origin_provenance'] = judgment.get('provenance') if judgment else gold['status']
            record['expected_targets'] = targets
            record['origin_outcome'] = 'missing_or_unaligned_output' if record['origin_eligible'] else 'excluded'
            record['origin_correct'] = False
            if matches and item['reference_present']:
                record['origin_correct'] = bool(targets) and all(any(origin_matches(p, target, root_only=root_only, notes=bundle['notes']) for p in matches) for target in targets)
                reported = [p for p in matches if p.get('ref_chain_origin_footnote_id') or p.get('ref_target_footnote_id')]
                wrong = [p for p in reported if not any(origin_matches(p, target, root_only=root_only, notes=bundle['notes']) for target in targets)]
                record['origin_correct'] &= not wrong
                if record['origin_eligible']:
                    if abstain:
                        record['origin_correct'] = not reported
                        record['origin_outcome'] = 'unsupported_resolution' if reported else 'correct_abstention'
                    else:
                        record['origin_outcome'] = ('correct' if record['origin_correct'] else 'wrong_target' if wrong
                                                    else 'partial_targets' if reported else 'unresolved')
                record['multiple_targets_required'] = len(targets) > 1
                valid, reason = link_truth.gate_gold_link(gold['expected_link'], origin.get('verbatim', ''))
                record['link_eligible'] = not judgment and gold['status'] in ('auto', 'agent') and valid
                record['link_verification'] = 'source_adjudication_requires_separate_link_gold' if judgment else reason
                identities = {link_truth.canonical_link_identity(p['citation_part_link']) for p in matches}
                identities.discard('')
                expected_identity = link_truth.canonical_link_identity(gold['expected_link'])
                record['link_correct'] = identities == ({expected_identity} if expected_identity else set())
                record['link_outcome'] = ('excluded' if not record['link_eligible'] else 'correct' if record['link_correct']
                                          else 'different_link' if identities else 'unresolved')
                record['expected_link'] = gold['expected_link']
                record['actual_link_identities'] = sorted(identities)
                record['same_link_without_pinpoint'] = {
                    link_truth.canonical_link_identity(p['citation_part_link'], include_fragment=False)
                    for p in matches if link_truth.canonical_link_identity(p['citation_part_link'])
                } == {link_truth.canonical_link_identity(gold['expected_link'], include_fragment=False)}
            outputs.append(record)
    if args.output.exists():
        raise FileExistsError(args.output)
    write(args.output, {'gold_sha256': sha(args.gold), 'scorer_sha256': sha(__file__), 'details': outputs,
                       'counts': dict(collections.Counter((r['arm'] + ':' + r.get('alignment', r.get('status', ''))) for r in outputs))})
    print(args.output)


def main():
    below_normal()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('build')
    p.add_argument('--document-hash', required=True)
    p.add_argument('--gold-source', required=True)
    p.add_argument('--adjudications', type=Path)
    p.add_argument('--saved-documents', type=Path)
    p = sub.add_parser('score')
    p.add_argument('--gold', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--link-db', type=Path)
    p = sub.add_parser('score-core')
    p.add_argument('--gold', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--mode', choices=['safe', 'aggressive'], default='safe')
    p = sub.add_parser('build-roots')
    p.add_argument('--gold', type=Path, required=True)
    for p in sub.choices.values():
        p.add_argument('--manifest', type=Path, required=True)
        p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    for name, value in vars(args).items():
        if isinstance(value, Path):
            setattr(args, name, value.resolve())
    {'build': build, 'score': score, 'score-core': score_core, 'build-roots': build_roots}[args.command](args)


if __name__ == '__main__':
    main()
