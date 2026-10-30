"""Census structural-mark transcription, prepare bounded native probes, and summarize their evidence.

All real text, source identities and receipts stay in the ignored output directory. This script
aligns observations; parser decisions and structure scoring run in the owning Rust code.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import sys
import time
import unicodedata

from rapidfuzz.distance import Levenshtein
from rapidfuzz import fuzz

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "experiments/legal_pdf_corpus"))
import gold_store  # noqa: E402

DEFAULT_OUT = ROOT / "benchmarks/local-data/ocr-structure-attribution/latest"


def read(path):
    return json.loads(gzip.decompress(path.read_bytes()) if str(path).endswith('.gz') else path.read_bytes())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def folded(text):
    # Match the scorer's printed private-use bullets; keep every scalar offset unchanged.
    bullets = {'\uf0b7': '\u2022', '\uf0a7': '\u25aa', '\uf0d8': '\u27a2'}
    out = []
    for c in text:
        n = unicodedata.normalize('NFKC', bullets.get(c, c))
        out.append(' ' if c.isspace() else n if len(n) == 1 else c)
    return ''.join(out)


def observe(gold, actual, start, end):
    """Project a corrected scalar span through edits, retaining insertions at its boundaries.

    A replacement crossing the span boundary is unresolved: don't call neighbouring prose an
    incorrectly recognized label. Spacing is reported separately from visible glyph changes.
    """
    if not 0 <= start < end <= len(gold):
        raise ValueError('Invalid gold scalar span')
    g, a = folded(gold), folded(actual)
    parts, uncertain = [], False
    for tag, x, y, u, v in Levenshtein.opcodes(g, a):
        if tag == 'insert':
            if start <= x <= end:
                parts.append(a[u:v])
        elif x < end and start < y:
            lo, hi = max(x, start), min(y, end)
            if tag == 'equal':
                parts.append(a[u + lo - x:u + hi - x])
            elif tag == 'replace':
                if x < start or y > end:
                    uncertain = True
                parts.append(a[u:v])
    wanted, found = g[start:end], ''.join(parts)
    visible = lambda t: ''.join(t.split())
    payload = lambda t: ''.join(c for c in t if c.isalnum())
    if uncertain:
        status = 'unresolved'
    elif wanted.strip() == found.strip():
        status = 'intact'
    elif visible(wanted) == visible(found):
        status = 'spacing'
    elif not visible(found):
        status = 'missing'
    elif payload(wanted) != payload(found):
        status = 'value'
    else:
        status = 'delimiter_or_symbol'
    return {'status': status, 'observed': found}


def marks(gold):
    lines = {l['id']: l for l in gold['lines']}
    seen = set()
    for typed in gold['typed']:
        groups = [('marker_' + typed['region'], spans) for spans in typed['markers']]
        groups += [('reference', r['spans']) for r in typed['references']]
        groups += [('transcript_line', [s]) for s in typed.get('line_number', [])]
        for kind, spans in groups:
            key = (kind, tuple((s['line_id'], s['start'], s['end']) for s in spans))
            if key in seen:
                continue
            seen.add(key)
            pieces, statuses, labels = [], [], []
            for s in spans:
                line = lines[s['line_id']]
                corrected = line.get('corrected', line['text'])
                observed = observe(corrected, line['text'], s['start'], s['end'])
                statuses.append(observed['status']); labels.append(corrected[s['start']:s['end']])
                pieces.append({**s, 'page': line['page'], 'bbox': line['bbox'], 'raw': line['text'],
                               'corrected': corrected, **observed})
            if not pieces:
                continue
            status = next((s for s in ['unresolved', 'value', 'missing', 'delimiter_or_symbol', 'spacing'] if s in statuses), 'intact')
            yield {'kind': kind, 'label': ''.join(labels), 'status': status, 'pieces': pieces}


def sources():
    """The gold store's current golds of train and development sources (gold_store.py)."""
    for sha, path in gold_store.sources(gold_store.STRUCTURE):
        split = gold_store.source(sha).get('partition')
        if split not in ('train', 'development'):
            continue
        receipt = read(path.with_name('receipt.json'))
        if receipt['status'] != 'complete':
            continue
        gold = read(path)
        if gold['schema_version'] != 'legal-structure-gold.v4' or gold['source_sha256'] != sha:
            raise ValueError('Unexpected gold schema or source binding')
        if 'text_edits' in gold:
            raise ValueError('This experiment requires the current per-line corrected gold')
        if digest(path) != receipt['gold_sha256']:
            raise ValueError(f'Gold/receipt hash mismatch: {sha}')
        yield {'sha256': sha, 'mode': receipt['mode'], 'split': split, 'path': str(gold_store.pdf(sha)),
               'run': path.parent.name, 'gold': str(path), 'gold_sha256': receipt['gold_sha256']}, gold


def prepare(args):
    out = args.out; out.mkdir(parents=True, exist_ok=True)
    totals, groups, documents = Counter(), defaultdict(Counter), []
    candidates = []
    with gzip.open(out / 'gold-marks.jsonl.gz', 'wt', encoding='utf-8') as sink:
        for row, gold in sources():
            rows = list(marks(gold)); page_marks = defaultdict(list)
            totals['documents'] += 1; totals['lines'] += len(gold['lines']); totals['pages'] += gold['page_count']
            report = gold.get('report', {})
            for key in ['unanchored_lines', 'unplaced_markers', 'unplaced_references']:
                totals[key] += len(report.get(key, []))
            for mark in rows:
                sink.write(json.dumps({'sha256': row['sha256'], 'mode': row['mode'], 'split': row['split'], **mark}, ensure_ascii=False) + '\n')
                groups[(row['mode'], mark['kind'])][mark['status']] += 1
                page_marks[mark['pieces'][0]['page']].append(mark)
            documents.append({**row, 'marks': len(rows), 'report': {k: len(v) for k, v in report.items() if isinstance(v, list)}})
            if row['mode'] != 'ocr' or gold['page_count'] > args.max_document_pages:
                continue
            pdf = Path(row['path'])
            if not pdf.is_file():
                totals['probe_source_missing'] += 1; continue
            # Deliberately diagnostic: references first, then marker errors, with intact controls
            # on the same pages. This is not an unbiased accuracy sample or an untouched test.
            ranked = sorted(page_marks, key=lambda p: (-sum(m['kind'] == 'reference' for m in page_marks[p]),
                -sum(m['status'] not in ('intact', 'spacing') for m in page_marks[p]), -len(page_marks[p]), p))
            if not ranked: continue
            counts = Counter(m['kind'] for m in rows if m['status'] not in ('intact', 'spacing', 'unresolved'))
            candidates.append((counts, {**row, 'pdf': str(pdf)}, page_marks, ranked))
        jobs = []
        used = set()
        focuses = ['reference', 'reference', 'marker_text', 'marker_list_item', 'marker_provision', 'marker_quote']
        for focus in focuses[:args.documents]:
            available = [c for c in candidates if c[1]['sha256'] not in used]
            if not available: break
            counts, row, page_marks, ranked = min(available, key=lambda c: (-c[0][focus], -sum(c[0].values()), c[1]['sha256']))
            used.add(row['sha256'])
            ranks = {page: n for n, page in enumerate(ranked)}
            ranked = sorted(ranked, key=lambda p: (-sum(m['kind']==focus and m['status'] not in ('intact','spacing','unresolved') for m in page_marks[p]),
                                                     -sum(m['kind']==focus for m in page_marks[p]), ranks[p]))
            jobs.append({**row, 'focus': focus, 'pages': sorted(ranked[:args.pages_per_document])})
        for row in jobs:
            if digest(Path(row['pdf'])) != row['sha256']: raise ValueError('Canonical PDF hash mismatch')
    write(out / 'census.json', {'schema': 'ocr-attribution.census.v1', 'totals': totals,
        'groups': [{'mode': mode, 'kind': kind, **count} for (mode, kind), count in sorted(groups.items())],
        'documents': documents, 'script_sha256': digest(Path(__file__)),
        'limits': ['Mode is an authoring label, not evidence Indra read a line.',
                   'Unanchored printed lines have no mark positions and are not in anchored-span denominators.',
                   'One run per source: its current gold in the gold store (run a); train/development only.']})
    write(out / 'jobs.json', {'schema': 'ocr-attribution.jobs.v1', 'documents': jobs,
        'selection': 'Exploratory: two reference-rich sources, then sources for text/list/provision/quote markers; errors first, bounded pages per source.'})
    print(json.dumps({'census': dict(totals), 'probe_documents': len(jobs), 'probe_pages': sum(len(r['pages']) for r in jobs)}))


def intersects(a, b):
    vertical = min(a[3], b[3]) - max(a[1], b[1])
    return vertical >= 0.35 * min(a[3] - a[1], b[3] - b[1]) and min(a[2], b[2]) > max(a[0], b[0])


def text_near(piece, trace, kept=True, beam=False):
    if trace['turns']:
        return None
    sx, sy = trace['points_per_pixel']; a = piece['bbox']
    # Padding can overlap the preceding printed row. Associate by frozen detector cores,
    # before looking at either arm's text; otherwise neighbouring prose becomes label edits.
    cores = {}
    for b in trace['core_boxes']:
        padded = (max(0,b[0]-10),max(0,b[1]-6),min(trace['width'],b[2]+11),min(trace['height'],b[3]+7))
        cores.setdefault(padded, []).append(b)
    ranked = []
    for line in trace['lines']:
        boxes = cores.get(tuple(line['bbox']), [])
        if len(boxes) != 1 or min(a[2],line['bbox'][2]*sx) <= max(a[0],line['bbox'][0]*sx): continue
        b = boxes[0]; overlap = min(a[3],b[3]*sy)-max(a[1],b[1]*sy)
        if overlap >= .35*min(a[3]-a[1],(b[3]-b[1])*sy): ranked.append((overlap,line,b))
    if not ranked: return None
    maximum = max(r[0] for r in ranked)
    winners = [(line,b) for overlap,line,b in ranked if abs(overlap-maximum)<1e-6]
    if any(min(a[3],b[3]) <= max(a[1],b[1]) for _,a in winners for _,b in winners): return None
    candidates = [line for line,_ in winners if not kept or line['kept']]
    if not candidates: return None
    candidates.sort(key=lambda l:l['bbox'][0])
    if beam:
        if any(not l.get('reading', {}).get('beam') for l in candidates): return None
        return ' '.join(l['reading']['beam'][0]['text'] for l in candidates)
    return ' '.join(l['text'] for l in candidates)


def measure_detail(piece, text):
    if text is None: return {'status':'unobserved'}
    gold = piece['corrected']
    # The authoring extractor can split one printed row into several source lines. Align a
    # contextual fragment inside the current complete row, without trimming an added digit.
    if len(text) > len(gold) * 1.3 + 8:
        if sum(c.isalpha() for c in gold) < 6: return {'status':'unaligned'}
        match = fuzz.partial_ratio_alignment(folded(gold), folded(text), score_cutoff=70)
        if match is None: return {'status':'unaligned'}
        start, end = match.dest_start, match.dest_end
        while start > 0 and text[start-1].isdigit() and start < len(text) and text[start].isdigit(): start -= 1
        while end < len(text) and end > 0 and text[end-1].isdigit() and text[end].isdigit(): end += 1
        text = text[start:end]
    # A source box can include a neighbouring line: those readings are not label evidence.
    g, a = ''.join(folded(gold).split()), ''.join(folded(text).split())
    if not g or Levenshtein.distance(g, a) / max(len(g), len(a)) > 0.5:
        return {'status':'unaligned'}
    return observe(piece['corrected'], text, piece['start'], piece['end'])


def measure(piece, text):
    return measure_detail(piece, text)['status']


def report(args):
    jobs = read(args.out / 'jobs.json')['documents']; rows = []
    run_identity = read(args.out / 'run.json')
    if run_identity['jobs_sha256'] != digest(args.out/'jobs.json'): raise ValueError('Jobs changed after the native run')
    by_kind = defaultdict(lambda: defaultdict(Counter)); route = Counter(); pooled = defaultdict(lambda: defaultdict(Counter))
    complete = []; missing = []; parity = Counter(); interventions = defaultdict(Counter)
    for job in jobs:
        directory = args.out / 'native' / job['sha256']
        if not (directory / 'receipt.json').is_file(): missing.append(job['sha256']); continue
        receipt = read(directory / 'receipt.json')
        if receipt.get('run_identity') != run_identity:
            missing.append(job['sha256']); continue
        if receipt['gold_sha256'] != job['gold_sha256']: raise ValueError('Probe belongs to a different gold revision')
        complete.append(job['sha256']); gold = read(Path(job['gold'])); extraction = read(directory / 'extraction.json.gz')
        pages = {p['number']: p for p in extraction['pages']}
        structures = read(directory / 'structure.json')
        for arm, result in structures.items():
            for layer, metric in result['metrics'].items():
                pooled[arm][layer].update(metric)
            for key in ['eligible_corrected_lines','matched_corrected_lines','applied_edits']:
                interventions[arm][key] += result.get('intervention',{}).get(key,0)
        traces = {(p, dpi): read(directory / f'page-{p}-{dpi}/trace.json') for p in job['pages'] for dpi in [144, 288]}
        for trace in traces.values():
            parity.update('agree' if l['greedy_parity'] else 'disagree' for l in trace['lines'] if 'greedy_parity' in l)
        for mark in marks(gold):
            if len(mark['pieces']) != 1 or mark['pieces'][0]['page'] not in job['pages']: continue
            piece = mark['pieces'][0]; page = piece['page']; t = traces[page,144]; high = traces[page,288]
            native = [l for l in pages[page]['lines'] if intersects(piece['bbox'], l['bbox'])]
            native.sort(key=lambda l:l['bbox'][0]); native_text = ' '.join(l['text'] for l in native) if native else None
            source = 'unobserved' if not native else 'indra' if all(l['source']=='ocr' for l in native) else 'embedded_ocr' if any(any(s.get('flags',0)&32 for s in l['spans']) for l in native) else 'native_or_mixed'
            route[source] += 1
            crops = {c['variant']: c for c in t['crops'] if c['id'] == piece['line_id']}
            arms = {'current_extraction': measure(piece,native_text), 'indra_144': measure(piece,text_near(piece,t)),
                    'before_acceptance': measure(piece,text_near(piece,t,kept=False)), 'beam_top1': measure(piece,text_near(piece,t,beam=True)),
                    'indra_288': measure(piece,text_near(piece,high)),
                    **{name:measure(piece,crops.get(name,{}).get('text')) for name in ['authoring_box','expanded_box']}}
            for arm, status in arms.items(): by_kind[mark['kind']][arm][status] += 1
            good = lambda s:s == 'intact'
            evidence = []
            if not good(arms['indra_144']):
                if good(arms['before_acceptance']): evidence.append('acceptance_filter')
                if good(arms['beam_top1']): evidence.append('decoder_sensitive')
                if good(arms['indra_288']): evidence.append('resolution_sensitive')
                if good(arms['authoring_box']) or good(arms['expanded_box']): evidence.append('crop_or_segmentation_sensitive')
                if not evidence: evidence.append('unresolved')
            if source=='embedded_ocr' and not good(arms['current_extraction']) and good(arms['indra_144']): evidence.append('rerouting_sensitive')
            rows.append({'sha256':job['sha256'],'page':page,'line_id':piece['line_id'],'kind':mark['kind'],
                         'label':mark['label'],'route':source,'arms':arms,'evidence':evidence})
    metrics = {arm:{layer:{**counts,'f1':2*counts['correct']/max(1,counts['expected']+counts['predicted'])} for layer,counts in layers.items()} for arm,layers in pooled.items()}
    comparisons = {}
    for arm in ['current_extraction','beam_top1','indra_288','authoring_box','expanded_box']:
        counts = Counter()
        for row in rows:
            baseline, candidate = row['arms']['indra_144'], row['arms'][arm]
            if baseline in ('unobserved','unaligned','unresolved') or candidate in ('unobserved','unaligned','unresolved'):
                counts['unresolved_or_unobserved'] += 1; continue
            counts['comparable'] += 1
            before, after = baseline == 'intact', candidate == 'intact'
            counts['baseline_intact'] += before; counts['candidate_intact'] += after
            counts['rescued'] += not before and after; counts['regressed'] += before and not after
        comparisons[arm] = counts
    result = {'schema':'ocr-attribution.report.v1','completed_documents':complete,'missing_documents':missing,
              'routes':route,'greedy_tensor_parity':parity,'groups':{k:{a:dict(c) for a,c in v.items()} for k,v in by_kind.items()},
              'evidence':dict(Counter(e for r in rows for e in r['evidence'])),'structure':metrics,
              'intervention_coverage':interventions,'comparisons_to_indra_144':comparisons,'marks':rows,
              'limits':['Exploratory selected sample, not held-out accuracy.', 'Sensitivity categories overlap; they are not exclusive root causes.',
                        'Authoring boxes are inherited extraction geometry, not independently verified glyph boxes.',
                        'No proposal around a gold line does not establish which glyph was missed.',
                        'Text oracles apply only to unique exact raw-line matches; inserted glyph geometry is not known.',
                        'Resolution/crop/beam probes score mark transcription; only text-oracle arms are replayed through structure.']}
    write(args.out / 'report.json',result)
    print(json.dumps({k:result[k] for k in ['completed_documents','missing_documents','routes','greedy_tensor_parity','evidence']},ensure_ascii=True))


def corpus(args):
    """Analyze every saved mark without rendering PDFs, running OCR or invoking Rust."""
    started = time.perf_counter()
    census = read(args.out / 'census.json')
    groups, shapes, confusions = defaultdict(Counter), defaultdict(Counter), defaultdict(Counter)
    affected, mark_lines = defaultdict(set), defaultdict(set)
    with gzip.open(args.out / 'gold-marks.jsonl.gz', 'rt', encoding='utf-8') as source:
        for raw in source:
            mark = json.loads(raw); key = (mark['mode'], mark['kind'])
            groups[key][mark['status']] += 1
            payload = ''.join(c for c in folded(mark['label']) if c.isalnum())
            shape = ('symbol' if not payload else 'numeric' if payload.isdecimal() else
                     'roman_like' if all(c in 'ivxlcdmIVXLCDM' for c in payload) else
                     'alphabetic' if payload.isalpha() else 'mixed')
            shapes[(*key, shape)][mark['status']] += 1
            for piece in mark['pieces']:
                line = (mark['sha256'], piece['line_id']); mark_lines[key].add(line)
                if piece['status'] not in ('intact', 'spacing', 'unresolved'):
                    affected[key].add(line)
                if piece['status'] in ('intact', 'unresolved'): continue
                wanted = folded(piece['corrected'][piece['start']:piece['end']]).strip()
                actual = folded(piece['observed']).strip()
                for tag, x, y, u, v in Levenshtein.opcodes(wanted, actual):
                    left, right = wanted[x:y], actual[u:v]
                    if tag == 'replace' and len(left) == len(right):
                        confusions[key].update(zip(left, right))
                    elif tag == 'delete': confusions[key].update((c, '') for c in left)
                    elif tag == 'insert': confusions[key].update(('', c) for c in right)
                    elif tag != 'equal' and len(left) <= 3 and len(right) <= 3:
                        confusions[key][(left, right)] += 1
    expected = {(g['mode'], g['kind']): Counter({k:v for k,v in g.items() if k not in ('mode','kind')})
                for g in census['groups']}
    if dict(groups) != expected: raise ValueError('Saved marks do not reproduce the census counts')
    result = {'schema':'ocr-attribution.corpus-report.v1', **census['totals'],
              'anchored_marks':sum(sum(c.values()) for c in groups.values()),
              'inputs':{name:digest(args.out/name) for name in ['census.json','gold-marks.jsonl.gz']},
              'script_sha256':digest(Path(__file__)), 'groups':[], 'shapes':[],
              'limits':['Authoring OCR mode does not identify the recognizer responsible for each glyph.',
                        'Text differences do not establish detector or crop causes.',
                        'Unanchored lines and unplaced marks remain outside anchored-span denominators.']}
    for key, counts in sorted(groups.items()):
        result['groups'].append({'mode':key[0], 'kind':key[1], **counts,
            'unique_mark_lines':len(mark_lines[key]), 'unique_error_lines':len(affected[key]),
            'glyph_operations':[{'printed':a, 'extracted':b, 'count':n}
                                for (a,b),n in confusions[key].most_common(16)]})
    for (mode,kind,shape), counts in sorted(shapes.items()):
        result['shapes'].append({'mode':mode, 'kind':kind, 'shape':shape, **counts})
    result['seconds'] = time.perf_counter() - started
    write(args.out/'corpus-report.json', result)
    print(json.dumps({k:result[k] for k in ['documents','pages','lines','anchored_marks','seconds']}))


def main():
    parser=argparse.ArgumentParser(__doc__)
    parser.add_argument('command',choices=['prepare','corpus','report'])
    parser.add_argument('--out',type=Path,default=DEFAULT_OUT);parser.add_argument('--documents',type=int,default=6)
    parser.add_argument('--pages-per-document',type=int,default=2);parser.add_argument('--max-document-pages',type=int,default=30)
    args=parser.parse_args()
    if args.documents<1 or args.pages_per_document<1:parser.error('Positive document and page limits required')
    {'prepare':prepare, 'corpus':corpus, 'report':report}[args.command](args)


if __name__=='__main__':main()
