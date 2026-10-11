import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

const partialGold = process.argv.includes('--partial-gold');
const [nativeDirectory, goldFile] = process.argv.slice(2).filter(value => value !== '--partial-gold');
if (!nativeDirectory || !goldFile) throw Error('Supply a native source/web-run directory and independent browser structure gold');
const normalize = value => (value ?? '').replace(/\s+/gu, ' ').trim();
const key = row => row.html_sha256 + ':' + row.body_index;
const sourceHeading = element => /^(?:h|h[1-6]|heading)$/u.test(element.tag)
  || (element.tag === 'div' && (element.attributes.class ?? '').split(/\s+/u).includes('co_headtext'));
const fileDigest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const gold = new Map();
for await (const line of createInterface({input: fs.createReadStream(goldFile), crlfDelay: Infinity})) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (gold.has(key(row))) throw Error('Duplicate independent source body');
  gold.set(key(row), {url: row.url, headings: row.elements.filter(sourceHeading)});
}
const binary = process.platform === 'win32' ? 'courtlistener-corpus.exe' : 'courtlistener-corpus';
const executable = fileURLToPath(new URL('../../native/legal-structure-node/target/release/' + binary, import.meta.url));
const nativeFile = path.join(nativeDirectory, 'records.jsonl.zst');
const decoded = spawn(executable, ['decode', nativeFile], {stdio: ['ignore', 'pipe', 'pipe']});
let decodeError = '';
decoded.stderr.setEncoding('utf8').on('data', value => { decodeError += value; });
const completed = new Promise(resolve => {
  decoded.on('error', error => resolve({error}));
  decoded.on('close', code => resolve({code}));
});
const totals = {bodies: 0, without_gold: 0, observed_source_headings: 0, retained_native_headings: 0,
  exact_source_attributes: 0, exact_source_anchors: 0, exact_source_labels: 0,
  exact_native_heading_text: 0, emitted_native_headings: 0, exact_outline_titles: 0,
  gaps: 0, omitted_from_outline: {empty_title: 0, title_over_200_scalars: 0, repeated_source_title: 0, unresolved_outline_exclusion: 0}};
const output = fs.openSync(path.join(nativeDirectory, 'heading-titles.jsonl'), 'w');
try {
  for await (const line of createInterface({input: decoded.stdout, crlfDelay: Infinity})) {
    if (!line.trim()) continue;
    const document = JSON.parse(line), source = gold.get(key(document));
    if (!source && partialGold) { totals.without_gold++; continue; }
    if (!source || !Array.isArray(document.document_outline) || !Array.isArray(document.native_structures))
      throw Error('Independent source body, native structures or document_outline receipt missing');
    gold.delete(key(document)); totals.bodies++;
    const nodes = document.native_structures.filter(node => node.kind === 'heading' && node.source === 'native'
      && sourceHeading({tag: node.markup_tag, attributes: node.markup_attributes ?? {}}))
      .sort((a, b) => a.markup_start - b.markup_start);
    const byTag = Map.groupBy(nodes, node => node.markup_tag), ordinals = new Map();
    const outline = Map.groupBy(document.document_outline.filter(entry => entry.kind === 'heading'), entry => entry.start);
    const titleCounts = new Map();
    for (const heading of source.headings) {
      const title = normalize(heading.inner_text ?? heading.text_content).toLowerCase();
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }
    const headings = source.headings.map(element => {
      totals.observed_source_headings++;
      const ordinal = ordinals.get(element.tag) ?? 0;
      ordinals.set(element.tag, ordinal + 1);
      const node = byTag.get(element.tag)?.[ordinal];
      const title = normalize(element.inner_text ?? element.text_content), failures = [];
      const receipt = {source_index: element.source_index, tag: element.tag, source_title: title,
        source_anchor: element.anchor, native_node_id: node?.id ?? null, failures};
      if (!node) { failures.push('missing-native-heading'); totals.gaps++; return receipt; }
      totals.retained_native_headings++;
      const attributes = node.markup_attributes ?? {}, range = node.rendered_range ?? node.range;
      const exactAttributes = Object.keys(attributes).length === Object.keys(element.attributes).length
        && Object.entries(element.attributes).every(([name, value]) => attributes[name] === value);
      const exactAnchor = (node.anchor ?? null) === element.anchor;
      const exactLabel = (node.label ?? null) === element.anchor;
      const text = normalize(document.text.slice(range.start, range.end));
      totals.exact_source_attributes += Number(exactAttributes); totals.exact_source_anchors += Number(exactAnchor);
      totals.exact_source_labels += Number(exactLabel); totals.exact_native_heading_text += Number(text === title);
      if (!exactAttributes) failures.push('source-attributes');
      if (!exactAnchor) failures.push('source-anchor');
      if (!exactLabel) failures.push('source-label');
      if (text !== title) failures.push('rendered-title-text');
      receipt.query_range = range; receipt.source_label = node.label ?? null;
      const entries = outline.get(range.start) ?? [];
      const matched = entries.findIndex(entry => entry.title === title);
      const sourceId = entries.findIndex(entry => node.label && entry.title === node.label);
      const at = matched >= 0 ? matched : sourceId >= 0 ? sourceId
        : title && Array.from(title).length <= 200 ? 0 : -1;
      const entry = at < 0 ? null : entries.splice(at, 1)[0];
      if (entry) {
        receipt.outline_title = entry.title; totals.emitted_native_headings++;
        totals.exact_outline_titles += Number(entry.title === title);
        if (entry.title !== title) failures.push('outline-title');
      } else {
        const reason = !title ? 'empty_title' : Array.from(title).length > 200 ? 'title_over_200_scalars'
          : titleCounts.get(title.toLowerCase()) >= 3 ? 'repeated_source_title' : 'unresolved_outline_exclusion';
        receipt.outline_omission = reason; totals.omitted_from_outline[reason]++;
      }
      totals.gaps += Number(failures.length > 0);
      return receipt;
    });
    if (headings.length) fs.writeSync(output, JSON.stringify({html_sha256: document.html_sha256,
      body_index: document.body_index, url: source.url, headings}) + '\n');
  }
  const result = await completed;
  if (result.error) throw result.error;
  if (result.code !== 0) throw Error(decodeError || 'Native receipt decoding failed');
  if (gold.size) throw Error('Native run omitted independent source bodies');
} finally {
  fs.closeSync(output);
  decoded.kill();
}
const nativeSummary = JSON.parse(fs.readFileSync(path.join(nativeDirectory, 'summary.json'), 'utf8').replace(/^\uFEFF/u, ''));
const summary = {schema: 'courtlistener.native-heading-titles.v1', ...totals,
  native_receipts_sha256: await fileDigest(nativeFile), independent_gold_sha256: await fileDigest(goldFile),
  engine_source_sha256: nativeSummary.engine_source_sha256,
  gold_source: 'Retained independent browser element text, source attributes and anchors; no inferred title baseline',
  outline_omissions: 'Empty titles, titles over 200 Unicode scalars and at least three identical source titles provide concrete unchanged policy witnesses. Every other omitted title remains an unresolved_outline_exclusion until its actual policy/source witness is established; zero gaps does not resolve that bucket.'};
fs.writeFileSync(path.join(nativeDirectory, 'heading-titles-summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
