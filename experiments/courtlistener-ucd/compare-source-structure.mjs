import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

const partialGold = process.argv.includes('--partial-gold');
const [nativeDirectory, goldFile, captureManifest] = process.argv.slice(2).filter(value => value !== '--partial-gold');
if (!nativeDirectory || !goldFile) throw Error('Supply a native web-run directory and independent browser-structure-gold.jsonl');
const binary = process.platform === 'win32' ? 'courtlistener-corpus.exe' : 'courtlistener-corpus';
const executable = fileURLToPath(new URL('../../native/legal-structure-node/target/release/' + binary, import.meta.url));
const nativeFile = path.join(nativeDirectory, 'records.jsonl.zst');
const reportPrefix = path.basename(goldFile) === 'browser-structure-gold.jsonl' ? 'source' : path.basename(goldFile).replace(/-gold\.jsonl$/u,'');
const reportFile = name => path.join(nativeDirectory,reportPrefix + '-' + name);
const goldSummaryFile = path.join(path.dirname(goldFile),path.basename(goldFile).replace(/\.jsonl$/u,'-summary.json'));
const goldSummary = JSON.parse(fs.readFileSync(goldSummaryFile,'utf8').replace(/^\uFEFF/u,''));
const capturedSource = goldSummary.schema === 'courtlistener.captured-source-gold.v1';
const allElements = goldSummary.all_elements === true;
const compareVisibleText = goldSummary.visible_text !== false;
if (capturedSource && (!allElements || compareVisibleText
    || ['element_preorder','element_direct_parents','element_attributes','element_text_content','body_inner_text'].some(name => goldSummary.capabilities?.[name] !== true)
    || ['element_inner_text','element_visibility','browser_table_spans','outside_ancestors','native_namespace_comparison'].some(name => goldSummary.capabilities?.[name] !== false)))
  throw Error('Captured source gold capability contract changed');
const frozenCaptureManifest = capturedSource ? path.join(path.dirname(goldFile),goldSummary.capture_manifest) : null;
const captureFile = captureManifest ?? frozenCaptureManifest;
const captures = captureFile ? new Map(JSON.parse(fs.readFileSync(captureFile,'utf8')).map(capture => [capture.sha256,capture])) : null;
const capturedBodyText = {bodies:0,exact_normalized_body_text:0,gaps:[]};
const key = row => row.html_sha256 + ':' + row.body_index;
const normalize = value => (value ?? '').replace(/\s+/gu,' ').trim();
const digest = value => createHash('sha256').update(value).digest('hex');
const fileDigest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
if (capturedSource && (await fileDigest(goldFile) !== goldSummary.gold_sha256
    || await fileDigest(frozenCaptureManifest) !== goldSummary.capture_manifest_sha256
    || await fileDigest(captureFile) !== goldSummary.capture_manifest_sha256)) throw Error('Frozen captured source gold or capture manifest changed');
const goldIndex = new Map();
let byteOffset = 0;
for await (const line of createInterface({input:fs.createReadStream(goldFile),crlfDelay:Infinity})) {
  const length = Buffer.byteLength(line);
  if (line.trim()) {
    const source = JSON.parse(line);
    if (goldIndex.has(key(source))) throw Error('Duplicate independent source body');
    goldIndex.set(key(source),{offset:byteOffset,length});
  }
  byteOffset += length + 1;
}
const tags = new Set(['p','blockquote','h1','h2','h3','h4','h5','h6','h','heading','opinion','casebody','author','judges','attorneys','headnotes','table','tr','td','th','ul','ol','li','footnote','footnote_body']);
const structural = node => tags.has(node.markup_tag)
  || (node.markup_tag === 'div' && (node.markup_attributes.class ?? '').split(/\s+/u).some(value => ['co_opinionBlock','co_section','co_headtext','co_paragraph','co_footnoteBody'].includes(value)))
  || (['aside','div','section'].includes(node.markup_tag) && (node.markup_attributes.class ?? '').split(/\s+/u).includes('footnote'))
  || (['article','section','div'].includes(node.markup_tag) && (node.markup_attributes.class ?? '').split(/\s+/u).some(value => ['opinion','casebody','head-matter'].includes(value)))
  || (node.markup_tag === 'div' && node.markup_attributes.id === 'headmatter');
const declaredCoKind = element => {
  if (element.tag !== 'div') return null;
  const roles = {co_opinionBlock:'section',co_section:'section',co_headtext:'heading',co_paragraph:'prose',co_footnoteBody:'footnote'};
  return (element.attributes.class ?? '').split(/\s+/u).map(value => roles[value]).find(Boolean) ?? null;
};
const totals = {}, gaps = [];
const markupTotals = {}, markupGaps = [], markupTextDifferences = [], links = {}, attributes = {};
const ancestorTotals = {bodies:0,ancestors:0,exact_bodies:0};
const unsupported = {element_inner_text:0,element_visibility:0,browser_table_spans:0,outside_ancestors:0,native_namespace_comparison:0};
const coRelationships = {note_bodies:0,paired_sibling_labels:0,exact_note_labels:0,source_marker_ids:0,resolved_marker_ids:0,page_markers:0,exact_pages:0,resolved_pages:0};
const exactAttributes = (actual, expected) => Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([name,value]) => actual[name] === value);
let queryCells = 0, matchingQueryCells = 0, bodies = 0, allMarkupElements = 0, withoutGold = 0;
const decoded = spawn(executable,['decode',nativeFile],{stdio:['ignore','pipe','pipe']});
let decodeError = '';
decoded.stderr.setEncoding('utf8').on('data',value => {decodeError += value;});
const completed = new Promise((resolve,reject) => {
  decoded.on('error',reject);
  decoded.on('close',code => code === 0 ? resolve() : reject(Error(decodeError)));
});
const goldHandle = fs.openSync(goldFile,'r');
try {
for await (const line of createInterface({input:decoded.stdout,crlfDelay:Infinity})) {
  if (!line.trim()) continue;
  const document = JSON.parse(line), position = goldIndex.get(key(document));
  if (!position && partialGold) { withoutGold++; continue; }
  if (!position || !document.native_structures) throw Error('Frozen source body or native structure receipt missing');
  const bytes = Buffer.alloc(position.length);
  if (fs.readSync(goldHandle,bytes,0,bytes.length,position.offset) !== bytes.length) throw Error('Independent gold truncated');
  const source = JSON.parse(bytes.toString('utf8'));
  goldIndex.delete(key(document)); bodies++;
  if (capturedSource) {
    if (source.schema !== 'courtlistener.captured-source-body.v1' || source.ancestors !== undefined
        || source.elements.some(element => ['inner_text','visible','row_span','column_span'].some(name => Object.hasOwn(element,name)))
        || !Array.isArray(document.markup_anchor_lookups))
      throw Error('Captured gold observation contract or native source-ID lookup receipt missing');
    unsupported.element_inner_text += source.elements.length;
    unsupported.element_visibility += source.elements.length;
    unsupported.native_namespace_comparison += source.elements.length;
    unsupported.browser_table_spans += source.elements.filter(element => element.tag === 'td' || element.tag === 'th').length;
    unsupported.outside_ancestors++;
  }
  if (source.ancestors?.length) {
    const actual = document.markup_ancestors ?? [];
    ancestorTotals.bodies++; ancestorTotals.ancestors += source.ancestors.length;
    const exact = actual.length === source.ancestors.length && source.ancestors.every((ancestor,index) => actual[index]?.tag === ancestor.tag && exactAttributes(actual[index].attributes,ancestor.attributes));
    ancestorTotals.exact_bodies += Number(exact);
    if (!exact) markupGaps.push({html_sha256:source.html_sha256,body_index:source.body_index,failures:['ancestor-context'],expected:source.ancestors,actual});
  }
  if (captures) {
    const capture = captures.get(source.html_sha256);
    if (!capture) throw Error('Original live capture missing');
    const evidenceBytes = fs.readFileSync(path.join(path.dirname(captureFile),capture.browser_evidence_path));
    if (digest(evidenceBytes) !== capture.browser_evidence_sha256) throw Error('Original live capture digest changed');
    const evidence = JSON.parse(evidenceBytes), body = evidence.bodies[source.body_index];
    if (capturedSource && (source.browser_evidence_path !== capture.browser_evidence_path
        || source.browser_evidence_sha256 !== capture.browser_evidence_sha256
        || digest(JSON.stringify(body)) !== source.body_evidence_sha256
        || digest(JSON.stringify(body.source_nodes)) !== source.source_nodes_sha256)) throw Error('Original captured body provenance changed');
    const expected = normalize(body.innerText), actual = normalize(document.text);
    capturedBodyText.bodies++; capturedBodyText.exact_normalized_body_text += Number(expected === actual);
    if (expected !== actual) {
      let first = 0;
      while (first < Math.min(actual.length,expected.length) && actual[first] === expected[first]) first++;
      capturedBodyText.gaps.push({html_sha256:source.html_sha256,body_index:source.body_index,first_difference:first,native_length:actual.length,source_length:expected.length,native_context:actual.slice(Math.max(0,first-50),first+90),source_context:expected.slice(Math.max(0,first-50),first+90)});
    }
  }
  const sourceElements = new Map(source.elements.map(element => [element.source_index,element]));
  const selected = source.elements.filter(element => structural({markup_tag:element.tag,markup_attributes:element.attributes}));
  const nodes = document.native_structures.filter(node => node.markup_start != null && structural(node)).sort((a,b) => a.markup_start-b.markup_start);
  const byTag = Map.groupBy(nodes, node => node.markup_tag), offsets = new Map(), matches = new Map();
  const byId = new Map(document.native_structures.map(node => [node.id,node]));
  for (const element of selected) {
    const ordinal = offsets.get(element.tag) ?? 0;
    offsets.set(element.tag,ordinal+1);
    matches.set(element.source_index,byTag.get(element.tag)?.[ordinal]);
  }
  for (const element of selected) {
    const node = matches.get(element.source_index), failures = [];
    const total = totals[element.tag] ??= {observed:0,retained:0,exact_attributes:0,exact_text_content:0,exact_visible_text:capturedSource ? null : 0,matching_parents:0,matching_anchors:0,without_anchor:0};
    total.observed++; total.without_anchor += Number(element.anchor === null);
    if (!node) failures.push('missing-node');
    else {
      total.retained++;
      const attributes = node.markup_attributes ?? {};
      const exactAttributes = Object.keys(attributes).length === Object.keys(element.attributes).length && Object.entries(element.attributes).every(([name,value]) => attributes[name] === value);
      const text = document.text.slice(node.range.start,node.range.end);
      const exactContent = normalize(text) === normalize(element.text_content);
      const exactVisible = normalize(text) === normalize(element.inner_text ?? element.text_content);
      let parent = byId.get(node.parent_id), seen = new Set();
      while (parent && !structural(parent) && !seen.has(parent.id)) { seen.add(parent.id); parent = byId.get(parent.parent_id); }
      let parentIndex = element.parent_index;
      while (parentIndex !== null && !matches.has(parentIndex)) parentIndex = sourceElements.get(parentIndex).parent_index;
      const expectedParent = matches.get(parentIndex);
      const exactParent = parentIndex === null ? !parent : !!expectedParent && parent?.id === expectedParent.id;
      const exactAnchor = (node.anchor ?? null) === element.anchor;
      const declaredKind = declaredCoKind(element);
      total.exact_attributes += Number(exactAttributes);
      total.exact_text_content += Number(exactContent);
      if (!capturedSource) total.exact_visible_text += Number(exactVisible);
      total.matching_parents += Number(exactParent);
      total.matching_anchors += Number(exactAnchor);
      if (!exactAttributes) failures.push('attributes');
      if (compareVisibleText && !exactVisible) failures.push('visible-text');
      if (!exactParent) failures.push('parent');
      if (!exactAnchor) failures.push('anchor');
      if (declaredKind && node.kind !== declaredKind) failures.push('declared-role');
      if (!capturedSource && (element.tag === 'td' || element.tag === 'th')) {
        queryCells++;
        const address = /^table:(\d+)\/row:(\d+)\/col:(\d+)$/u.exec(node.id);
        const cells = address ? document.table_cells.filter(cell => cell.table === Number(address[1]) && cell.row === Number(address[2]) && cell.column === Number(address[3])) : [];
        const cell = cells.length === 1 ? cells[0] : null;
        const exactQuery = cell && cell.start === node.range.start && cell.end === node.range.end && (cell.rowSpan ?? 1) === element.row_span && (cell.columnSpan ?? 1) === element.column_span && (!compareVisibleText || normalize(cell.displayValue) === normalize(element.inner_text ?? element.text_content));
        matchingQueryCells += Number(!!exactQuery);
        if (!exactQuery) failures.push('table-query');
      }
    }
    if (failures.length) gaps.push({html_sha256:source.html_sha256,body_index:source.body_index,tag:element.tag,source_index:element.source_index,native_node_id:node?.id,failures});
  }
  const hasClass = (element, name) => (element.attributes.class ?? '').split(/\s+/u).includes(name);
  for (const body of source.elements.filter(element => element.tag === 'div' && hasClass(element,'co_footnoteBody'))) {
    coRelationships.note_bodies++;
    const numbers = source.elements.filter(element => element.tag === 'div' && hasClass(element,'co_footnoteNumber') && element.parent_index === body.parent_index);
    const siblings = source.elements.filter(element => element.tag === 'div' && hasClass(element,'co_footnoteBody') && element.parent_index === body.parent_index);
    if (numbers.length !== 1 || siblings.length !== 1 || !/^\d{1,5}$/u.test(numbers[0].text_content.trim())) {
      gaps.push({html_sha256:source.html_sha256,body_index:source.body_index,source_index:body.source_index,failures:['unresolved-source-note-pairing']});
      continue;
    }
    const number = numbers[0], expected = 'fn' + Number(number.text_content.trim());
    coRelationships.paired_sibling_labels++;
    const element = document.markup_elements?.[body.source_index];
    const node = document.native_structures.find(node => node.kind === 'footnote' && node.markup_start === element?.markup_start);
    const note = document.notes?.find(note => note.node_id === node?.id);
    const marker = document.markup_elements?.[number.source_index], failures = [];
    const raw = marker ? document.text.slice(marker.range.start,marker.range.end) : '';
    const start = marker ? marker.range.start + raw.length - raw.trimStart().length : null;
    const end = start === null ? null : start + raw.trim().length;
    const exact = node?.label === expected && note && node.marker_range?.start === start && node.marker_range?.end === end
      && note.label_range.start === start && note.label_range.end === end
      && normalize(document.text.slice(start,end)) === normalize(number.text_content)
      && note.body_range.start === node.range.start && note.body_range.end === node.range.end
      && (node.anchor ?? null) === body.anchor;
    coRelationships.exact_note_labels += Number(!!exact);
    if (!exact) failures.push('sibling-note-label-or-body-range');
    for (const label of source.elements.filter(element => element.anchor !== null && normalize(element.text_content) === normalize(number.text_content))) {
      let parent = label.source_index;
      while (parent !== null && parent !== number.source_index) parent = sourceElements.get(parent)?.parent_index ?? null;
      if (parent === null) continue;
      coRelationships.source_marker_ids++;
      const lookup = document.note_label_queries?.find(query => query.anchor === label.anchor && query.node_id === node?.id);
      const actual = document.markup_elements?.[label.source_index];
      const resolves = lookup?.markup_start === actual?.markup_start && lookup?.label_range.start === start && lookup?.label_range.end === end;
      coRelationships.resolved_marker_ids += Number(!!resolves);
      if (!resolves) failures.push('source-note-label-query:' + label.anchor);
    }
    if (failures.length) gaps.push({html_sha256:source.html_sha256,body_index:source.body_index,source_index:body.source_index,native_node_id:node?.id,failures});
  }
  for (const page of source.elements.filter(element => element.tag === 'span' && hasClass(element,'co_starPage'))) {
    coRelationships.page_markers++;
    const printed = source.elements.filter(element => element.tag === 'em' && element.parent_index === page.source_index);
    const match = printed.length === 1 ? /^\*(\d{1,5})$/u.exec(printed[0].text_content.trim()) : null;
    const element = document.markup_elements?.[page.source_index];
    const node = document.native_structures.find(node => node.kind === 'page' && node.markup_start === element?.markup_start);
    const exact = match && node?.label === 'page' + Number(match[1]) && (node.anchor ?? null) === page.anchor;
    const resolves = document.native_pinpoint_queries?.find(query => query.node_id === node?.id)?.resolves === true;
    coRelationships.exact_pages += Number(!!exact); coRelationships.resolved_pages += Number(resolves);
    if (!exact || !resolves) gaps.push({html_sha256:source.html_sha256,body_index:source.body_index,source_index:page.source_index,native_node_id:node?.id,failures:[...(!exact ? ['source-printed-page-label'] : []),...(!resolves ? ['native-page-query'] : [])]});
  }
  if (allElements) {
    const elements = document.markup_elements ?? [];
    const ids = new Map(), lookups = new Map((document.markup_anchor_lookups ?? []).map(lookup => [lookup.anchor,lookup.markup_start]));
    for (const element of source.elements) if (element.anchor !== null) ids.set(element.anchor,(ids.get(element.anchor) ?? 0) + 1);
    if (document.markup_byte_ranges_valid === false) markupGaps.push({html_sha256:source.html_sha256,body_index:source.body_index,failures:['markup-byte-ranges']});
    allMarkupElements += source.elements.length;
    for (const [index,element] of source.elements.entries()) {
      const nativeElement = elements[index], failures = [];
      const total = markupTotals[element.tag] ??= {observed:0,retained:0,exact_attributes:0,matching_parents:0,exact_visible_text:capturedSource ? null : 0,valid_ranges:0,ids:0};
      if (capturedSource) total.source_text_content_matches_rendered ??= 0;
      total.observed++; total.ids += Number(element.anchor !== null);
      if (!nativeElement || nativeElement.tag !== element.tag) failures.push('missing-or-out-of-order-element');
      else {
        total.retained++;
        const exactAttributes = Object.keys(nativeElement.attributes).length === Object.keys(element.attributes).length && Object.entries(element.attributes).every(([name,value]) => nativeElement.attributes[name] === value);
        const exactParent = nativeElement.parent === element.parent_index;
        const validRange = nativeElement.range.start >= 0 && nativeElement.range.start <= nativeElement.range.end && nativeElement.range.end <= document.text.length;
        const exactText = validRange && normalize(document.text.slice(nativeElement.range.start,nativeElement.range.end)) === normalize(element.inner_text ?? element.text_content);
        total.exact_attributes += Number(exactAttributes); total.matching_parents += Number(exactParent);
        if (capturedSource) total.source_text_content_matches_rendered += Number(exactText);
        else total.exact_visible_text += Number(exactText);
        total.valid_ranges += Number(validRange);
        if (!exactText) markupTextDifferences.push({html_sha256:source.html_sha256,body_index:source.body_index,tag:element.tag,source_index:element.source_index,markup_start:nativeElement.markup_start,range:nativeElement.range,...(capturedSource ? {comparison:'source-textContent-vs-native-rendered-text'} : {})});
        if (!exactAttributes) failures.push('attributes');
        if (!exactParent) failures.push('parent');
        if (!validRange) failures.push('invalid-rendered-range');
        if (document.markup_anchor_lookups && element.anchor !== null) {
          const wanted = element.anchor !== '' && ids.get(element.anchor) === 1 ? nativeElement.markup_start : null;
          if (lookups.get(element.anchor) !== wanted) failures.push('source-id-query');
        }
        for (const name of Object.keys(element.attributes)) attributes[name] = (attributes[name] ?? 0) + 1;
        if (element.attributes.href !== undefined) {
          const category = element.attributes.href.startsWith('#') ? 'internal' : /^(?:https?:\/\/[^/]+)?\/opinion\//u.test(element.attributes.href) ? 'opinion' : 'other';
          const count = links[category] ??= {observed:0,exact_targets:0};
          count.observed++; count.exact_targets += Number(nativeElement.attributes.href === element.attributes.href);
        }
      }
      if (failures.length) markupGaps.push({html_sha256:source.html_sha256,body_index:source.body_index,tag:element.tag,source_index:element.source_index,failures});
    }
    if (elements.length > source.elements.length) markupGaps.push({html_sha256:source.html_sha256,body_index:source.body_index,failures:['extra-elements'],count:elements.length-source.elements.length});
  }
}
await completed;
if (goldIndex.size) throw Error('Native corpus omitted independent source bodies');
} finally {
  fs.closeSync(goldHandle);
  if (decoded.exitCode === null) decoded.kill();
}
const previous = JSON.parse(fs.readFileSync(path.join(nativeDirectory,'summary.json'),'utf8'));
const summary = {schema:'courtlistener.source-structure-comparison.v2',bodies,totals,gaps:gaps.length,engine_source_sha256:previous.engine_source_sha256,query_source_sha256:previous.query_source_sha256,gold_sha256:await fileDigest(goldFile),native_receipt_sha256:await fileDigest(nativeFile),comparator_sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),scope:'Independent cached browser DOM; selected legal structures include visible text, parents, attributes, anchors and table queries. All-element scope checks every source tag in order, attribute, direct parent and rendered-range validity; visible text is measured separately from source fidelity. No live-navigation claim'};
if (capturedSource) {
  summary.scope = 'Independent frozen acquisition DOM: every source element in order, attribute, direct parent, ID lookup and native rendered-range validity; original captured whole-body innerText is measured separately. Element textContent versus native rendered text is diagnostic. Unrecorded per-element innerText/visibility, browser reflected table spans and outside ancestors, plus native namespace comparison, remain unsupported. No live-navigation claim';
  summary.source_capabilities = goldSummary.capabilities;
  summary.unsupported_observations = unsupported;
  summary.gold_summary_sha256 = await fileDigest(goldSummaryFile);
  summary.projector_sha256 = goldSummary.projector_sha256;
  summary.typed_text_content_comparison = 'source-textContent-vs-native-rendered-text; diagnostic equality, not a visible-text oracle';
  summary.markup_text_comparison = 'source-textContent-vs-native-rendered-text; no per-element visible-text oracle';
}
summary.native_bodies_without_gold = withoutGold;
summary.visible_text_required = compareVisibleText;
summary.gold_scope = goldSummary.scope;
summary.markup = {elements:allMarkupElements,totals:markupTotals,gaps:markupGaps.length,ancestors:ancestorTotals,attributes,links};
if (captures) {
  summary.captured_live_body_text = {bodies:capturedBodyText.bodies,exact_normalized_body_text:capturedBodyText.exact_normalized_body_text,mismatches:capturedBodyText.gaps.length,scope:'Original live acquisition DOM text; no fresh live link navigation'};
  summary.capture_manifest_sha256 = await fileDigest(captureFile);
  fs.writeFileSync(reportFile('captured-body-text-gaps.jsonl'),capturedBodyText.gaps.map(row => JSON.stringify(row)+'\n').join(''));
}
summary.table_query_cells = capturedSource ? null : queryCells;
summary.table_query_visible_text_required = capturedSource ? null : compareVisibleText;
summary.declared_co_relationships = coRelationships;
summary.matching_table_query_cells = capturedSource ? null : matchingQueryCells;
fs.writeFileSync(reportFile('structure-summary.json'),JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync(reportFile('structure-gaps.jsonl'),gaps.map(row => JSON.stringify(row)+'\n').join(''));
fs.writeFileSync(reportFile('markup-gaps.jsonl'),markupGaps.map(row => JSON.stringify(row)+'\n').join(''));
fs.writeFileSync(reportFile('markup-text-differences.jsonl'),markupTextDifferences.map(row => JSON.stringify(row)+'\n').join(''));
console.log(JSON.stringify(summary));
