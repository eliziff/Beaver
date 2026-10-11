"""Run native source-anchor candidates against their complete saved CourtListener HTML."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit

RUNNER = Path(__file__).resolve().parents[1] / 'text-fragment-fidelity/webdriver-marker-gate.py'
SPEC = importlib.util.spec_from_file_location('cached_fragment_runner', RUNNER)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
gate = runner.gate

STRUCTURE_GOLD = r"""
const selector = arguments[0] ? '*' : 'p,blockquote,h1,h2,h3,h4,h5,h6,heading,opinion,author,judges,attorneys,headnotes,table,tr,td,th,ul,ol,li,footnote,footnote_body,aside.footnote,div.footnote,section.footnote';
return [...document.querySelectorAll(arguments[2])].map((body, body_index) => {
  const root = body;
  const elements = arguments[1] || arguments[3] ? [root,...root.querySelectorAll(selector)] : [...body.querySelectorAll(selector)];
  const indexes = new Map(elements.map((e,i) => [e,i]));
  const ancestors = [];
  if (arguments[1]) for (let ancestor = body.parentElement; ancestor; ancestor = ancestor.parentElement) {
    ancestors.push({tag:ancestor.localName,attributes:Object.fromEntries([...ancestor.attributes].map(a => [a.name,a.value]))});
  }
  return {body_index, ancestors, elements:elements.map((e, source_index) => {
    let parent = e.parentElement;
    while (parent && !indexes.has(parent)) parent = parent.parentElement;
    return {source_index, parent_index:indexes.get(parent) ?? null, tag:e.localName,
      anchor:e.getAttribute('id'), namespace:e.namespaceURI, attributes:Object.fromEntries([...e.attributes].map(a => [a.name,a.value])),
      text_content:e.textContent, inner_text:e.innerText ?? null,
      visible:e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden',
      row_index:e.localName === 'tr' ? e.sectionRowIndex : null,
      column_span:e.localName === 'td' || e.localName === 'th' ? e.colSpan : null,
      row_span:e.localName === 'td' || e.localName === 'th' ? e.rowSpan : null};
  })};
});
"""

CHECK_TARGET = r"""
const input = arguments[0], done = arguments[arguments.length - 1];
const started = performance.now();
let previous = null, stable = 0, frames = 0;
function observe() {
  const wantedNow = document.getElementById(input.anchor), rectNow = wantedNow?.getBoundingClientRect();
  const position = [scrollX,scrollY,rectNow?.top,rectNow?.bottom,innerHeight];
  const tolerance = 0.5 / devicePixelRatio;
  const offscreen = rectNow && (rectNow.bottom < -tolerance || rectNow.top > innerHeight + tolerance);
  stable = previous && position.every((value,index) => value === previous[index]) ? stable + 1 : 0;
  previous = position; frames++;
  if ((stable < 4 || offscreen) && performance.now() - started < 5000) return requestAnimationFrame(observe);
  let state = window.__courtlistenerAnchorCorpus;
  if (!state) {
  const bodies = [...document.querySelectorAll('.subopinion-content')];
  const headings = [...document.querySelectorAll('h3.opinion-section-title[id]')]
    .filter(e => !e.closest('.subopinion-content'));
  const counts = new Map();
  for (const e of document.querySelectorAll('[id]')) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
    const headmatters = [...document.querySelectorAll('div#headmatter')];
    state = window.__courtlistenerAnchorCorpus = {bodies, headings, counts, headmatters};
  }
  const {bodies, headings, counts, headmatters} = state;
    const wanted = document.getElementById(input.anchor), target = document.querySelector(':target');
    const rect = wanted?.getBoundingClientRect(), style = wanted && getComputedStyle(wanted);
    let bodyIndex = wanted ? bodies.indexOf(wanted.closest('.subopinion-content')) : -1;
    if (input.kind === 'opinion_boundary') {
      bodyIndex = bodies.findIndex(body => headings.filter(h =>
        h.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) === wanted);
    }
    const headmatterIndex = wanted ? headmatters.indexOf(wanted.closest('div#headmatter')) : -1;
    const visible = !!wanted && wanted.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    const landed = !!rect && rect.bottom >= -tolerance && rect.top <= innerHeight + tolerance;
    const failures = [];
    if (!wanted || target !== wanted) failures.push('target-mismatch');
    if (counts.get(input.anchor) !== 1) failures.push('duplicate-or-missing-id');
    if (wanted?.localName !== input.source_tag) failures.push('tag-mismatch');
    if (input.source_region === 'headmatter') {
      if (headmatters.length !== 1 || input.body_index !== null || bodyIndex >= 0 || headmatterIndex !== input.source_region_index)
        failures.push('wrong-source-region');
    } else {
      if (input.source_region != null && input.source_region !== 'opinion') failures.push('wrong-source-region');
      if (bodyIndex < 0 || bodyIndex !== input.body_index) failures.push('wrong-opinion');
    }
    if (!visible) failures.push('not-visible');
    if (!landed) failures.push('offscreen');
    if (stable < 4) failures.push('scroll-not-settled');
    done({...input, verdict:failures.length ? 'rejected' : 'cached-anchor-exact', failures,
      actual_body_index:bodyIndex, actual_target_id:target?.id ?? null, visible, landed,
      actual_headmatter_root_count:headmatters.length,
      actual_headmatter_region_index:headmatterIndex < 0 ? null : headmatterIndex,
      actual_fragment:location.hash, landing_tolerance_css_pixels:tolerance,
      natural_scroll_settled:stable >= 4, scroll_frames:frames, scroll_wait_ms:performance.now()-started,
      geometry:rect ? {top:rect.top,bottom:rect.bottom,viewport_height:innerHeight,scroll_y:scrollY} : null});
}
requestAnimationFrame(observe);
"""

def live_publisher(args):
    import collect as host
    if args.workers != 1 or args.structure_gold or args.styles:
        raise ValueError('Live publisher navigation requires one worker and unmodified publisher styles')
    if not 1 <= args.limit_targets <= 50:
        raise ValueError('Live publisher navigation requires --limit-targets between 1 and 50')
    inputs_path = args.corpus_run/'publisher-live-inputs.jsonl'
    inputs = gate.read_jsonl(inputs_path)[:args.limit_targets]
    if not inputs:
        raise ValueError('Prepare source-bound publisher-live-inputs.jsonl before live navigation')
    native_rows = gate.read_jsonl(args.corpus_run/'anchor-targets.jsonl')
    emitted = {(row['url'],row['body_index'],json.dumps(target,sort_keys=True))
               for row in native_rows for target in row['targets']}
    manifest = {row['url']:row for row in gate.read_jsonl(args.corpus_run/'page-html-manifest.jsonl')}
    ledger_path = host.WORKSPACE/'benchmarks/local-data/courtlistener-ucd/captures.jsonl'
    saved_rows = {json.dumps(row,sort_keys=True) for row in gate.read_jsonl(ledger_path)}
    checked = set()
    for item in inputs:
        saved, target = item['before_capture'], item['target']
        if json.dumps(saved,sort_keys=True) not in saved_rows or saved['sampling']['url'] != saved['url']:
            raise ValueError('Live input is not a complete unchanged collector-owned capture')
        if (saved['url'],item['body_index'],json.dumps(target,sort_keys=True)) not in emitted:
            raise ValueError('Live target was not emitted by the retained native corpus run')
        entry = manifest[saved['url']]
        if entry['sha256'] != saved['sha256'] or host.runtime._split_url(target['target'])[0] != saved['url']:
            raise ValueError('Live input source or canonical URL differs from its native target')
        if args.kinds and target['kind'] not in args.kinds:
            raise ValueError('Prepared live inputs contain a kind excluded by --kinds')
        if saved['url'] not in checked:
            raw = Path(entry['path']).read_bytes()
            if hashlib.sha256(raw).hexdigest() != saved['sha256'] or len(raw) != saved['bytes']:
                raise ValueError('Original served source digest or length changed')
            evidence = host.WORKSPACE/'benchmarks/local-data/courtlistener-ucd'/saved['browser_evidence_path']
            if hashlib.sha256(evidence.read_bytes()).hexdigest() != saved['browser_evidence_sha256']:
                raise ValueError('Original collector DOM evidence digest changed')
            checked.add(saved['url'])
    out = args.corpus_run/'publisher-live'
    cache_dir = out/'browser-cache'
    if cache_dir.exists() and any(cache_dir.iterdir()):
        raise ValueError('Live publisher pilot requires a fresh owned browser cache; retained inputs are not deleted')
    out.mkdir(exist_ok=True)
    result_path = out/'publisher-anchor.jsonl'
    with host.writer():
        host.require_bytes(host.RECEIPT_RESERVE)
        result_path.write_bytes(b'')
    source_files = {'inputs':inputs_path,'native_targets':args.corpus_run/'anchor-targets.jsonl',
                    'native_manifest':args.corpus_run/'page-html-manifest.jsonl','capture_ledger':ledger_path,
                    'runner':Path(__file__),'collector':Path(host.__file__),
                    'copied_browser':Path(host.__file__).with_name('courtlistener_browser.py'),
                    'budget':host.WORKSPACE/'experiments/courtlistener-renditions/budget.py'}
    source_hashes = {name:hashlib.sha256(path.read_bytes()).hexdigest() for name,path in source_files.items()}
    native_summary = json.loads((args.corpus_run/'summary.json').read_text(encoding='utf-8'))
    started = time.monotonic()
    counts, kinds, records, browsers = Counter(), defaultdict(Counter), {}, set()
    host.WORKSPACE.joinpath('.tmp').mkdir(exist_ok=True)
    profile = host.tempfile.mkdtemp(prefix='courtlistener-ucd-',dir=host.WORKSPACE/'.tmp')
    resolver = None
    stopped = False
    try:
        resolver = host.CachedHtmlResolver(cache_dir=cache_dir,user_data_dir=profile)
        host.guard_resolver_writes(resolver)
        for item in inputs:
            saved, target = item['before_capture'], item['target']
            observation = {**target,'body_index':item['body_index']}
            fresh = None
            if host.remaining()<256*1024*1024:
                raise host.BudgetExhausted('Live publisher pilot reached the original 256 MiB pre-fetch floor')
            try:
                fresh = host.capture(resolver,saved['sampling'],out,navigation_url=target['target'])
            except Exception as error:
                result = {**observation,'verdict':'fetch_failure','failures':[],
                          'pinpoint_status':'pinpoint_unverified','error':str(error)}
            else:
                records[fresh['cluster_id']] = fresh
                driver = resolver.browser.driver
                browsers.add(driver.capabilities.get('browserVersion'))
                if host.runtime._split_url(driver.current_url)[0] != host.runtime._split_url(target['target'])[0]:
                    result = {**observation,'verdict':'redirected_base','failures':[],
                              'pinpoint_status':'pinpoint_unverified','live_url':driver.current_url}
                else:
                    try:
                        result = driver.execute_async_script(CHECK_TARGET,observation)
                        if result['verdict'] == 'cached-anchor-exact':
                            result['verdict'] = 'publisher'
                        result.update(live_url=driver.current_url,pinpoint_status='observed')
                    except Exception as error:
                        result = {**observation,'verdict':'rejected','failures':['observation-error'],
                                  'pinpoint_status':'pinpoint_unverified','error':str(error),'live_url':driver.current_url}
            result.update(schema='courtlistener.publisher-anchor-navigation.v1',url=saved['url'],
                          before_html_sha256=saved['sha256'],source_hashes=source_hashes,
                          fresh_html_sha256=fresh['sha256'] if fresh else None,
                          fresh_browser_evidence_path=fresh.get('browser_evidence_path') if fresh else None,
                          fresh_browser_evidence_sha256=fresh.get('browser_evidence_sha256') if fresh else None,
                          source_changed=fresh['sha256'] != saved['sha256'] if fresh else None,
                          emitted_url=target['target'])
            host.append(result_path,result)
            counts[result['verdict']] += 1
            kinds[result['kind']][result['verdict']] += 1
            print(f'Publisher anchor corpus: {sum(counts.values())}/{len(inputs)}, {result["verdict"]}, {target["target"]}',flush=True)
    except host.BudgetExhausted as error:
        stopped = True
        print(f'Publisher anchor corpus stopped at the shared disk budget: {error}',flush=True)
    finally:
        try:
            if resolver is not None:
                resolver.close()
        finally:
            host.cleanup_profile(profile)
    if stopped:
        raise SystemExit(2)
    summary = {'schema':'courtlistener.publisher-anchor-navigation.v1','pages':len(checked),
               'fresh_distinct_captures':len(records),'targets':sum(counts.values()),
               'verdicts':dict(counts),'kinds':dict(kinds),'browsers':sorted(browsers),'workers':1,
               'seconds':time.monotonic()-started,'source_hashes':source_hashes,
               'engine_source_sha256':native_summary['engine_source_sha256'],
               'query_source_sha256':native_summary['query_source_sha256'],
               'initial_cache_empty':True,'shared_budget_bytes':host.CAP,
               'navigation':'Unchanged copied UCD resolve/fetch/retries/delays, then location.assign of the exact emitted URL only on an identical live base; observe natural scrolling with CHECK_TARGET; no manual scrolling or stylesheet replacement',
               'scope':'Bounded live publisher source-ID navigation; fetch failures and changed-base redirects do not establish missing targets'}
    try:
        host.report(out,records,len(checked),started)
        data = host.text_bytes(json.dumps(summary,indent=2)+'\n')
        with host.writer():
            host.require_bytes(len(data)+host.RECEIPT_RESERVE)
            (out/'publisher-anchor-summary.json').write_bytes(data)
    except host.BudgetExhausted as error:
        print(f'Publisher anchor corpus stopped at the shared disk budget: {error}',flush=True)
        raise SystemExit(2)
    print(json.dumps(summary),flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus_run', type=Path)
    parser.add_argument('--limit-pages', type=int, default=0)
    parser.add_argument('--workers', type=int, choices=range(1,7), default=1)
    parser.add_argument('--structure-gold', action='store_true')
    parser.add_argument('--all-elements', action='store_true', help='Inventory every element in each opinion body')
    parser.add_argument('--kinds', nargs='+', help='Restrict navigation to the selected emitted link kinds')
    parser.add_argument('--styles', type=Path, help='Retained exact publisher stylesheet capture ledger')
    parser.add_argument('--source-controls', type=Path, help='Separate source-bound cached navigation controls')
    parser.add_argument('--source-context', action='store_true', help='Include the opinion wrapper and retain its actual ancestor attributes separately')
    parser.add_argument('--body-selector', default='.subopinion-content', help='Actual source body selector for independent inventories')
    parser.add_argument('--include-root', action='store_true', help='Inventory the selected root as well as its descendants')
    parser.add_argument('--live', action='store_true', help='Observe bounded real publisher anchors through the unchanged copied UCD pathway')
    parser.add_argument('--limit-targets', type=int, default=0, help='Required bounded target count for a prepared live publisher pilot (1–50)')
    args = parser.parse_args()
    if args.live:
        live_publisher(args)
        return
    manifest = {row['url']:row for row in gate.read_jsonl(args.corpus_run/'page-html-manifest.jsonl')}
    pages = defaultdict(list)
    for row in gate.read_jsonl(args.corpus_run/'anchor-targets.jsonl'):
        for target in row['targets']:
            if args.kinds and target['kind'] not in args.kinds:
                continue
            context = {key:row[key] for key in ('source_region','source_region_index') if key in row}
            pages[row['url']].append({**target, 'body_index':row['body_index'], **context})
    if args.source_controls:
        if args.structure_gold:
            raise ValueError('Source navigation controls require cached anchor navigation')
        for target in gate.read_jsonl(args.source_controls):
            if target.get('source_control') is not True or target['url'] not in manifest or target['html_sha256'] != manifest[target['url']]['sha256']:
                raise ValueError('Source control is not bound to an original corpus page')
            if not args.kinds or target['kind'] in args.kinds:
                pages[target['url']].append(target)
    if args.structure_gold:
        for url in manifest:
            pages.setdefault(url, [])
    selected = list(pages.items())[:args.limit_pages or None]
    files = {}
    styles = {}
    style_hashes = []
    if args.styles:
        home = Path(os.environ.get('OPEN_LEGAL_DATA_HOME') or Path(os.environ['LOCALAPPDATA'])/'OpenLegalData')
        for entry in gate.read_jsonl(args.styles):
            if not entry.get('sha256'):
                raise RuntimeError('Publisher stylesheet was not retained')
            raw = (home/entry['corpus_path']).read_bytes()
            if hashlib.sha256(raw).hexdigest() != entry['sha256']:
                raise RuntimeError('Publisher stylesheet digest changed')
            for url in {entry['url'],entry.get('final_url',entry['url'])}:
                styles[url] = raw.decode('utf-8')
            style_hashes.append(entry['sha256'])
    for url, _ in selected:
        entry = manifest[url]
        source = Path(entry['path'])
        if hashlib.sha256(source.read_bytes()).hexdigest() != entry['sha256']:
            raise RuntimeError('Native corpus source digest mismatch')
        files[entry['file']] = source
    counts, kinds = Counter(), defaultdict(Counter)
    started = time.monotonic()
    runner_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    browser_versions = set()
    with gate.CacheServer(files) as server:
        def worker(index):
            completed = []
            with gate.owned_chrome_profile('courtlistener-anchors') as profile, gate.chrome_session(runner.options(profile)) as (driver, _, _):
                driver.set_script_timeout(30)
                driver.set_page_load_timeout(30)
                for url, targets in selected[index::args.workers]:
                    entry = manifest[url]
                    local = f'http://127.0.0.1:{server.httpd.server_port}/page/{entry["file"]}'
                    driver.get(local)
                    if styles:
                        driver.execute_script("""
                        const retained = arguments[0];
                        for (const link of document.querySelectorAll('link[rel~=stylesheet]')) {
                          if (!(link.href in retained)) throw Error('Publisher stylesheet not retained: ' + link.href);
                          const style = document.createElement('style');
                          style.textContent = retained[link.href];
                          if (link.media) style.media = link.media;
                          link.after(style);
                        }
                        """, styles)
                    runner.wait_for_stable_document(driver)
                    results = []
                    if args.structure_gold:
                        results = driver.execute_script(STRUCTURE_GOLD, args.all_elements, args.source_context, args.body_selector, args.include_root)
                    else:
                        for target in targets:
                            fragment = urlsplit(target['target']).fragment
                            navigation = driver.execute_cdp_cmd('Page.navigate', {'url':local+'#'+fragment})
                            if navigation.get('errorText'):
                                raise RuntimeError(f'Cached navigation failed: {navigation["errorText"]}')
                            results.append(driver.execute_async_script(CHECK_TARGET, target))
                    completed.append((entry, url, results))
                    print(f'Cached anchor corpus: worker {index}, {len(completed)} pages, {url}', flush=True)
                return completed, driver.capabilities.get('browserVersion')
        output_name = 'browser-structure-gold' if args.structure_gold else 'anchor-browser'
        with ThreadPoolExecutor(max_workers=args.workers) as pool, (args.corpus_run/f'{output_name}.jsonl').open('w', encoding='utf-8', newline='\n') as output:
            for completed, browser in pool.map(worker, range(args.workers)):
                browser_versions.add(browser)
                for entry, url, results in completed:
                    for result in results:
                        if args.structure_gold:
                            counts['bodies'] += 1
                            for element in result['elements']:
                                kinds[element['tag']]['observed'] += 1
                        else:
                            counts[result['verdict']] += 1
                            kinds[result['kind']][result['verdict']] += 1
                        output.write(json.dumps({'html_sha256':entry['sha256'], 'url':url, **result}, ensure_ascii=False)+'\n')
                output.flush()
            summary = {'schema':'courtlistener.cached-anchor-navigation.v1', 'pages':len(selected),
                'targets':sum(counts.values()), 'verdicts':dict(counts), 'kinds':dict(kinds),
                'seconds':time.monotonic()-started, 'browsers':sorted(browser_versions), 'workers':args.workers,
                'runner_sha256':runner_sha,'navigation':'Browser-initiated CDP Page.navigate using the emitted URL fragment unchanged; observe natural scrolling until target and viewport geometry are unchanged for four frames (five-second limit); never scroll the target manually',
                'publisher_stylesheet_sha256':sorted(set(style_hashes)),
                'scope':'Cached complete HTML, exact :target identity, opinion membership and viewport landing; live navigation is not proved'}
            if args.structure_gold:
                summary.update(schema='courtlistener.cached-structure-gold.v1', bodies=counts['bodies'],
                    all_elements=args.all_elements,
                    source_context=args.source_context,
                    body_selector=args.body_selector,
                    include_root=args.include_root or args.source_context,
                    scope='Independent complete saved-page DOM structure, attributes and text; never generated from native output')
                summary.pop('targets')
                summary.pop('navigation')
            (args.corpus_run/f'{output_name}-summary.json').write_text(json.dumps(summary, indent=2)+'\n', encoding='utf-8')
            print(json.dumps(summary), flush=True)

if __name__ == '__main__':
    main()
