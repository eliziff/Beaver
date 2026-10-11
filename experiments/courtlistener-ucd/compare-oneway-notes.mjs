// Actual retained-source corpus comparison. Publish under budget.writer().
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {isDeepStrictEqual as same} from 'node:util';

const [cohort,candidateDirectory,...extra]=process.argv.slice(2);
if(!cohort||!candidateDirectory||extra.length)
  throw Error('Supply original cohort and candidate source-run directories');
const priorDirectory=path.join(cohort,'native-observed-61c1');
if(path.resolve(priorDirectory)===path.resolve(candidateDirectory))
  throw Error('Candidate must not replace the frozen observation directory');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const relative=file=>path.relative(process.cwd(),path.resolve(file)).replaceAll('\\','/');
const inputs=new Map();
const descriptor=file=>{
  const actual=file instanceof URL?fileURLToPath(file):file;
  const bytes=fs.readFileSync(actual),proof={file:relative(actual),bytes:bytes.length,sha256:hash(bytes)};
  inputs.set(path.resolve(actual),proof);return proof;
};
const json=file=>{descriptor(file);return JSON.parse(fs.readFileSync(file,'utf8'));};
const verify=input=>{
  const file=input.file??input.path,actual=descriptor(file);
  if(actual.bytes!==input.bytes||actual.sha256!==input.sha256)
    throw Error('Frozen input changed: '+file);
};
const records=directory=>{
  const file=path.join(directory,'records.jsonl.zst');descriptor(file);
  return zstdDecompressSync(fs.readFileSync(file)).toString('utf8').trimEnd().split('\n')
    .map(line=>({line,value:JSON.parse(line)}));
};
const identity=row=>JSON.stringify([row.source_capture.opinion_id,row.source_capture.cluster_id,
  row.source_capture.field,row.html_sha256,row.body_index]);
const valueProof=value=>{
  const bytes=Buffer.from(JSON.stringify(value)??'<absent>');
  return {bytes:bytes.length,sha256:hash(bytes),type:value===null?'null':typeof value};
};
const reviewFile=path.join(cohort,'oneway-footnote-review.json'),reviewProof=descriptor(reviewFile);
if(reviewProof.sha256!=='2f4e95bc35eece8981de0ee18dad91c44f059fa40863a16c093e6398f03a2743')
  throw Error('Frozen independent one-way source review changed');
const review=json(reviewFile);
for(const input of review.inputs)verify(input);
verify(review.selected_source.complete_original);
const original=fs.readFileSync(review.selected_source.complete_original.file);
const originalText=original.toString('utf8');
const sourceSpan=span=>{
  const bytes=original.subarray(span.raw_utf8.start,span.raw_utf8.end);
  if(bytes.length!==span.bytes||hash(bytes)!==span.sha256||bytes.toString('utf8')!==span.literal
      ||originalText.slice(span.raw_utf16.start,span.raw_utf16.end)!==span.literal)
    throw Error('Independent raw source span changed');
};
const priorProvenance=json(path.join(priorDirectory,'run-provenance.json'));
if(priorProvenance.executable.sha256!==review.native_producer.executable.sha256
    ||priorProvenance.executable.sha256!=='bd9182c4f82f77ddf6fd619c865cc22dbf041ae9743872b3452e8e464f995df8'
    ||priorProvenance.command.exit_code!==0)
  throw Error('Frozen prior observation is not the reviewed bd producer');
for(const input of priorProvenance.inputs)verify(input);
for(const output of priorProvenance.outputs)verify(output);
const prior=records(priorDirectory),candidate=records(candidateDirectory);
const oldSummary=json(path.join(priorDirectory,'summary.json'));
const summary=json(path.join(candidateDirectory,'summary.json'));
if(oldSummary.errors||oldSummary.engine_source_sha256!==review.native_producer.engine_source_sha256
    ||oldSummary.engine_source_sha256!=='61c1e71f2471a32d96cf9a683839fb022461f623e8223817902071b4cfef12c7'
    ||oldSummary.query_source_sha256!==review.native_producer.query_source_sha256)
  throw Error('Prior observation producer differs from the source review');
const failures=[],details=[],counts={records:0,unchanged_records:0,new_footnote_nodes:0,
  new_notes:0,new_label_ranges:0,new_typed_body_queries:0,new_references:0};
const expect=(condition,kind,context={})=>{if(!condition)failures.push({kind,...context});};
expect(prior.length===11&&candidate.length===11,'record-count');
expect(new Set(prior.map(row=>identity(row.value))).size===prior.length
  &&new Set(candidate.map(row=>identity(row.value))).size===candidate.length,'duplicate-record-identity');
expect(same(prior.map(row=>identity(row.value)),candidate.map(row=>identity(row.value))),
  'ordered-original-membership');
// Compare every observed query result below; producer identity can change when
// another independently measured query capability is corrected.
expect(typeof summary.query_source_sha256==='string'&&/^[0-9a-f]{64}$/u.test(summary.query_source_sha256),
  'candidate-query-digest');
expect(typeof summary.engine_source_sha256==='string'&&/^[0-9a-f]{64}$/u.test(summary.engine_source_sha256),
  'candidate-engine-digest');
const expectedSummary={...oldSummary,engine_source_sha256:summary.engine_source_sha256,
  query_source_sha256:summary.query_source_sha256,seconds:summary.seconds};
expect(same(expectedSummary,summary),'summary-contract-difference');
const byIdentity=new Map(candidate.map(row=>[identity(row.value),row.value]));
for(const {line,value:old} of prior){
  counts.records++;
  verify({file:path.join(cohort,old.source_capture.corpus_path),bytes:old.source_capture.bytes,
    sha256:old.source_capture.sha256});
  const key=identity(old),current=byIdentity.get(key),context={identity:JSON.parse(key)};
  if(!current){expect(false,'original-omitted',context);continue;}
  const expected=structuredClone(old),selected=old.html_sha256===review.selected_source.complete_original.sha256
    &&old.source_capture.opinion_id===review.selected_source.opinion_id
    &&old.source_capture.field===review.selected_source.field;
  if(selected){
    if(Buffer.byteLength(line)!==review.native_producer.selected_record_raw_json_bytes
        ||hash(Buffer.from(line))!==review.native_producer.selected_record_raw_json_sha256
        ||old.notes.length||old.note_label_queries.length||old.native_pinpoint_queries.length)
      throw Error('Frozen selected observation differs from the reviewed baseline');
    if(review.notes.length!==2)throw Error('Independent two-note review is incomplete');
    for(const witness of review.notes){
      const source=witness.independent_source_facts,observed=witness.frozen_native_observations;
      for(const span of [source.complete_paragraph,source.named_target_complete,source.named_target_opening,
        source.printed_label_digit_text_node,source.complete_body_source_markup_tail])sourceSpan(span);
      if(source.unique_named_target_count!==1||source.id_collision_count||source.backlink_count
          ||!source.reciprocal_link_missing||source.named_target_opening.literal!==`<a name="${witness.name}">`
          ||source.printed_label_digit_text_node.literal!==witness.number)
        throw Error('Independent unique target/label admission differs');
      for(const [kind,element] of [['paragraph',observed.paragraph],['named target',observed.named_target],
        ['label',observed.label_span],['earlier reference',observed.earlier_reference]]){
        const {source_index,...frozen}=element;
        if(!same(old.markup_elements[source_index],frozen))
          throw Error('Frozen '+kind+' source-element annotation differs');
      }
      const label=observed.label_range_observed_61c1;
      const body=observed.body_range_after_label_to_paragraph_end_observed_61c1;
      if(!same(label,observed.label_span.range)||body.start!==label.end||body.end!==observed.paragraph.range.end
          ||old.text.slice(label.start,label.end)!==witness.number
          ||old.text.slice(body.start,body.end)!==observed.body_text_observed_61c1)
        throw Error('Frozen printed label/full paragraph body coordinates differ');
      const markupStart=source.named_target_opening.raw_utf8.start,nodeId='native-markup-'+markupStart;
      if(old.native_structures.some(node=>node.id===nodeId)
          ||!same(old.native_structures.filter(node=>node.markup_start===observed.paragraph.markup_start),
            observed.source_prose_node))throw Error('New identity collides or prior P prose differs');
      const node={id:nodeId,kind:'footnote',range:structuredClone(body),origin_id:'provider-adapter',
        source:'native',label:'fn'+witness.number,anchor:witness.name,markup_tag:'a',markup_start:markupStart,
        markup_attributes:{name:witness.name},marker_range:structuredClone(label)};
      const note={id:'note-'+nodeId,node_id:nodeId,kind:'footnote',label_range:structuredClone(label),
        body_range:structuredClone(body),references:[]};
      const typed={node_id:nodeId,kind:'footnote',label:node.label,resolves:true,
        selected:[{label:node.label,start:body.start,end:body.end}]};
      expected.native_structures.push(node);expected.notes.push(note);expected.native_pinpoint_queries.push(typed);
      counts.new_footnote_nodes+=current.native_structures.filter(value=>value.id===nodeId&&value.kind==='footnote').length;
      counts.new_notes+=current.notes.filter(value=>value.id===note.id).length;
      counts.new_label_ranges+=current.notes.filter(value=>value.id===note.id&&same(value.label_range,label)).length;
      counts.new_typed_body_queries+=current.native_pinpoint_queries.filter(value=>same(value,typed)).length;
      details.push({...context,number:witness.number,node_id:nodeId,source_anchor:witness.name,
        markup_start:markupStart,label_range:label,body_range:body,prior_generic_named_anchor_range:observed.named_target.range,
        prior_prose_node_ids:observed.source_prose_node.map(node=>node.id),references:[],primary_reference:'absent',
        generic_source_note_label_query:'unavailable: named A includes prose, so it does not equal the printed label range'});
    }
    counts.new_references=current.notes.reduce((n,note)=>n+note.references.length,0);
  }
  const changedKeys=[...new Set([...Object.keys(expected),...Object.keys(current)])]
    .filter(field=>!same(expected[field],current[field]));
  for(const field of changedKeys)expect(false,'record-field-difference',{...context,field,
    expected:valueProof(expected[field]),actual:valueProof(current[field])});
  if(selected)for(const field of ['native_structures','notes','native_pinpoint_queries']){
    const actualById=new Map(current[field].map(value=>[value.id??value.node_id,value]));
    for(const value of expected[field])if(!same(value,actualById.get(value.id??value.node_id)))
      failures.push({kind:'semantic-value-difference',...context,field,id:value.id??value.node_id,
        expected:value,actual:actualById.get(value.id??value.node_id)??null});
  }
  if(!selected)counts.unchanged_records+=Number(same(old,current));
}
const expectedCounts={records:11,unchanged_records:10,new_footnote_nodes:2,new_notes:2,
  new_label_ranges:2,new_typed_body_queries:2,new_references:0};
expect(same(counts,expectedCounts),'exact-recovery-control-counts',{counts});
const report={schema:'courtlistener.oneway-note-comparison.v1',created_utc:new Date().toISOString(),
  engine_source_sha256:summary.engine_source_sha256,query_source_sha256:summary.query_source_sha256,
  prior_engine_source_sha256:oldSummary.engine_source_sha256,
  prior_executable_sha256:priorProvenance.executable.sha256,expected_counts:expectedCounts,counts,details,
  failures,failure_count:failures.length,inputs:[...inputs.values()],comparator:descriptor(new URL(import.meta.url)),
  expectation_scope:'Exact independent 2f4e source admission plus frozen 61c1/bd coordinate observations; candidate coordinates never define expectations.',
  body_policy:'New typed Footnotes use observed label.end through independently selected simple P end, preserving post-label whitespace. Metadata/node identity belongs to the actual named A; prior P Prose and generic A ranges remain unchanged.',
  reference_policy:'New Notes have references=[] and no primary_reference. Absolute one-way file hrefs remain literal in the unchanged generic graph; destination identity is unadjudicated.',
  label_query_policy:'The unchanged source_note_label API matches a whole source element to the printed label. These nonempty named A elements include prose, so note_label_queries remains empty; typed Footnote queries select complete reviewed paragraph bodies.',
  scope:'Eleven complete originals, ten whole-record controls. Only two exact appended Footnote nodes, Notes and typed body queries may change. Every other per-record field and prior node stays equal. Summary changes allow only engine digest and timing; query digest stays fixed. No DOM gold, URI-locality, deployed-navigation or unseen-layout claim.'};
const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
if(bytes.length>1024*1024)throw Error('Bounded comparison receipt exceeded');
const output=path.join(candidateDirectory,'oneway-note-comparison.json'),pending=output+'.next';
try{fs.writeFileSync(pending,bytes,{flag:'wx'});fs.renameSync(pending,output);}
finally{if(fs.existsSync(pending))fs.unlinkSync(pending);}
console.log(JSON.stringify({file:relative(output),bytes:bytes.length,sha256:hash(bytes),counts,failure_count:failures.length}));
if(failures.length)process.exitCode=1;
