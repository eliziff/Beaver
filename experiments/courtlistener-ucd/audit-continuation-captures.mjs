// Read existing corpus bytes only. Publish bounded stdout through budget.writer().
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';

const [ownerArg, homeArg, prefixArg, prefixSHA, limitArg='20', frozenName='continuation-source-captures.json'] = process.argv.slice(2);
const prefixBytes = Number(prefixArg);
const selectionLimit = Number(limitArg);
if (!ownerArg || !homeArg || !Number.isSafeInteger(prefixBytes) || prefixBytes < 1 || !/^[0-9a-f]{64}$/u.test(prefixSHA ?? ''))
  throw Error('Supply capture owner, OpenLegalData home, baseline byte count and baseline SHA');
if (!Number.isSafeInteger(selectionLimit) || selectionLimit < 1 || selectionLimit > 12000
    || path.basename(frozenName) !== frozenName || !/^[\w-]+\.json$/u.test(frozenName))
  throw Error('Optional selection limit and owning capture filename are invalid');
const owner = path.resolve(ownerArg), home = path.resolve(homeArg);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const check = (condition, message) => { if (!condition) throw Error(message); };
const relative = file => path.relative(project, file).replaceAll('\\', '/');
const within = (root, value) => {
  check(typeof value === 'string' && !path.isAbsolute(value), 'Expected relative retained-source path');
  const file = path.resolve(root, value), back = path.relative(root, file);
  check(back !== '..' && !back.startsWith(`..${path.sep}`) && !path.isAbsolute(back), 'Source path leaves its owner');
  return file;
};
const cluster = url => /^https:\/\/(?:www\.)?courtlistener\.com\/opinion\/(\d+)(?:\/|$)/u.exec(url ?? '')?.[1];
const requestFile = path.join(owner, 'acquisition-request.json');
const requestBytes = fs.readFileSync(requestFile), request = JSON.parse(requestBytes);
const candidateFile = within(project, request.candidates), ledgerFile = path.join(owner, 'captures.jsonl');
const snapshotBytes = fs.statSync(ledgerFile).size;
check(snapshotBytes >= prefixBytes, 'Ledger is shorter than original baseline');
const prefixHash = createHash('sha256'), completeHash = createHash('sha256');
const baseline = new Set(), additions = new Set(), selected = [];
let consumed = 0, completeBytes = 0, baselineRows = 0, baselineOpinionRows = 0,
  baselineOtherRows = 0, rows = 0, pending = Buffer.alloc(0);
for await (const chunk of fs.createReadStream(ledgerFile, {end:snapshotBytes - 1, highWaterMark:32768})) {
  if (consumed < prefixBytes) prefixHash.update(chunk.subarray(0, Math.min(chunk.length, prefixBytes - consumed)));
  consumed += chunk.length;
  const data = pending.length ? Buffer.concat([pending,chunk]) : chunk;
  let start = 0, end;
  while ((end = data.indexOf(10,start)) >= 0) {
    const line = data.subarray(start,end + 1), row = JSON.parse(line.toString('utf8'));
    completeHash.update(line); completeBytes += line.length; rows++;
    const found = cluster(row.final_url);
    if (completeBytes <= prefixBytes) {
      baselineRows++;
      if (found && found === row.cluster_id && row.body_count > 0) {
        baseline.add(found); baselineOpinionRows++;
      } else baselineOtherRows++;
    }
    else {
      check(completeBytes - line.length >= prefixBytes, 'Baseline does not end at a complete JSONL row');
      check(found && found === row.cluster_id && row.body_count > 0, 'New ledger opinion identity is invalid');
      if (!baseline.has(found) && !additions.has(found)) {
        additions.add(found);
        if (selected.length < selectionLimit) selected.push(row);
      }
    }
    start = end + 1;
  }
  pending = data.subarray(start);
}
check(consumed === snapshotBytes && prefixHash.digest('hex') === prefixSHA, 'Original baseline byte digest changed');
check(baseline.size === 5000, 'Original 5,000-page baseline membership differs');

// Stream the large top-level array; only the selected original candidates remain
// in memory. This framing uses JSON.parse for every complete record, not a new
// JSON semantic parser. The queue consists of object records in one JSON array.
const wanted = new Set(selected.map(row => `${row.sampling?.opinion_id}|${row.cluster_id}|${row.url}`));
const candidates = new Map(), queueHash = createHash('sha256');
let state = 'open', depth = 0, inString = false, escaped = false, parts = [], candidateCount = 0;
for await (const chunk of fs.createReadStream(candidateFile, {highWaterMark:32768})) {
  queueHash.update(chunk);
  let start = state === 'record' ? 0 : -1;
  for (let at = 0; at < chunk.length; at++) {
    const byte = chunk[at];
    if (state === 'record') {
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 92) escaped = true;
        else if (byte === 34) inString = false;
      } else if (byte === 34) inString = true;
      else if (byte === 123 || byte === 91) depth++;
      else if (byte === 125 || byte === 93) {
        depth--;
        if (!depth) {
          parts.push(chunk.subarray(start,at + 1));
          const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
          const key = `${value.opinion_id}|${value.cluster_id}|${value.url}`;
          candidateCount++;
          if (wanted.has(key)) {
            check(!candidates.has(key), 'Selected candidate identity is duplicated');
            candidates.set(key,value);
          }
          parts = []; start = -1; state = 'delimiter';
        }
      }
    } else if (byte === 32 || byte === 9 || byte === 10 || byte === 13) continue;
    else if (state === 'open') { check(byte === 91, 'Candidate queue is not an array'); state = 'member'; }
    else if (state === 'member') {
      if (byte === 93) state = 'done';
      else { check(byte === 123, 'Candidate array member is not an object'); state = 'record'; depth = 1; start = at; }
    } else if (state === 'delimiter') {
      if (byte === 44) state = 'member';
      else { check(byte === 93, 'Invalid candidate array delimiter'); state = 'done'; }
    } else throw Error('Unexpected bytes after candidate array');
  }
  if (state === 'record') parts.push(chunk.subarray(start));
}
check(state === 'done' && candidateCount === request.candidate_count, 'Incomplete or changed candidate count');

function inventory(body) {
  check(typeof body.containerId === 'string' && typeof body.innerText === 'string' && typeof body.visible === 'boolean' &&
    Array.isArray(body.anchors) && Array.isArray(body.links) && Array.isArray(body.source_nodes) && body.source_nodes.length,
    'Complete original body inventory missing');
  const nodes = body.source_nodes, active = [], elements = [], texts = [];
  let offset = 0;
  for (const [index,node] of nodes.entries()) {
    check(Number.isInteger(node.node_type) && node.node_type >= 1 && node.node_type <= 12, 'Invalid recorded DOM type');
    if (!index) check(node.node_type === 1 && node.parent_index === null, 'Body root is not the first element');
    else {
      check(Number.isInteger(node.parent_index) && node.parent_index >= 0 && node.parent_index < index, 'Invalid DOM parent');
      while (active.length && active.at(-1).index !== node.parent_index) {
        const closed = active.pop(); if (closed.element) closed.element.end = offset;
      }
      check(active.length && nodes[node.parent_index].node_type === 1, 'Recorded nodes are not a rooted element-parent preorder');
    }
    let element;
    if (node.node_type === 1) {
      check(typeof node.tag === 'string' && (node.namespace === null || typeof node.namespace === 'string') &&
        node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes) &&
        Object.values(node.attributes).every(value => typeof value === 'string'), 'Element source fields missing');
      element = {index,node,start:offset,end:null}; elements.push(element);
    } else {
      check(node.value === null || typeof node.value === 'string', 'DOM value missing');
      if (node.node_type === 3 || node.node_type === 4) {
        check(typeof node.value === 'string', 'Text/CDATA value missing'); texts.push(node.value); offset += node.value.length;
      }
    }
    active.push({index,element});
  }
  for (const entry of active) if (entry.element) entry.element.end = offset;
  const text = texts.join(''), descendants = elements.slice(1);
  check(nodes[0].attributes.class?.split(/\s+/u).includes('subopinion-content'), 'Saved root is not the opinion body');
  const anchors = descendants.filter(element => Object.hasOwn(element.node.attributes,'id'));
  const links = descendants.filter(element => element.node.tag === 'a' && Object.hasOwn(element.node.attributes,'href'));
  check(anchors.length === body.anchors.length && links.length === body.links.length, 'DOM anchor/link counts disagree');
  for (const [index,{node,start,end}] of anchors.entries()) {
    const actual = body.anchors[index], attrs = node.attributes;
    check(actual.id === attrs.id && actual.tag === node.tag && actual.text === text.slice(start,end).trim() &&
      actual.href === (attrs.href ?? null) && actual.label === (attrs['data-label'] || attrs.label || null) &&
      typeof actual.visible === 'boolean', 'Complete original anchor inventory differs from recorded nodes');
  }
  for (const [index,{node,start,end}] of links.entries()) {
    const actual = body.links[index];
    check(actual.id === (node.attributes.id ?? '') && actual.href === node.attributes.href &&
      actual.text === text.slice(start,end).trim().slice(0,160), 'Original link inventory differs from recorded nodes');
  }
  return {container_id:body.containerId, source_nodes:nodes.length, elements:elements.length,
    anchors:anchors.length, links:links.length, body_inner_text_sha256:digest(body.innerText),
    source_nodes_sha256:digest(JSON.stringify(nodes)), root: nodes[0]};
}

const cacheFile = path.join(owner,'browser-cache/index.json'), cacheBytes = fs.readFileSync(cacheFile), cache = JSON.parse(cacheBytes);
const outcomes = [], frozen = [];
for (const row of selected) {
  try {
    const candidate = candidates.get(`${row.sampling?.opinion_id}|${row.cluster_id}|${row.url}`);
    check(candidate && isDeepStrictEqual(row.sampling,candidate), 'Complete sampling metadata differs from original candidate');
    check(row.schema === 'courtlistener.browser-capture.v1' && row.representation === 'selenium.page_source' &&
      cluster(row.url) === row.cluster_id && cluster(row.final_url) === row.cluster_id &&
      Number.isInteger(row.http_status) && row.http_status >= 200 && row.http_status < 400,
      'Capture URL, cluster, representation or status is invalid');
    const htmlFile = within(home,row.corpus_path), html = fs.readFileSync(htmlFile);
    check(html.length === row.bytes && digest(html) === row.sha256, 'Original canonical HTML length/SHA differs');
    const evidenceFile = within(owner,row.browser_evidence_path), evidenceBytes = fs.readFileSync(evidenceFile);
    check(digest(evidenceBytes) === row.browser_evidence_sha256 && path.basename(evidenceFile) === `${row.browser_evidence_sha256}.json`,
      'DOM bytes or their own content-addressed path differ');
    const evidence = JSON.parse(evidenceBytes);
    check(evidence.schema === 'courtlistener.browser-evidence.v1' && evidence.html_sha256 === row.sha256 &&
      evidence.url === row.final_url && Array.isArray(evidence.bodies) && evidence.bodies.length === row.body_count && row.body_count > 0,
      'DOM document/body identity differs');
    const bodies = evidence.bodies.map(inventory);
    const entries = [...new Set([row.url,row.final_url])].map(url => {
      const entry = cache[url];
      check(entry && entry.canonical_url_base === row.final_url && entry.status_code === row.http_status,
        'Original cache canonical URL/status differs');
      const file = path.isAbsolute(entry.html_path) ? entry.html_path : path.resolve(path.dirname(cacheFile),entry.html_path);
      check(fs.realpathSync(file) === fs.realpathSync(htmlFile), 'Original cache does not resolve to canonical HTML');
      return {url,entry};
    });
    frozen.push(row);
    outcomes.push({cluster_id:row.cluster_id,html_sha256:row.sha256,bytes:row.bytes,
      browser_evidence_path:row.browser_evidence_path,browser_evidence_sha256:row.browser_evidence_sha256,
      http_status:row.http_status,complete_sampling_equal:true,canonical_html_equal:true,own_hash_dom_equal:true,
      bodies,cache_entries:entries,status:'preserved'});
  } catch (error) { outcomes.push({cluster_id:row.cluster_id,status:'failed',reason:error.message}); }
}
const capturesBytes = Buffer.from(`${JSON.stringify(frozen,null,2)}\n`);
const report = {schema:'courtlistener.continuation-capture-parity.v1',created_utc:new Date().toISOString(),
  baseline:{bytes:prefixBytes,sha256:prefixSHA,rows:baselineRows,opinion_rows:baselineOpinionRows,
    earlier_bootstrap_or_other_rows:baselineOtherRows,duplicate_opinion_rows:baselineOpinionRows - baseline.size,
    distinct_clusters:baseline.size,unchanged:true},
  ledger_snapshot:{path:relative(ledgerFile),stat_bytes:snapshotBytes,complete_prefix_bytes:completeBytes,
    complete_prefix_sha256:completeHash.digest('hex'),pending_partial_bytes:pending.length,complete_rows:rows,
    observed_distinct_clusters:baseline.size + additions.size,new_distinct_clusters:additions.size},
  selected_distinct_additions:selected.length,unselected_additions:additions.size - selected.length,
  preserved_captures:frozen.length,failures:outcomes.filter(value => value.status === 'failed').length,outcomes,
  source:{request:{path:relative(requestFile),sha256:digest(requestBytes)},
    candidates:{path:relative(candidateFile),sha256:queueHash.digest('hex'),records:candidateCount},
    cache:{path:relative(cacheFile),sha256:digest(cacheBytes),bytes:cacheBytes.length},
    script:{path:relative(fileURLToPath(import.meta.url)),sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url)))},
    collector_sha256:digest(fs.readFileSync(path.join(project,'experiments/courtlistener-ucd/collect.py'))),
    copied_browser_sha256:digest(fs.readFileSync(path.join(project,'experiments/courtlistener-ucd/courtlistener_browser.py')))},
  frozen_original_captures:{path:relative(path.join(owner,frozenName)),bytes:capturesBytes.length,sha256:digest(capturesBytes)},
  scope:`First at most ${selectionLimit} distinct additions at a fixed complete-ledger snapshot. Complete original candidate metadata, canonical HTML, own-hash DOM bytes/rooted source-node inventories, anchors/links and actual cache paths/status are checked. The earlier 5,000 baseline is bound by unchanged bytes and membership, not re-audited. No fetching, browser rerender, native structure comparison or current publisher-link claim. Later appended rows are outside this snapshot.`,
  regeneration_argv:['node','--max-old-space-size=32',relative(fileURLToPath(import.meta.url)),relative(owner),'<OpenLegalData home>',String(prefixBytes),prefixSHA,String(selectionLimit),frozenName]};
const result = Buffer.from(`${JSON.stringify({report,captures_utf8:capturesBytes.toString('utf8')})}\n`);
check(result.length <= 8 * 1024 * 1024, 'Bounded continuation outputs exceed 8 MiB');
process.stdout.write(result);
