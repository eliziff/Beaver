// Compare actual preserved Word source output with its frozen source review.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';

const [cohort,candidateDirectory,controls,controlsCandidateDirectory,breadth,breadthCandidateDirectory]=process.argv.slice(2);
if(!cohort || !candidateDirectory) throw Error('Supply the original Word cohort and actual candidate directory');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const descriptor=file=>{const bytes=fs.readFileSync(file);return {file,bytes:bytes.length,sha256:hash(bytes)};};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const records=directory=>zstdDecompressSync(fs.readFileSync(path.join(directory,'records.jsonl.zst')))
  .toString('utf8').trim().split('\n').map(JSON.parse);
const same=isDeepStrictEqual;
const reviewFile=path.join(cohort,'word-reference-review.json'),review=json(reviewFile);
if(review.failure_count!==0 || !review.conclusion.semantic_note_reference_supplement_supported)
  throw Error('Frozen independent Word review incomplete');
for(const input of review.inputs) {
  const actual=descriptor(input.path);
  if(actual.bytes!==input.bytes || actual.sha256!==input.sha256) throw Error('Frozen review input changed: '+input.path);
}
const priorDirectory=path.join(cohort,'native-notes-candidate');
const prior=records(priorDirectory),candidate=records(candidateDirectory);
const summary=json(path.join(candidateDirectory,'summary.json'));
if(summary.errors || prior.length!==candidate.length) throw Error('Native source membership/error mismatch');
const failures=[],details=[],inputs=[reviewFile,path.join(priorDirectory,'records.jsonl.zst'),
  path.join(candidateDirectory,'records.jsonl.zst'),path.join(candidateDirectory,'summary.json')];
const expect=(ok,kind,number)=>{if(!ok) failures.push({kind,number});};
let unchangedSources=0,unchangedControls=0;
for(const old of prior) {
  const current=candidate.find(row=>row.html_sha256===old.html_sha256 && row.body_index===old.body_index);
  if(!current) throw Error('Retained original omitted');
  if(old.html_sha256!==review.source.source_sha256) {
    expect(same(old,current),'other-original-full-parity');unchangedSources+=Number(same(old,current));continue;
  }
  for(const key of new Set([...Object.keys(old),...Object.keys(current)]))
    if(key!=='notes' && key!=='native_pinpoint_queries') expect(same(old[key],current[key]),'prior-'+key+'-changed');
  expect(current.notes.length===review.pairs.length,'note-membership');
  for(const pair of review.pairs) {
    const original=pair.current_typed_note,note=current.notes.find(value=>value.node_id===original.node_id);
    const label=pair.backward_printed_label.native_observation.range;
    const reference=pair.forward_reference.native_observation.range;
    // Source/DOM printed labels are independent; rendered coordinates belong
    // to the frozen prior receipt whose complete text must remain identical.
    expect(pair.forward_reference.printed_source_labels.length===1
      && pair.backward_printed_label.printed_source_labels.length===1
      && pair.forward_reference.printed_source_labels[0].text===old.text.slice(reference.start,reference.end)
      && pair.backward_printed_label.printed_source_labels[0].text===old.text.slice(label.start,label.end),
      'independent-printed-label-equality',pair.number);
    const body={start:label.end,end:original.body_range.end};
    const anchor=pair.reference_named_bookmark.attributes.name;
    const expected={...original,label_range:label,body_range:body,primary_reference:reference,
      references:[{range:reference,anchor}]};
    expect(same(note,expected),'exact-semantic-note',pair.number);
    const before=old.native_pinpoint_queries.find(query=>query.node_id===original.node_id);
    const after=current.native_pinpoint_queries.find(query=>query.node_id===original.node_id);
    expect(same(before,after),'native-owner-query-parity',pair.number);
    details.push({number:pair.number,node_id:original.node_id,label_range:label,body_range:body,
      reference_range:reference,reference_anchor:anchor,literal_href:pair.forward_reference.decoded_href_attribute,
      href_destination_certified:false});
  }
  expect(same(old.native_pinpoint_queries,current.native_pinpoint_queries),'all-native-owner-query-parity');
}
if(controls || controlsCandidateDirectory) {
  if(!controls || !controlsCandidateDirectory) throw Error('Supply both control directories');
  const controlSummary=json(path.join(controlsCandidateDirectory,'summary.json'));
  const previous=records(path.join(controls,'native-notes-candidate')),next=records(controlsCandidateDirectory);
  if(controlSummary.errors || previous.length!==next.length || controlSummary.engine_source_sha256!==summary.engine_source_sha256
      || controlSummary.query_source_sha256!==summary.query_source_sha256) throw Error('Control producer/membership mismatch');
  for(const old of previous) {
    const current=next.find(row=>row.html_sha256===old.html_sha256 && row.body_index===old.body_index);
    expect(same(old,current),'full-source-control-parity');unchangedControls+=Number(same(old,current));
  }
  inputs.push(path.join(controls,'native-notes-candidate','records.jsonl.zst'),
    path.join(controlsCandidateDirectory,'records.jsonl.zst'),path.join(controlsCandidateDirectory,'summary.json'));
}
let breadthSources=0,breadthPairs=0,breadthControls=0;
if(breadth || breadthCandidateDirectory) {
  if(!breadth || !breadthCandidateDirectory) throw Error('Supply both additional original directories');
  const file=path.join(breadth,'semantic-review.json'),additional=json(file);
  for(const input of additional.inputs) {
    const actual=descriptor(input.file);
    if(actual.bytes!==input.bytes || actual.sha256!==input.sha256) throw Error('Frozen breadth input changed: '+input.file);
  }
  const old=records(path.join(breadth,'native-before-word')),next=records(breadthCandidateDirectory);
  const producer=json(path.join(breadthCandidateDirectory,'summary.json'));
  if(producer.errors || old.length!==next.length || producer.engine_source_sha256!==summary.engine_source_sha256
      || producer.query_source_sha256!==summary.query_source_sha256) throw Error('Additional source producer/membership mismatch');
  for(const before of old) {
    const after=next.find(row=>row.html_sha256===before.html_sha256 && row.body_index===before.body_index);
    if(!after) throw Error('Additional original omitted');
    const witness=additional.sources.find(source=>source.source_sha256===before.html_sha256);
    if(!witness) {
      expect(additional.controls.some(source=>source.source_sha256===before.html_sha256),'unreviewed-control');
      expect(same(before,after),'additional-full-source-control-parity');breadthControls+=Number(same(before,after));continue;
    }
    const expected=structuredClone(before);
    for(const pair of witness.expected_pairs) {
      const note=expected.notes.find(note=>note.id===pair.expected_note_id);
      if(!note || !same(note,pair.owner_baseline.note)) throw Error('Frozen baseline Note changed');
      const label=pair.reverse_baseline.rendered_utf16,reference=pair.expected_native_reference_range;
      expect(before.text.slice(reference.start,reference.end)===pair.reference_printed_marker.literal
        && before.text.slice(label.start,label.end)===pair.reciprocal_printed_marker.label,'additional-independent-printed-label',pair.number);
      note.label_range=label;note.body_range.start=label.end;note.primary_reference=reference;
      note.references=[{range:reference,anchor:'_ftnref'+pair.number}];
      breadthPairs++;
    }
    expect(same(expected,after),'additional-exact-note-and-full-prior-parity');breadthSources++;
  }
  inputs.push(file,path.join(breadth,'native-before-word','records.jsonl.zst'),
    path.join(breadthCandidateDirectory,'records.jsonl.zst'),path.join(breadthCandidateDirectory,'summary.json'));
}
const report={schema:'courtlistener.word-semantic-note-comparison.v1',created_utc:new Date().toISOString(),
  engine_source_sha256:summary.engine_source_sha256,query_source_sha256:summary.query_source_sha256,
  sources:candidate.length,reviewed_pairs:review.pairs.length,unchanged_other_originals:unchangedSources,
  unchanged_source_controls:unchangedControls,details,failures,failure_count:failures.length,
  additional_positive_renditions:breadthSources,additional_reviewed_pairs:breadthPairs,additional_unchanged_controls:breadthControls,
  inputs:inputs.map(descriptor),comparator:descriptor(new URL(import.meta.url)),
  scope:'Existing native Word owners unchanged; source-supported semantic labels/body/reference fields only. Complete source graph, hrefs, rendered text and prior native owner/query parity. No href-locality, deployed navigation or unseen-layout claim.'};
fs.writeFileSync(path.join(candidateDirectory,'word-note-comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({sources:report.sources,reviewed_pairs:report.reviewed_pairs,failure_count:report.failure_count}));
if(failures.length) process.exitCode=1;
