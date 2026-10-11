import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const [manifest, ledger, output, countValue = '500'] = process.argv.slice(2);
if (!manifest || !ledger || !output) throw Error('Supply capture manifest, CAP capture ledger, output and count');
const count = Number(countValue);
if (!Number.isSafeInteger(count) || count < 1) throw Error('Count must be a positive integer');
const started = performance.now();
const manifestBytes = fs.readFileSync(manifest), ledgerBytes = fs.readFileSync(ledger);
const seen = new Set(ledgerBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  .filter(row => row.sha256).map(row => row.url));
const dimensions = ['court_id', 'jurisdiction', 'era', 'type', 'ocr', 'size_bucket', 'source',
  'precedential_status', 'per_curiam', 'author_present', 'renditions', 'shapes', 'subject_hints', 'metadata_presence'];
const tokens = sampling => dimensions.flatMap(name => {
  const value = sampling[name];
  return (Array.isArray(value) ? value : [value]).filter(value => value != null)
    .map(value => `${name}:${value}`);
});
const candidates = JSON.parse(manifestBytes.toString('utf8')).flatMap(capture => {
  const sampling = capture.sampling ?? {};
  const source = sampling.cluster_metadata?.filepath_json_harvard;
  if (!source || !/^law\.free\.cap\.[^/]+\/[^/]+\.json$/u.test(source)) return [];
  const url = 'https://archive.org/download/' + source;
  if (seen.has(url)) return [];
  return [{url, opinion_url:capture.final_url, cluster_id:capture.cluster_id,
    court:sampling.court_id, era:sampling.era, sampling_tokens:tokens(sampling),
    source_html_sha256:capture.sha256,
    rank:createHash('sha256').update(url).digest('hex')}];
}).sort((left, right) => left.rank.localeCompare(right.rank));
const selected = [], covered = new Set(), selectedUrls = new Set();
for (const candidate of candidates) {
  if (selected.length >= count) break;
  if (selectedUrls.has(candidate.url)) continue;
  if (candidate.sampling_tokens.every(token => covered.has(token))) continue;
  selected.push(candidate); selectedUrls.add(candidate.url);
  candidate.sampling_tokens.forEach(token => covered.add(token));
}
for (const candidate of candidates) {
  if (selected.length >= count) break;
  if (selectedUrls.has(candidate.url)) continue;
  selected.push(candidate); selectedUrls.add(candidate.url);
  candidate.sampling_tokens.forEach(token => covered.add(token));
}
fs.writeFileSync(output, JSON.stringify(selected.map(({rank, ...candidate}) => candidate), null, 2) + '\n');
const coverage = Object.fromEntries(dimensions.map(name => [name,
  [...covered].filter(token => token.startsWith(name + ':')).map(token => token.slice(name.length + 1)).sort()]));
const summary = {schema:'courtlistener.cap-source-selection.v1', selected:selected.length,
  eligible_unretained:candidates.length, selection_ms:performance.now()-started, coverage,
  method:'Cover observed marginal metadata values, then fill by deterministic SHA-256 URL rank; subject hints are provisional',
  manifest_sha256:createHash('sha256').update(manifestBytes).digest('hex'),
  ledger_sha256:createHash('sha256').update(ledgerBytes).digest('hex')};
fs.writeFileSync(output.replace(/\.json$/u, '') + '-selection.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({selected:summary.selected, eligible:summary.eligible_unretained,
  selection_ms:summary.selection_ms, dimensions:Object.fromEntries(Object.entries(coverage).map(([name, values]) => [name, values.length]))}));
