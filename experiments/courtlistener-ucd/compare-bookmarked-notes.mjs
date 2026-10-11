// Actual retained-source corpus comparison. Run publication under budget.writer().
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {isDeepStrictEqual as same} from 'node:util';

const [cohort,candidateDirectory,controls,controlsCandidateDirectory,breadth,breadthCandidateDirectory,...extra]=process.argv.slice(2);
if(!cohort||!candidateDirectory||!controls||!controlsCandidateDirectory||!breadth||!breadthCandidateDirectory||extra.length)
  throw Error('Supply source cohort/candidate, control cohort/candidate and breadth cohort/candidate directories');
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
  if(actual.bytes!==input.bytes||actual.sha256!==input.sha256)throw Error('Frozen input changed: '+file);
};
const records=directory=>{
  const file=path.join(directory,'records.jsonl.zst');descriptor(file);
  return zstdDecompressSync(fs.readFileSync(file)).toString('utf8').trim().split('\n').map(JSON.parse);
};
const identity=row=>JSON.stringify([row.source_capture.opinion_id,row.source_capture.cluster_id,
  row.source_capture.field,row.html_sha256,row.body_index]);
const reviewFile=path.join(breadth,'declared-note-label-review.json'),reviewProof=descriptor(reviewFile);
if(reviewProof.sha256!=='4f9bc9bee0a1639c15b9ce6e21c38f6b5c39f0f7c027919215ec05f7132837d1')
  throw Error('Expected corrected independent source review changed');
const review=json(reviewFile);
for(const input of review.inputs)verify(input);
for(const source of review.sources)verify(source.complete_original);
const provenanceFile=path.join(cohort,'native-word-candidate','run-provenance.json'),provenance=json(provenanceFile);
if(provenance.executable.sha256!=='baf65aa862f72ef436c57e9f3b6594c29ab41f15df0300162d684da2c8d05616'
    ||provenance.comparison_exit_code!==0)throw Error('Frozen prior Word run is not the approved baf producer');
const priorProofs=new Map(provenance.files.map(p=>[path.resolve(p.path),p]));
const groups=[
  {name:'originals',owner:cohort,directory:candidateDirectory,count:3},
  {name:'controls',owner:controls,directory:controlsCandidateDirectory,count:2},
  {name:'breadth',owner:breadth,directory:breadthCandidateDirectory,count:5},
];
const failures=[],details=[],counts={records:0,unchanged_records:0,label_body_updates:0,new_references:0};
const expect=(condition,kind,context={})=>{if(!condition)failures.push({kind,...context});};
const valueProof=value=>{
  const bytes=Buffer.from(JSON.stringify(value)??'<absent>');
  return {bytes:bytes.length,sha256:hash(bytes),type:value===null?'null':typeof value};
};
let producer=null;
for(const group of groups){
  const priorDirectory=path.join(group.owner,'native-word-candidate');
  if(path.resolve(priorDirectory)===path.resolve(group.directory))throw Error('Candidate must not replace the frozen Word directory');
  for(const name of ['records.jsonl.zst','summary.json']){
    const file=path.join(priorDirectory,name),proof=priorProofs.get(path.resolve(file));
    if(!proof)throw Error('Prior Word output missing from frozen run provenance: '+file);
    verify(proof);
  }
  const before=records(priorDirectory),after=records(group.directory);
  const oldSummary=json(path.join(priorDirectory,'summary.json')),summary=json(path.join(group.directory,'summary.json'));
  if(oldSummary.errors||oldSummary.engine_source_sha256!==provenance.engine_source_sha256
      ||oldSummary.query_source_sha256!==provenance.query_source_sha256)
    throw Error('Prior Word producer differs from the frozen run');
  expect(summary.errors===0,'candidate-errors',{group:group.name,errors:summary.errors});
  expect(summary.records===group.count&&before.length===group.count&&after.length===group.count,'record-count',{group:group.name});
  expect(summary.markup_bytes===oldSummary.markup_bytes,'original-source-byte-count',{group:group.name});
  if(!producer)producer={engine_source_sha256:summary.engine_source_sha256,query_source_sha256:summary.query_source_sha256};
  expect(summary.engine_source_sha256===producer.engine_source_sha256
    &&summary.query_source_sha256===producer.query_source_sha256,'candidate-producer-parity',{group:group.name});
  expect(new Set(before.map(identity)).size===before.length&&new Set(after.map(identity)).size===after.length,
    'duplicate-record-identity',{group:group.name});
  expect(same(before.map(identity),after.map(identity)),'ordered-original-membership',{group:group.name});
  const next=new Map(after.map(row=>[identity(row),row]));
  for(const old of before){
    counts.records++;
    verify({file:path.join(group.owner,old.source_capture.corpus_path),
      bytes:old.source_capture.bytes,sha256:old.source_capture.sha256});
    const key=identity(old),current=next.get(key),context={group:group.name,identity:JSON.parse(key)};
    if(!current){expect(false,'original-omitted',context);continue;}
    const expected=structuredClone(old);
    const source=group.name==='breadth'?review.sources.find(s=>s.complete_original.sha256===old.html_sha256
      &&s.opinion_id===old.source_capture.opinion_id&&s.field===old.source_capture.field):null;
    const modifies=source?.whole_baseline_current_record_equal&&source.notes.length>0;
    if(modifies){
      const original=fs.readFileSync(source.complete_original.file);
      for(const witness of source.notes){
        if(!witness.independently_supported_printed_label||witness.current_notes.length!==1)
          throw Error('Independent declared-owner label review is incomplete');
        const frozenNote=witness.current_notes[0],note=expected.notes.find(n=>n.id===frozenNote.id);
        if(!note||!same(note,frozenNote)||!same(witness.current_owner,witness.baseline_owner))
          throw Error('Frozen prior Word Note/owner differs from the independently reviewed baseline');
        const label=witness.source_supported_label_range_observed_9521;
        if(!same(label,witness.printed_label.baseline.rendered_utf16)
            ||old.text.slice(label.start,label.end)!==witness.printed_label.printed_text_trimmed)
          throw Error('Frozen printed label disagrees with prior rendered coordinates');
        for(const span of witness.printed_label.printed_digit_text_node_spans){
          const bytes=original.subarray(span.raw_source_utf8.start,span.raw_source_utf8.end);
          if(bytes.length!==span.bytes||hash(bytes)!==span.sha256||bytes.toString('utf8')!==span.literal)
            throw Error('Corrected literal printed digit source span changed');
        }
        // Preserve all whitespace after the label, matching the approved Word policy.
        const body={start:label.end,end:frozenNote.body_range.end};
        note.label_range=structuredClone(label);note.body_range=body;
        const references=[];
        for(const start of witness.strict_equal_printed_marker_reciprocal_reference_links){
          const link=source.file_fragment_links.find(l=>l.source_utf16_start===start);
          if(!link||link.baseline.status!=='present'||!same(link.baseline,link.current))
            throw Error('Frozen reference coordinate observation changed');
          const range=link.baseline.rendered_utf16,anchor='_ftnref'+witness.number;
          const marker=link.first_sup??link.word_class_marker;
          if(marker?.number!==witness.printed_label.number||old.text.slice(range.start,range.end)!==marker.number
              ||!link.origin_named_identifiers.includes(anchor)||link.exact_named_target_count!==1)
            throw Error('Independent reference marker or bookmark disagrees with the frozen prior text');
          references.push({range:structuredClone(range),anchor});
        }
        if(references.length){
          note.references=references;note.primary_reference=structuredClone(references[0].range);
        }
        expect(note.references.length===references.length,'unexpected-prior-reference',{...context,number:witness.number});
        counts.label_body_updates++;counts.new_references+=references.length;
        details.push({...context,number:witness.number,note_id:note.id,node_id:note.node_id,
          label_range:label,body_range:body,reference_ranges:references,
          reviewed_trimmed_body_annotation_unused:witness.source_supported_body_range_observed_9521,
          printed_label_raw_sha256:witness.printed_label.whole.sha256,
          source_reference_printed_conflicts_preserved:witness.reference_links_outside_notes.filter(start=>{
            const link=source.file_fragment_links.find(l=>l.source_utf16_start===start);
            const marker=link.first_sup??link.word_class_marker;
            return marker?.number&&marker.number!==witness.printed_label.number;
          })});
      }
    }
    const changedKeys=[...new Set([...Object.keys(expected),...Object.keys(current)])].filter(k=>!same(expected[k],current[k]));
    for(const field of changedKeys)expect(false,'record-field-difference',{...context,field,
      expected:valueProof(expected[field]),actual:valueProof(current[field])});
    if(changedKeys.includes('notes')){
      const actualNotes=new Map(current.notes.map(note=>[note.id,note]));
      for(const note of expected.notes)if(!same(note,actualNotes.get(note.id)))
        failures.push({kind:'semantic-note-difference',...context,note_id:note.id,expected_note:note,actual_note:actualNotes.get(note.id)??null});
    }
    if(!modifies)counts.unchanged_records+=Number(same(old,current));
  }
}
expect(counts.records===10&&counts.unchanged_records===8,'unchanged-record-total',counts);
expect(counts.label_body_updates===78&&counts.new_references===9,'exact-expected-recovery-counts',counts);
const report={schema:'courtlistener.bookmarked-note-comparison.v1',created_utc:new Date().toISOString(),
  ...producer,prior_word_executable_sha256:provenance.executable.sha256,
  expected_counts:{records:10,unchanged_records:8,label_body_updates:78,new_references:9},counts,
  details,failures,failure_count:failures.length,inputs:[...inputs.values()],
  comparator:descriptor(new URL(import.meta.url)),
  body_policy:'Expected body.start equals independently frozen printed label.end; body.end equals frozen prior Word Note.body_range.end. Post-label whitespace is preserved. The review trimmed-body annotation is retained as unused context.',
  prior_plain_sup_review_use:'Hash/provenance and retained erratum only; its erroneous nested-markup printed_digit_span is never used as expected gold.',
  scope:'Ten exact original fields. Only independently expected Notes changes; complete text, node graph, source metadata, generic markup, literal hrefs and all query results otherwise equal prior baf Word output. Summary engine/query fingerprints and timing may change; no per-record field exemptions. No DOM-gold, URL-locality, deployed navigation or unseen-layout claim.'};
const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
if(bytes.length>1024*1024)throw Error('Bounded comparison receipt exceeded');
const output=path.join(candidateDirectory,'bookmarked-note-comparison.json'),pending=output+'.next';
try{fs.writeFileSync(pending,bytes,{flag:'wx'});fs.renameSync(pending,output);}
finally{if(fs.existsSync(pending))fs.unlinkSync(pending);}
console.log(JSON.stringify({file:relative(output),bytes:bytes.length,sha256:hash(bytes),counts,failure_count:failures.length}));
if(failures.length)process.exitCode=1;
