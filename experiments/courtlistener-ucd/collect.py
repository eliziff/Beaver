"""Resumable CourtListener HTML acquisition through the copied ALR UCD pathway."""
from __future__ import annotations
import argparse
import atexit
from collections import Counter
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import urljoin
from bs4 import BeautifulSoup
from courtlistener_browser import CachedHtmlResolver
import courtlistener_runtime as runtime

WORKSPACE = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(WORKSPACE/'experiments/courtlistener-renditions'))
from budget import CAP, BudgetExhausted, remaining, require_bytes, writer
RECEIPT_RESERVE = 16 * 1024 * 1024
CLUSTER = re.compile(r'https://(?:www\.)?courtlistener\.com/opinion/(\d+)(?:/|$)')
DOM_EVIDENCE = """
function sourceNodes(root) {
 const nodes = [], indexes = new Map();
 const walker = document.createTreeWalker(root,NodeFilter.SHOW_ALL);
 let node = root;
 do {
  const index = nodes.length;
  const parent = indexes.get(node.parentNode) ?? null;
  indexes.set(node,index);
  nodes.push(node.nodeType === Node.ELEMENT_NODE ? {
    node_type:node.nodeType,parent_index:parent,tag:node.localName,namespace:node.namespaceURI,
    attributes:Object.fromEntries([...node.attributes].map(a => [a.name,a.value]))
  } : {node_type:node.nodeType,parent_index:parent,value:node.nodeValue});
 } while (node = walker.nextNode());
 return nodes;
}
return Array.from(document.querySelectorAll('.subopinion-content')).map(body => ({
 containerId:body.parentElement.id, innerText:body.innerText,
 source_nodes:sourceNodes(body),
 visible:body.getClientRects().length > 0 && getComputedStyle(body).visibility !== 'hidden',
 anchors:Array.from(body.querySelectorAll('[id]')).map(e => ({
   id:e.id, tag:e.tagName.toLowerCase(), text:e.textContent.trim(),
   visible:e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden',
   href:e.getAttribute('href'), label:e.getAttribute('data-label') || e.getAttribute('label')
 })),
 links:Array.from(body.querySelectorAll('a[href]')).map(e => ({
   id:e.id, href:e.getAttribute('href'), text:e.textContent.trim().slice(0,160)
 }))
}));
"""

def append(path, value):
    data = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    with writer():
        require_bytes(len(data) + RECEIPT_RESERVE)
        with path.open('ab') as handle:
            handle.write(data)

def text_bytes(text, errors='strict'):
    # Match the copied pathway's default TextIO newline translation on Windows.
    return text.replace('\n', os.linesep).encode('utf-8', errors=errors)

def guard_resolver_writes(resolver):
    cache = resolver.cache
    put, save_index = cache.put, cache._save_index
    def guarded_put(alias_url_base, canonical_url_base, html, status_code):
        with writer():
            require_bytes(len(text_bytes(html or '', errors='replace')) + RECEIPT_RESERVE)
            return put(alias_url_base, canonical_url_base, html, status_code)
    def guarded_save_index():
        data = text_bytes(json.dumps(cache._index, ensure_ascii=False, indent=2))
        with writer():
            require_bytes(len(data) + RECEIPT_RESERVE)  # The complete .tmp coexists with index.json.
            return save_index()
    cache.put, cache._save_index = guarded_put, guarded_save_index
    for handler in resolver.logger.handlers:
        if isinstance(handler, logging.FileHandler) and Path(handler.baseFilename).resolve().is_relative_to(cache.cache_dir):
            handle = handler.handle
            def guarded_handle(record, handler=handler, handle=handle):
                data = text_bytes(handler.format(record) + handler.terminator, errors=handler.errors or 'strict')
                with writer():
                    require_bytes(len(data) + RECEIPT_RESERVE)
                    return handle(record)
            handler.handle = guarded_handle

def cluster(url):
    match = CLUSTER.match(url)
    return match[1] if match else None

def has_opinion_content(body):
    # A diagram, scan or equation is evidence even when it supplies no text.
    return bool(body.get_text(strip=True) or body.find(['img', 'svg', 'math', 'object', 'embed']))

def capture(resolver, candidate, out, *, navigation_url=None):
    url = candidate['url']
    if navigation_url is not None and runtime._split_url(navigation_url)[0] != url:
        raise ValueError('Fragment navigation must retain the original canonical candidate URL')
    final = resolver.resolve_url(navigation_url or url)
    if navigation_url is not None:
        final = runtime._split_url(final)[0]
    if not final:
        raise RuntimeError('Browser could not resolve opinion')
    html = resolver.get_cached_html(url)
    driver = resolver.browser.driver
    if cluster(final) and (driver is None or cluster(driver.current_url) != cluster(final)):
        final, html, status, _ = resolver.browser.fetch_html(final)
        if not final or status is None or status >= 400:
            raise RuntimeError('Could not read cached opinion in browser')
        resolver.cache.put(url, final, html, status)
        driver = resolver.browser.driver
    if not html or resolver.browser._looks_blocked('', html):
        raise RuntimeError('Empty or challenge page; excluded')
    if cluster(url) and cluster(final)!=cluster(url):
        raise RuntimeError('Browser returned a different opinion cluster; excluded')
    soup = BeautifulSoup(html, 'html.parser')
    published = soup.select_one('meta[property="og:url"]')
    if cluster(url) and (published is None or cluster(published.get('content',''))!=cluster(url)):
        raise RuntimeError('Published canonical URL does not identify the requested cluster; excluded')
    bodies = soup.select('.subopinion-content')
    if cluster(final) and not any(has_opinion_content(body) for body in bodies):
        raise RuntimeError('Page has no opinion body; excluded')
    if navigation_url is not None and runtime._split_url(driver.current_url)[0] == runtime._split_url(navigation_url)[0]:
        # The copied fetch strips fragments. This changes only the live document's
        # fragment, after its original fetch, retries and delays have completed.
        driver.execute_script('location.assign(arguments[0]);', navigation_url)
    entry = resolver.cache.get_entry(url)
    raw = html.encode('utf-8')
    sha = hashlib.sha256(raw).hexdigest()
    def field(selector):
        found = soup.select_one(selector)
        return found.get_text(' ', strip=True) if found else None
    record = {'schema':'courtlistener.browser-capture.v1','url':url,'final_url':final,
      'cluster_id':cluster(final),'sha256':sha,'corpus_path':None,'bytes':len(raw),
      'representation':'selenium.page_source','http_status':entry.status_code,
      'title':field('title'),'court':field('.case-court'),'date_filed':field('.case-date-new'),
      'body_count':len(bodies), 'sampling':candidate,
      'body_classes':sorted({name for b in bodies for t in b.find_all(class_=True) for name in t.get('class',[])}),
      'tags':dict(Counter(t.name for b in bodies for t in b.find_all())),
      'element_ids':sum(len(b.find_all(id=True)) for b in bodies),
      'opinion_links':sorted({urljoin(final,a['href']).split('#')[0] for a in soup.find_all('a',href=True) if cluster(urljoin(final,a['href']))})}
    evidence_bytes = None
    if bodies:
        evidence = {'schema':'courtlistener.browser-evidence.v1','html_sha256':sha,
          'url':final,'browser':driver.capabilities.get('browserVersion'),
          'bodies':driver.execute_script(DOM_EVIDENCE)}
        evidence_bytes = json.dumps(evidence,ensure_ascii=False,separators=(',',':')).encode('utf-8')
        evidence_sha = hashlib.sha256(evidence_bytes).hexdigest()
        destination = out / 'browser-evidence' / f'{evidence_sha}.json'
        record.update(browser_evidence_path=destination.relative_to(out).as_posix(),
                      browser_evidence_sha256=evidence_sha)
    # All DOM work is complete before the shared persistence lock is acquired.
    with writer():
        if runtime._database is None:
            runtime._database = runtime.corpus_store.connect()
            atexit.register(runtime._database.close)
        known = runtime._database.execute('SELECT path FROM files WHERE sha256=?', (sha,)).fetchone()
        meta = {'collection':'courtlistener-web', 'jurisdiction':'us',
                'kind':'opinion' if '/opinion/' in final else 'index-page'}
        ext = '.pdf' if raw[:5] == b'%PDF-' else '.html' if raw.lstrip()[:1] == b'<' else '.bin'
        anticipated_file = runtime.corpus_store.ROOT / runtime.corpus_store.place(meta) / f'{sha}{ext}'
        corpus_path = known[0] if known else anticipated_file.relative_to(runtime.corpus_store.HOME).as_posix()
        canonical_file = runtime._corpus_file(corpus_path).resolve()
        cached_file = (resolver.cache.cache_dir / entry.html_path).resolve()
        projected_index = {key: dict(value) for key, value in resolver.cache._index.items()}
        for value in projected_index.values():
            if (resolver.cache.cache_dir / value['html_path']).resolve() == cached_file:
                value['html_path'] = str(canonical_file)
        record['corpus_path'] = corpus_path
        ledger_bytes = (json.dumps(record,ensure_ascii=False,separators=(',',':')) + '\n').encode('utf-8')
        index_bytes = text_bytes(json.dumps(projected_index,ensure_ascii=False,indent=2))
        html_growth = len(raw) if not known and not canonical_file.exists() else 0
        require_bytes(html_growth + len(index_bytes) + len(evidence_bytes or b'') + len(ledger_bytes) + RECEIPT_RESERVE)
        # Original cache HTML can coexist with canonical HTML until commit completes.
        stored_path = runtime._store_html(html, url, final, entry.status_code)
        if stored_path != corpus_path:
            raise RuntimeError('Canonical corpus path changed during capture; source remains stored')
        for value in resolver.cache._index.values():
            if (resolver.cache.cache_dir / value['html_path']).resolve() == cached_file:
                value['html_path'] = str(canonical_file)
        resolver.cache._save_index()
        if evidence_bytes is not None:
            destination.parent.mkdir(exist_ok=True)
            destination.write_bytes(evidence_bytes)
        append(out / 'captures.jsonl', record)
        if cached_file != canonical_file and cached_file.is_relative_to(resolver.cache.html_dir):
            cached_file.unlink()
    print(f'Captured {len(raw):,} bytes: {final}',flush=True)
    return record

def existing(out):
    records = {}
    ledger = out / 'captures.jsonl'
    if not ledger.exists():
        return records
    for line in ledger.read_text(encoding='utf-8').splitlines():
        row = json.loads(line)
        found = cluster(row['final_url'])
        if not found:
            continue
        path = runtime._corpus_file(row['corpus_path'])
        if not path.is_file():
            continue
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != row['sha256']:
            raise RuntimeError(f'Captured source digest changed: {found}')
        if any(has_opinion_content(b) for b in BeautifulSoup(raw,'html.parser').select('.subopinion-content')):
            records[found] = row
    return records

def report(out, records, target, started):
    values = list(records.values())
    years = Counter()
    for row in values:
        match = re.search(r'(\d{4})',row.get('date_filed') or '')
        if match:
            years[str(int(match[1]) // 25 * 25)] += 1
    summary = {'schema':'courtlistener.browser-corpus.v1','target':target,
      'valid_distinct_clusters':len(values),'complete':len(values)>=target,
      'html_bytes':sum(r['bytes'] for r in values),
      'courts':dict(Counter(r.get('court') for r in values)), 'date_25_year_buckets':dict(years),
      'body_classes':dict(Counter(c for r in values for c in r.get('body_classes',[]))),
      'source_positions':dict(Counter(str(r.get('sampling',{}).get('range_index')) for r in values)),
      'browser_evidence_records':sum('browser_evidence_path' in r for r in values),
      'current_run_seconds':time.monotonic()-started,
      'scope':'Stratified convenience corpus; no full-corpus coverage claim'}
    summary_bytes = text_bytes(json.dumps(summary,indent=2)+'\n')
    opinion_bytes = text_bytes(json.dumps(values,ensure_ascii=False,indent=2)+'\n')
    with writer():
        require_bytes(len(summary_bytes) + len(opinion_bytes) + RECEIPT_RESERVE)
        (out/'summary.json').write_bytes(summary_bytes)
        (out/'opinions.json').write_bytes(opinion_bytes)

def cleanup_profile(profile):
    if sys.platform=='win32':
        cleanup = subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',
          str(Path(__file__).with_name('cleanup-profile.ps1')),'-Profile',profile],
          creationflags=subprocess.CREATE_NO_WINDOW)
        if cleanup.returncode and Path(profile).exists():
            raise RuntimeError(f'Owned browser profile cleanup failed: {profile}')
    else:
        __import__('shutil').rmtree(profile)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',action='append',default=[])
    parser.add_argument('--candidates',type=Path)
    parser.add_argument('--count',type=int,default=1000)
    parser.add_argument('--out',default='benchmarks/local-data/courtlistener-ucd')
    args = parser.parse_args()
    if not args.url and not args.candidates:
        parser.error('Supply --candidates or --url')
    candidates = json.loads(args.candidates.read_text(encoding='utf-8')) if args.candidates else []
    candidates = [{'url':url} for url in args.url] + candidates
    forced_urls = set(args.url)
    for candidate in candidates:
        if not re.fullmatch(r'https://www\.courtlistener\.com/opinion/\d+/[^/?#]+/',candidate['url']):
            raise ValueError('Opinion collection requires the full canonical URL, including its source slug')
    out = Path(args.out).resolve()
    out.mkdir(parents=True,exist_ok=True)
    records = existing(out)
    started = time.monotonic()
    print(f'Resuming {len(records)} distinct opinions; target {args.count}',flush=True)
    scratch = WORKSPACE/'.tmp'
    scratch.mkdir(exist_ok=True)
    profile = tempfile.mkdtemp(prefix='courtlistener-ucd-',dir=scratch)
    budget_exhausted = False
    try:
        resolver = CachedHtmlResolver(cache_dir=out/'browser-cache',user_data_dir=profile)
        guard_resolver_writes(resolver)
        try:
            for candidate in candidates:
                found = cluster(candidate['url'])
                if candidate['url'] not in forced_urls and found in records and 'browser_evidence_path' in records[found]:
                    continue
                if args.candidates and len(records)>=args.count:
                    break
                if remaining()<256*1024*1024:
                    raise BudgetExhausted('Browser acquisition reached the original 256 MiB pre-fetch floor')
                try:
                    row = capture(resolver,candidate,out)
                    if row['cluster_id']:
                        records[row['cluster_id']] = row
                except Exception as error:
                    append(out/'failures.jsonl',{'url':candidate['url'],'error':str(error)})
                    print(f'Skipped {candidate["url"]}: {error}',flush=True)
                report(out,records,args.count,started)
                print(f'Corpus progress: {len(records)}/{args.count}',flush=True)
        finally:
            resolver.close()
    except BudgetExhausted as error:
        budget_exhausted = True
        print(f'Browser acquisition stopped at the configured shared disk budget: {error}',flush=True)
    finally:
        cleanup_profile(profile)
        if not budget_exhausted:
            try:
                report(out,records,args.count,started)
            except BudgetExhausted as error:
                budget_exhausted = True
                print(f'Browser acquisition stopped at the configured shared disk budget: {error}',flush=True)
    if budget_exhausted:
        raise SystemExit(2)
    if args.candidates and len(records)<args.count:
        raise RuntimeError(f'Candidate list exhausted with {len(records)}/{args.count}')

if __name__=='__main__':
    main()
