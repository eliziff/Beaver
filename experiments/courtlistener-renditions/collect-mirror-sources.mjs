// Bounded public mirror source acquisition, not a parser oracle or a mirror census.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const owner = join(root, 'benchmarks/local-data/courtlistener-renditions/all-collections/mirror-samples');
const maximumBytes = 16777216, requiredBytes = 4406164480 + maximumBytes;
const maximumGets = 12, maximumResponseBytes = 4194304, receiptReserve = 524288;
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const repoPath = path => relative(root, path).replaceAll('\\', '/');
const plan = [
  { item: 'gov.uscourts.dcd.178502', catalog_bytes_observed: 79904,
    catalog_sha256_observed: '8c292a9294bcea35297da22859bd2ee1ba7c2a8c6b1a06431ba9a3f3aed0e629',
    files: [{ name: 'gov.uscourts.dcd.178502.docket.json', kind: 'docket_json', bytes: 536394,
      sha1: 'c5709e40025ef7b91025c2c524baf229465b1ef9', md5: '5e875f5660c9a64a62c37ae2be46e92e' }] },
  { item: 'gov.uscourts.ca5.23-60483', catalog_bytes_observed: 4242,
    catalog_sha256_observed: 'f3ea9e7a087426dec326bd4608b23e64742ae5b221aab04faf1fb4e67908beda',
    files: [{ name: 'gov.uscourts.ca5.23-60483.2024-10-08.asr.js', kind: 'asr_words', bytes: 860576,
      sha1: '53779ce258b1173908ec2f063a7594ba215601d1', md5: '81421926335e491132c9e75e30f0fbfc' },
    { name: 'gov.uscourts.ca5.23-60483.2024-10-08.asr.vtt', kind: 'transcript_vtt', bytes: 56245,
      sha1: '9017010d01bf8036c0f5075924a5e857caecba54', md5: '688cb12eccf836c5c07e17059c2340bb' }] },
  { item: 'gov.uscourts.deb.188803', catalog_bytes_observed: 134985,
    catalog_sha256_observed: '2c01db3d27decb6cf7558f97c2832fdc3a7c09eff60ac7ee3d5a818604396600',
    files: [{ name: 'gov.uscourts.deb.188803.1.1_hocr.html', kind: 'ocr_hocr_html', bytes: 82402,
      sha1: 'd986c63332294e5eed51d012bd3dc22d0a0667e8', md5: 'dabb1091f18f040964522663564f722e' }] },
];

// This capture is immutable. Reinvocation verifies retained entities without another GET.
if (existsSync(join(owner, 'report.json'))) {
  const priorBytes = readFileSync(join(owner, 'report.json'));
  const prior = JSON.parse(priorBytes.toString('utf8'));
  for (const response of prior.responses) {
    if (!response.original) continue;
    const bytes = readFileSync(join(owner, response.original.path));
    if (bytes.length !== response.original.bytes || hash(bytes) !== response.original.sha256)
      throw new Error('Retained mirror entity identity differs');
  }
  console.log(JSON.stringify({ retained_capture: true, report_sha256: hash(priorBytes),
    sample_plan_complete: prior.sample_plan_complete, new_gets: 0 }));
  process.exit(0);
}

const report = {
  schema: 'courtlistener.public-mirror-source-sample.v1', captured_utc: new Date().toISOString(),
  collector_sha256: hash(readFileSync(fileURLToPath(import.meta.url))), owner: repoPath(owner),
  scope: 'Seven specifically qualified Internet Archive resources: three item catalogs and four small source entities. Only captured entities are covered; no whole-RECAP count, freshness or semantic-gold claim.',
  authentication: { mode: 'anonymous', credential_files_read: false, authorization_header_sent: false,
    courtlistener_api_requested: false },
  limits: { maximum_owner_bytes: maximumBytes, maximum_actual_gets_including_redirects: maximumGets,
    maximum_response_bytes: maximumResponseBytes, maximum_seconds_per_get: 30,
    redirects_per_resource: 3, retry_count: 0, required_shared_guard_bytes: requiredBytes },
  plan, responses: [], resources: [], items: [],
  boundaries: [
    'HTTP entity bytes are retained before parsing, with Accept-Encoding identity requested; headers and transfer framing are not body bytes.',
    'Every redirect is a separately counted GET with its own complete response entity. No automatic retries or pagination.',
    'Internet Archive catalogs and item-level mirrors are the source identities. An item publicdate or file mtime is not proof of current CourtListener coverage.',
    'ASR and OCR are derived representations, not court-certified transcripts or independent parser gold.',
    'No CourtListener API, auth, account operation, PACER action, PDF, audio, image or ZIP acquisition.',
    'Structure observations are JSON field/array and lexical source inventories; no Native parser is invoked.',
  ],
  serializer_scope_reference: {
    url: 'https://github.com/freelawproject/courtlistener/blob/main/cl/corpus_importer/api_serializers.py',
    boundary: 'Current upstream serializer documentation, not a version claim about the captured historical docket JSON.',
    intended_nested_sources: ['docket_entries.recap_documents', 'parties.attorneys.roles', 'parties.party_types',
      'claims.claim_history_entries', 'original_court_info', 'bankruptcy_information', 'idb_data'],
    stated_excluded_fields: { RECAPDocument: ['docket_entry', 'plain_text', 'tags'],
      Attorney: ['organizations'], Role: ['party', 'attorney', 'docket'],
      Claim: ['docket', 'tags'], ClaimHistory: ['claim', 'plain_text'], DocketEntry: ['tags'],
      Docket: ['view_count', 'tags', 'originating_court_information', 'ia_upload_failure_count',
        'ia_needs_upload', 'ia_date_first_change'] },
  },
};
const payloads = new Map();
let gets = 0, retainedBytes = 0, stopReason = null;

function allowedUrl(value, original, item, filename) {
  const url = new URL(value, original);
  const path = filename ? `/items/${item}/${filename}` : null;
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !(url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org'))
      || !(url.pathname === new URL(original).pathname
        || (path && url.pathname.endsWith(path) && /^\/(?:\d+\/)?items\//u.test(url.pathname))))
    throw new Error('Redirect leaves the qualified HTTPS mirror resource');
  return url.href;
}

function systemGet(url) {
  const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  const config = ['silent', 'show-error', 'include', 'max-time = 30',
    `max-filesize = ${maximumResponseBytes}`, 'request = "GET"', `url = ${quote(url)}`,
    'header = "Accept: application/json, text/plain, text/html, */*"',
    'header = "Accept-Encoding: identity"'].join('\n') + '\n';
  const reply = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--disable', '--config', '-'],
    { input: config, maxBuffer: maximumResponseBytes + 65536, timeout: 31000 });
  const output = reply.stdout ?? Buffer.alloc(0);
  let offset = 0, status = null, headers = {};
  while (output.subarray(offset, offset + 5).toString() === 'HTTP/') {
    const end = output.indexOf('\r\n\r\n', offset); if (end < 0) break;
    const lines = output.subarray(offset, end).toString('utf8').split('\r\n');
    status = Number(lines.shift().match(/^HTTP\/\S+\s+(\d{3})/u)?.[1]) || null;
    headers = {};
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    offset = end + 4;
  }
  return { status, body: output.subarray(offset), complete: reply.status === 0 && status !== null,
    headers: Object.fromEntries(Object.entries(headers).filter(([name]) =>
      ['date', 'content-type', 'content-length', 'content-encoding', 'etag', 'last-modified',
        'location', 'retry-after'].includes(name) || name.startsWith('x-ratelimit') || name.startsWith('ratelimit'))),
    error: reply.status === 0 && status !== null ? null
      : (reply.stderr?.toString('utf8').trim() || reply.error?.message || 'No complete HTTP response'),
    error_code: reply.error?.code ?? (reply.status ? `CURL_${reply.status}` : null) };
}

function capture(original, purpose, item, filename = null) {
  const resource = { original_url: original, purpose, item, filename, response_ordinals: [],
    final_response_ordinal: null, complete: false, error: null };
  report.resources.push(resource);
  let url = allowedUrl(original, original, item, filename);
  for (let hop = 0; hop <= report.limits.redirects_per_resource; hop++) {
    if (stopReason || gets >= maximumGets) {
      resource.error = stopReason ?? 'actual_GET_cap'; stopReason ??= resource.error; return null;
    }
    gets++;
    const record = { ordinal: report.responses.length, original_url: original, request_url: url,
      method: 'GET', item, filename, purpose, redirect_hop: hop, captured_utc: new Date().toISOString(),
      transport: 'installed_curl_with_system_certificate_verification', status: null, body_complete: false };
    report.responses.push(record); resource.response_ordinals.push(record.ordinal);
    const response = systemGet(url);
    record.status = response.status; record.headers = response.headers;
    record.received_body_bytes = response.body.length;
    record.error = response.error; record.error_code = response.error_code;
    if (!response.complete) {
      record.received_partial_sha256 = hash(response.body);
      resource.error = response.error; stopReason = 'transport_or_response_completeness_failure';
      console.log(JSON.stringify({ response: record.ordinal, status: record.status, complete: false,
        error: record.error, error_code: record.error_code })); return null;
    }
    const digest = hash(response.body), name = `${digest}.body`;
    if (!payloads.has(name)) {
      if (retainedBytes + response.body.length > maximumBytes - receiptReserve) {
        resource.error = 'owner_byte_cap_before_retention'; stopReason = resource.error; return null;
      }
      payloads.set(name, response.body); retainedBytes += response.body.length;
    }
    record.body_complete = true;
    record.original = { path: name, bytes: response.body.length, sha256: digest };
    console.log(JSON.stringify({ response: record.ordinal, status: record.status, bytes: response.body.length,
      item, filename, redirect_hop: hop }));
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location) { resource.error = 'redirect_without_location'; return null; }
      try { url = allowedUrl(response.headers.location, url, item, filename); }
      catch (error) { resource.error = error.message; return null; }
      continue;
    }
    resource.final_response_ordinal = record.ordinal;
    resource.complete = response.status === 200;
    if (!resource.complete) { resource.error = `HTTP_${response.status}`; return null; }
    return { body: response.body, record, resource };
  }
  resource.error = 'redirect_hop_cap'; return null;
}

function jsonInventory(value) {
  const rootShape = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const fields = Object.create(null), arrays = Object.create(null), stack = [value];
  let objects = 0;
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) { stack.push(...node); continue; }
    if (!node || typeof node !== 'object') continue;
    objects++;
    for (const [key, child] of Object.entries(node)) {
      const shape = child === null ? 'null' : Array.isArray(child) ? 'array' : typeof child;
      const counts = fields[key] ??= Object.create(null); counts[shape] = (counts[shape] ?? 0) + 1;
      if (Array.isArray(child)) {
        const count = arrays[key] ??= { arrays: 0, elements: 0 }; count.arrays++; count.elements += child.length;
      }
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return { representation: 'JSON parsed without executing code; field-name aggregates retain no invented relationships',
    root_shape: rootShape, root_fields: rootShape === 'object' ? Object.keys(value) : null,
    object_count: objects, field_shapes: fields, array_fields: arrays };
}

function observe(body, kind) {
  const text = body.toString('utf8');
  if (kind === 'docket_json' || kind === 'asr_words') {
    try { return jsonInventory(JSON.parse(text)); }
    catch (error) { return { representation: kind === 'asr_words' ? 'Unexecuted JavaScript/text source' : 'Unparsed JSON source',
      json_parse_error: error.message, executable_evaluation: false,
      lexical_timing_field_occurrences: Object.fromEntries(['start', 'end', 'duration', 'word', 'text', 'confidence']
        .map(field => [field, [...text.matchAll(new RegExp(`\\b${field}\\b`, 'gu'))].length])) }; }
  }
  if (kind === 'transcript_vtt') return { representation: 'Raw WebVTT lexical inventory; no speaker or legal-role inference',
    webvtt_signature: text.replace(/^\uFEFF/u, '').startsWith('WEBVTT'),
    timing_line_count: [...text.matchAll(/^\s*(?:\d+:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d+:)?\d{2}:\d{2}\.\d{3}/gmu)].length };
  const tags = Object.create(null), classes = Object.create(null);
  for (const match of text.matchAll(/<([A-Za-z][A-Za-z0-9:_-]*)\b[^>]*>/gu)) {
    tags[match[1]] = (tags[match[1]] ?? 0) + 1;
    const classValue = match[0].match(/\bclass\s*=\s*(["'])(.*?)\1/u)?.[2];
    for (const token of classValue?.split(/\s+/u).filter(Boolean) ?? []) classes[token] = (classes[token] ?? 0) + 1;
  }
  return { representation: 'Raw hOCR opening-tag/class spelling inventory; exact HTML hierarchy remains in the retained entity, not a Native parse',
    opening_tag_spellings: tags, class_tokens: classes,
    bbox_spelling_count: [...text.matchAll(/\bbbox\s+\d+\s+\d+\s+\d+\s+\d+/gu)].length };
}

for (const selected of plan) {
  const catalogUrl = `https://archive.org/metadata/${selected.item}`;
  const item = { identifier: selected.item, catalog_url: catalogUrl, catalog_response_ordinal: null,
    metadata: null, files_listed: null, selected_sources: [], unfetched_binary_links: [], error: null };
  report.items.push(item);
  const captured = capture(catalogUrl, 'Complete bounded item catalog', selected.item);
  let catalog = null;
  if (captured) {
    item.catalog_response_ordinal = captured.record.ordinal;
    try { catalog = JSON.parse(captured.body.toString('utf8')); }
    catch (error) { item.error = error.message; }
    if (catalog?.metadata?.identifier !== selected.item || !Array.isArray(catalog.files)) {
      item.error ??= 'Returned catalog does not bind the expected item and file list'; catalog = null;
    }
  } else item.error = report.resources.at(-1).error;
  if (catalog) {
    item.metadata = Object.fromEntries(['identifier', 'collection', 'source_url', 'publicdate', 'mediatype']
      .map(key => [key, catalog.metadata[key] ?? null]));
    item.files_listed = catalog.files.length;
    item.catalog_identity_at_capture = captured.record.original;
    item.catalog_unchanged_from_qualified_observation = hash(captured.body) === selected.catalog_sha256_observed;
    // Binary locators are observations only. Complete file listings remain in the catalog original.
    item.unfetched_binary_links = catalog.files.filter(file => /\.(?:pdf|mp3)$/iu.test(file.name)).slice(0, 3)
      .map(file => ({ url: `https://archive.org/download/${selected.item}/${encodeURIComponent(file.name)}`,
        name: file.name, bytes: Number(file.size), sha1: file.sha1 ?? null, md5: file.md5 ?? null,
        source: file.source ?? null, downloaded: false }));
  }
  for (const selectedFile of selected.files) {
    const source = { filename: selectedFile.name, kind: selectedFile.kind,
      original_url: `https://archive.org/download/${selected.item}/${selectedFile.name}`,
      catalog_file_pointer: null, catalog_file: null, qualified_identity: selectedFile,
      status: 'skipped', error: null, final_response_ordinal: null, integrity: null, observations: null };
    item.selected_sources.push(source);
    if (!catalog) { source.error = 'item_catalog_unavailable_or_unqualified'; continue; }
    const matches = catalog.files.map((file, index) => ({ file, index })).filter(({ file }) => file.name === selectedFile.name);
    if (matches.length !== 1) { source.error = 'catalog_selected_filename_missing_or_ambiguous'; continue; }
    const { file, index } = matches[0]; source.catalog_file_pointer = `/files/${index}`;
    source.catalog_file = Object.fromEntries(['name', 'size', 'sha1', 'md5', 'mtime', 'format', 'source', 'original']
      .map(key => [key, file[key] ?? null]));
    if (Number(file.size) !== selectedFile.bytes || file.sha1 !== selectedFile.sha1 || file.md5 !== selectedFile.md5) {
      source.error = 'catalog_file_identity_changed_from_qualified_observation'; continue;
    }
    const original = capture(source.original_url, selectedFile.kind, selected.item, selectedFile.name);
    if (!original) {
      source.status = report.resources.at(-1).response_ordinals.length ? 'failed' : 'skipped';
      source.error = report.resources.at(-1).error; continue;
    }
    source.final_response_ordinal = original.record.ordinal;
    source.integrity = { bytes: original.body.length, sha256: hash(original.body),
      sha1: hash(original.body, 'sha1'), md5: hash(original.body, 'md5') };
    source.integrity.matches_catalog_and_qualified_file = original.body.length === selectedFile.bytes
      && source.integrity.sha1 === selectedFile.sha1 && source.integrity.md5 === selectedFile.md5;
    source.status = source.integrity.matches_catalog_and_qualified_file ? 'captured_identity_verified' : 'captured_identity_mismatch';
    if (source.status === 'captured_identity_mismatch') source.error = 'Complete response retained but differs from bound catalog identity';
    source.observations = observe(original.body, selectedFile.kind);
  }
}
report.completed_utc = new Date().toISOString();
report.actual_gets_including_redirects = gets;
report.distinct_original_bytes = retainedBytes;
report.distinct_original_entities = payloads.size;
report.sample_plan_complete = report.items.every(item => !item.error
  && item.selected_sources.every(source => source.status === 'captured_identity_verified'));
report.collection_census_complete = false;
report.stop_reason = stopReason ?? (report.sample_plan_complete ? 'declared_sample_complete' : 'declared_sample_with_source_failures');

const markdown = [
  '# Public mirror source sample', '', report.scope, '',
  `Actual GETs including redirects: ${gets}/${maximumGets}. Distinct original entities: ${payloads.size}; bytes: ${retainedBytes}.`,
  `Sample plan complete: ${report.sample_plan_complete}. Collection census complete: false. Stop: ${report.stop_reason}.`, '',
  ...report.items.flatMap(item => [`- Item [${item.identifier}](${item.catalog_url}): ${item.files_listed ?? 'unavailable'} catalog files; ${item.error ?? 'catalog identity verified'}.`,
    ...item.selected_sources.map(source => `  - [${source.filename}](${source.original_url}): ${source.status}; ${source.integrity?.bytes ?? 0} retained bytes${source.error ? `; ${source.error}` : ''}.`)]), '',
  'Exact entities and redirect responses are bound in report.json by SHA-256. Selected source entities also match the actual catalog size, SHA-1 and MD5, when explicitly marked verified.', '',
  'Current upstream IA serialization excludes RECAP document/claim-history plain_text, attorney organizations and redundant nested role links. This is a documented scope reference; the historical JSON field inventory is reported separately.', '',
  ...report.boundaries.map(value => `- ${value}`), '',
].join('\n');
payloads.set('report.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
payloads.set('access-structure-report.md', Buffer.from(markdown));
const files = [...payloads].map(([name, bytes]) => ({ name, base64: bytes.toString('base64') }));
if ([...payloads.values()].reduce((sum, bytes) => sum + bytes.length, 0) > maximumBytes)
  throw new Error('Source entities and complete receipts exceed the owner cap; no publication attempted');

// Publication waits for the existing corpus writer. It never bypasses admission or rewrites an original.
console.log(JSON.stringify({ publication: 'waiting_for_existing_budget_writer', required_bytes: requiredBytes,
  maximum_owner_bytes: maximumBytes, sample_plan_complete: report.sample_plan_complete }));
const publishCode = `import base64,json,sys
from pathlib import Path
root=Path.cwd()
sys.path.insert(0,str(root/'experiments/courtlistener-renditions'))
import budget
owner=root/'benchmarks/local-data/courtlistener-renditions/all-collections/mirror-samples'
payload=json.load(sys.stdin)
with budget.writer():
 budget.require_bytes(4422941696)
 files=[(item['name'],base64.b64decode(item['base64'],validate=True)) for item in payload['files']]
 for name,data in files:
  if Path(name).name!=name: raise RuntimeError('Publication must stay inside the assigned owner')
  if (owner/name).exists() and (owner/name).read_bytes()!=data: raise RuntimeError('Immutable mirror capture already exists and differs')
 current=sum(path.stat().st_size for path in owner.iterdir() if path.is_file()) if owner.exists() else 0
 additional=sum(len(data) for name,data in files if not (owner/name).exists())
 if current+additional>16777216: raise RuntimeError('Mirror owner cap exceeded before publication')
 owner.mkdir(parents=True,exist_ok=True)
 for name,data in files:
  if not (owner/name).exists():
   with (owner/name).open('xb') as handle: handle.write(data)
 print(json.dumps({'published_files':len(files),'owner_bytes':current+additional,'required_bytes':4422941696}))
`;
const publication = spawnSync('python', ['-c', publishCode],
  { cwd: root, input: JSON.stringify({ files }), encoding: 'utf8', maxBuffer: 1048576 });
if (publication.stdout) process.stdout.write(publication.stdout);
if (publication.status !== 0) throw new Error(publication.stderr || publication.error?.message || 'Guarded publication failed');
console.log(JSON.stringify({ sample_plan_complete: report.sample_plan_complete, actual_gets_including_redirects: gets,
  report_sha256: hash(payloads.get('report.json')), distinct_original_bytes: retainedBytes }));
