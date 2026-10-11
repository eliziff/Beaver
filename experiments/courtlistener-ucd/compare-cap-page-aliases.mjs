import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const [nativeDirectory, corpusHome = path.join(process.env.LOCALAPPDATA ?? '', 'OpenLegalData')] = process.argv.slice(2);
if (!nativeDirectory) throw Error('Supply the retained CAP source-run directory and optionally OpenLegalData home');
const started = performance.now();
const manifestFile = path.join(nativeDirectory, 'source-manifest.jsonl');
const goldFile = path.join(nativeDirectory, 'xml-source-gold.jsonl');
const nativeFile = path.join(nativeDirectory, 'records.jsonl.zst');
const executable = fileURLToPath(new URL('../../native/legal-structure-node/target/release/courtlistener-corpus' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const fileDigest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const lines = file => createInterface({input:fs.createReadStream(file), crlfDelay:Infinity});
const ranks = new Map(['official', 'nominative', 'parallel', 'vendor'].map((type, index) => [type, index]));
const sources = new Map(), gaps = [], records = [];
const totals = {sources:0, sources_with_pages:0, original_citations:0, citation_types:{}, citation_indexes:{}, citation_arrays_reordered:0, source_page_markers:0, source_marker_tags:{}, source_footnote_page_markers:0, expected_aliases:0, native_page_markers:0, exact_aliases:0, missing_page_markers:0, missing_aliases:0, wrong_alias_mappings:0, unexpected_aliases:0, wrong_page_labels:0, citation_order_mismatches:0, source_label_text_mismatches:0, ambiguous_aliases:0, ambiguous_page_markers:0, local_query_rows:0, local_query_rows_resolved:0, unambiguous_queries:0, unambiguous_queries_resolved:0, missing_query_rows:0};

for await (const line of lines(manifestFile)) {
  if (!line.trim()) continue;
  const capture = JSON.parse(line);
  if (capture.format !== 'cap-json') continue;
  if (sources.has(capture.sha256)) throw Error('Duplicate original CAP source in manifest');
  const sourcePath = path.resolve(corpusHome, capture.corpus_path);
  if (!sourcePath.startsWith(path.resolve(corpusHome) + path.sep)) throw Error('Original source path escapes corpus home');
  const bytes = fs.readFileSync(sourcePath);
  if (digest(bytes) !== capture.sha256) throw Error('Original retained CAP source digest changed');
  const original = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(original.citations) || typeof original.casebody?.data !== 'string') throw Error('Original CAP metadata or XML missing');
  const citations = original.citations
    .map((value, index) => ({...value, index}))
    .filter(value => typeof value.cite === 'string' && value.cite.trim())
    .sort((left, right) => (ranks.get(left.type) ?? 99) - (ranks.get(right.type) ?? 99) || left.index - right.index);
  totals.citation_arrays_reordered += Number(citations.some((citation, index) => citation.index !== index));
  for (const citation of original.citations) totals.citation_types[citation.type ?? 'unknown'] = (totals.citation_types[citation.type ?? 'unknown'] ?? 0) + 1;
  totals.original_citations += original.citations.length;
  sources.set(capture.sha256, {capture, citations, pages:null});
}

for await (const line of lines(goldFile)) {
  if (!line.trim()) continue;
  const gold = JSON.parse(line), source = sources.get(gold.html_sha256);
  if (!source || gold.body_index !== 0 || source.pages !== null) throw Error('Independent XML gold does not match unique original CAP source');
  source.pages = gold.elements.filter(element => element.tag === 'page-number' || (element.attributes.class ?? '').split(/\s/u).includes('page-label')).map(element => {
    const label = element.attributes.label ?? element.attributes['data-label'];
    const citationIndex = element.attributes['citation-index'] ?? element.attributes['data-citation-index'];
    if (typeof label !== 'string' || !label || !/^[1-9]\d*$/u.test(citationIndex ?? '')) throw Error('Source page label or citation index needs a broader corpus oracle');
    const citation = source.citations[Number(citationIndex) - 1];
    const prefix = citation?.cite.trimEnd().match(/^(.*\s)\S+$/su)?.[1];
    if (!prefix) throw Error('Source citation index or reporter prefix cannot form an independently justified alias');
    const textLabel = element.text_content.replace(/^\*+/u, '').trim();
    if (textLabel !== label) {
      totals.source_label_text_mismatches++;
      gaps.push({html_sha256:gold.html_sha256, source_index:element.source_index, failure:'source-label-text-disagreement', label, text_label:textLabel});
    }
    totals.citation_indexes[citationIndex] = (totals.citation_indexes[citationIndex] ?? 0) + 1;
    totals.source_marker_tags[element.tag] = (totals.source_marker_tags[element.tag] ?? 0) + 1;
    let parent = element.parent_index, footnote = null;
    while (parent !== null) {
      const ancestor = gold.elements[parent];
      if (ancestor.tag === 'footnote' || (ancestor.attributes.class ?? '').split(/\s/u).includes('footnote')) footnote = {source_index:parent, label:ancestor.attributes.label ?? null};
      parent = ancestor.parent_index;
    }
    totals.source_footnote_page_markers += Number(footnote !== null);
    const alias = prefix + label;
    const aliases = /^\d{1,5}$/u.test(label) ? [alias] : [label, alias];
    if (element.attributes.pagescheme) aliases.push(element.attributes.pagescheme + ', at *' + label);
    return {source_index:element.source_index, tag:element.tag, attributes:element.attributes, footnote, label, citation_index:Number(citationIndex), citation:citation.cite, citation_type:citation.type, alias, aliases};
  });
}
if ([...sources.values()].some(source => source.pages === null)) throw Error('Independent XML gold omitted an original CAP source');

const decoded = spawn(executable, ['decode', nativeFile], {stdio:['ignore', 'pipe', 'pipe']});
let decodeError = '';
decoded.stderr.setEncoding('utf8').on('data', value => {decodeError += value;});
const completed = new Promise((resolve, reject) => {
  decoded.on('error', reject);
  decoded.on('close', code => code === 0 ? resolve() : reject(Error(decodeError || 'Native receipt decoding failed')));
});
let skippedNonCap = 0;
try {
  for await (const line of createInterface({input:decoded.stdout, crlfDelay:Infinity})) {
    if (!line.trim()) continue;
    const document = JSON.parse(line), source = sources.get(document.html_sha256);
    if (!source) { skippedNonCap++; continue; }
    sources.delete(document.html_sha256);
    if (document.error || !Array.isArray(document.native_structures) || !Array.isArray(document.page_alias_queries)) throw Error('CAP native source-run or alias query receipt missing');
    totals.sources++; totals.sources_with_pages += Number(source.pages.length > 0);
    const orderedCitations = source.citations.map(value => value.cite);
    const orderMatches = JSON.stringify(document.page_citations) === JSON.stringify(orderedCitations);
    if (!orderMatches) {
      totals.citation_order_mismatches++;
      gaps.push({html_sha256:document.html_sha256, failure:'citation-order', expected:orderedCitations, actual:document.page_citations});
    }
    const nativePages = document.native_structures.filter(node => node.kind === 'page');
    const queries = document.page_alias_queries;
    totals.source_page_markers += source.pages.length; totals.native_page_markers += nativePages.length;
    totals.local_query_rows += queries.length; totals.local_query_rows_resolved += queries.filter(query => query.resolves).length;
    const groups = new Map();
    for (const page of source.pages) for (const alias of page.aliases) {
      const group = groups.get(alias) ?? [];
      group.push(page.source_index); groups.set(alias, group);
    }
    const ambiguous = [...groups.entries()].filter(([, indexes]) => indexes.length > 1);
    totals.ambiguous_aliases += ambiguous.length;
    totals.ambiguous_page_markers += ambiguous.reduce((count, [, indexes]) => count + indexes.length, 0);
    const pages = source.pages.map(page => {
      const element = document.markup_elements?.[page.source_index];
      const native = element ? nativePages.find(node => node.markup_start === element.markup_start) : undefined;
      const failures = [];
      if (!element || element.tag !== page.tag || !Object.entries(page.attributes).every(([name, value]) => element.attributes?.[name] === value)) failures.push('source-element-position');
      const expectedLabel = /^\d{1,5}$/u.test(page.label) ? 'page' + Number(page.label) : 'page' + page.label.replace(/\s/gu, '');
      if (!native) { totals.missing_page_markers++; failures.push('missing-native-page'); }
      else if (native.label !== expectedLabel) { totals.wrong_page_labels++; failures.push('wrong-native-label'); }
      const aliases = page.aliases.map(alias => {
        const exactAlias = native?.aliases?.includes(alias) === true;
        totals.expected_aliases++;
        if (exactAlias) totals.exact_aliases++; else { totals.missing_aliases++; failures.push('missing-or-wrong-alias:' + alias); }
        totals.wrong_alias_mappings += Number(!exactAlias && (native?.aliases?.length ?? 0) > 0);
        const query = queries.find(value => value.alias === alias && value.label === expectedLabel && value.source_markup_start === element?.markup_start);
        if (!query) { totals.missing_query_rows++; failures.push('missing-query-receipt:' + alias); }
        const isAmbiguous = groups.get(alias).length > 1;
        if (!isAmbiguous) {
          totals.unambiguous_queries++; totals.unambiguous_queries_resolved += Number(query?.resolves === true);
          if (query?.resolves !== true) failures.push('unambiguous-query-unresolved:' + alias);
        }
        return {alias, exact_alias:exactAlias, ambiguous:isAmbiguous, local_query_resolves:query?.resolves ?? null};
      });
      if (failures.length) gaps.push({html_sha256:document.html_sha256, ...page, native_label:native?.label, native_aliases:native?.aliases, failures});
      return {...page, native_label:native?.label, source_markup_start:element?.markup_start, native_markup_start:native?.markup_start, aliases};
    });
    for (const native of nativePages) for (const alias of native.aliases ?? []) {
      if (!groups.has(alias)) { totals.unexpected_aliases++; gaps.push({html_sha256:document.html_sha256, failure:'unexpected-alias', alias, native_label:native.label}); }
    }
    records.push({html_sha256:document.html_sha256, source_url:source.capture.url, opinion_url:source.capture.opinion_url, ordered_citations:orderedCitations, citation_order_matches:orderMatches, ambiguous_aliases:ambiguous.map(([alias, source_indexes]) => ({alias, source_indexes})), pages});
  }
  await completed;
  if (sources.size) throw Error('Native corpus omitted original CAP sources');
} finally {
  if (decoded.exitCode === null) decoded.kill();
}

const nativeSummary = JSON.parse(fs.readFileSync(path.join(nativeDirectory, 'summary.json'), 'utf8').replace(/^\uFEFF/u, ''));
const summary = {schema:'courtlistener.cap-page-alias-comparison.v2', ...totals, gaps:gaps.length, skipped_non_cap_native_sources:skippedNonCap, engine_source_sha256:nativeSummary.engine_source_sha256, query_source_sha256:nativeSummary.query_source_sha256, source_manifest_sha256:await fileDigest(manifestFile), independent_xml_gold_sha256:await fileDigest(goldFile), native_receipt_sha256:await fileDigest(nativeFile), comparator_sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))), citation_order_basis:'Current and historical Beaver CAP consumer: official, nominative, parallel, vendor, then other; stable original index; source XML citation-index is one-based.', scope:'Expected aliases use original retained CAP JSON citation metadata and independent XML source page labels. Native aliases are matched to the corresponding source element. Query booleans are local engine receipt evidence, distinct from alias ambiguity; no deployed CourtListener-anchor or browser-navigation claim.', limitations:['Only observed source citation-index values, citation types and original ordering cases are covered.', 'Repeated source aliases are ambiguous even when a local query returns a matching page label.', 'Query receipts match the alias to its source marker and verify the exact selected label and UTF-16 range; repeated aliases remain independently classified as ambiguous.'], seconds:(performance.now() - started) / 1000};
fs.writeFileSync(path.join(nativeDirectory, 'page-alias-summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(nativeDirectory, 'page-alias-records.jsonl'), records.map(record => JSON.stringify(record) + '\n').join(''));
fs.writeFileSync(path.join(nativeDirectory, 'page-alias-gaps.jsonl'), gaps.map(gap => JSON.stringify(gap) + '\n').join(''));
console.log(JSON.stringify(summary));
