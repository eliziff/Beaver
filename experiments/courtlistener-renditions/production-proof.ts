/** Storage round-trip proof through Beaver's unchanged compiler and link planner.
 * This does NOT select alternate renditions, invent a parser, or verify a website.
 * Apply expose-compiler.patch; run in Beaver's normal tsx/native-addon environment.
 */
import { deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { courtlistenerLegalSourceProvider as provider } from '../../backend/src/lib/legalSources/courtlistener';
import { structureNative, type NativeDocument } from '../../backend/src/lib/structureNative';
import { nativeDocumentPassages } from '../../backend/src/lib/legalSources/nativeDocumentPassages';
import { buildLegalSourcePinpoint } from '../../backend/src/lib/legalSourceLinks';
import { nonemptyString } from '../../backend/src/lib/value';
import type { LegalSourceReference } from '../../backend/src/lib/legalSources';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const option = process.argv.find(v => v.startsWith('--max-probes='));
const maxProbes = option ? Number(option.split('=')[1]) : 12;
if (!Number.isSafeInteger(maxProbes) || maxProbes < 0) throw new Error('Invalid --max-probes');
const api = structureNative(); // A missing native addon is an error, not a mocked pass.
if (typeof provider.compileOpinion !== 'function') throw new Error('Apply expose-compiler.patch first');
type Row = Record<string, unknown>;
type Job = {
  opinion: Row; original_opinion: Row | null; cluster: Row | null;
  cap_metadata: { citations?: Array<{ cite?: string; type?: string }> } | null;
  corpus_scope: unknown; source_digest: string;
};

function pageCitations(job: Job): string[] {
  // The exact priority in capPageCitations(). No substitute from a different table.
  const order = new Map(['official', 'nominative', 'parallel', 'vendor'].map((v,i) => [v,i]));
  return (job.cap_metadata?.citations ?? []).map((c,index) => ({ ...c,index }))
    .filter(c => typeof c.cite === 'string' && c.cite.trim())
    .sort((a,b) => (order.get(a.type ?? '') ?? 99) - (order.get(b.type ?? '') ?? 99) || a.index - b.index)
    .map(c => c.cite!);
}

function reference(job: Job, compiledUrl: string | null): LegalSourceReference | null {
  const id = Number(job.opinion.cluster_id ?? job.cluster?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const slug = nonemptyString(job.cluster?.slug);
  let url = compiledUrl ?? nonemptyString(job.cluster?.absolute_url) ??
    (slug ? `https://www.courtlistener.com/opinion/${id}/${slug}/` : null);
  if (!url || !new URL(url, 'https://www.courtlistener.com').pathname.match(/^\/opinion\/\d+\/[^/]+\/$/u)) return null;
  if (url.startsWith('/')) url = `https://www.courtlistener.com${url}`;
  return { provider: 'courtlistener', id: String(id), part: String(job.opinion.id), kind: 'case', url };
}

function snapshot(document: NativeDocument, source: LegalSourceReference | null) {
  const anchors = api.documentAnchors(document);
  const available = anchors.filter(a => ['paragraph','section','page','footnote'].includes(a.kind));
  const picked = new Map<string, typeof anchors[number]>();
  const n = Math.min(maxProbes, available.length);
  for (let i=0;i<n;i++) {
    const a = available[Math.floor(i*available.length/n)]!;
    picked.set(`${a.kind}:${a.label}`, a);
  }
  const probes: unknown[] = [];
  for (const a of picked.values()) {
    if (!source) break;
    const kind = a.kind as 'paragraph'|'section'|'page'|'footnote';
    const passages = nativeDocumentPassages({ reference: source, document,
      request: { source, locator: { kind, value: a.label }, contextBlocks: 0 } });
    probes.push({ kind, label: a.label, passages: passages.map(p => {
      const quote = p.text.slice(0,400).trim();
      const target = source.url && quote ? buildLegalSourcePinpoint({
        url: source.url, blockText: p.text, documentText: document,
        anchor: p.locator.anchor ?? undefined, pageScoped: p.locator.pageScoped,
      }, [quote]) : null;
      return { text: p.text, locator: p.locator, role: p.role,
        block: p.blockArtifact ?? null, target };
    }) });
  }
  return { text: api.documentText(document), anchors,
    fingerprint: api.documentFingerprint(document), probes };
}

async function run(job: Job) {
  if (!job.original_opinion) throw new Error('Export jobs with --original-db; no self-comparison');
  deepStrictEqual(job.opinion, job.original_opinion, 'Reconstructed input differs');
  const id = Number(job.opinion.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid opinion id');
  // The importer/API normalizes IDs to numbers. Both sides use the same conversion.
  const original = { ...job.original_opinion, id };
  const restored = { ...job.opinion, id };
  const citations = pageCitations(job);
  const before = await provider.compileOpinion(original, citations);
  const after = await provider.compileOpinion(restored, citations);
  const beforeDocument = 'native' in before ? before.native : undefined;
  const afterDocument = 'native' in after ? after.native : undefined;
  const metadata = (v: object) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'native'));
  deepStrictEqual(metadata(before), metadata(after), 'Compiled metadata differs');
  deepStrictEqual(Boolean(beforeDocument), Boolean(afterDocument), 'Document availability differs');
  const a = beforeDocument ? snapshot(beforeDocument, reference(job,before.url)) : null;
  const b = afterDocument ? snapshot(afterDocument, reference(job,after.url)) : null;
  deepStrictEqual(a,b,'Structure, passage, or link-plan output differs');
  return { schema: 'beaver.courtlistener-storage-parity.v1', opinion_id: id,
    source_digest: job.source_digest, status: 'exact-roundtrip',
    native_document_present: Boolean(a),
    text_sha256: a ? hash(a.text) : null, anchor_count: a?.anchors.length ?? 0,
    link_probe_count: a?.probes.length ?? 0, corpus_scope: job.corpus_scope,
    cap_metadata: job.cap_metadata ? 'supplied-offline' : 'missing-on-both-sides',
    live_browser_verification: 'not-run',
    meaning: 'Storage does not change existing behavior; not a structure-quality or live-link certificate' };
}

async function main() {
  let jobs = 0;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const result = await run(JSON.parse(line) as Job);
    if (!process.stdout.write(JSON.stringify(result)+'\n')) await once(process.stdout,'drain');
    jobs++;
  }
  console.error(JSON.stringify({ completed_jobs: jobs, native_build_features: api.nativeBuildFeatures(),
    changed_source_policies: 0, live_browser_checks: 0 }));
}
main().catch(error => { console.error(error); process.exitCode=1; });
