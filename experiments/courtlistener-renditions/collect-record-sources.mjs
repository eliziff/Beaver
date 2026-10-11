// Real, bounded read-only API acquisition. Originals remain private; no document bodies are fetched by URL.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const owner = join(root, 'benchmarks/local-data/courtlistener-renditions/all-collections/api-samples');
const base = 'https://www.courtlistener.com/api/rest/v4/';
const maximumBytes = 33554432, requiredBytes = 4406164480 + maximumBytes;
const maximumRequests = 20, maximumResponseBytes = 4 * 1024 * 1024, receiptReserve = 256 * 1024;
const intervalMs = 13000;
const useSystemCurl = process.argv.includes('--system-curl');
const families = ['docket-entries', 'recap-documents', 'parties', 'attorneys', 'sources', 'aba-ratings'];
const allowed = new Set([...families, 'dockets', 'api-usage']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const collectorSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
const repoPath = path => relative(root, path).replaceAll('\\', '/');
const reportPath = join(owner, 'report.json');
const previous = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
const responses = previous?.responses ?? [];
const cache = new Map(responses.map(record => [record.request_url, record]));
const live = new Map();
const payloads = [];
let retainedBytes = responses.reduce((sum, record) => sum + (record.original?.bytes ?? 0), 0);
let requests = 0, lastRequest = 0, quota = maximumRequests, stopReason = null;
const report = {
  schema: 'courtlistener.public-record-source-sample.v1', captured_utc: previous?.captured_utc ?? new Date().toISOString(),
  updated_utc: null, scope: 'Complete bounded API response entities for a first public-record sample; only actually returned records are covered. No whole-RECAP census or document-file/body acquisition is claimed.',
  owner: repoPath(owner), limits: { maximum_owner_bytes: maximumBytes, maximum_requests_this_run: maximumRequests,
    maximum_response_bytes: maximumResponseBytes, minimum_request_interval_ms: intervalMs, maximum_selected_dockets: 2,
    pagination_pages_per_query: 1, field_selection: 'No fields omitted; every complete response is retained without JSON reserialization.' },
  documentation: {
    overview: 'https://wiki.free.law/c/courtlistener/help/api/rest/v4/rest-api-v47',
    pacer: 'https://wiki.free.law/c/courtlistener/help/api/rest/v4/pacer-data',
    judges: 'https://wiki.free.law/c/courtlistener/help/api/rest/v4/american-judge-and-justice-api',
    refinement: 'https://wiki.free.law/c/courtlistener/help/api/rest/v4/query-refinement',
    files: 'https://wiki.free.law/c/courtlistener/help/api/rest/v4/field-help',
    usage: 'https://wiki.free.law/c/courtlistener/help/api/rest/v4/api-usage',
  },
  authentication: 'Configured backend/.env token used only in memory and same-origin Authorization headers; neither token nor request headers retained.',
  responses, selected_dockets: [], collections: {}, source_body_candidates: [],
  boundaries: ['The documented default is 5 requests/minute, 50/hour, 125/day; this sample paces every GET and stops on throttling or reported hour/day exhaustion.',
    'Counts describe the exact server query at capture time. Cursor/next links are retained but never enumerated.',
    'People, source/ABA metadata and docket relations are API records, not independent semantic gold. Nested relations are reported as returned.',
    'Storage/PDF/source URLs and is_available flags are recorded claims; no binary, external source page, PACER purchase, prayers or fetch endpoint is visited.'],
};

const envText = readFileSync(join(root, 'backend/.env'), 'utf8');
const token = parseEnv(envText).COURTLISTENER_API_TOKEN?.trim();
const authenticationMode = token ? 'configured_token' : 'anonymous_credentials_absent';
report.authentication = { mode: authenticationMode, credentials_absent: !token,
  configuration: 'backend/.env parsed with the standard Node parseEnv used by the backend env-file loader; no other credential locations searched.',
  boundary: 'No token or request Authorization header/value retained; configured values enter only memory and same-origin headers/curl stdin.' };
for (const record of responses) {
  if (record.status === 401 && record.authentication_mode === undefined) {
    record.collector_configuration_failure = 'Pre-fix custom .env parser crossed an empty assignment; this failed request does not qualify collection access.';
    record.collection_access_qualified = false;
  }
}
const scrub = message => token ? String(message).replaceAll(token, '[redacted]') : String(message);

function apiUrl(value) {
  const url = new URL(value, base);
  if (url.origin !== 'https://www.courtlistener.com' || url.username || url.password
      || !url.pathname.startsWith('/api/rest/v4/') || !allowed.has(url.pathname.split('/')[4])) {
    throw new Error('Returned URL is outside the approved read-only API record endpoints');
  }
  return url.href;
}

function systemFetch(url) {
  const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  const config = ['silent', 'show-error', 'include', 'max-time = 30', 'request = "GET"',
    `url = ${quote(url)}`, 'header = "Accept: application/json"', 'header = "Accept-Encoding: identity"',
    ...(token ? [`header = ${quote(`Authorization: Token ${token}`)}`] : [])].join('\n') + '\n';
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'COURTLISTENER_API_TOKEN'));
  const reply = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--config', '-'],
    { input: config, env, maxBuffer: maximumResponseBytes + 65536, timeout: 31000 });
  const output = reply.stdout ?? Buffer.alloc(0);
  let offset = 0, status = null, headers = new Headers();
  while (output.subarray(offset, offset + 5).toString() === 'HTTP/') {
    const end = output.indexOf('\r\n\r\n', offset); if (end < 0) break;
    const lines = output.subarray(offset, end).toString('utf8').split('\r\n');
    status = Number(lines.shift().match(/^HTTP\/\S+\s+(\d{3})/u)?.[1]) || null;
    headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(':'); if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    offset = end + 4;
  }
  if (reply.status !== 0 || status === null) {
    const error = new Error(scrub(reply.stderr?.toString('utf8') || reply.error?.message || 'curl returned no HTTP response'));
    error.code = reply.error?.code ?? `CURL_${reply.status}`;
    error.httpStatus = status;
    throw error;
  }
  return new Response([204, 304].includes(status) ? null : output.subarray(offset), { status, headers });
}

async function capture(value, purpose) {
  const url = apiUrl(value);
  if (live.has(url)) return live.get(url);
  const prior = cache.get(url);
  if (prior?.body_complete && prior.authentication_mode === authenticationMode) {
    const bytes = readFileSync(join(owner, prior.original.path));
    if (bytes.length !== prior.original.bytes || sha256(bytes) !== prior.original.sha256) throw new Error('Retained API original identity differs');
    let data = null; try { data = JSON.parse(bytes.toString('utf8')); } catch {}
    return { record: prior, data };
  }
  if (stopReason || requests >= maximumRequests || requests >= quota
      || retainedBytes >= maximumBytes - receiptReserve) {
    stopReason ??= requests >= quota ? 'declared_request_or_observed_quota_limit' : 'declared_owner_byte_limit';
    return { record: { request_url: url, purpose, status: null, skipped: stopReason }, data: null };
  }
  const wait = Math.max(0, lastRequest + intervalMs - Date.now());
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequest = Date.now(); requests++;
  const record = { ordinal: responses.length, purpose, request_url: url, method: 'GET', captured_utc: new Date().toISOString(),
    authentication_mode: authenticationMode, status: null, body_complete: false, original: null, error: null, limits: {}, pagination: null };
  responses.push(record);
  let data = null;
  try {
    const response = useSystemCurl ? systemFetch(url) : await fetch(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...(token ? { Authorization: `Token ${token}` } : {}) } });
    record.transport = useSystemCurl ? 'installed_curl_with_system_certificate_verification' : 'node_fetch';
    record.status = response.status;
    record.response_url = response.url || url;
    record.headers = Object.fromEntries([...response.headers].filter(([name]) =>
      ['date', 'content-type', 'content-length', 'content-encoding', 'etag', 'last-modified', 'retry-after'].includes(name)
      || name.startsWith('x-ratelimit') || name.startsWith('ratelimit')));
    const limit = Math.min(maximumResponseBytes, maximumBytes - receiptReserve - retainedBytes);
    record.limits.response_byte_limit = limit;
    const chunks = []; let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > limit) { await reader.cancel(); throw new Error('Complete response exceeds the declared byte allowance; no partial original retained'); }
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { record.received_body_bytes = bytes; reader.releaseLock(); }
    }
    const body = Buffer.concat(chunks, bytes);
    if (token && body.includes(Buffer.from(token))) throw new Error('Response contained configured secret; original was not retained');
    const filename = `response-${String(record.ordinal).padStart(3, '0')}-${new URL(url).pathname.split('/')[4]}.body`;
    payloads.push({ name: filename, base64: body.toString('base64') });
    retainedBytes += body.length;
    record.body_complete = true;
    record.original = { path: filename, bytes: body.length, sha256: sha256(body),
      representation: 'Complete HTTP response entity bytes from fetch, before JSON parsing; Accept-Encoding identity requested.' };
    try { data = JSON.parse(body.toString('utf8')); } catch { record.error = 'Complete response is not JSON'; }
    if (!response.ok) record.error ??= `HTTP ${response.status}`;
    if (data && typeof data === 'object') {
      record.pagination = { count: data.count ?? null, next: data.next ?? null, previous: data.previous ?? null,
        returned_records: Array.isArray(data.results) ? data.results.length : null, next_followed: false };
    }
    if (response.status === 429 || (response.status === 401 && token)) stopReason = `HTTP_${response.status}`;
  } catch (error) {
    record.status ??= error.httpStatus ?? null;
    record.error = scrub(error.message ?? error);
    record.error_cause = error.cause?.message ? scrub(error.cause.message) : null;
    record.error_code = error.cause?.code ?? error.code ?? null;
    if (record.status === null) stopReason = 'transport_failure_before_HTTP_response';
  }
  cache.set(url, record);
  live.set(url, { record, data });
  console.log(JSON.stringify({ ordinal: record.ordinal, endpoint: new URL(url).pathname.split('/')[4],
    status: record.status, body_complete: record.body_complete, bytes: record.original?.bytes ?? 0,
    error: record.error, error_cause: record.error_cause ?? null, error_code: record.error_code ?? null }));
  return { record, data };
}

function rows(capture) { return capture.record.status === 200 && Array.isArray(capture.data?.results) ? capture.data.results : []; }
function webUrl(value) { return typeof value === 'string' && value ? new URL(value, 'https://www.courtlistener.com').href : null; }
function storageUrl(value) { return typeof value === 'string' && value ? new URL(value.replace(/^\/+/, ''), 'https://storage.courtlistener.com/').href : null; }
function courtOf(row) { return row.court_id ?? row.court?.split('/').filter(Boolean).at(-1) ?? null; }
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array:${value.length}`;
  if (typeof value === 'string') return value.length ? 'string_nonempty' : 'string_empty';
  return typeof value;
}

function observe(family, result) {
  const items = rows(result), counts = {};
  const increment = key => counts[key] = (counts[key] ?? 0) + 1;
  for (const row of items) {
    for (const [field, value] of Object.entries(row)) increment(`${field}:${shape(value)}`);
    if (family === 'recap-documents') report.source_body_candidates.push({
      collection: family, response_ordinal: result.record.ordinal, record_id: row.id,
      api_url: row.resource_uri ?? null, web_url: webUrl(row.absolute_url), docket_entry: row.docket_entry ?? null,
      document_type: row.document_type ?? null, attachment_number: row.attachment_number ?? null,
      is_available: row.is_available ?? null, filepath_local: row.filepath_local ?? null,
      canonical_file_url: storageUrl(row.filepath_local),
      original_download_url: row.download_url ?? null,
      plain_text: { presence: shape(row.plain_text ?? null), utf8_bytes: typeof row.plain_text === 'string' ? Buffer.byteLength(row.plain_text) : null },
      binary_link_verified: false, source_body_fetched_by_url: false,
    });
    if (family === 'sources') report.source_body_candidates.push({ collection: family, response_ordinal: result.record.ordinal,
      record_id: row.id, api_url: row.resource_uri ?? null, person: row.person ?? null, source_url: row.url ?? null,
      source_body_fetched_by_url: false });
  }
  const collection = report.collections[family] ??= { captures: [], observed_records: 0, record_field_shapes: {}, coverage: 'Only returned page records; not a collection census.' };
  collection.captures.push({ response_ordinal: result.record.ordinal ?? null, request_url: result.record.request_url,
    status: result.record.status, error: result.record.error ?? result.record.skipped ?? null, returned_records: items.length,
    count_evidence: result.record.pagination?.count ?? null, next: result.record.pagination?.next ?? null });
  collection.observed_records += items.length;
  for (const [key, count] of Object.entries(counts)) collection.record_field_shapes[key] = (collection.record_field_shapes[key] ?? 0) + count;
}

// Publication happens only in this callback, under the shared mutex/admission and owner cap.
const publishCode = `import base64,hashlib,json,os,sys
from pathlib import Path
root=Path.cwd()
sys.path.insert(0,str(root/'experiments/courtlistener-renditions'))
import budget
owner=root/'benchmarks/local-data/courtlistener-renditions/all-collections/api-samples'
payload=json.load(sys.stdin)
with budget.writer():
 budget.require_bytes(4439718912)
 owner.mkdir(parents=True,exist_ok=True)
 files=[(item['name'],base64.b64decode(item['base64'],validate=True)) for item in payload['files']]
 current=sum(path.stat().st_size for path in owner.iterdir() if path.is_file())
 additional=sum(len(data) for name,data in files if not (owner/name).exists())
 replaced=sum((owner/name).stat().st_size for name,data in files if name in ('report.json','access-structure-report.md') and (owner/name).exists())
 new_receipts=sum(len(data) for name,data in files if name in ('report.json','access-structure-report.md') and (owner/name).exists())
 journal=owner/'transport-failures.jsonl'
 failure_line=b''
 if (owner/'report.json').exists():
  prior_bytes=(owner/'report.json').read_bytes()
  prior=json.loads(prior_bytes)
  if prior.get('responses') and all(row.get('status') is None for row in prior['responses']):
   line=(json.dumps({'report_sha256':hashlib.sha256(prior_bytes).hexdigest(),'report':prior},separators=(',',':'))+'\\n').encode()
   if not journal.exists() or line not in journal.read_bytes(): failure_line=line
 if current+additional-replaced+new_receipts+len(failure_line)>33554432: raise RuntimeError('API sample owner cap exceeded before publication')
 if failure_line:
  with journal.open('ab') as handle: handle.write(failure_line)
 for name,data in files:
  if Path(name).name!=name: raise RuntimeError('Publication must remain inside the assigned owner')
  path=owner/name
  if name in ('report.json','access-structure-report.md'):
   path.write_bytes(data)
  elif path.exists():
   if path.read_bytes()!=data: raise RuntimeError('Retained original differs; refusing overwrite')
  else:
   with path.open('xb') as handle: handle.write(data)
 print(json.dumps({'published_files':len(files),'owner_bytes':sum(path.stat().st_size for path in owner.iterdir() if path.is_file()),'required_bytes':4439718912}))
`;

try {
  await capture('sources/', 'First actual judge-source corpus page; continue other endpoints only after an HTTP response');
  const usage = token ? await capture('api-usage/', 'Document actual account throttles before the bounded source acquisition')
    : { data: null, record: { skipped: 'Authentication-required usage endpoint not requested without configured credentials' } };
  report.usage_endpoint_boundary = usage.record.skipped ?? null;
  report.observed_rate_limits = usage.data?.current_usage ?? null;
  const userRates = Array.isArray(usage.data?.current_usage) ? usage.data.current_usage.filter(row => row.scope === 'user') : [];
  const longRates = userRates.filter(row => row.window_seconds >= 3600);
  if (longRates.length) quota = Math.min(quota, ...longRates.map(row => Math.max(0, Number(row.remaining) || 0)));
  if (userRates.some(row => row.blocked || row.remaining === 0)) stopReason = 'reported_account_quota_exhausted';
  if (!stopReason && userRates.some(row => row.window_seconds === 60 && row.used > 0)) {
    console.log(JSON.stringify({ pacing: 'Clear earlier minute-window traffic before the first source GET', wait_ms: 60000 }));
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
  const first = new Map();
  for (const family of families) {
    const result = await capture(`${family}/`, `First complete bounded page of ${family} omitted from quarterly bulk`);
    first.set(family, result); observe(family, result);
  }
  const dockets = await capture('dockets/?order_by=-date_modified', 'Returned public docket/court/source context for bounded strata, without invented IDs');
  observe('dockets', dockets);
  const seenStrata = new Set();
  for (const docket of rows(dockets)) {
    if (!docket.pacer_case_id || !Number.isSafeInteger(docket.id)) continue;
    const stratum = `${courtOf(docket)}:${docket.source}`;
    if (seenStrata.has(stratum)) continue;
    seenStrata.add(stratum);
    report.selected_dockets.push({ id: docket.id, court: courtOf(docket), source: docket.source,
      pacer_case_id: docket.pacer_case_id, provenance: { response_ordinal: dockets.record.ordinal, record_id: docket.id } });
    if (report.selected_dockets.length === 2) break;
  }
  for (const [family, result] of first) {
    if (result.record.status !== 200 || typeof result.data?.count !== 'string') continue;
    const countUrl = apiUrl(result.data.count);
    if (new URL(countUrl).searchParams.get('count') !== 'on') continue;
    const count = await capture(countUrl, `Count evidence for the exact ${family} page query; not downloaded collection coverage`);
    report.collections[family].total_count_evidence = { response_ordinal: count.record.ordinal ?? null,
      request_url: count.record.request_url, status: count.record.status, count: count.data?.count ?? null, error: count.record.error ?? count.record.skipped ?? null };
  }
  for (const docket of report.selected_dockets) {
    for (const family of ['docket-entries', 'parties', 'attorneys']) {
      if (first.get(family)?.record.status !== 200) continue;
      const nested = family === 'docket-entries' ? '' : '&filter_nested_results=True';
      const result = await capture(`${family}/?docket=${docket.id}${nested}`, `Returned docket ${docket.id}, court ${docket.court}, source ${docket.source}; bounded related-record stratum`);
      observe(family, result);
    }
  }
} catch (error) { report.failure = scrub(error.message ?? error); stopReason ??= 'acquisition_error'; }
finally {
  report.updated_utc = new Date().toISOString();
  report.requests_this_run = requests; report.retained_original_bytes = retainedBytes;
  report.stop_reason = stopReason ?? 'declared_first_sample_complete';
  report.sample_plan_complete = !stopReason;
  report.collection_census_complete = false;
  report.script_sha256 = collectorSha256;
  report.backend_client_sha256 = sha256(readFileSync(join(root, 'backend/src/lib/legalSources/courtlistener.ts')));
  const lines = [
    '# CourtListener public API first source sample', '', report.scope, '',
    `Stop: ${report.stop_reason}. New GETs: ${requests}/${maximumRequests}. Complete original response bytes: ${retainedBytes}. Owner cap: ${maximumBytes} bytes.`, '',
    '| Collection | Returned page records | HTTP/access outcomes |', '| --- | ---: | --- |',
    ...Object.entries(report.collections).map(([family, value]) => `| ${family} | ${value.observed_records} | ${value.captures.map(row => row.status ?? row.error).join(', ')} |`), '',
    'Every retained response has its request URL, status, complete original-byte SHA-256 and pagination/count evidence in report.json. Record counts may overlap across queries; they are not distinct corpus totals.', '',
    'Canonical file/source candidates are in report.json. Availability and links are reported by the returned API record; no PDF, file, source page or PACER purchase was requested.', '',
    `Official guidance: [REST v4.7](${report.documentation.overview}), [PACER data](${report.documentation.pacer}), [judge records](${report.documentation.judges}), [query refinement](${report.documentation.refinement}), [file paths](${report.documentation.files}).`, '',
  ];
  const receipts = { 'report.json': JSON.stringify(report, null, 2) + '\n', 'access-structure-report.md': lines.join('\n') };
  for (const [name, content] of Object.entries(receipts)) payloads.push({ name, base64: Buffer.from(content).toString('base64') });
  const childEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'COURTLISTENER_API_TOKEN')), PYTHONDONTWRITEBYTECODE: '1' };
  const published = spawnSync('python', ['-c', publishCode], { cwd: root, env: childEnv,
    input: JSON.stringify({ files: payloads }), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (published.status !== 0) throw new Error(`Guarded API publication failed: ${scrub(published.stderr || published.error || published.status)}`);
  console.log(published.stdout.trim());
}
