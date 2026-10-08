"""Replay a saved gold run, or score a witness-stack product against its gold."""
import argparse
from collections import Counter, defaultdict
import difflib
import json
from pathlib import Path
import worker
import composer
import gold
from gold import require


def replay(job):
    receipt = worker.read_json(job / 'receipt.json')
    require(receipt['status'] == 'complete', 'Replay requires a completed run')
    require(worker.digest(job / 'gold.json.gz') == receipt['gold_sha256'], 'Gold artifact changed')
    expected = worker.read_json(job / 'gold.json.gz')
    evidence = job / 'evidence'
    manifest = worker.read_json(evidence / 'manifest.json')
    require(worker.digest(evidence / 'manifest.json') == expected['provenance']['evidence_sha256'], 'Evidence manifest changed')
    for name, sha in manifest['files'].items():
        require(Path(name).name == name and worker.digest(evidence / name) == sha, 'Evidence changed')
    baseline = worker.read_json(job / 'baseline.json.gz')
    require(worker.fingerprint(baseline) == manifest['structure_sha256'], 'Baseline changed')
    pages = [worker.read_json(evidence / f'page-{n:06}.json.gz') for n in range(1, len([n for n in baseline['nodes'] if n['kind'] == 'page']) + 1)]
    state = gold.initial(baseline, pages)
    for operation in expected['operations']:
        saved = operation['request']
        visible = [p for p in pages if p['page'] in saved['pages']]
        surface, request = gold.request(baseline, visible, saved['targets'], state)
        require(composer.fingerprint(request['aliases']) == saved['aliases_sha256'] and composer.fingerprint(request['annotation_aliases']) == saved['annotation_aliases_sha256'], 'Replay aliases changed')
        state = gold.apply(surface, request, operation['response'], state, expected['mode'])
    manuscript, actual = gold.materialize(baseline, state, expected['provenance'])
    actual['mode'] = expected['mode']
    actual['manuscript_sha256'] = expected['manuscript_sha256']
    require(actual == expected, 'Replay changed the gold artifact')
    require(manuscript == (job / 'manuscript.txt').read_text(encoding='utf-8'), 'Replay changed the manuscript')
    require(worker.digest(job / 'manuscript.txt') == receipt['manuscript_sha256'], 'Manuscript changed')
    return {'replay': 'identical', 'run_id': receipt['run_id'], 'source_sha256': expected['source_sha256'], 'operations': len(expected['operations'])}


def state_of(value):
    if value.get('schema_version') == gold.VERSION:
        structure = value['structure']
        lines = {l['id']: l for l in value['source_trace']}
        def unproject(item):
            if isinstance(item, dict):
                if 'line_id' in item and 'range' in item:
                    line = lines[item['line_id']]
                    raw = line['text'].encode('utf-16-le')
                    a = item['range']['start'] - line['range']['start']
                    b = item['range']['end'] - line['range']['start']
                    return {'line_id':line['id'], 'start':len(raw[:2*a].decode('utf-16-le')), 'end':len(raw[:2*b].decode('utf-16-le'))}
                return {k:unproject(v) for k,v in item.items()}
            if isinstance(item, list): return [unproject(v) for v in item]
            return item
        return structure, {'lines':list(lines.values()), 'groups':value['blocks'],
            'reading_order':value['reading_order'], 'annotations':unproject(structure['annotations']),
            'joins':value['joins'],'continuations':value['continuations'],'resumes':value['resumes']}
    extraction = value.get('extraction', {}).get('pages', [])
    value = value.get('document', value.get('baseline', value))
    structure = value.get('structure_graph', value.get('structure', value))
    lines = composer.source_lines(structure)
    pages = [{'atoms':[{'id':i, 'bbox':[0,0,0,0]} for i,l in lines.items() if l['page'] == n]}
             for n in sorted({l['page'] for l in lines.values()})]
    state = gold.initial(structure, pages)
    # The structure leaves running heads, folios and print margins out of every node, and
    # names each page's folio line; such a line in the page's outer bands is furniture.
    folios = {n.get('anchor') for n in structure['nodes'] if n['kind'] == 'page'}
    bands = {l['id']: (l['bbox'][1] + l['bbox'][3]) / 2 / p['height'] for p in extraction for l in p['lines']}
    for group in state['groups']:
        if group['kind'] != 'prose' or 'native_id' in group['attributes']: continue
        if any(i in folios for i in group['line_ids']): group['kind'] = 'page_label'
        elif group['line_ids'] and all(i in bands for i in group['line_ids']):
            middle = sum(bands[i] for i in group['line_ids']) / len(group['line_ids'])
            if middle < 0.15: group['kind'] = 'header'
            elif middle > 0.85: group['kind'] = 'footer'
    # Native products can carry the composer's source-anchored annotations too.
    if structure.get('annotations'):
        def refs(item):
            if isinstance(item, dict):
                if 'line_id' in item and 'range' in item: return gold.range_refs(item['range'],lines,structure)[0]
                return {k:refs(v) for k,v in item.items()}
            if isinstance(item, list): return [refs(v) for v in item]
            return item
        state['annotations'] = refs(structure['annotations'])
    elif not any(n['kind'] == 'document' for n in structure['nodes']):
        # A PDF parser's constituents are sections under the package's own document.
        parts = [n for n in structure['nodes'] if n['kind'] == 'section' and (n.get('grammar') or '').startswith('constituent_') and n.get('line_ids')]
        roots = [a for a in state['annotations'] if a['kind'] == 'document']
        state['annotations'] = [a for a in state['annotations'] if a['kind'] != 'document']
        if parts and roots:
            first = roots[0]['line_ids'][0]
            state['annotations'].append(roots[0])
            relationships = {'exhibit': 'exhibit', 'schedule': 'schedule', 'annex': 'attachment'}
            for n in parts:
                kind = n['grammar'][len('constituent_'):]
                state['annotations'].append({'id': n['id'], 'kind': 'document', 'line_ids': n['line_ids'], 'attributes': {
                    'kind': kind, 'parent': first, 'relationship': relationships.get(kind, 'component'), 'title': [], 'facets': {}}})
    return structure, state


def prf(expected, actual):
    expected, actual = Counter(expected), Counter(actual)
    correct = sum((expected & actual).values()); total, predicted = sum(expected.values()), sum(actual.values())
    return {'expected':total, 'predicted':predicted, 'correct':correct,
            'precision':correct/predicted if predicted else float(not total),
            'recall':correct/total if total else float(not predicted),
            'f1':2*correct/(total+predicted) if total+predicted else 1.0}


def compare(expected, candidate):
    require(expected.get('schema_version') == gold.VERSION, 'Expected a generated structure gold artifact')
    gs, reference = state_of(expected); ps, predicted = state_of(candidate)
    require(gs['source_sha256'] == ps['source_sha256'], 'Candidate belongs to another PDF')
    # A line the gold had to insert (text the extraction missed, such as a pasted picture of
    # text) is the candidate's own new line on that page reading the same.
    known = {l['source_id'] for l in reference['lines'] if l['source_id']}
    extra = [l for l in predicted['lines'] if (l['source_id'] or l['id']) not in known]
    for inserted in (l for l in reference['lines'] if not l['source_id']):
        ratio = lambda l: difflib.SequenceMatcher(None, inserted['text'], l['text'], autojunk=False).ratio()
        match = max((l for l in extra if l['page'] == inserted['page']), key=ratio, default=None)
        if match is not None and ratio(match) >= 0.8:
            extra.remove(match)
            match['source_id'] = inserted['id']
            match['source_range'] = None
    cuts = defaultdict(set)
    for state in (reference, predicted):
        for line in state['lines']:
            key = line['source_id'] or line['id']
            cuts[key].update(line['source_range'] or [0,len(line['text'])])
    def features(state):
        lines = {l['id']:l for l in state['lines']}
        def span(s):
            line = lines[s['line_id']]; origin = line['source_id'] or line['id']
            lo,hi = line['source_range'] or (0,len(line['text']))
            old = line['original_text'][lo:hi] if line['source_id'] else line['text']
            # Project corrected offsets back to the unchanged extraction surface.
            def edge(at, right=False):
                for _,a,b,x,y in difflib.SequenceMatcher(None,old,line['text'],autojunk=False).get_opcodes():
                    if x <= at < y: return a + (at-x if b-a == y-x else b-a if right else 0)
                return len(old)
            return (origin,lo+edge(s['start']),lo+edge(s['end'],True))
        def spans(values): return tuple(span(s) for s in values)
        def anchor(i):
            if i is None: return None
            line=lines[i]; return (line['source_id'] or i, (line['source_range'] or [0])[0])
        def pieces(i):
            line=lines[i]; key=line['source_id'] or i; a,b=line['source_range'] or (0,len(line['text']))
            boundaries=sorted(c for c in cuts[key] if a <= c <= b)
            return [(key,x,y) for x,y in zip(boundaries,boundaries[1:])]
        sequence=[p for i in state['reading_order'] for p in pieces(i)]
        result={'coverage':sequence, 'order':list(zip(sequence,sequence[1:])), 'roles':[], 'groups':[], 'joins':[], 'hierarchy':[],
                **{k:[] for k in ('table','field','note','quotation','document','table_cells','note_references','continuations','document_facets','document_ownership','document_resumes')}}
        groups={g['line_ids'][0]:g for g in state['groups']}
        text_links=gold.text_links(state)
        incoming={l['next'] for l in text_links.values()}
        for first,g in groups.items():
            result['roles'].extend((p,g['kind']) for i in g['line_ids'] for p in pieces(i))
            if first not in incoming:
                members=list(g['line_ids']); cursor=first; visited={first}; separators={}
                while cursor in text_links:
                    link=text_links[cursor]; cursor=link['next']
                    if cursor in visited or cursor not in groups: break
                    separators[members[-1]]=link['separator']
                    visited.add(cursor); members.extend(groups[cursor]['line_ids'])
                result['groups'].append(tuple(p for i in members for p in pieces(i)))
                previous=None
                for i in members:
                    parts=pieces(i)
                    result['joins'].extend((a,b,'') for a,b in zip(parts,parts[1:]))
                    if previous is not None and parts and pieces(previous):
                        separator=separators.get(previous,gold.line_separator(state,lines[previous],lines[i]))
                        result['joins'].append((pieces(previous)[-1],parts[0],separator))
                    previous=i
            attrs=g['attributes']
            if g['kind']=='heading' or attrs.get('marker'):
                result['hierarchy'].append((anchor(first),g['kind'],attrs.get('locator_kind'),attrs.get('level',1),anchor(attrs.get('parent')),spans(attrs.get('marker',[]))))
        for a in gold.logical_annotations(state):
            kind=a['kind']; attrs=a['attributes']; extent=spans(a.get('spans',gold.whole(a['line_ids'],lines)))
            if kind not in result: continue
            if kind=='table':
                result[kind].append((extent,len(attrs['rows']),len(attrs['rows'][0]),tuple(attrs.get('header_rows',[])),tuple(tuple(m) for m in attrs.get('merges',[]))))
                result['table_cells'].extend((anchor(a['line_ids'][0]),r,c,None if cell is None else spans(cell)) for r,row in enumerate(attrs['rows']) for c,cell in enumerate(row))
            elif kind=='field': result[kind].append((extent,attrs['type'],*(spans(attrs.get(k,[])) for k in ('label','value','placeholder')),attrs.get('state')))
            elif kind=='note':
                result[kind].append((extent,attrs['kind'],spans(attrs.get('label',[]))))
                result['note_references'].extend((extent,span(s)) for s in attrs.get('references',[]))
            elif kind=='quotation': result[kind].append((extent,attrs['layout'],spans(attrs.get('attribution',[]))))
            elif kind=='document':
                start=anchor(a['line_ids'][0]); result[kind].append((start,attrs['kind'],anchor(attrs.get('parent')),attrs.get('relationship')))
                result['document_facets'].append((start,'title',spans(attrs.get('title',[]))))
                result['document_facets'].extend((start,k,spans(v)) for k,v in attrs.get('facets',{}).items())
        if any(a['kind']=='document' for a in state['annotations']):
            try:
                owners,docs=gold.ownership(state); starts={a['id']:anchor(a['line_ids'][0]) for a in docs}
                result['document_ownership']=[(p,starts[owners[i]]) for i in state['reading_order'] for p in pieces(i)]
            except ValueError:
                result['document_ownership']=[(p,'invalid_hierarchy') for i in state['reading_order'] for p in pieces(i)]
        result['document_resumes']=[(anchor(i),anchor(v['document'])) for i,v in state.get('resumes',{}).items()]
        result['continuations']=[(anchor(i),anchor(l['next']),l['kind'],l['separator']) for i,l in gold.continuations(state)]
        texts=defaultdict(str)
        for line in sorted(lines.values(),key=lambda l:((l['source_id'] or l['id']), (l['source_range'] or [0])[0])):
            texts[line['source_id'] or line['id']]+=line['text']
        return result,texts
    wanted,wanted_text=features(reference); got,got_text=features(predicted)
    matched=total=exact=0
    for ident in set(wanted_text)|set(got_text):
        a,b=wanted_text.get(ident,''),got_text.get(ident,'')
        matched+=sum(m.size for m in difflib.SequenceMatcher(None,a,b,autojunk=False).get_matching_blocks())
        total+=max(len(a),len(b)); exact+=a==b
    return {'schema_version':'legal-structure-gold.score.v1', 'source_sha256':gs['source_sha256'],
            'text':{'exact_units':exact,'units':len(set(wanted_text)|set(got_text)), 'matched_characters':matched,
                    'characters':total,'match_fraction':matched/total if total else 1},
            'metrics':{k:prf(wanted[k],got[k]) for k in wanted}}


def main():
    worker.low_priority()
    parser=argparse.ArgumentParser(description=__doc__)
    action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--replay',type=Path); action.add_argument('--gold',type=Path)
    parser.add_argument('--candidate',type=Path); parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if args.gold and not args.candidate: parser.error('--gold requires --candidate')
    result=replay(args.replay) if args.replay else compare(worker.read_json(args.gold),worker.read_json(args.candidate))
    if args.output: worker.write_json(args.output,result)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
