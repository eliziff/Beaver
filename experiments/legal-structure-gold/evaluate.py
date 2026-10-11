"""Replay a saved gold run, or score a witness-stack product against its gold."""
import argparse
from contextlib import closing
from collections import Counter, defaultdict
import difflib
import hashlib
import json
from pathlib import Path
import worker
import composer
import gold
import package
from gold import require


def replay(job):
    worker.recover_update(job)
    receipt = worker.read_json(job / 'receipt.json')
    require(receipt['status'] == 'complete', 'Replay requires a completed run')
    require(worker.digest(job / 'gold.json.gz') == receipt['gold_sha256'], 'Gold artifact changed')
    expected = worker.read_json(job / 'gold.json.gz')
    compact = expected if expected.get('schema_version') == package.VERSION else None
    if compact is not None and receipt.get('kind') == 'record_import':
        worker.verified_run(job)
        return {'replay': 'current_facts_validated', 'run_id': receipt['run_id'],
                'source_sha256': compact['source_sha256'], 'operations': None, 'record_layers': len(compact['records'])}
    if receipt.get('kind') == 'annotation_update':
        worker.verified_run(job)
        package.validate(compact)
        stages = compact['provenance'].get('annotation_stages', {})
        current = {stage: worker.stage_current(job, compact, stage) for stage in stages}
        require(any(current.values()), 'No annotation stage describes current gold')
        receipts = {stage: worker.read_json(job / marker['receipt']) for stage, marker in stages.items()}
        for stage, saved in receipts.items():
            require(worker.stage_binding(job, compact, stage, saved) is not None,
                    'Annotation stage refers to different shared text')
            if not current[stage]:
                require(any(a[:len(b)] == b or b[:len(a)] == a
                            for other, active in current.items() if active
                            for a in saved['owned_paths'] for b in receipts[other]['owned_paths']),
                        'Changed annotations have no current owning stage')
        return {'replay': 'current_facts_validated', 'run_id': receipt['run_id'],
                'source_sha256': compact['source_sha256'], 'annotation_stages': sorted(stages),
                'superseded_annotation_stages': sorted(stage for stage, active in current.items() if not active),
                'operations': None, 'record_layers': len(compact['records'])}
    if receipt.get('parent_run'):
        parent = (job / receipt['parent_run']).resolve()
        require(compact is not None and parent != job.resolve(), 'Invalid package parent')
        require(worker.digest(parent / 'gold.json.gz') == receipt['source_gold_sha256'], 'Source gold changed')
        source_receipt, original, pages = worker.verified_run(parent)
        paths = receipt['artifact_paths']
        require(worker.digest(job / paths['manuscript']) == receipt['manuscript_sha256'], 'Manuscript changed')
        require(compact['pages'] == worker.page_geometry(pages), 'Package page geometry changed')
        records = [{'gold': package.record_gold(compact,rid), **compact['views'][rid]} for rid in compact['records'] if rid in compact['views']]
        if receipt.get('record_promotion'):
            records.extend(worker.court_record_item(rid) for rid,record in compact['records'].items() if 'owner_source_sha256' in record)
            records.sort(key=lambda item: item['gold']['record_id'])
            require(worker.fingerprint(records) == receipt['record_promotion']['record_inputs_sha256'] and
                    worker.fingerprint(compact['form_observations']) == receipt['record_promotion']['form_observations_sha256'],
                    'Promoted record evidence changed')
            projected, hierarchy_sha = worker.package_value(parent, original, records, compact['pages'],
                compact['form_observations'], record_promotion=True)
            require(hierarchy_sha == receipt.get('source_hierarchy_sha256'), 'Imported hierarchy evidence changed')
        else:
            projected = package.attach_records(original, records, compact['form_observations']) if original.get('schema_version') == package.VERSION else package.pack(original, records, compact['pages'], compact['form_observations'])
        if receipt.get('source_hierarchy_sha256') and not receipt.get('record_promotion'):
            import hierarchy_pass
            saved_hierarchy = hierarchy_pass.read_layer(parent)
            require(saved_hierarchy is not None, 'Imported hierarchy evidence missing')
            path, layer = saved_hierarchy
            require(worker.digest(path) == receipt['source_hierarchy_sha256'], 'Imported hierarchy evidence changed')
            require(layer['gold_sha256'] == receipt['source_gold_sha256'], 'Imported hierarchy source differs')
            hierarchy_pass.apply_items(projected, layer['items'])
            projected['provenance']['imported_hierarchy'] = {
                'artifact_sha256': receipt['source_hierarchy_sha256'], 'state_sha256': hierarchy_pass.state_identity(projected)}
        projected['records'].update({rid:record for rid,record in compact['records'].items() if 'owner_source_sha256' in record})
        require(projected == compact, 'Package facts changed')
        operation_replay = 'identical'
        operations = None
        try: operations = replay(parent)['operations']
        except ValueError as error:
            code = source_receipt['configuration'].get('code', {})
            changed = any(code.get(path.name) != worker.digest(path) for path in (worker.HERE/'gold.py',worker.COMPOSER/'composer.py'))
            if not changed or str(error) not in {'Replay aliases changed','Replay changed the gold artifact','Replay changed the manuscript'}: raise
            operation_replay = 'original_code_required: '+str(error)
        return {'replay': 'facts_identical', 'run_id': receipt['run_id'], 'source_sha256': compact['source_sha256'],
                'operations': operations, 'source_operation_replay': operation_replay, 'record_layers': len(compact['records'])}
    evidence = job / 'evidence'
    manifest = worker.read_json(evidence / 'manifest.json')
    require(worker.digest(evidence / 'manifest.json') == expected['provenance']['evidence_sha256'], 'Evidence manifest changed')
    for name, sha in manifest['files'].items():
        require(Path(name).name == name and worker.digest(evidence / name) == sha, 'Evidence changed')
    baseline = worker.read_json(job / 'baseline.json.gz')
    require(worker.fingerprint(baseline) == manifest['structure_sha256'], 'Baseline changed')
    pages = [worker.read_json(evidence / f'page-{n:06}.json.gz') for n in range(1, len([n for n in baseline['nodes'] if n['kind'] == 'page']) + 1)]
    state = gold.initial(baseline, pages)
    metadata = compact['metadata'] if compact else expected
    if compact:
        configuration = compact['provenance']['configuration']
        schema_sha = worker.digest(job / 'schema.json')
        for index, page in enumerate(pages):
            surface, request = gold.request(baseline, pages[max(0,index-1):index+2], [page['page']], state)
            prompt_sha = hashlib.sha256(worker.prompt(request, metadata['mode']).encode()).hexdigest()
            matches = []
            for path in (job / 'calls' / f"page-{page['page']:06}").glob('*/receipt.json'):
                call = worker.read_json(path)
                first = call['attempts'][0] if call['attempts'] else {}
                if call.get('response_sha256') and first.get('prompt_sha256') == prompt_sha:
                    matches.append((path, call, first))
            require(len(matches) == 1, 'Replay needs one matching accepted authoring response')
            path, call, first = matches[0]
            require(first['schema_sha256'] == schema_sha and all(first[key] == configuration[key] for key in ('model','effort')), 'Replay call identity changed')
            response = path.parent / 'response.json'
            require(worker.digest(response) == call['response_sha256'], 'Authoring response changed')
            state = gold.apply(surface, request, worker.read_json(response), state, metadata['mode'])
    else:
        for operation in expected['operations']:
            saved = operation['request']
            visible = [p for p in pages if p['page'] in saved['pages']]
            surface, request = gold.request(baseline, visible, saved['targets'], state)
            require(composer.fingerprint(request['aliases']) == saved['aliases_sha256'] and composer.fingerprint(request['annotation_aliases']) == saved['annotation_aliases_sha256'], 'Replay aliases changed')
            state = gold.apply(surface, request, operation['response'], state, metadata['mode'])
    manuscript, actual = gold.materialize(baseline, state, expected['provenance'])
    actual['mode'] = metadata['mode']
    actual['manuscript_sha256'] = metadata['manuscript_sha256']
    if compact:
        records = [{'gold': package.record_gold(compact,rid), **compact['views'][rid]} for rid in compact['records'] if rid in compact['views']]
        projected = package.pack(actual, records, worker.page_geometry(pages), compact['form_observations'])
        projected['records'].update({rid:record for rid,record in compact['records'].items() if 'owner_source_sha256' in record})
        require(projected == compact, 'Replay changed canonical package')
    else:
        require(actual == expected, 'Replay changed the gold artifact')
    require(manuscript == (job / 'manuscript.txt').read_text(encoding='utf-8'), 'Replay changed the manuscript')
    require(worker.digest(job / 'manuscript.txt') == receipt['manuscript_sha256'], 'Manuscript changed')
    return {'replay': 'identical', 'run_id': receipt['run_id'], 'source_sha256': expected['source_sha256'], 'operations': len(actual['operations'])}


def state_of(value):
    if value.get('schema_version') == package.VERSION:
        return {'source_sha256': value['source_sha256']}, package.structure_state(value)
    if value.get('schema_version') == gold.VERSION:
        structure = value['structure']
        lines = {l['id']: l for l in value['source_trace']}
        return structure, {'lines':list(lines.values()), 'groups':value['blocks'],
            'reading_order':value['reading_order'], 'annotations':package.unproject(structure['annotations'], lines),
            'joins':value['joins'],'continuations':value['continuations'],'resumes':value['resumes']}
    extraction = value.get('extraction', {}).get('pages', [])
    value = value.get('document', value.get('baseline', value))
    structure = value.get('structure_graph', value.get('structure', value))
    lines = composer.source_lines(structure)
    boxes = {line['id']: [1000*v/(page['width'] if i%2 == 0 else page['height']) for i,v in enumerate(line['bbox'])]
             for page in extraction for line in page['lines']}
    pages = [{'atoms':[{'id':i, 'bbox':boxes.get(i,[0,0,0,0])} for i,l in lines.items() if l['page'] == n]}
             for n in sorted({l['page'] for l in lines.values()})]
    state = gold.initial(structure, pages)
    # A unit's level is its depth under the units it is projected beneath, as the gold's is (its
    # parent's plus one), not the parser's own count within a list or a type size's rank.
    by_line = {i: g for g in state['groups'] for i in g['line_ids']}
    depths = {}
    def depth(group):
        # Up the parents until a known depth, a root or a cycle; then back down.
        chain, seen = [], set()
        while group is not None and id(group) not in depths and id(group) not in seen:
            seen.add(id(group)); chain.append(group)
            group = by_line.get(group['attributes'].get('parent'))
        base = depths.get(id(group), 0) if group is not None else 0
        for offset, member in enumerate(reversed(chain), 1):
            depths[id(member)] = base + offset
        return depths[id(chain[0])] if chain else base
    for group in state['groups']:
        if 'level' in group['attributes']: group['attributes']['level'] = depth(group)
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
                if 'line_id' in item and 'range' in item: return gold.range_refs(item['range'],lines,structure)
                return {k:refs(v) for k,v in item.items()}
            if isinstance(item, list):
                return [part for value in item for part in (refs(value) if isinstance(value, dict) and
                    'line_id' in value and 'range' in value else [refs(value)])]
            return item
        state['annotations'] = refs(structure['annotations'])
    elif not any(n['kind'] == 'document' for n in structure['nodes']):
        # A PDF parser's constituents are sections under the package's own document.
        parts = [n for n in structure['nodes'] if n['kind'] == 'section' and (n.get('grammar') or '').startswith('constituent_') and n.get('line_ids')]
        roots = [a for a in state['annotations'] if a['kind'] == 'document']
        state['annotations'] = [a for a in state['annotations'] if a['kind'] != 'document']
        # A PDF the parser does not part is one document: its own.
        if roots:
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


def source_alignment(reference, predicted):
    """Project page-local source intervals, including split and merged witnesses.

    Shared source text retains its exact coordinates. Foreign witnesses align Unicode
    scalars in physical order; unmatched intervals keep distinct candidate coordinates.
    No line IDs, text, annotations or source records are rewritten.
    """
    def sources(state):
        result = {}
        for line in state['lines']:
            ident = line['source_id'] or line['id']
            row = result.setdefault(ident, {'page':line['page'], 'original':line['original_text'] if line['source_id'] else line['text'],
                                           'box':list(line['box']), 'parts':[]})
            require(row['page'] == line['page'], 'Source witness spans pages')
            row['parts'].append(line)
            old, box = row['box'], line['box']
            row['box'] = [min(old[0],box[0]),min(old[1],box[1]),max(old[2],box[2]),max(old[3],box[3])]
        for row in result.values():
            row['text'] = ''.join(line['text'] for line in sorted(row['parts'], key=lambda line:(line['source_range'] or [0])[0]))
            row['edits'] = difflib.SequenceMatcher(None,row['original'],row['text'],autojunk=False).get_opcodes()
        return result
    known, own = sources(reference), sources(predicted)
    mappings = defaultdict(list)
    shared = {ident for ident,row in own.items() if ident in known and
              row['page'] == known[ident]['page'] and row['original'] == known[ident]['original']}
    for ident in shared:
        mappings[ident].append((0,len(own[ident]['original']),ident,0,len(own[ident]['original'])))
    matched_known = set(shared)
    def old_interval(row, start, end):
        def edge(at, right):
            for _,a,b,x,y in row['edits']:
                if (x < at <= y) if right else (x <= at < y):
                    return a + (at-x if b-a == y-x else b-a if right else 0)
            return len(row['original'])
        offset = row.get('offset',0)
        return offset+edge(start,False),offset+edge(end,True)
    def add(ident, target, start_a, start_b, size, reference_row=None, candidate_row=None):
        reference_row = reference_row if reference_row is not None else known[target]
        candidate_row = candidate_row if candidate_row is not None else own[ident]
        # Split on correction boundaries as well as source boundaries, preserving
        # exact scalar coordinates outside the changed text.
        boundaries = {0,size}
        boundaries.update(at-start_a for _,_,_,x,y in reference_row['edits'] for at in (x,y) if start_a < at < start_a+size)
        boundaries.update(at-start_b for _,_,_,x,y in candidate_row['edits'] for at in (x,y) if start_b < at < start_b+size)
        points = sorted(boundaries)
        for lo,hi in zip(points,points[1:]):
            a,b = old_interval(reference_row,start_a+lo,start_a+hi)
            x,y = old_interval(candidate_row,start_b+lo,start_b+hi)
            if x < y and a < b: mappings[ident].append((x,y,target,a,b))
    def local_row(line):
        start,end = line['source_range'] or (0,len(line['text']))
        old = line['original_text'][start:end] if line['source_id'] else line['text']
        return {'original':old, 'offset':start,
                'edits':difflib.SequenceMatcher(None,old,line['text'],autojunk=False).get_opcodes()}
    def printed_page(state, page):
        lines = {line['id']:line for line in state['lines']}
        rows, chunks, cursor = [], [], 0
        for ident in state['reading_order']:
            line = lines[ident]
            if line['page'] != page: continue
            chunks.append(line['text']); rows.append((cursor,cursor+len(line['text']),line))
            cursor += len(line['text'])+1
        return '\n'.join(chunks),rows
    page_anchors = set()
    # Identical printed pages give exact corrected offsets even if one exporter
    # splits a multiline legal unit into several native source lines.
    for page in sorted({row['page'] for row in own.values()} & {row['page'] for row in known.values()}):
        left,rows_a = printed_page(reference,page); right,rows_b = printed_page(predicted,page)
        if left != right: continue
        ia = ib = 0
        while ia < len(rows_a) and ib < len(rows_b):
            lo_a,hi_a,line_a = rows_a[ia]; lo_b,hi_b,line_b = rows_b[ib]
            start,end = max(lo_a,lo_b),min(hi_a,hi_b)
            ident = line_b['source_id'] or line_b['id']
            if start < end and ident not in shared:
                add(ident,line_a['source_id'] or line_a['id'],start-lo_a,start-lo_b,end-start,
                    local_row(line_a),local_row(line_b))
            if hi_a <= hi_b: ia += 1
            if hi_b <= hi_a: ib += 1
        page_anchors.update(ident for ident,row in own.items() if row['page'] == page)
        matched_known.update(ident for ident,row in known.items() if row['page'] == page)
    def spatial(ident, rows):
        row = rows[ident]; x0,y0,x1,y1 = row['box']
        return (row['page'],(y0+y1)/2,x0)
    for page in sorted({row['page'] for row in own.values()}):
        a = [ident for ident,row in known.items() if row['page'] == page and ident not in matched_known]
        b = [ident for ident,row in own.items() if row['page'] == page and ident not in shared and ident not in page_anchors]
        # Exact unique witnesses can move in the candidate's order without losing identity.
        by_text = defaultdict(list)
        for ident in a: by_text[known[ident]['text']].append(ident)
        counts = Counter(own[ident]['text'] for ident in b)
        paired = set()
        for ident in b:
            text = own[ident]['text']; matches = by_text[text]
            if text and len(matches) == counts[text] == 1:
                target = matches[0]
                add(ident,target,0,0,len(text))
                matched_known.add(target); paired.add(ident)
        a = sorted((ident for ident in a if ident not in matched_known),key=lambda ident:spatial(ident,known))
        b = sorted((ident for ident in b if ident not in paired),key=lambda ident:spatial(ident,own))
        def surface(ids, rows):
            text, spans, offset = [], [], 0
            for ident in ids:
                value = rows[ident]['text']; text.append(value)
                spans.append((offset,offset+len(value),ident)); offset += len(value)
            return ''.join(text),spans
        text_a, spans_a = surface(a,known); text_b, spans_b = surface(b,own)
        ia = ib = 0
        for block in difflib.SequenceMatcher(None,text_a,text_b,autojunk=False).get_matching_blocks():
            left,right,remaining = block
            while remaining:
                while ia < len(spans_a) and spans_a[ia][1] <= left: ia += 1
                while ib < len(spans_b) and spans_b[ib][1] <= right: ib += 1
                start_a,end_a,target = spans_a[ia]; start_b,end_b,ident = spans_b[ib]
                size = min(remaining,end_a-left,end_b-right)
                add(ident,target,left-start_a,right-start_b,size)
                left += size; right += size; remaining -= size
    for ident,spans in mappings.items():
        accepted=[]
        for span in sorted(set(spans)):
            if not accepted or span[0] >= accepted[-1][1]: accepted.append(span)
        mappings[ident]=accepted
    def project(ident, start, end):
        result, cursor = [], start
        for lo,hi,target,offset,limit in mappings[ident]:
            def edge(at, right=False):
                return offset+(at-lo if hi-lo == limit-offset else limit-offset if right or at == hi else 0)
            if start == end and lo <= start < hi:
                return [(target,edge(start),edge(start))]
            a,b = max(start,lo),min(end,hi)
            if a >= b: continue
            if cursor < a: result.append(('candidate:'+ident,cursor,a))
            result.append((target,edge(a),edge(b,True))); cursor = b
        if cursor < end: result.append(('candidate:'+ident,cursor,end))
        if start == end:
            last = next((part for part in reversed(mappings[ident]) if part[1] == start),None)
            return [(last[2],last[4],last[4])] if last else [('candidate:'+ident,start,end)]
        return result
    target_sources = defaultdict(set)
    for ident,spans in mappings.items():
        for _,_,target,_,_ in spans: target_sources[target].add(ident)
    diagnostics = {'method':'shared-witness-then-page-local-unicode-span-alignment',
        'reference_sources':len(known), 'candidate_sources':len(own),
        'matched_sources':sum(bool(spans) for spans in mappings.values()),
        'unmatched_reference_sources':len(known.keys()-target_sources.keys()),
        'unmatched_candidate_sources':sum(not mappings[ident] for ident in own),
        'split_reference_sources':sum(len(ids)>1 for ids in target_sources.values()),
        'merged_candidate_sources':sum(len({part[2] for part in spans})>1 for spans in mappings.values()),
        'shared_witness_sources':len(shared),
        'exact_page_witness_sources':len(page_anchors-shared),
        'matched_span_coordinates_shared':all(ident in shared for ident,spans in mappings.items() if spans),
        'reference_characters':sum(len(row['original']) for row in known.values()),
        'candidate_characters':sum(len(row['original']) for row in own.values()),
        'aligned_candidate_characters':sum(hi-lo for spans in mappings.values() for lo,hi,_,_,_ in spans),
        'changed_length_spans':sum(hi-lo != b-a for spans in mappings.values() for lo,hi,_,a,b in spans)}
    covered = defaultdict(list)
    for spans in mappings.values():
        for _,_,target,start,end in spans: covered[target].append((start,end))
    aligned_reference = 0
    for spans in covered.values():
        cursor = 0
        for start,end in sorted(spans):
            aligned_reference += max(0,end-max(start,cursor)); cursor = max(cursor,end)
    diagnostics['aligned_reference_characters'] = aligned_reference
    diagnostics['reference_character_coverage'] = aligned_reference / diagnostics['reference_characters'] if diagnostics['reference_characters'] else 1
    diagnostics['candidate_character_coverage'] = diagnostics['aligned_candidate_characters'] / diagnostics['candidate_characters'] if diagnostics['candidate_characters'] else 1
    # Recognition compares connected source components in reference coordinate order.
    # Splitting or reordering physical sources is measured separately from recognition.
    parent = {}
    def root(key):
        parent.setdefault(key,key)
        while parent[key] != key:
            parent[key] = parent[parent[key]]; key = parent[key]
        return key
    for ident,spans in mappings.items():
        for _,_,target,_,_ in spans: parent[root(('candidate',ident))] = root(('reference',target))
    texts = ({}, {})
    for side,rows,out in zip(('reference','candidate'),(known,own),texts):
        def position(ident):
            if side == 'candidate' and mappings[ident]:
                return min((*spatial(target,known),offset) for _,_,target,offset,_ in mappings[ident])
            return (*spatial(ident,rows),0)
        for ident in sorted(rows,key=position):
            key = root((side,ident)); out[key] = out.get(key,'') + rows[ident]['text'].replace('\n','')
    return project, diagnostics, texts


def merged_spans(values):
    """Canonicalize adjacent coordinates without erasing gaps or changing order."""
    result = []
    for origin,start,end in values:
        if result and result[-1][0] == origin and result[-1][2] == start:
            result[-1] = (origin,result[-1][1],end)
        else: result.append((origin,start,end))
    return tuple(result)


def compare(expected, candidate):
    require(expected.get('schema_version') in {gold.VERSION, package.VERSION}, 'Expected a generated structure gold artifact')
    gs, reference = state_of(expected); ps, predicted = state_of(candidate)
    require(gs['source_sha256'] == ps['source_sha256'], 'Candidate belongs to another PDF')
    project_candidate, alignment, (wanted_text,got_text) = source_alignment(reference,predicted)
    witnesses = {line['source_id'] or line['id']:line['original_text'] if line['source_id'] else line['text'] for line in reference['lines']}
    witnesses.update({'candidate:'+(line['source_id'] or line['id']):line['original_text'] if line['source_id'] else line['text'] for line in predicted['lines']})
    def project(line, start, end, candidate_side):
        ident = line['source_id'] or line['id']
        mapped = project_candidate(ident,start,end) if candidate_side else [(ident,start,end)]
        result = []
        # A newline inside a Gold legal unit and a newline between native source
        # fragments represent the same boundary, not missing recognized text.
        for origin,a,b in mapped:
            if a == b:
                result.append((origin,a,b)); continue
            cursor = a
            for point in range(a,b):
                if witnesses[origin][point:point+1] == '\n':
                    if cursor < point: result.append((origin,cursor,point))
                    cursor = point+1
            if cursor < b: result.append((origin,cursor,b))
        return result
    cuts = defaultdict(set)
    for state,candidate_side in ((reference,False),(predicted,True)):
        for line in state['lines']:
            start,end = line['source_range'] or (0,len(line['text']))
            for ident,a,b in project(line,start,end,candidate_side): cuts[ident].update((a,b))
    def features(state, candidate_side):
        lines = {l['id']:l for l in state['lines']}
        def span(s):
            line = lines[s['line_id']]
            lo,hi = line['source_range'] or (0,len(line['text']))
            old = line['original_text'][lo:hi] if line['source_id'] else line['text']
            # Project corrected offsets back to the unchanged extraction surface.
            def edge(at, right=False):
                for _,a,b,x,y in difflib.SequenceMatcher(None,old,line['text'],autojunk=False).get_opcodes():
                    if x <= at < y: return a + (at-x if b-a == y-x else b-a if right else 0)
                return len(old)
            return project(line,lo+edge(s['start']),lo+edge(s['end'],True),candidate_side)
        def spans(values): return merged_spans(part for s in values for part in span(s))
        def anchor(i):
            if i is None: return None
            line=lines[i]; start=(line['source_range'] or [0])[0]
            origin,offset,_=project(line,start,start,candidate_side)[0]
            return (origin,offset)
        # The package's own document is the root, whichever line it opens on.
        roots={a['line_ids'][0] for a in state['annotations'] if a['kind']=='document' and a['attributes'].get('parent') is None}
        def document(i): return ('root',) if i in roots else anchor(i)
        def pieces(i):
            line=lines[i]; start,end=line['source_range'] or (0,len(line['text']))
            result=[]
            for key,a,b in project(line,start,end,candidate_side):
                boundaries=sorted(c for c in cuts[key] if a <= c <= b)
                result.extend((key,x,y) for x,y in zip(boundaries,boundaries[1:]))
            return result
        sequence=[p for i in state['reading_order'] for p in pieces(i)]
        result={'coverage':sequence, 'order':list(zip(sequence,sequence[1:])), 'roles':[], 'groups':[], 'joins':[], 'hierarchy':[],
                'hierarchy_units':[], 'hierarchy_relation':[], 'hierarchy_parent':[], 'hierarchy_marker':[], 'hierarchy_depth':[],
                **{k:[] for k in ('table','field','note','quotation','document','table_cells','note_references','continuations','document_facets','document_ownership','document_resumes')}}
        groups={g['line_ids'][0]:g for g in state['groups']}
        # A unit's structure is scored relative to the unit before it in reading order (its child,
        # its sibling, a sibling of its k-th ancestor), never by absolute depth: one wrong parent
        # higher up costs that unit, not every unit under it.
        position={i:n for n,i in enumerate(state['reading_order'])}
        units=sorted((first for first,g in groups.items() if g['kind']=='heading' or g['attributes'].get('marker')),
                     key=lambda first: position.get(first, len(position)))
        parent_of={first: groups[first]['attributes'].get('parent') for first in units}
        relation={}
        for n,first in enumerate(units):
            if n == 0:
                relation[first]='first'; continue
            previous, parent = units[n-1], parent_of[first]
            if parent == previous:
                relation[first]='child'; continue
            chain, at, seen = [], previous, set()
            while at is not None and at not in seen:
                seen.add(at); chain.append(at); at = parent_of.get(at)
            relation[first] = next((('sibling' if k == 0 else f'up {k}') for k, a in enumerate(chain) if parent_of.get(a) == parent), 'other')
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
                result['hierarchy'].append((anchor(first),g['kind'],attrs.get('locator_kind'),relation.get(first),anchor(attrs.get('parent')),spans(attrs.get('marker',[]))))
                # The same units scored field by field, so a unit found with its role but another
                # relation or parent still counts for what it gets right. Depth is reported, not scored
                # in the unit's tuple.
                result['hierarchy_units'].append((anchor(first),g['kind']))
                result['hierarchy_relation'].append((anchor(first),relation.get(first)))
                result['hierarchy_depth'].append((anchor(first),attrs.get('level',1)))
                result['hierarchy_parent'].append((anchor(first),anchor(attrs.get('parent'))))
                result['hierarchy_marker'].append((anchor(first),spans(attrs.get('marker',[]))))
        for a in gold.logical_annotations(state):
            kind=a['kind']; attrs=a['attributes']; extent=spans(a.get('spans',gold.whole(a['line_ids'],lines)))
            if kind not in result: continue
            if kind=='table':
                result[kind].append((extent,len(attrs['rows']),len(attrs['rows'][0]),tuple(attrs.get('header_rows',[])),tuple(tuple(m) for m in attrs.get('merges',[]))))
                result['table_cells'].extend((anchor(a['line_ids'][0]),r,c,None if cell is None else spans(cell)) for r,row in enumerate(attrs['rows']) for c,cell in enumerate(row))
            elif kind=='field': result[kind].append((extent,attrs['type'],*(spans(attrs.get(k,[])) for k in ('label','value','placeholder')),attrs.get('state')))
            elif kind=='note':
                result[kind].append((extent,attrs['kind'],spans(attrs.get('label',[]))))
                result['note_references'].extend((extent,spans([s])) for s in attrs.get('references',[]))
            elif kind=='quotation': result[kind].append((extent,attrs['layout'],spans(attrs.get('attribution',[]))))
            elif kind=='document':
                start=document(a['line_ids'][0]); result[kind].append((start,attrs['kind'],document(attrs.get('parent')),attrs.get('relationship')))
                result['document_facets'].append((start,'title',spans(attrs.get('title',[]))))
                result['document_facets'].extend((start,k,spans(v)) for k,v in attrs.get('facets',{}).items())
        if any(a['kind']=='document' for a in state['annotations']):
            try:
                owners,docs=gold.ownership(state); starts={a['id']:document(a['line_ids'][0]) for a in docs}
                result['document_ownership']=[(p,starts[owners[i]]) for i in state['reading_order'] for p in pieces(i)]
            except (ValueError, KeyError):
                # A candidate whose headings name a parent no group opens is an invalid hierarchy too.
                result['document_ownership']=[(p,'invalid_hierarchy') for i in state['reading_order'] for p in pieces(i)]
        result['document_resumes']=[(anchor(i),document(v['document'])) for i,v in state.get('resumes',{}).items()]
        result['continuations']=[(anchor(i),anchor(l['next']),l['kind'],l['separator']) for i,l in gold.continuations(state)]
        return result
    wanted=features(reference,False); got=features(predicted,True)
    matched=total=exact=0
    for ident in set(wanted_text)|set(got_text):
        a,b=wanted_text.get(ident,''),got_text.get(ident,'')
        matched+=sum(m.size for m in difflib.SequenceMatcher(None,a,b,autojunk=False).get_matching_blocks())
        total+=max(len(a),len(b)); exact+=a==b
    return {'schema_version':'legal-structure-gold.score.v1', 'source_sha256':gs['source_sha256'],
            'alignment':alignment,
            'text':{'method':'aligned-source-components-without-line-breaks','exact_units':exact,'units':len(set(wanted_text)|set(got_text)), 'matched_characters':matched,
                    'characters':total,'match_fraction':matched/total if total else 1},
            'metrics':{k:prf(wanted[k],got[k]) for k in wanted}}


def main():
    worker.low_priority()
    parser=argparse.ArgumentParser(description=__doc__)
    action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--replay',type=Path); action.add_argument('--gold',type=Path)
    action.add_argument('--export',type=Path)
    parser.add_argument('--candidate',type=Path); parser.add_argument('--output',type=Path)
    parser.add_argument('--view',choices=('parser','manuscript','affidavit','ocr','pagexml','line-ocr','ocr-all'),default='parser')
    parser.add_argument('--record-id'); parser.add_argument('--pdf',type=Path)
    parser.add_argument('--dpi',type=int,choices=range(72,301),default=300)
    args=parser.parse_args()
    if args.gold and not args.candidate: parser.error('--gold requires --candidate')
    if args.export:
        if not args.output: parser.error('--export requires --output')
        value=worker.read_json(args.export)
        require(value.get('schema_version') == package.VERSION, 'Export requires a canonical gold package')
        args.output.parent.mkdir(parents=True,exist_ok=True)
        if args.view == 'parser':
            worker.write_json(args.output,package.parser_view(value))
            worker.write_json(args.output.with_name(args.output.name+'.receipt.json'), {
                'source_sha256':value['source_sha256'], 'gold_sha256':worker.digest(args.export),
                'exported_at':worker.corpus_store.now(), 'view':'parser',
                'exporter':{path.name:worker.digest(path) for path in (worker.HERE/'package.py',worker.HERE/'gold.py',worker.COMPOSER/'composer.py')},
                'output_sha256':worker.digest(args.output)})
        elif args.view == 'manuscript': args.output.write_text(package.manuscript_text(value),encoding='utf-8',newline='\n')
        elif args.view == 'affidavit':
            if not args.record_id: parser.error('--view affidavit requires --record-id')
            worker.write_json(args.output,worker.affidavit_record(value,args.record_id))
        else:
            pdf=args.pdf
            if pdf is None:
                import sqlite3
                with closing(sqlite3.connect(worker.corpus_store.DB.as_uri()+'?mode=ro',uri=True)) as db:
                    row=db.execute('select path from files where sha256=?',(value['source_sha256'],)).fetchone()
                require(row is not None,'OCR source missing from corpus')
                pdf=worker.corpus_store.HOME/row[0]
            print(json.dumps(package.export_ocr(value,pdf,args.output,args.dpi,args.view in {'pagexml','ocr-all'},args.view in {'line-ocr','ocr-all'})))
        return
    result=replay(args.replay) if args.replay else compare(worker.read_json(args.gold),worker.read_json(args.candidate))
    if args.output: worker.write_json(args.output,result)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
