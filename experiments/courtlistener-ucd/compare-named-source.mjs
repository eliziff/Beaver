// Compare actual retained original HTML and independent cached browser evidence.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';

const [cohort,nativeDirectory]=process.argv.slice(2);
if(!nativeDirectory) throw Error('Supply the original named-source cohort and actual native source-run directory');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=name=>fs.readFileSync(path.join(cohort,name));
const preparationBytes=read('preparation.json'),preparation=JSON.parse(preparationBytes);
const goldBytes=read('browser-structure-gold.jsonl'),goldSummaryBytes=read('browser-structure-gold-summary.json');
const goldSummary=JSON.parse(goldSummaryBytes);
if(goldSummary.schema!=='courtlistener.cached-structure-gold.v1' || !goldSummary.all_elements
  || goldSummary.include_root || goldSummary.body_selector!=='body') throw Error('Independent original-source DOM scope changed');
const gold=new Map(goldBytes.toString('utf8').trim().split('\n').map(JSON.parse).map(row=>[row.html_sha256,row]));
const nativeFile=path.join(nativeDirectory,'records.jsonl.zst'),nativeBytes=fs.readFileSync(nativeFile);
const native=zstdDecompressSync(nativeBytes).toString('utf8').trim().split('\n').map(JSON.parse);
const nativeSummaryBytes=fs.readFileSync(path.join(nativeDirectory,'summary.json')),nativeSummary=JSON.parse(nativeSummaryBytes);
const baselineFile=path.join(cohort,'native-baseline','records.jsonl.zst');
const baselineBytes=fs.existsSync(baselineFile)?fs.readFileSync(baselineFile):null;
const baseline=baselineBytes?zstdDecompressSync(baselineBytes).toString('utf8').trim().split('\n').map(JSON.parse):null;
const failures=[],details=[];
const totals={sources:0,named_elements:0,named_identifiers:0,exact_attributes:0,exact_opening_bytes:0,
  named_queries:0,exact_named_queries:0,id_queries:0,exact_id_queries:0,ambiguous_identifiers:0,
  browser_named_elements:0,browser_extra_named_instances:0,browser_ambiguous_named_identifiers:0,
  non_anchor_name_queries:0,exact_non_anchor_name_queries:0,unchanged_baseline_records:0,
  empty_id_queries:0,exact_empty_id_queries:0};
const exactAttributes=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([name,value])=>b[name]===value);
const opening=/<([A-Za-z][\w:.-]*)(?=\s|\/?>)(?:"[^"]*"|'[^']*'|[^'">])*>/gu;
const attribute=/\s+([^\s=<>/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const browserDifferences=[];
for(const source of preparation.sources) {
  const original=fs.readFileSync(path.join(cohort,'originals',source.sha256+'.html'));
  if(original.length!==source.bytes || digest(original)!==source.sha256) throw Error('Original rendition identity changed');
  const browser=gold.get(source.sha256),document=native.find(row=>row.html_sha256===source.sha256&&row.body_index===0);
  if(!browser || !document || document.error || !Array.isArray(document.markup_name_lookups)) throw Error('Actual independent DOM or name query receipt missing');
  totals.sources++;
  if(baseline) {
    const previous=baseline.find(row=>row.html_sha256===source.sha256&&row.body_index===0);
    if(!previous) throw Error('Frozen original source baseline membership changed');
    const changed=Object.keys(previous).filter(key=>JSON.stringify(previous[key])!==JSON.stringify(document[key]));
    if(changed.length) failures.push({opinion_id:source.opinion_id,kind:'prior-source-receipt-changed',fields:changed});
    else totals.unchanged_baseline_records++;
  }
  const ids=new Map(),names=new Map(),browserNames=new Map(),attributeNames=new Set();
  for(const element of browser.elements) {
    const name=element.tag==='a'?element.attributes.name:null;
    if(name) browserNames.set(name,[...(browserNames.get(name)??[]),element]);
  }
  const originalText=original.toString('utf8');
  for(const match of originalText.matchAll(opening)) {
    const attributes=Object.fromEntries([...match[0].slice(1+match[1].length).matchAll(attribute)]
      .map(attr=>[attr[1],attr[2]??attr[3]??attr[4]??'']));
    if(attributes.name) {
      if(/[&\u0080-\uFFFF]/u.test(attributes.name)) throw Error('Original name encoding requires separate adjudication');
      attributeNames.add(attributes.name);
    }
    const id=attributes.id,hasId=Object.hasOwn(attributes,'id'),name=match[1].toLowerCase()==='a'?attributes.name:null;
    if(!hasId&&!name) continue;
    // These real witnesses use literal ASCII identifiers and lowercase keys.
    // Other source encodings require independent decoding before admission.
    if([id,name].some(value=>value&&(/[&\u0080-\uFFFF]/u.test(value)))) throw Error('Original identifier encoding requires separate adjudication');
    const element={tag:match[1],attributes,markup_start:Buffer.byteLength(originalText.slice(0,match.index)),
      opening:match[0]};
    if(hasId) ids.set(id,[...(ids.get(id)??[]),element]);
    if(name) names.set(name,[...(names.get(name)??[]),element]);
  }
  for(const [anchor,elements] of names) {
    totals.named_identifiers++;totals.named_elements+=elements.length;
    const observed=browserNames.get(anchor)??[];
    totals.browser_named_elements+=observed.length;
    totals.browser_extra_named_instances+=Math.max(0,observed.length-elements.length);
    totals.browser_ambiguous_named_identifiers+=Number(observed.length>1);
    if(observed.length!==elements.length) browserDifferences.push({opinion_id:source.opinion_id,anchor,
      original_openings:elements.length,browser_instances:observed.length,
      browser_unique_name_without_id:!browser.elements.some(element=>element.attributes.id===anchor)&&observed.length===1,
      scope:'Original source and independently reparsed DOM remain separate; extra DOM instances do not erase original opening identity'});
    for(const element of elements) {
      if(!observed.length || observed.some(actual=>actual.namespace!=='http://www.w3.org/1999/xhtml'
        || !exactAttributes(actual.attributes,element.attributes))) throw Error('Independent named DOM attributes or namespace require separate adjudication');
      const matches=document.markup_elements.filter(actual=>actual.markup_start===element.markup_start
        &&actual.tag===element.tag&&exactAttributes(actual.attributes,element.attributes));
      if(matches.length!==1) {failures.push({opinion_id:source.opinion_id,anchor,kind:'named-source-attributes',matches:matches.length});continue;}
      totals.exact_attributes++;
      const actual=matches[0],openingBytes=Buffer.from(element.opening);
      const exact=original.subarray(actual.markup_start,actual.markup_start+openingBytes.length).equals(openingBytes)
        &&actual.markup_end>=actual.markup_start+openingBytes.length;
      totals.exact_opening_bytes+=Number(exact);
      if(!exact) failures.push({opinion_id:source.opinion_id,anchor,kind:'literal-opening-identity'});
    }
  }
  const lookups=[...document.markup_anchor_lookups.map(row=>({...row,kind:'id'})),
    ...document.markup_name_lookups.map(row=>({...row,kind:'name'}))];
  for(const [kind,expected] of [['id',ids],['name',attributeNames]]) {
    const anchors=lookups.filter(row=>row.kind===kind).map(row=>row.anchor);
    if(new Set(anchors).size!==anchors.length||JSON.stringify(anchors.toSorted())!==JSON.stringify([...expected.keys()].toSorted()))
      throw Error('Exact original '+kind+' query request coverage changed');
  }
  for(const lookup of lookups) {
    const expected=lookup.anchor===''?[]:ids.get(lookup.anchor)??names.get(lookup.anchor)??[];
    const counter=lookup.kind==='id'?'id_queries':'named_queries';totals[counter]++;
    let exact;
    if(expected.length!==1) {
      totals.ambiguous_identifiers+=Number(expected.length>1);exact=lookup.markup_start===null;
    } else {
      const element=expected[0];
      exact=lookup.markup_start===element.markup_start;
    }
    totals[lookup.kind==='id'?'exact_id_queries':'exact_named_queries']+=Number(exact);
    if(lookup.kind==='id'&&lookup.anchor==='') {
      totals.empty_id_queries++;totals.exact_empty_id_queries+=Number(exact);
    }
    if(lookup.kind==='name'&&!names.has(lookup.anchor)) {
      totals.non_anchor_name_queries++;totals.exact_non_anchor_name_queries+=Number(exact);
    }
    if(!exact) failures.push({opinion_id:source.opinion_id,anchor:lookup.anchor,kind:lookup.kind,actual_markup_start:lookup.markup_start,independent_matches:expected.length});
    details.push({opinion_id:source.opinion_id,anchor:lookup.anchor,kind:lookup.kind,exact,
      independent_id_matches:ids.get(lookup.anchor)?.length??0,independent_named_matches:names.get(lookup.anchor)?.length??0,
      browser_named_matches:browserNames.get(lookup.anchor)?.length??0,
      actual_markup_start:lookup.markup_start});
  }
}
if(native.length!==preparation.sources.length || gold.size!==preparation.sources.length) throw Error('Source cohort membership changed');
const report={schema:'courtlistener.named-source-query-comparison.v1',created_utc:new Date().toISOString(),totals,
  failures,details,browser_differences:browserDifferences,engine_source_sha256:nativeSummary.engine_source_sha256,query_source_sha256:nativeSummary.query_source_sha256,
  inputs:Object.fromEntries([[path.join(cohort,'preparation.json'),preparationBytes],[path.join(cohort,'browser-structure-gold.jsonl'),goldBytes],
    [path.join(cohort,'browser-structure-gold-summary.json'),goldSummaryBytes],[nativeFile,nativeBytes],
    [path.join(nativeDirectory,'summary.json'),nativeSummaryBytes],
    ...(baselineBytes?[[baselineFile,baselineBytes]]:[])].map(([file,bytes])=>[file,{bytes:bytes.length,sha256:digest(bytes)}])),
  comparator_sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  scope:'Actual original HTML opening identities and native source-local cached lookup results, independent cached DOM attributes. Original and reparsed DOM duplicate counts remain separate. IDs have priority in source-local lookup; raw duplicates stay conservative. No CourtListener deployed URL, natural scrolling, whole-graph DOM equivalence, namespace-general or unobserved collision claim.'};
fs.writeFileSync(path.join(nativeDirectory,'named-source-query-summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({totals,failures:failures.length}));
if(failures.length) process.exitCode=1;
