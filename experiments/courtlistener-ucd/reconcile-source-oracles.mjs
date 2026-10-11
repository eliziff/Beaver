import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const [directory, browserGold] = process.argv.slice(2);
if (!directory || !browserGold) throw Error('Supply the native directory and independent browser gold');
const read = name => JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
const jsonl = name => fs.readFileSync(path.join(directory,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const key = row => row.html_sha256 + ':' + row.body_index;
const normalize = value => (value ?? '').replace(/\s+/gu,' ').trim();
const primary = read('source-structure-summary.json');
const literal = read('literal-source-structure-summary.json');
if (primary.native_receipt_sha256 !== literal.native_receipt_sha256 || literal.markup.gaps) throw Error('Literal source oracle does not cover this candidate faithfully');
if (primary.captured_live_body_text?.mismatches !== 0 || primary.captured_live_body_text.bodies !== primary.bodies) throw Error('Original live body text is not completely matched');
const literalBodies = new Set(jsonl('literal-source-gold.jsonl').map(key));
const parentChanges = jsonl('source-markup-gaps.jsonl');
const unexplainedMarkup = parentChanges.filter(row => row.failures.length !== 1 || row.failures[0] !== 'parent' || !literalBodies.has(key(row)));
const differences = Map.groupBy(jsonl('source-markup-text-differences.jsonl'),key);
const changes = Map.groupBy(parentChanges,key);
const positions = new Map();
let offset = 0;
for await (const line of createInterface({input:fs.createReadStream(browserGold),crlfDelay:Infinity})) {
  const bytes = Buffer.byteLength(line);
  if (line.trim()) positions.set(key(JSON.parse(line)),{offset,length:bytes});
  offset += bytes + 1;
}
const executable = fileURLToPath(new URL('../../native/legal-structure-node/target/release/courtlistener-corpus' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url));
const decoded = spawn(executable,['decode',path.join(directory,'records.jsonl.zst')],{stdio:['ignore','pipe','pipe']});
let stderr = '';
decoded.stderr.setEncoding('utf8').on('data',value => {stderr += value;});
const completed = new Promise((resolve,reject) => {
  decoded.on('error',reject);
  decoded.on('close',code => code === 0 ? resolve() : reject(Error(stderr)));
});
const counts = {}, unexplainedText = [];
const gold = fs.openSync(browserGold,'r');
try {
  for await (const line of createInterface({input:decoded.stdout,crlfDelay:Infinity})) {
    const document = JSON.parse(line), flagged = differences.get(key(document));
    if (!flagged) continue;
    const position = positions.get(key(document)), bytes = Buffer.alloc(position.length);
    if (fs.readSync(gold,bytes,0,bytes.length,position.offset) !== bytes.length) throw Error('Browser oracle truncated');
    const source = JSON.parse(bytes.toString('utf8'));
    const parents = changes.get(key(document)) ?? [];
    for (const difference of flagged) {
      const index = difference.source_index, element = source.elements[index], native = document.markup_elements[index];
      const actual = normalize(document.text.slice(native.range.start,native.range.end));
      const expected = normalize(element.inner_text ?? element.text_content);
      let explanation;
      if (element.visible === false && (element.attributes.class ?? '').split(/\s+/u).includes('jumpback') && native.range.start === native.range.end
          && document.markup_ancestors.some(ancestor => ancestor.attributes.id === 'resource-org-text')) {
        explanation = 'publisher-css-hidden-jumpback';
      } else if (element.tag === 'a' && literalBodies.has(key(document)) && parents.some(change => {
        let parent = document.markup_elements[change.source_index].parent;
        while (parent !== null) {
          if (parent === index) return true;
          parent = document.markup_elements[parent].parent;
        }
        return false;
      })) {
        explanation = 'html5-nested-anchor-repair';
      } else if (element.tag === 'div' && actual === normalize(document.text) && expected === normalize(source.elements[0].inner_text)) {
        let first = 0;
        while (actual[first] === expected[first] && first < Math.min(actual.length,expected.length)) first++;
        if (actual[first] === ' ' && actual.slice(first+1) === expected.slice(first)) explanation = 'html5-leading-pre-newline';
      }
      if (explanation) counts[explanation] = (counts[explanation] ?? 0) + 1;
      else unexplainedText.push(difference);
    }
  }
  await completed;
} finally {
  fs.closeSync(gold);
  if (decoded.exitCode === null) decoded.kill();
}
const summary = {schema:'courtlistener.source-oracle-reconciliation.v1',bodies:primary.bodies,
  elements:primary.markup.elements,original_live_body_text_exact:primary.captured_live_body_text.exact_normalized_body_text,
  cached_parent_changes:parentChanges.length,source_nesting_confirmed:parentChanges.length-unexplainedMarkup.length,
  unexplained_markup_gaps:unexplainedMarkup.length,generic_text_difference_explanations:counts,
  unexplained_generic_text_differences:unexplainedText.length,
  engine_source_sha256:primary.engine_source_sha256,native_receipt_sha256:primary.native_receipt_sha256,
  browser_gold_sha256:primary.gold_sha256,literal_gold_sha256:literal.gold_sha256,
  harness_sha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  scope:'Observed source fidelity and original live text. Browser reparsing changes and CSS-hidden source content are recorded separately; no live navigation or unseen-corpus guarantee.'};
fs.writeFileSync(path.join(directory,'source-preservation-summary.json'),JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync(path.join(directory,'unexplained-source-differences.jsonl'),[...unexplainedMarkup,...unexplainedText].map(row=>JSON.stringify(row)+'\n').join(''));
console.log(JSON.stringify(summary));
