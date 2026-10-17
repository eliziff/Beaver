"""Score a parser export against its v4 structure gold, or validate a saved record publication."""
import argparse
from collections import Counter, defaultdict
import difflib
import json
from pathlib import Path
import worker
import gold
import package
from gold import require

V4 = 'legal-structure-gold.v4'
# The scorer's roles for typed regions the composition has no primary role for: block quotes are
# running text, notes and tables are text inside their annotations, list items are text with a
# list_item locator. Contents keep their own role.
KINDS = {'heading': 'heading', 'caption': 'caption', 'headnote': 'headnote', 'marginal_note': 'marginal_note',
         'furniture': 'furniture', 'page_label': 'page_label', 'contents': 'contents'}
OWN = {'furniture', 'page_label'}


def projected(value):
    """A v4 gold in the scorer's frame: its lines, one block per unit fragment (a unit's lines on
    one page, unbroken), parents, markers, continuations, notes paired with their references,
    tables and document starts.

    v4 lines carry no geometry: their reading position stands for it when sources are aligned."""
    require(value.get('schema_version') == V4, 'Expected a legal-structure-gold.v4 file')
    lines = {line['id']: {'id': line['id'], 'page': line['page'], 'text': line.get('corrected', line['text']),
                          'original_text': line['text'], 'source_id': line['id'], 'source_range': [0, len(line['text'])],
                          'box': [0, n, 0, n]} for n, line in enumerate(value['lines'])}
    order = list(lines)
    position = {ident: n for n, ident in enumerate(order)}
    at = lambda span: (position[span['line_id']], span['start'])
    anchor = lambda spans: gold.span_anchor(spans[0])
    ids = lambda spans: list(dict.fromkeys(s['line_id'] for s in spans))
    typed, units = value['typed'], value['units']

    def fragments(members):
        """A unit's spans, split at each page and at each line another unit interrupts."""
        result, previous = [], None
        for n in members:
            for k, span in enumerate(typed[n]['spans']):
                if not result or lines[result[-1][-1]['line_id']]['page'] != lines[span['line_id']]['page']                         or k == 0 and n != previous + 1:
                    result.append([])
                result[-1].append(span)
            previous = n
        return [sorted(spans, key=at) for spans in result]

    parts = [fragments(unit['lines']) for unit in units]
    region = [typed[unit['lines'][0]]['region'] for unit in units]
    heads = [anchor(found[0]) if found else None for found in parts]
    groups, annotations, continuations = [], [], defaultdict(dict)
    notes = {}
    for u, unit in enumerate(units):
        first = typed[unit['lines'][0]]
        marker = [s for spans in first['markers'] for s in spans]
        parent = heads[unit['parent']] if unit['parent'] is not None else None
        for k, spans in enumerate(parts[u]):
            attributes = {'parent': parent, 'reading_stream_id': None}
            if region[u] == 'list_item': attributes.update(locator_kind='list_item', marker=marker if k == 0 else [])
            elif k == 0 and marker and region[u] in ('text', 'quote'): attributes.update(locator_kind='paragraph', marker=marker)
            elif k == 0 and marker and region[u] == 'heading': attributes['marker'] = marker
            groups.append({'kind': KINDS.get(region[u], 'text'), 'line_ids': ids(spans), 'spans': spans, 'attributes': attributes})
            if region[u] == 'note':
                annotations.append({'id': 'note:' + anchor(spans), 'kind': 'note', 'line_ids': ids(spans), 'spans': spans, 'attributes': {
                    'kind': 'footnote', 'label': first['markers'][0] if k == 0 and first['markers'] else [], 'references': []}})
                if k == 0: notes[u] = annotations[-1]
        if region[u] in OWN: continue
        kind = 'heading' if region[u] == 'heading' else 'note' if region[u] == 'note' else 'paragraph'
        for left, right in zip(parts[u], parts[u][1:]):
            continuations[kind][anchor(left)] = {'next': anchor(right), 'separator': ' ', 'kind': kind}
            if region[u] == 'list_item':
                continuations['list'][anchor(left)] = {'next': anchor(right), 'separator': None, 'kind': 'list'}
    # Documents: the first block opens the source's own; each unit holding a document start opens
    # another under it.
    opened = [u for u, unit in enumerate(units) if parts[u] and any(typed[n]['document'] for n in unit['lines'])]
    start = min((found[0][0] for found in parts if found), key=at, default=None)
    if opened and start is not None:
        root = 'document:' + gold.span_anchor(start)
        for opening in [start] + [parts[u][0][0] for u in opened if parts[u][0][0] != start]:
            annotations.append({'id': 'document:' + gold.span_anchor(opening), 'kind': 'document',
                                'line_ids': [opening['line_id']], 'spans': [opening],
                                'attributes': {'kind': None, 'parent': None if opening == start else root,
                                               'relationship': None, 'title': [], 'facets': {}}})
    # Each note reference with the note the notes pass paired it with.
    for pair in value['notes']:
        if pair['note'] is None or pair['reference'] is None: continue
        notes[pair['note']]['attributes']['references'].extend(typed[pair['line']]['references'][pair['reference']]['spans'])
    # Tables: consecutive table rows, with only furniture, page labels and notes between, form one
    # table, one annotation per page linked across pages; a row is on the page of its first cell.
    tables, current = [], None
    for u in range(len(units)):
        if region[u] == 'table' and parts[u]:
            if current is None: current = []; tables.append(current)
            current.append(u)
        elif region[u] not in OWN | {'note'}: current = None
    for rows in tables:
        pages = {}
        for u in rows:
            cells = defaultdict(list)
            for n in units[u]['lines']:
                for c, spans in enumerate(typed[n].get('cells', [])): cells[c].extend(spans)
            row = [cells[c] for c in range(max(cells, default=-1) + 1)]
            found = [s for cell in row for s in cell]
            if found: pages.setdefault(lines[min(found, key=at)['line_id']]['page'], []).append(row)
        if not pages: continue
        width = max(len(row) for grid in pages.values() for row in grid)
        chain = []
        for grid in pages.values():
            grid = [row + [[] for _ in range(width - len(row))] for row in grid]
            populated = [s for row in grid for cell in row for s in cell]
            annotations.append({'id': 'table:' + anchor(populated), 'kind': 'table', 'line_ids': ids(populated), 'spans': populated,
                                'attributes': {'rows': grid, 'header_rows': [], 'merges': []}})
            chain.append(anchor(populated))
        for left, right in zip(chain, chain[1:]):
            continuations['table'][left] = {'next': right, 'separator': None, 'kind': 'table'}
    return {'source_sha256': value['source_sha256']}, {
        'lines': list(lines.values()), 'reading_order': order, 'groups': groups, 'annotations': annotations,
        'joins': {}, 'continuations': dict(continuations), 'resumes': {}, 'manuscript_edits': {}}


def state_of(value):
    """The scorer's frame of a v4 gold or of a parser export."""
    if value.get('schema_version') == V4: return projected(value)
    extraction = value.get('extraction', {}).get('pages', [])
    value = value.get('document', value.get('baseline', value))
    structure = value.get('structure_graph', value.get('structure', value))
    lines = gold.source_lines(structure)
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
        if group['kind'] not in ('prose', 'text') or 'native_id' in group['attributes']: continue
        if any(i in folios for i in group['line_ids']): group['kind'] = 'page_label'
        elif group['line_ids'] and all(i in bands for i in group['line_ids']):
            middle = sum(bands[i] for i in group['line_ids']) / len(group['line_ids'])
            if middle < 0.15 or middle > 0.85: group['kind'] = 'furniture'
    # Native products can carry source-anchored annotations too.
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


# The eight primary roles: older exports' names for the same roles.
ROLE_ALIASES = {'prose': 'text', 'header': 'furniture', 'footer': 'furniture'}
# Roles outside the outline: the hierarchy gold gives them no parent.
UNRANKED_ROLES = {'furniture', 'page_label', 'marginal_note', 'contents'}


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
    require(expected.get('schema_version') == V4, 'Expected a legal-structure-gold.v4 file')
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
    opcodes = {}
    def surface(line, at, right=False):
        # Project a corrected offset back to the unchanged extraction surface.
        lo,hi = line['source_range'] or (0,len(line['text']))
        old = line['original_text'][lo:hi] if line['source_id'] else line['text']
        key = (id(line), old, line['text'])
        if key not in opcodes:
            opcodes[key] = difflib.SequenceMatcher(None,old,line['text'],autojunk=False).get_opcodes()
        for _,a,b,x,y in opcodes[key]:
            if x <= at < y: return lo + a + (at-x if b-a == y-x else b-a if right else 0)
        return lo + len(old)
    def members(group, lines):
        # A block is its exact source spans; several blocks may share one physical line.
        return group.get('spans') or gold.whole(group['line_ids'], lines)
    cuts = defaultdict(set)
    for state,candidate_side in ((reference,False),(predicted,True)):
        lines = {l['id']:l for l in state['lines']}
        for line in state['lines']:
            start,end = line['source_range'] or (0,len(line['text']))
            for ident,a,b in project(line,start,end,candidate_side): cuts[ident].update((a,b))
        for group in state['groups']:
            for s in members(group, lines):
                line = lines[s['line_id']]
                for ident,a,b in project(line,surface(line,s['start']),surface(line,s['end'],True),candidate_side):
                    cuts[ident].update((a,b))
    def features(state, candidate_side):
        lines = {l['id']:l for l in state['lines']}
        if not any(a['kind']=='document' for a in state['annotations']) and state['reading_order']:
            # A source without declared documents is one document, as its projection states.
            first=state['reading_order'][0]
            state={**state,'annotations':state['annotations']+[{'id':'source','kind':'document','line_ids':[first],
                'spans':[{'line_id':first,'start':0,'end':len(lines[first]['text'])}],
                'attributes':{'kind':None,'parent':None,'relationship':None,'title':[],'facets':{}}}]}
        def span(s):
            line = lines[s['line_id']]
            return project(line,surface(line,s['start']),surface(line,s['end'],True),candidate_side)
        def spans(values): return merged_spans(part for s in values for part in span(s))
        def span_pieces(s):
            result=[]
            for key,a,b in span(s):
                boundaries=sorted(c for c in cuts[key] if a <= c <= b)
                result.extend((key,x,y) for x,y in zip(boundaries,boundaries[1:]))
            return result
        def anchor(i):
            # A line ID or an exact source-span anchor (line@offset).
            if i is None: return None
            ident,offset = (i,0) if i in lines else (i.rsplit('@',1)[0],int(i.rsplit('@',1)[1]))
            line=lines[ident]; start=surface(line,offset)
            origin,at,_=project(line,start,start,candidate_side)[0]
            return (origin,at)
        # The package's own document is the root, whichever line it opens on.
        roots={a['line_ids'][0] for a in state['annotations'] if a['kind']=='document' and a['attributes'].get('parent') is None}
        # A document parent may name the parent's declaration rather than its opening.
        openings={a['id']:a['line_ids'][0] for a in state['annotations'] if a['kind']=='document'}
        def document(i):
            i=openings.get(i,i)
            return ('root',) if i in roots else anchor(i)
        def pieces(i):
            line=lines[i]; start,end=line['source_range'] or (0,len(line['text']))
            result=[]
            for key,a,b in project(line,start,end,candidate_side):
                boundaries=sorted(c for c in cuts[key] if a <= c <= b)
                result.extend((key,x,y) for x,y in zip(boundaries,boundaries[1:]))
            return result
        sequence=[p for i in state['reading_order'] for p in pieces(i)]
        result={'coverage':sequence, 'order':list(zip(sequence,sequence[1:])), 'roles':[], 'groups':[], 'joins':[], 'hierarchy':[],
                'hierarchy_units':[], 'hierarchy_roles':[], 'hierarchy_relation':[], 'hierarchy_parent':[], 'hierarchy_marker':[],
                **{k:[] for k in ('table','note','document','table_cells','note_references','continuations','document_ownership')}}
        # Blocks are identified by their first source span (line@start), never by a line.
        groups={gold.block_id(g):g for g in state['groups']}
        text_links=gold.text_links(state)
        incoming={l['next'] for l in text_links.values()}
        notes=[s for a in state['annotations'] if a['kind']=='note' for s in members(a,lines)]
        tables=[s for a in state['annotations'] if a['kind']=='table' for s in members(a,lines)]
        def inside(block, extents):
            first=members(block,lines)[0]
            return any(first['line_id']==s['line_id'] and s['start']<=first['start']<s['end'] for s in extents)
        def role(block):
            kind=ROLE_ALIASES.get(block['kind'],block['kind'])
            if inside(block,tables): return 'table'
            if kind=='text' and block['attributes'].get('locator_kind')=='list_item': return 'list_item'
            return kind
        # Hierarchy rows, as the hierarchy gold has them: one per logical block outside furniture,
        # page labels, marginal notes and notes, a continued fragment counted with its first part.
        position={i:n for n,i in enumerate(state['reading_order'])}
        def order(ident):
            line,_,at=ident.partition('@')
            return (position.get(line,len(position)), int(at or 0))
        units=sorted((first for first,g in groups.items() if first not in incoming
                      and role(g) not in UNRANKED_ROLES and not inside(g,notes)), key=order)
        parent_of={first: groups[first]['attributes'].get('parent') for first in units}
        # A unit's structure is scored relative to the unit before it in reading order (its child,
        # its sibling, a sibling of its k-th ancestor), never by absolute depth: one wrong parent
        # higher up costs that unit, not every unit under it.
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
        for first,g in groups.items():
            result['roles'].extend((p,ROLE_ALIASES.get(g['kind'],g['kind'])) for s in members(g,lines) for p in span_pieces(s))
            if first not in incoming:
                parts=list(members(g,lines)); cursor=first; visited={first}
                while cursor in text_links:
                    cursor=text_links[cursor]['next']
                    if cursor in visited or cursor not in groups: break
                    visited.add(cursor); parts.extend(members(groups[cursor],lines))
                pieces_now=[p for s in parts for p in span_pieces(s)]
                result['groups'].append(tuple(pieces_now))
                # Adjacent pieces of one logical block; v4 records no separators between them.
                result['joins'].extend(zip(pieces_now,pieces_now[1:]))
        for first in units:
            attrs=groups[first]['attributes']; unit=anchor(first); kind=role(groups[first])
            result['hierarchy'].append((unit,kind,relation[first],anchor(parent_of[first]),spans(attrs.get('marker',[]))))
            # The same units scored field by field, so a unit found with its role but another
            # relation or parent still counts for what it gets right. Missing and spurious units
            # count against the parent links as well as the units.
            result['hierarchy_units'].append(unit)
            result['hierarchy_roles'].append((unit,kind))
            result['hierarchy_relation'].append((unit,relation[first]))
            result['hierarchy_parent'].append((unit,anchor(parent_of[first])))
            if attrs.get('marker'): result['hierarchy_marker'].append((unit,spans(attrs['marker'])))
        for a in gold.logical_annotations(state):
            kind=a['kind']; attrs=a['attributes']; extent=spans(a.get('spans',gold.whole(a['line_ids'],lines)))
            if kind not in result: continue
            if kind=='table':
                result[kind].append((extent,len(attrs['rows']),len(attrs['rows'][0])))
                result['table_cells'].extend((anchor(a['line_ids'][0]),r,c,None if cell is None else spans(cell)) for r,row in enumerate(attrs['rows']) for c,cell in enumerate(row))
            elif kind=='note':
                result[kind].append((extent,spans(attrs.get('label',[]))))
                result['note_references'].extend((extent,spans([s])) for s in attrs.get('references',[]))
            elif kind=='document': result[kind].append(document(a['line_ids'][0]))
        if any(a['kind']=='document' for a in state['annotations']):
            try:
                # Text before the first declared document is the source's own: the root's.
                owners,docs=gold.ownership(state); starts={'source':('root',),**{a['id']:document(a['line_ids'][0]) for a in docs}}
                # Blocks are identified by their first source span; a line takes its first block's owner.
                by_line={}
                for g in state['groups']:
                    parts=members(g,lines)
                    owner=owners.get(gold.span_anchor(parts[0]),owners.get(parts[0]['line_id']))
                    for member in parts: by_line.setdefault(member['line_id'],owner)
                result['document_ownership']=[(p,starts[by_line[i]]) for i in state['reading_order'] if i in by_line for p in pieces(i)]
            except (ValueError, KeyError):
                # A candidate whose headings name a parent no group opens is an invalid hierarchy too.
                result['document_ownership']=[(p,'invalid_hierarchy') for i in state['reading_order'] for p in pieces(i)]
        result['continuations']=[(anchor(i),anchor(l['next']),l['kind']) for i,l in gold.continuations(state)]
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


def replay(job):
    """Validate a saved record publication: its receipt, gold and current annotation stages."""
    worker.recover_update(job)
    receipt = worker.read_json(job / 'receipt.json')
    require(receipt['status'] == 'complete', 'Replay requires a completed run')
    require(worker.digest(job / 'gold.json.gz') == receipt['gold_sha256'], 'Gold artifact changed')
    value = worker.read_json(job / 'gold.json.gz')
    require(value.get('schema_version') == package.VERSION, 'Replay requires a canonical gold package')
    worker.verified_run(job)
    result = {'replay': 'current_facts_validated', 'run_id': receipt['run_id'], 'source_sha256': value['source_sha256'],
              'record_layers': len(value['records'])}
    if receipt.get('kind') == 'record_import': return result
    require(receipt.get('kind') == 'annotation_update', 'Replay validates record imports and annotation publications')
    package.validate(value)
    stages = value['provenance'].get('annotation_stages', {})
    current = {stage: worker.stage_current(job, value, stage) for stage in stages}
    require(any(current.values()), 'No annotation stage describes current gold')
    receipts = {stage: worker.read_json(job / marker['receipt']) for stage, marker in stages.items()}
    for stage, saved in receipts.items():
        require(worker.stage_binding(job, value, stage, saved) is not None, 'Annotation stage refers to different shared text')
        if not current[stage]:
            require(any(a[:len(b)] == b or b[:len(a)] == a
                        for other, active in current.items() if active
                        for a in saved['owned_paths'] for b in receipts[other]['owned_paths']),
                    'Changed annotations have no current owning stage')
    return {**result, 'annotation_stages': sorted(stages),
            'superseded_annotation_stages': sorted(stage for stage, active in current.items() if not active)}


def main():
    worker.low_priority()
    parser=argparse.ArgumentParser(description=__doc__)
    action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--replay',type=Path,help='A record publication to validate')
    action.add_argument('--gold',type=Path,help='A v4 gold file to score --candidate against')
    action.add_argument('--export',type=Path,help='A gold package to export --record-id from')
    parser.add_argument('--candidate',type=Path); parser.add_argument('--output',type=Path)
    parser.add_argument('--record-id')
    args=parser.parse_args()
    if args.gold and not args.candidate: parser.error('--gold requires --candidate')
    if args.export:
        if not (args.output and args.record_id): parser.error('--export requires --record-id and --output')
        value=worker.read_json(args.export)
        require(value.get('schema_version') == package.VERSION, 'Export requires a canonical gold package')
        args.output.parent.mkdir(parents=True,exist_ok=True)
        worker.write_json(args.output,worker.affidavit_record(value,args.record_id))
        return
    result=replay(args.replay) if args.replay else compare(worker.read_json(args.gold),worker.read_json(args.candidate))
    if args.output: worker.write_json(args.output,result)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
