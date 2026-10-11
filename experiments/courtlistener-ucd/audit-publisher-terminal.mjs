// Audit the actual completed publisher ledger; never regenerate observations.
// node experiments/courtlistener-ucd/audit-publisher-terminal.mjs
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const base='benchmarks/local-data/courtlistener-renditions/web-source-context';
const out=path.join(base,'publisher-live');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>{const bytes=fs.readFileSync(file);return {file,bytes:bytes.length,sha256:hash(bytes),value:JSON.parse(bytes)};};
const lines=file=>{const bytes=fs.readFileSync(file);return {file,bytes:bytes.length,sha256:hash(bytes),rows:bytes.toString('utf8').trim().split('\n').map(JSON.parse)};};
const prepared=lines(path.join(base,'publisher-live-inputs.jsonl'));
const outcomes=lines(path.join(out,'publisher-anchor.jsonl'));
const captures=lines(path.join(out,'captures.jsonl'));
if(prepared.rows.length!==42 || outcomes.rows.length!==42) throw Error('Prepared publisher scope is not terminal');
const native=read(path.join(base,'summary.json'));
const sources=outcomes.rows[0].source_hashes;
const bindings={
  inputs:prepared.file,
  native_targets:path.join(base,'anchor-targets.jsonl'),
  native_manifest:path.join(base,'page-html-manifest.jsonl'),
  capture_ledger:'benchmarks/local-data/courtlistener-ucd/captures.jsonl',
  runner:path.join(out,'source',`verify-cached-anchors.${sources.runner}.py`),
  budget:path.join(out,'source',`budget.${sources.budget}.py`),
  collector:'experiments/courtlistener-ucd/collect.py',
  copied_browser:'experiments/courtlistener-ucd/courtlistener_browser.py'
};
const source_files={};
for(const [name,file] of Object.entries(bindings)) {
  // The collector ledger is append-only; bind the original pilot prefix.
  const all=fs.readFileSync(file);
  const bytes=name==='capture_ledger' ? all.subarray(0,35081252) : all;
  if(hash(bytes)!==sources[name]) throw Error(`Publisher source binding changed: ${name}`);
  source_files[name]={file,bytes:bytes.length,sha256:hash(bytes),
    ...(name==='capture_ledger' ? {scope:'Original35,081,252-byte append-only prefix; subsequent collector rows excluded'} : {})};
}
const verdicts={},kinds={};
for(let i=0;i<outcomes.rows.length;i++) {
  const result=outcomes.rows[i],input=prepared.rows[i],target=input.target;
  if(!isDeepStrictEqual(result.source_hashes,sources) || result.emitted_url!==target.target ||
      result.url!==input.before_capture.url || result.anchor!==target.anchor ||
      result.body_index!==input.body_index || result.kind!==target.kind || result.source_tag!==target.source_tag)
    throw Error(`Publisher outcome does not match prepared target ${i}`);
  verdicts[result.verdict]=(verdicts[result.verdict]??0)+1;
  const group=kinds[result.kind]??={};group[result.verdict]=(group[result.verdict]??0)+1;
}
const chosen=[],seen=new Set(),observations=[],comparisons=[];
for(let i=0;i<captures.rows.length;i++) {
  const row=captures.rows[i];
  const original=prepared.rows.find(item=>item.before_capture.url===row.url)?.before_capture;
  if(!original || !isDeepStrictEqual(original.sampling,row.sampling) || original.cluster_id!==row.cluster_id)
    throw Error(`Captured source metadata changed at ${i}`);
  const fresh=read(path.join(out,row.browser_evidence_path));
  if(fresh.sha256!==row.browser_evidence_sha256 || fresh.value.html_sha256!==row.sha256 || fresh.value.url!==row.final_url)
    throw Error(`Fresh DOM identity changed at ${i}`);
  observations.push({ordinal:i,url:row.url,html_sha256:row.sha256,dom_sha256:fresh.sha256});
  if(seen.has(row.sha256)) continue;
  seen.add(row.sha256);chosen.push(row);
  const before=read(path.join('benchmarks/local-data/courtlistener-ucd',original.browser_evidence_path));
  if(before.sha256!==original.browser_evidence_sha256 || before.value.html_sha256!==original.sha256)
    throw Error(`Prior DOM identity changed at ${i}`);
  const fields=['innerText','anchors','links','containerId','visible'];
  const equal=Object.fromEntries(fields.map(field=>[field,isDeepStrictEqual(
    before.value.bodies.map(body=>body[field]),fresh.value.bodies.map(body=>body[field]))]));
  comparisons.push({url:row.url,before_html_sha256:original.sha256,fresh_html_sha256:row.sha256,
    before_dom_sha256:before.sha256,fresh_dom_sha256:fresh.sha256,
    html_changed:row.sha256!==original.sha256,body_count_equal:before.value.bodies.length===fresh.value.bodies.length,
    comparable_body_fields_equal:equal});
}
const profile=path.resolve('.tmp/courtlistener-ucd-q4evbwhf');
if(fs.existsSync(profile)) throw Error('Original publisher temporary profile remains');
const frozen=Buffer.from(JSON.stringify(chosen,null,2)+'\n');
const frozenPath=path.join(out,'pilot-captures.json');
const report={schema:'courtlistener.publisher-terminal-recovery.v1',created_utc:new Date().toISOString(),
  execution:{session_id:27686,exit_code:1,reason:'All42 outcomes persisted; cleanup_profile failed before the runner could write its summary',
    original_summary_present:fs.existsSync(path.join(out,'publisher-anchor-summary.json')),
    profile,profile_present:false,cleanup:'Existing cleanup-profile.ps1 completed separately after confirming no browser owner',
    replayed_requests:0},
  prepared:{file:prepared.file,bytes:prepared.bytes,sha256:prepared.sha256},
  outcomes:{file:outcomes.file,bytes:outcomes.bytes,sha256:outcomes.sha256},
  capture_ledger:{file:captures.file,bytes:captures.bytes,sha256:captures.sha256},
  targets:outcomes.rows.length,pages:new Set(prepared.rows.map(item=>item.before_capture.url)).size,
  verdicts,kinds,source_files,engine_source_sha256:native.value.engine_source_sha256,
  query_source_sha256:native.value.query_source_sha256,shared_budget_bytes:45000000000,
  frozen_cohort:{file:frozenPath,bytes:frozen.length,sha256:hash(frozen),pages:chosen.length,
    distinct_urls:new Set(chosen.map(row=>row.url)).size,selection:'Earliest unchanged capture row per actual HTMLSHA; all other DOM observations retained'},
  observations,body_comparisons:comparisons,
  scope:'Actual terminal outcomes, not a successful original summary. Publisher verdicts describe the recorded in-view observations; the initial offscreen result does not prove eventual failure. Fetch failures do not prove missing IDs. Native namespace identity remains unmeasured.'};
fs.writeFileSync(frozenPath,frozen);
const reportPath=path.join(out,'publisher-terminal-recovery.json');
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:reportPath,targets:report.targets,pages:report.pages,verdicts,frozen_pages:chosen.length,
  changed_html:comparisons.filter(row=>row.html_changed).length,
  changed_comparable_bodies:comparisons.filter(row=>!row.body_count_equal||Object.values(row.comparable_body_fields_equal).includes(false)).length}));
