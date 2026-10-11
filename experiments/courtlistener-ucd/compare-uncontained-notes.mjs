// Compare actual native corpus output with the frozen independent source review.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';

const [cohort, candidateDirectory, controls, controlsCandidateDirectory] = process.argv.slice(2);
if (!candidateDirectory) throw Error('Supply retained original cohort and candidate source-run directory');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = file => { const bytes = fs.readFileSync(file); return {file, bytes:bytes.length, sha256:digest(bytes)}; };
const reviewedFile = path.join(cohort, 'uncontained-footnote-review.json');
const review = JSON.parse(fs.readFileSync(reviewedFile));
if (review.failure_count !== 0) throw Error('Independent source review is incomplete');
for (const expected of Object.values(review.inputs)) {
  const actual = descriptor(expected.file);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw Error(`Frozen source review input changed: ${expected.file}`);
}
const records = directory => zstdDecompressSync(fs.readFileSync(path.join(directory,'records.jsonl.zst')))
  .toString('utf8').trim().split('\n').map(JSON.parse);
const previous = records(path.join(cohort,'native-candidate'));
const candidate = records(candidateDirectory);
const controlInputs=[];
let unchangedControls=0;
const summary = JSON.parse(fs.readFileSync(path.join(candidateDirectory,'summary.json')));
if (summary.errors || candidate.length !== previous.length) throw Error('Native corpus membership/error mismatch');
const failures=[], details=[];
const expect=(condition, opinion, kind)=>{if(!condition)failures.push({opinion_id:opinion,kind});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const unchanged=['text','source_capture','source','html_sha256','body_index','markup_serialization','page_citations',
  'source_markup_byte_start','source_markup_byte_end','table_cells','markup_anchor_lookups','markup_name_lookups',
  'markup_byte_ranges_valid','markup_elements','markup_ancestors','markup_sha256','page_alias_queries'];
for (const prior of previous) {
  const actual=candidate.find(row=>row.html_sha256===prior.html_sha256 && row.body_index===prior.body_index);
  if (!actual || actual.error) throw Error('Retained original missing from candidate');
  const witness=review.records.find(row=>row.original.sha256===actual.html_sha256);
  for (const key of unchanged) expect(equal(prior[key],actual[key]),witness?.opinion_id,'prior-'+key+'-changed');
  if (!witness) {
    for (const key of Object.keys(prior)) expect(equal(prior[key],actual[key]),'declared-note-control','control-'+key+'-changed');
    continue;
  }
  const original=descriptor(witness.original.file);
  if (original.bytes!==witness.original.bytes || original.sha256!==witness.original.sha256) throw Error('Frozen original changed');
  const locations=witness.saved_native_observations.source_derived_printed_text_locations;
  const source=witness.independent_source;
  const footnotes=actual.native_structures.filter(node=>node.kind==='footnote');
  expect(footnotes.length===1,witness.opinion_id,'footnote-count');
  const node=footnotes[0], note=actual.notes.find(note=>note.node_id===node?.id);
  expect(actual.notes.length===1 && Boolean(note),witness.opinion_id,'note-count');
  expect(equal(node?.range,locations.body),witness.opinion_id,'body-range');
  expect(equal(note?.label_range,locations.label),witness.opinion_id,'label-range');
  expect(equal(note?.body_range,locations.body),witness.opinion_id,'note-body-range');
  expect(node?.markup_start===source.footnote_label_and_backlink.raw_utf8.start &&
    node?.anchor===source.footnote_label_and_backlink.name,witness.opinion_id,'source-anchor');
  expect(equal(note?.primary_reference,locations.reference) && note?.references.length===1 &&
    equal(note.references[0].range,locations.reference) && note.references[0].anchor===source.reference.name,
    witness.opinion_id,'typed-reference');
  expect(actual.text.slice(locations.body.start,locations.body.end)===source.body_fragment.printed_text,
    witness.opinion_id,'independent-printed-body');
  expect(actual.native_pinpoint_queries.some(query=>query.node_id===node?.id && query.resolves &&
    query.selected.some(range=>range.start===locations.body.start && range.end===locations.body.end)),
    witness.opinion_id,'footnote-query');
  expect(actual.note_label_queries.some(query=>query.anchor===source.footnote_label_and_backlink.name &&
    query.node_id===node?.id && equal(query.label_range,locations.label) && equal(query.body_range,locations.body)),
    witness.opinion_id,'source-note-label-query');
  for (const priorNode of prior.native_structures) expect(actual.native_structures.some(node=>equal(node,priorNode)),
    witness.opinion_id,'prior-native-structure-changed');
  details.push({opinion_id:witness.opinion_id,body_range:note?.body_range,label_range:note?.label_range,
    reference_range:note?.primary_reference,source_anchor:node?.anchor});
}
if (controls || controlsCandidateDirectory) {
  if (!controls || !controlsCandidateDirectory) throw Error('Supply both control directories');
  const controlSummary=JSON.parse(fs.readFileSync(path.join(controlsCandidateDirectory,'summary.json')));
  const oldControls=records(path.join(controls,'native-candidate')),newControls=records(controlsCandidateDirectory);
  if (controlSummary.errors || oldControls.length!==newControls.length ||
    controlSummary.engine_source_sha256!==summary.engine_source_sha256 ||
    controlSummary.query_source_sha256!==summary.query_source_sha256) throw Error('Control producer/membership/error mismatch');
  for (const old of oldControls) {
    const current=newControls.find(row=>row.html_sha256===old.html_sha256 && row.body_index===old.body_index);
    const same=equal(old,current);
    expect(same,'source-control','full-control-receipt-changed');
    unchangedControls+=Number(same);
  }
  controlInputs.push(path.join(controls,'native-candidate','records.jsonl.zst'),
    path.join(controlsCandidateDirectory,'records.jsonl.zst'),path.join(controlsCandidateDirectory,'summary.json'));
}
const result={schema:'courtlistener.uncontained-note-comparison.v1',created_utc:new Date().toISOString(),
  engine_source_sha256:summary.engine_source_sha256,query_source_sha256:summary.query_source_sha256,
  sources:candidate.length,unchanged_source_controls:unchangedControls,reviewed_fragments:review.records.length,details,failures,failure_count:failures.length,
  inputs:[reviewedFile,path.join(cohort,'native-candidate','records.jsonl.zst'),
    path.join(candidateDirectory,'records.jsonl.zst'),path.join(candidateDirectory,'summary.json'),...controlInputs].map(descriptor),
  comparator:descriptor(new URL(import.meta.url)),
  scope:'Two independently reviewed terminal original fragments; complete rendered text and generic graph equality, existing native structure/declared-note controls and actual source-local note queries. No deployed URL or unseen-layout completeness claim.'};
fs.writeFileSync(path.join(candidateDirectory,'uncontained-note-comparison.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({sources:result.sources,reviewed_fragments:result.reviewed_fragments,failure_count:result.failure_count}));
if(failures.length)process.exitCode=1;
