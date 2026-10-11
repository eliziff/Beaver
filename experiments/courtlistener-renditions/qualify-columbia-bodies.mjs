// Real retained corpus qualification. Run only inside the existing budget writer.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {zstdCompressSync, zstdDecompressSync} from 'node:zlib';

const base='benchmarks/local-data/courtlistener-renditions/';
const originalHome=base+'columbia-opinion-components/';
const home=base+'columbia-body-components/';
const executable='native/legal-structure-node/target/release/courtlistener-corpus.exe';
const guard=4406164480, growth=4194304, maximum=16777216;
const mode=process.argv[2], buildPath=process.argv[3];
if(!['freeze','candidate'].includes(mode)||!buildPath)throw Error('Usage: qualify-columbia-bodies.mjs freeze|candidate BUILD_JSON');
if(process.env.COURTLISTENER_BUDGET_WRITER!=='1'||process.env.COURTLISTENER_REQUIRED_BYTES!==String(guard+growth))throw Error('Existing budget writer and 4MiB admission required');
const sha=b=>createHash('sha256').update(b).digest('hex');
const relative=f=>path.relative(process.cwd(),path.resolve(f)).replaceAll('\\','/');
const proof=f=>{const b=fs.readFileSync(f);return{path:relative(f),bytes:b.length,sha256:sha(b)}};
function bound(p){const b=fs.readFileSync(p.path);if(b.length!==p.bytes||sha(b)!==p.sha256)throw Error('Frozen artifact differs: '+p.path);return b}
const canon=v=>Array.isArray(v)?'['+v.map(canon).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);
const same=(a,b)=>canon(a)===canon(b);
const measure=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?measure(path.join(d,e.name)):e.isFile()?fs.statSync(path.join(d,e.name)).size:0),0):0;
const initialBytes=measure(home), harness=proof(fileURLToPath(import.meta.url));
function admission(extra=0){const bytes=measure(home);if(bytes+extra>maximum||bytes-initialBytes+extra>growth)throw Error('Columbia body owner admission exceeded')}
function publish(name,value){const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n'),file=home+name;admission(b.length);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b,{flag:'wx'});return proof(file)}
const load=f=>{const p=proof(f);return{proof:p,value:JSON.parse(bound(p))}};
const rows=p=>zstdDecompressSync(bound(p)).toString('utf8').trimEnd().split('\n').map(JSON.parse);
function outputs(run){const records=run.outputs.find(p=>p.path.endsWith('/records.jsonl.zst')),summary=run.outputs.find(p=>p.path.endsWith('/summary.json'));if(!records||!summary)throw Error('Actual corpus outputs missing');return{records,summary}}

const allocation={schema:'courtlistener.bounded-columbia-body-allocation.v1',total_maximum_bytes:maximum,physical_guard_bytes:guard,admission_growth_bytes:growth,originals_retention:'Read existing hash-bound Columbia originals, CAP/named controls and complete sparse frames in their existing owners; no duplicate source files',scope:'Exactly matched Columbia body declarations; six crossing declarations remain generic and unresolved',tests_written_or_run:0};
let allocationProof;
if(mode==='freeze'){if(fs.existsSync(home))throw Error('Columbia body owner already exists; retain frozen work');allocationProof=publish('allocation.json',allocation)}else{allocationProof=proof(home+'allocation.json');if(!same(JSON.parse(bound(allocationProof)),allocation))throw Error('Columbia body allocation differs')}
const preparation=load(originalHome+'preparation.json'), gold=load(originalHome+'source-expectations.json');
const accepted=load(originalHome+'candidate-comparison.json'), priorCapture=load(originalHome+'run-candidate-provenance.json'), priorContract=load(originalHome+'candidate-contract.json');
if(!same(preparation.value.source_expectations,gold.proof)||!same(accepted.value.inputs.source_expectations,gold.proof)||!same(accepted.value.inputs.preparation,preparation.proof)||!same(accepted.value.inputs.candidate_capture,priorCapture.proof)||!same(accepted.value.inputs.candidate_contract,priorContract.proof)||accepted.value.status!=='passed'||accepted.value.diagnostics.length!==0||accepted.value.counts.exact_complete_candidate_records!==8||accepted.value.counts.exact_source_opinion_component_queries!==8||priorCapture.value.failures!==0||priorCapture.value.runs.length!==4||gold.value.counts.raw_source_elements!==2084||gold.value.counts.columbia_byline_declarations!==8||gold.value.counts.well_matched_body_declarations!==2||gold.value.counts.crossing_body_declarations!==6)throw Error('Accepted independent Columbia source qualification differs');
bound(accepted.value.inputs.scorer);
const build=load(buildPath), nativeBefore=proof(executable);
if(build.value.exit_code!==0||build.value.source_stable!==true||!same(build.value.native,nativeBefore))throw Error('Actual stable executable/build binding differs');
for(const [file,p]of Object.entries(build.value.source_after)){const actual=proof(file);if(actual.bytes!==p.bytes||actual.sha256!==p.sha256)throw Error('Stable build source differs: '+file)}
if(mode==='freeze'&&nativeBefore.sha256!=='506bd7dbdc868f0bcdece5044e91529ab710bdb35acf8d46147dbec47dedbeeb')throw Error('Expected accepted current producer differs before body edits');
const inputs={allocation:allocationProof,source_expectations:gold.proof,preparation:preparation.proof,accepted_source_comparison:accepted.proof,accepted_source_capture:priorCapture.proof,accepted_source_contract:priorContract.proof,harness};
const cohortInputs=preparation.value.cohorts.map(co=>{
 bound(co.manifest);
 const run=priorCapture.value.runs.find(r=>r.cohort===co.name),expected=priorContract.value.expected_cohorts.find(c=>c.cohort===co.name);
 if(!run||!expected||run.exit_code!==0||!same(run.argv.slice(0,4),co.prospective_before_argv.slice(0,4)))throw Error('Accepted cohort command/source differs');
 const out=outputs(run),oldRows=rows(out.records),expectedRaw=zstdDecompressSync(bound(expected.expected_candidate_records));
 if(expectedRaw.length!==expected.expected_raw_records.bytes||sha(expectedRaw)!==expected.expected_raw_records.sha256||!same(oldRows,expectedRaw.toString('utf8').trimEnd().split('\n').map(JSON.parse))||oldRows.length!==co.count)throw Error('Accepted complete cohort records differ');
 return{co,oldRows,oldSummary:JSON.parse(bound(out.summary))};
});
for(const g of gold.value.readings){const raw=bound(g.original),markup=g.capture.format==='cap-json'?Buffer.from(JSON.parse(raw).casebody.data):raw;if(markup.length!==g.engine_input_markup.bytes||sha(markup)!==g.engine_input_markup.sha256)throw Error('Complete original source input differs')}
const runs=[], captured=new Map();
function capture(profile){
 for(const {co}of cohortInputs){
  const output=home+profile+'/'+co.name;if(fs.existsSync(output))throw Error('Retain existing real corpus output: '+output);
  const argv=[executable,'source-run',co.manifest.path,co.corpus_home,output],started=performance.now();
  const result=spawnSync(argv[0],argv.slice(1),{cwd:process.cwd(),encoding:'utf8',windowsHide:true,maxBuffer:1048576});
  admission();if(result.error||result.status!==0)throw Error('Real corpus command failed: '+JSON.stringify({argv,status:result.status,error:result.error?.message,stderr:result.stderr}));
  const out={records:proof(output+'/records.jsonl.zst'),summary:proof(output+'/summary.json')},recordRows=rows(out.records),summary=JSON.parse(bound(out.summary));
  if(recordRows.length!==co.count||summary.records!==co.count||summary.errors!==0||summary.query_source_sha256!==build.value.source_after['legal-structure/query/src/document_query.rs'].sha256)throw Error('Actual corpus completeness/compiled query binding differs');
  runs.push({cohort:co.name,argv,exit_code:result.status,seconds:(performance.now()-started)/1000,stdout:result.stdout,stderr:result.stderr,outputs:[out.records,out.summary]});captured.set(co.name,{rows:recordRows,summary,out});
 }
 const nativeAfter=proof(executable);if(!same(nativeBefore,nativeAfter))throw Error('Actual producer changed during corpus capture');
 return publish(profile==='native-before'?'run-before-provenance.json':'run-candidate-provenance.json',{schema:'courtlistener.columbia-matched-body-real-run.v1',completed_utc:new Date().toISOString(),...inputs,executable:nativeBefore,executable_after:nativeAfter,build:build.proof,runs,failures:0,tests_written_or_run:0});
}
const scrubSummary=s=>{const out={...s};for(const name of ['seconds','engine_source_sha256','query_source_sha256'])delete out[name];return out};
if(mode==='freeze'){
 const beforeProof=capture('native-before'), diagnostics=[],expectedCohorts=[],deltas=[];
 let exactRecords=0,matchedBodies=0,crossingBodies=0,unownedBylines=0;
 for(const {co,oldRows,oldSummary}of cohortInputs){
  const before=captured.get(co.name),expected=[];
  if(!same(scrubSummary(before.summary),scrubSummary(oldSummary)))diagnostics.push({cohort:co.name,kind:'accepted-source-summary-changed'});
  for(let i=0;i<before.rows.length;i++){
   const r=before.rows[i],g=gold.value.readings.find(g=>g.key===co.name+'|'+i);if(!g)throw Error('Independent source reading missing');
   if(same(r,oldRows[i]))exactRecords++;else diagnostics.push({key:g.key,kind:'accepted-complete-record-changed',fields:[...new Set([...Object.keys(r),...Object.keys(oldRows[i])])].filter(k=>!same(r[k],oldRows[i][k]))});
   const source=bound(g.original),newSections=[],newOpinions=[];
   for(const d of g.columbia_role_declarations){
    const e=r.markup_elements[d.declaration.source_index];if(!e||e.markup_start!==d.declaration.opening_utf8.start||e.markup_end!==d.declaration.lexical_extent_utf8.end||e.tag!==d.declaration.raw_tag)throw Error('Independent role source extent differs');
    if(d.role==='literal-byline-declaration'){unownedBylines++;if(!r.source_opinion_components.unowned_authors.some(a=>same(a.source_element,e)&&a.author===null&&a.source_anchor===null))throw Error('Existing unowned byline lost');continue}
    if(d.lexical_scope_status!=='matched_exact_role_close'){crossingBodies++;continue}
    matchedBodies++;
    const closing=d.declaration.lexical_closing_utf8;
    if(g.key!=='columbia3|2'||![1049,74814].includes(e.markup_start)||e.parent!==null||Object.keys(e.attributes).length||d.ancestral_body_source_indexes.length||!closing||source.subarray(closing.start,closing.end).toString('utf8')!==d.declaration.lexical_closing_literal||!new RegExp('^<\\s*/\\s*'+d.declaration.tag+'\\s*>$','i').test(d.declaration.lexical_closing_literal))throw Error('Exact matched body contract differs');
    const node={id:'native-markup-'+e.markup_start,kind:'section',range:e.range,origin_id:'provider-adapter',source:'native',markup_tag:e.tag.toLowerCase(),markup_start:e.markup_start};
    if(r.native_structures.some(n=>n.source==='native'&&n.markup_start===e.markup_start))throw Error('Matched body was already projected');
    newSections.push(node);newOpinions.push({opinion:node,source_anchor:null,parent_opinion_id:null,authors:[]});
   }
   deltas.push({key:g.key,additional_native_sections:newSections,additional_source_opinions:newOpinions});
   expected.push({...r,native_structures:[...r.native_structures.filter(n=>n.source==='native'),...newSections,...r.native_structures.filter(n=>n.source!=='native')],source_opinion_components:{...r.source_opinion_components,opinions:[...r.source_opinion_components.opinions,...newOpinions].sort((a,b)=>a.opinion.markup_start-b.opinion.markup_start)}});
  }
  const raw=Buffer.from(expected.map(r=>JSON.stringify(r)).join('\n')+'\n');expectedCohorts.push({cohort:co.name,count:co.count,manifest:co.manifest,corpus_home:co.corpus_home,before:before.out,before_summary:before.summary,expected_candidate_records:publish('expected-candidate/'+co.name+'/records.jsonl.zst',zstdCompressSync(raw)),expected_raw_records:{bytes:raw.length,sha256:sha(raw)}});
 }
 if(exactRecords!==8||matchedBodies!==2||crossingBodies!==6||unownedBylines!==8)diagnostics.push({kind:'frozen-membership-or-before-correspondence-differs',exactRecords,matchedBodies,crossingBodies,unownedBylines});
 const comparison=publish(diagnostics.length?'before-comparison.failed.json':'before-comparison.json',{schema:'courtlistener.columbia-matched-body-before-comparison.v1',status:diagnostics.length?'failed':'passed',completed_utc:new Date().toISOString(),inputs:{...inputs,before_provenance:beforeProof},counts:{exact_complete_records:exactRecords,generic_elements:2084,matched_bodies:matchedBodies,unresolved_crossing_bodies:crossingBodies,unowned_bylines:unownedBylines},diagnostics,source_correspondence:'Complete current records exactly match the accepted independent source correspondence. Original raw UTF8 role scopes are independent gold; unchanged rendered UTF16 ranges are qualified producer observations.',tests_written_or_run:0});
 if(diagnostics.length)throw Error('Current producer differs from accepted source qualification; retain failed comparison');
 const contract=publish('candidate-contract.json',{schema:'courtlistener.columbia-matched-body-complete-record-contract.v1',status:'frozen-before-rust-edits',completed_utc:new Date().toISOString(),inputs:{...inputs,before_provenance:beforeProof,before_comparison:comparison},expected_cohorts:expectedCohorts,exact_source_supported_deltas:deltas,expected_additional_native_sections:2,expected_additional_source_opinions:2,only_record_delta:'Exactly two post-render Native Sections for the genuinely matched opinion_text and dissent_text declarations, plus two sourceOpinionComponents using those same Sections. All other complete record values remain exact.',body_scope_contract:'Six body declarations closed by enclosing paragraph tags stay generic and unresolved. Eight bylines remain unowned. No author/type/anchor/parent opinion is inferred. Empty Native markup attributes and empty type_declarations remain omitted by existing serialization. Text, generic source graph, ranges, notes, outlines, all existing nodes/parents and every other query remain exact.',tests_written_or_run:0});
 publish('README.md',Buffer.from('# Matched Columbia body qualification\n\nThis private owner reuses the existing independently frozen eight-field Columbia corpus and accepted source-role qualification. It stores one current-producer before and one frozen expected additive contract. Originals and all22 source-row values remain in their prior durable owners.\n\nThe contract allows exactly two Sections and two source opinion components from genuinely matched body declarations. Six crossing body declarations remain unresolved; eight bylines remain unowned. Rendered ranges are unchanged prior-producer observations, not independently reconstructed rendering gold. All other complete record values must remain exact.\n\nRun the repository harness experiments/courtlistener-renditions/qualify-columbia-bodies.mjs inside budget.writer with COURTLISTENER_BUDGET_WRITER=1 and require_bytes(4406164480+4194304), passing freeze or candidate and the actual stable build receipt. The harness refuses to overwrite frozen files. No downloads, browser navigation, builds or tests are performed by this harness.\n'));
 console.log(JSON.stringify({status:'frozen',before:beforeProof,comparison,contract,owner_bytes:measure(home),matchedBodies,crossingBodies,unownedBylines}));
}else{
 const contract=load(home+'candidate-contract.json');if(!same(contract.value.inputs.harness,harness)||!same(contract.value.inputs.source_expectations,gold.proof)||!same(contract.value.inputs.preparation,preparation.proof))throw Error('Frozen body candidate contract differs');
 const before=JSON.parse(bound(contract.value.inputs.before_provenance));bound(contract.value.inputs.before_comparison);
 const candidateProof=capture('native-candidate'),diagnostics=[],summaries=[];
 let exactRecords=0,exactQueries=0,additionalSections=0,additionalOpinions=0;
 for(const co of contract.value.expected_cohorts){
  const actual=captured.get(co.cohort),expectedRaw=zstdDecompressSync(bound(co.expected_candidate_records));if(expectedRaw.length!==co.expected_raw_records.bytes||sha(expectedRaw)!==co.expected_raw_records.sha256)throw Error('Frozen complete expected body records differ');
  const expected=expectedRaw.toString('utf8').trimEnd().split('\n').map(JSON.parse),old=rows(co.before.records);if(expected.length!==co.count||old.length!==co.count)throw Error('Frozen cohort membership differs');
  for(let i=0;i<actual.rows.length;i++){
   const a=actual.rows[i],e=expected[i];if(same(a,e))exactRecords++;else diagnostics.push({key:co.cohort+'|'+i,kind:'complete-record-values-differ',fields:[...new Set([...Object.keys(a),...Object.keys(e)])].filter(k=>!same(a[k],e[k])),expected_sha256:sha(Buffer.from(canon(e))),actual_sha256:sha(Buffer.from(canon(a)))});
   if(same(a.source_opinion_components,e.source_opinion_components))exactQueries++;else diagnostics.push({key:co.cohort+'|'+i,kind:'source-opinion-query-differs'});
   additionalSections+=a.native_structures.filter(n=>n.source==='native'&&n.kind==='section').length-old[i].native_structures.filter(n=>n.source==='native'&&n.kind==='section').length;
   additionalOpinions+=a.source_opinion_components.opinions.length-old[i].source_opinion_components.opinions.length;
  }
  if(!same(scrubSummary(actual.summary),scrubSummary(co.before_summary)))diagnostics.push({cohort:co.cohort,kind:'summary-values-differ'});
  summaries.push({cohort:co.cohort,summary:actual.out.summary,engine_source_sha256:actual.summary.engine_source_sha256,query_source_sha256:actual.summary.query_source_sha256,seconds:actual.summary.seconds});
 }
 if(exactRecords!==8||exactQueries!==8||additionalSections!==2||additionalOpinions!==2)diagnostics.push({kind:'candidate-counts-differ',exactRecords,exactQueries,additionalSections,additionalOpinions});
 const comparison=publish(diagnostics.length?'candidate-comparison.failed.json':'candidate-comparison.json',{schema:'courtlistener.columbia-matched-body-candidate-comparison.v1',status:diagnostics.length?'failed':'passed',completed_utc:new Date().toISOString(),inputs:{...inputs,candidate_contract:contract.proof,candidate_capture:candidateProof,before_provenance:contract.value.inputs.before_provenance},before_executable:before.executable,candidate_executable:nativeBefore,candidate_build:build.proof,counts:{exact_complete_records:exactRecords,exact_source_opinion_queries:exactQueries,additional_native_sections:additionalSections,additional_source_opinions:additionalOpinions},diagnostics,summary_producer_observations:summaries,performance:{before_native_process_seconds:before.runs.reduce((n,r)=>n+r.seconds,0),candidate_native_process_seconds:runs.reduce((n,r)=>n+r.seconds,0),speedup_claimed:false},body_scope_contract:contract.value.body_scope_contract,tests_written_or_run:0});
 console.log(JSON.stringify({status:diagnostics.length?'failed':'passed',comparison,exactRecords,exactQueries,additionalSections,additionalOpinions,diagnostics:diagnostics.length,owner_bytes:measure(home)}));if(diagnostics.length)process.exitCode=1;
}
