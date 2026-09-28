// Exercise the production acquisition -> saved draft -> pagination -> highlight path.
const fs = require('node:fs'), path = require('node:path');
const out = path.resolve('tmp/pdf-pagination');
process.env.MIKE_LOCAL_DATA_DIR = path.join(out, 'authorities-store');
const { resolveAuthoritiesSources } = require('../../backend/dist/lib/authoritiesSourceResolution');
const { createAuthoritiesDraft, reduceAuthoritiesDraft, decodeAuthoritiesDraft, authorityCitationForms } = require('../../backend/dist/lib/authoritiesDomain');
const { documentProjectionService: service } = require('../../backend/dist/lib/documentProjectionService');
const { reporterStartPages } = require('../../backend/dist/lib/pdfPagination');
const { prepareAuthorityAnnotations } = require('../../backend/dist/lib/authoritiesBuild');
const pdf = require('../../backend/node_modules/pdf-lib');
const crypto = require('node:crypto');
const diverse = process.argv.includes('--diverse');
const canadian = process.argv.includes('--canadian') || diverse;
const cohort = diverse ? 'canadian-diverse' : canadian ? 'canadian-authorities' : 'authorities';
const candidates = JSON.parse(fs.readFileSync(path.join(out, `${cohort}-candidates.json`)));
const citationOnly = process.argv.includes('--citation-only');
const batchArgument = process.argv.indexOf('--max-new');
const maxNew = batchArgument < 0 ? Infinity : Number(process.argv[batchArgument + 1]);
if (!Number.isSafeInteger(maxNew) && maxNew !== Infinity || maxNew < 1)
  throw new Error('--max-new must be a positive integer');
if (canadian && candidates.some(row => row.provider !== 'a2aj' || row.jurisdiction !== 'CA'))
  throw new Error('Canadian cohort contains a non-Canadian candidate');
const reusable = new Map();
if (canadian) for (const manifest of ['authorities-manifest.json', 'publisher-cached.json'])
  for (const row of JSON.parse(fs.readFileSync(path.join(out, manifest))))
    if (row.provider === 'a2aj' && row.origin === 'original' && row.id) reusable.set(row.id, row);
fs.mkdirSync(path.join(out, cohort), { recursive: true });
async function run(candidate, index) {
  const receipt = path.join(out, cohort, `${canadian ? 'case-' + candidate.id : index}.json`);
  if (fs.existsSync(receipt)) return JSON.parse(fs.readFileSync(receipt));
  if (reusable.has(candidate.id)) {
    const row = { ...reusable.get(candidate.id), ...candidate };
    fs.writeFileSync(receipt, JSON.stringify(row)); return row;
  }
  try {
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: 'manual' }, {}, 'book'), {
      type: 'add-authority', authority: { id: 'case', key: 'case', kind: 'case', citation: candidate.resolutionCitation ?? candidate.citation,
        name: null, displayName: null, excluded: false, evidenceIds: [], locators: [],
        sourceIdentity: null, source: { kind: 'unresolved' } },
    });
    const resolved = await resolveAuthoritiesSources(draft, undefined, AbortSignal.timeout(90_000));
    const verificationUrl = resolved.draft.authorities.case?.sourceVerificationUrl;
    if (verificationUrl) {
      const row = { ...candidate, error: 'Publisher verification required', verificationUrl };
      fs.writeFileSync(receipt, JSON.stringify(row));
      console.log(JSON.stringify(row)); return row;
    }
    const attachment = resolved.attachments[0];
    if (!attachment) throw new Error(`No attachment: ${resolved.draft.authorities.case?.source.kind}`);
    const filename = path.join(out, 'authorities', attachment.sourceSha256 + '.pdf');
    fs.writeFileSync(filename, attachment.bytes);
    draft = reduceAuthoritiesDraft(resolved.draft, { type: 'attach-source', authorityId: attachment.authorityId,
      bindingRole: 'source:case', binding: { kind: 'local-file', handleId: attachment.sourceSha256,
        lastSeen: { name: attachment.filename, size: attachment.bytes.length, modified: 0, sha256: attachment.sourceSha256 } },
      filename: attachment.filename, sourceSha256: attachment.sourceSha256, sourceUrl: attachment.sourceUrl,
      origin: attachment.origin, language: attachment.language });
    draft = decodeAuthoritiesDraft(JSON.parse(JSON.stringify(draft)));
    if (!draft) throw new Error('Draft did not survive serialization');
    const authority = draft.authorities[attachment.authorityId];
    const citations = authorityCitationForms(draft, authority.id);
    const starts = reporterStartPages(citations);
    if (citationOnly) {
      const pageCount = (await pdf.PDFDocument.load(attachment.bytes)).getPageCount();
      const row = { ...candidate, path: filename, sha256: attachment.sourceSha256,
        url: attachment.sourceUrl, title: authority.name ?? candidate.citation,
        category: 'authorities', origin: attachment.origin, citations, starts,
        page_count: pageCount, split: 'validation' };
      fs.writeFileSync(receipt, JSON.stringify(row));
      console.log(JSON.stringify({ index, citation: candidate.citation, origin: row.origin }));
      return row;
    }
    const reference = { documentId: attachment.sourceSha256, versionId: attachment.sourceSha256, sourceSha256: attachment.sourceSha256 };
    const source = { ...reference, fileType: 'pdf', readBytes: () => attachment.bytes };
    const started = performance.now(), labels = await service.pdfPageLabels(source, citations);
    const observed = await service.pdfPageLabels(source);
    const anchor = observed.findIndex(label => label && starts.includes(Number(label)));
    let agreement = null;
    if (anchor >= 0 && labels[anchor + 2]) {
      authority.locators = [{ kind: 'page', label: labels[anchor + 2] }];
      draft.settings.passageMarking = 'sidelined';
      const prepared = await service.preparePdf({ ...reference, bytes: attachment.bytes, ocrProvider: null });
      const geometry = await service.pdfPassageGeometry(source.readBytes,
        [{ id: 'page', locatorKind: 'page', locator: labels[anchor + 2] }],
        { ...reference, cacheKey: prepared.cacheKey }, { citations,
          pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile, status: prepared.status } });
      const document = await pdf.PDFDocument.load(attachment.bytes);
      const annotations = prepareAuthorityAnnotations(pdf, document, draft, authority, authority.source.sources[0],
        { pageLabels: labels, passageGeometry: geometry }, true);
      const destinations = [...new Set(annotations.annotations.marks.flatMap(mark => mark.fragments.map(f => f.pageNumber)))];
      agreement = destinations.length === 1 && destinations[0] === anchor + 3;
      if (!agreement) throw new Error(`Display/highlight disagreement: ${JSON.stringify(destinations)}`);
    }
    const row = { ...candidate, path: filename, sha256: attachment.sourceSha256, url: attachment.sourceUrl,
      title: authority.name ?? candidate.citation, category: 'authorities', source: candidate.provider,
      origin: attachment.origin, citations, page_count: labels.length, anchor: anchor < 0 ? null : anchor + 1,
      starts, agreement, elapsedMs: performance.now()-started,
      split: parseInt(crypto.createHash('sha256').update(candidate.citation).digest('hex').slice(0,8),16)%5===0 ? 'development':'held-out' };
    fs.writeFileSync(path.join(out, attachment.sourceSha256 + '.prediction.json'), JSON.stringify({
      starts, anchor: row.anchor, bindings: labels.map((label,i) => ({ pdfPage:i+1,label,observed:observed[i],
        source: observed[i] ? 'detected' : label ? 'reporter' : null })) }));
    fs.writeFileSync(receipt, JSON.stringify(row));
    console.log(JSON.stringify({ index, citation:candidate.citation, origin:row.origin, anchor:row.anchor, agreement }));
    return row;
  } catch(error) {
    const row = { ...candidate, error:String(error) }; fs.writeFileSync(receipt,JSON.stringify(row));
    console.log(JSON.stringify({index,...row})); return row;
  }
}
(async()=>{
  const rows=[];
  // Bounded public-provider traffic; no CanLII acquisition or application-store changes.
  const originals = new Set(), strata = new Map(), blockedHosts = new Set();
  let newAttempts = 0;
  for(let index=0;index<candidates.length;index++) {
    const host = candidates[index].sourceUrl ? new URL(candidates[index].sourceUrl).hostname : null;
    if (host && blockedHosts.has(host)) continue;
    if (canadian && !diverse && (strata.get(candidates[index].stratum) ?? 0) >= 50) continue;
    const receipt = path.join(out, cohort, `${canadian ? 'case-' + candidates[index].id : index}.json`);
    if (!fs.existsSync(receipt) && newAttempts >= maxNew) break;
    if (!fs.existsSync(receipt)) newAttempts++;
    const row = await run(candidates[index], index); rows.push(row);
    if (row.verificationUrl) {
      if (host) blockedHosts.add(host);
      if (!diverse) break;
      continue;
    }
    if (row.origin === 'original' && !originals.has(row.sha256)) {
      originals.add(row.sha256); strata.set(row.stratum, (strata.get(row.stratum) ?? 0) + 1);
    }
    fs.writeFileSync(path.join(out,`${cohort}-manifest.json`),JSON.stringify(rows.filter(row=>!row.error),null,2));
    if (citationOnly && originals.size >= (diverse ? 100 : 350)) break;
  }
  fs.writeFileSync(path.join(out,`${cohort}-manifest.json`),JSON.stringify(rows.filter(row=>!row.error),null,2));
  console.log(JSON.stringify({cohort,originals:originals.size,newAttempts,blockedHosts:[...blockedHosts]}));
})().catch(error=>{console.error(error);process.exitCode=1});
