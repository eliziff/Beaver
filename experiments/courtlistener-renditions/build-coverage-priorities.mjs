// One-shot cached coverage feedback. No catalog body, opinion or metadata scan.
// node build-coverage-priorities.mjs CATALOG POOL_SOURCE [OUTPUT]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const started = performance.now();
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3) throw Error('Usage: build-coverage-priorities.mjs CATALOG POOL_SOURCE [OUTPUT]');
const catalogPath = path.resolve(args[0]), poolPath = path.resolve(args[1]);
const outputPath = path.resolve(args[2] ?? path.join(path.dirname(poolPath), 'coverage-priorities.json'));
if (outputPath === catalogPath || outputPath === poolPath) throw Error('Priority output must differ from its inputs');
const dimensions = ['court_id','jurisdiction','era','nature_of_suit','type','ocr','size_bucket','source',
  'precedential_status','per_curiam','author_present','subject_hints','renditions','metadata_presence','shapes'];
const multiple = new Set(['subject_hints','renditions','metadata_presence','shapes']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(workspace, file).replaceAll('\\', '/');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const sameIdentity = (left,right) => ['url','bytes','etag'].every(key => left?.[key] === right?.[key]);

async function headerBytes(file) {
  const input = fs.createReadStream(file, {highWaterMark:64*1024});
  const stream = file.endsWith('.zst') ? zlib.createZstdDecompress() : input;
  if (stream !== input) { input.on('error', error => stream.destroy(error)); input.pipe(stream); }
  const parts = [];
  try {
    for await (const chunk of stream) {
      const end = chunk.indexOf(10);
      if (end >= 0) { parts.push(chunk.subarray(0,end+1)); return Buffer.concat(parts); }
      parts.push(chunk);
    }
    throw Error('Completed catalog has no complete JSONL header');
  } finally { stream.destroy(); input.destroy(); }
}

const catalogBytes = await headerBytes(catalogPath);
const header = JSON.parse(catalogBytes.toString('utf8'));
const poolBytes = fs.readFileSync(poolPath), pool = JSON.parse(poolBytes);
const source = pool.source;
if (pool.schema !== 'courtlistener.acquired-pack-pool.v1' || !object(source)
  || typeof source.url !== 'string' || typeof source.etag !== 'string' || !integer(source.bytes) || source.bytes === 0
  || !integer(source.range_bytes) || source.range_bytes === 0) throw Error('Unrecognized original source pool identity');
if (header.schema !== 'courtlistener.selection-catalog.v1' || header.opinion_source?.kind !== 'pool_manifest'
  || !sameIdentity(header.opinion_source.source,source) || !hashString(header.opinion_source.manifest_sha256)
  || !hashString(header.metadata_sha256) || !object(header.range_coverage)) throw Error('Catalog lacks frozen pool/source/metadata coverage provenance');

function bounds(value) {
  if (!object(value) || !integer(value.start) || !integer(value.end) || value.start > value.end || value.end >= source.bytes) throw Error('Source window bounds are outside the original snapshot');
  return value;
}
if (!Array.isArray(pool.planned_windows) || !Array.isArray(pool.parts) || !Array.isArray(pool.exclusions)) throw Error('Pool lacks retained plans, committed parts or exclusion declarations');
const plans = pool.planned_windows.map((window,index) => {
  bounds(window);
  if (window.ordinal !== index) throw Error('Retained source plan ordinals changed');
  return window;
});
const parts = new Map();
for (const part of pool.parts) {
  bounds(part);
  const plan = plans[part.ordinal];
  if (!integer(part.ordinal) || !plan || part.start !== plan.start || part.end !== plan.end
    || !integer(part.rows) || !hashString(part.index_sha256) || parts.has(part.ordinal)) throw Error('Committed source part differs from its immutable window plan');
  parts.set(part.ordinal,part);
}
if (Array.from(parts.values()).reduce((sum,part) => sum+part.rows,0) !== pool.opinion_rows) throw Error('Committed source row counts disagree with the pool');

const exclusions = [], excludedWindows = [];
for (const declaration of pool.exclusions) {
  if (typeof declaration.source !== 'string' || !hashString(declaration.source_sha256)) throw Error('Exclusion source identity is missing');
  const file = path.resolve(workspace,declaration.source), bytes = fs.readFileSync(file), value = JSON.parse(bytes);
  if (digest(bytes) !== declaration.source_sha256 || !sameIdentity(value.source,source)) throw Error('Exclusion belongs to a different original snapshot');
  const windows = value.planned_windows ?? value.ranges ?? value.parts;
  if (!Array.isArray(windows)) throw Error('Exclusion has no original byte-window declarations');
  for (const window of windows) { bounds(window); excludedWindows.push(window); }
  exclusions.push({path:relative(file),bytes:bytes.length,sha256:digest(bytes),windows:windows.length});
}

const observations = Object.entries(header.range_coverage).map(([key,coverage]) => {
  if (!object(coverage) || !integer(coverage.records) || coverage.records === 0 || !object(coverage.strata)) throw Error('Catalog lacks populated per-range strata; rebuild its header with native coverage fields');
  const window = bounds(coverage.source_window), part = parts.get(window.ordinal);
  if (!part || ['start','end','index_sha256','rows'].some(field => window[field] !== part[field])
    || coverage.records !== part.rows) throw Error('Observed catalog range does not bind an immutable committed source window');
  return {key,window,coverage,center:(window.start+window.end)/2,raw:{},dimension_scores:{}};
}).sort((left,right) => left.center-right.center);
const observedOrdinals = new Set(observations.map(observation => observation.window.ordinal));
if (observations.length === 0 || observedOrdinals.size !== observations.length
  || observations.reduce((sum,observation) => sum+observation.coverage.records,0) !== header.records
  || header.records !== header.opinion_source.opinion_rows) throw Error('Frozen catalog coverage source-record population is incomplete');

const active = [], inactive = [];
for (const dimension of dimensions) {
  const totals = new Map();
  for (const observation of observations) {
    const histogram = observation.coverage.strata[dimension] ?? (multiple.has(dimension) ? {} : undefined);
    if (!object(histogram)) throw Error('Scalar dimension missing from catalog strata: '+dimension);
    let count = 0;
    for (const [token,frequency] of Object.entries(histogram)) {
      JSON.parse(token);
      if (!integer(frequency) || frequency === 0 || frequency > observation.coverage.records) throw Error('Invalid source-record stratum count: '+dimension);
      totals.set(token,(totals.get(token)??0)+frequency); count += frequency;
    }
    if (!multiple.has(dimension) && count !== observation.coverage.records) throw Error('Scalar dimension does not account for every observed record: '+dimension);
  }
  let minimum = Infinity, maximum = -Infinity;
  for (const observation of observations) {
    let sum = 0, count = 0;
    for (const [token,frequency] of Object.entries(observation.coverage.strata[dimension]??{})) {
      sum += frequency/Math.sqrt(totals.get(token)); count += frequency;
    }
    const raw = count ? sum/count : 0;
    observation.raw[dimension] = raw; minimum = Math.min(minimum,raw); maximum = Math.max(maximum,raw);
  }
  if (maximum-minimum < 1e-12) { inactive.push({dimension,observed_values:totals.size,reason:'no variation between observed ranges'}); continue; }
  active.push({dimension,observed_values:totals.size});
  for (const observation of observations) observation.dimension_scores[dimension] = (observation.raw[dimension]-minimum)/(maximum-minimum);
}
const median = values => { const sorted = values.sort((a,b) => a-b); return sorted[Math.floor(sorted.length/2)]; };
const distances = observations.slice(1).map((observation,index) => observation.center-observations[index].center).filter(distance => distance>0);
const bandwidth = Math.max(source.range_bytes,distances.length?median(distances):source.range_bytes);
const proximity = distance => 1/(1+distance/bandwidth)**2;
const additionalParts = Array.from(parts.values()).filter(part => !observedOrdinals.has(part.ordinal));
for (const observation of observations) {
  const scores = Object.values(observation.dimension_scores);
  observation.rarity = scores.length ? scores.reduce((sum,value) => sum+value,0)/scores.length : 0;
  observation.additional_bytes = 0; observation.additional_rows = 0;
  for (const part of additionalParts) {
    const distance = Math.abs((part.start+part.end)/2-observation.center);
    if (distance>4*bandwidth) continue;
    const weight = proximity(distance);
    observation.additional_bytes += weight*(part.end-part.start+1);
    observation.additional_rows += weight*part.rows;
  }
  const equivalents = (observation.additional_bytes/(observation.window.end-observation.window.start+1)
    + observation.additional_rows/observation.coverage.records)/2;
  observation.damping = 1/(1+equivalents); observation.urgency = observation.rarity*observation.damping;
}

function score(window) {
  const center = (window.start+window.end)/2;
  let left = 0, right = observations.length;
  while (left<right) { const middle = Math.floor((left+right)/2); if (observations[middle].center<center) left=middle+1; else right=middle; }
  const neighbors = [observations[left-1],observations[left]].filter(Boolean);
  let sum = 0, weightSum = 0, nearest = 0;
  for (const observation of neighbors) {
    const weight = proximity(Math.abs(center-observation.center));
    sum += weight*observation.urgency; weightSum += weight; nearest = Math.max(nearest,weight);
  }
  return {priority:0.8*(sum/weightSum)*nearest+0.2*(1-nearest),
    nearby_observed_ordinals:neighbors.map(observation => observation.window.ordinal)};
}
const bits = Math.max(1,Math.ceil(Math.log2(plans.length)));
const reverseBits = ordinal => Number.parseInt(ordinal.toString(2).padStart(bits,'0').split('').reverse().join(''),2);
const pending = plans.filter(window => !parts.has(window.ordinal)).map(window => ({ordinal:window.ordinal,start:window.start,end:window.end,...score(window)}))
  .sort((left,right) => right.priority-left.priority || reverseBits(left.ordinal)-reverseBits(right.ordinal));
const blocked = [...plans,...excludedWindows].sort((left,right) => left.start-right.start || left.end-right.end);
const gaps = [];
let cursor = 0;
const addGap = (start,end) => { if (end-start+1>=source.range_bytes) gaps.push({start,end,...score({start,end})}); };
for (const window of blocked) {
  if (window.start>cursor) addGap(cursor,window.start-1);
  cursor = Math.max(cursor,window.end+1);
}
if (cursor<source.bytes) addGap(cursor,source.bytes-1);
gaps.sort((left,right) => right.priority-left.priority || right.end-right.start-(left.end-left.start) || left.start-right.start);

const catalogSha = digest(catalogBytes);
const value = {schema:'courtlistener.coverage-priorities.v1',source,
  ordinals:pending.map(window => window.ordinal),gaps,
  basis:'Heuristic nearby-source feedback: equally weighted observed stratum rarity, bounded exploration, and damping from additional nearby committed bytes/rows. Source position is not metadata about unseen records.',
  catalog_sha256:catalogSha,catalog_sha256_scope:'Exact first JSONL header bytes including LF only; catalog body is not read',
  provenance:{catalog:{path:relative(catalogPath),header_bytes:catalogBytes.length,header_sha256:catalogSha,
    metadata_sha256:header.metadata_sha256,opinion_source:header.opinion_source},
    current_pool:{path:relative(poolPath),bytes:poolBytes.length,sha256:digest(poolBytes),
      committed_parts:parts.size,opinion_rows:pool.opinion_rows,stored_bytes:pool.stored_bytes},exclusions},
  scoring:{active_dimensions:active,inactive_dimensions:inactive,
    rarity:'Count-weighted mean of 1/sqrt(global observed token record count); each varying dimension normalized to [0,1], then weighted equally',
    proximity:'1/(1+center distance/bandwidth)^2; use nearest observed ranges on either side',
    bandwidth_bytes:bandwidth,exploration_weight:0.2,
    damping:'1/(1+mean(weighted additional source bytes/observed window bytes, weighted additional stored rows/observed records)); nearby means within 4 bandwidths',
    additional_committed_parts:additionalParts.length},
  observed_ranges:observations.map(observation => ({...observation.window,records:observation.coverage.records,
    dimension_scores:observation.dimension_scores,rarity:observation.rarity,damping:observation.damping,
    weighted_additional_bytes:observation.additional_bytes,weighted_additional_rows:observation.additional_rows})),
  pending_windows:pending,build_ms:performance.now()-started};
const pendingPath = outputPath+'.pending';
let descriptor, created = false;
try {
  descriptor = fs.openSync(pendingPath,'wx'); created = true;
  fs.writeFileSync(descriptor,JSON.stringify(value)+'\n'); fs.fsyncSync(descriptor);
  fs.closeSync(descriptor); descriptor = undefined;
  fs.renameSync(pendingPath,outputPath); created = false;
} finally {
  if (descriptor!==undefined) fs.closeSync(descriptor);
  if (created) fs.rmSync(pendingPath);
}
console.log(JSON.stringify({output:relative(outputPath),catalog_header_sha256:catalogSha,
  observed_ranges:observations.length,active_dimensions:active.length,additional_committed_parts:additionalParts.length,
  pending_ordinals:pending.length,uncovered_gaps:gaps.length,build_ms:performance.now()-started}));
