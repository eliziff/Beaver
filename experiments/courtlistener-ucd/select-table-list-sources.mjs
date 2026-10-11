import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';

const [root, out] = process.argv.slice(2);
if (!root || !out) throw Error('Usage: node select-table-list-sources.mjs RENDITIONS OUTPUT');
fs.mkdirSync(out, {recursive:true});
const selectionFile = path.join(out, 'selection.json');
const started = performance.now();
if (fs.existsSync(selectionFile)) {
  const summary = JSON.parse(fs.readFileSync(selectionFile,'utf8')).summary;
  console.log(JSON.stringify({cached:true, cache_read_ms:performance.now()-started, ...summary}));
  process.exit(0);
}
const dbFile = path.join(root,'sample/original.sqlite');
const db = new DatabaseSync(dbFile, {readOnly:true});
const fields = ['html','html_lawbox','html_columbia','html_anon_2020','html_with_citations'];
const candidates = [];
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i').exec(tag)?.slice(1).find(value => value !== undefined);
for (const row of db.prepare(`SELECT id,cluster_id,${fields.join(',')},range_index FROM opinion JOIN sample_origin USING(id)`).iterate()) {
  for (const field of fields) {
    const markup = row[field];
    if (!markup || !/<(?:table|ul|ol)\b/i.test(markup)) continue;
    const counts = {}, spans = {row:[],column:[]}, tokens = new Set([`field:${field}`]);
    let tableDepth = 0, listDepth = 0, nestedTables = 0, nestedLists = 0;
    for (const [tag] of markup.matchAll(/<\/?(?:table|thead|tbody|tfoot|caption|tr|td|th|ul|ol|li)\b[^>]*>/gi)) {
      const name = /^<\/?(\w+)/.exec(tag)[1].toLowerCase(), close = tag.startsWith('</');
      if (name === 'table') {
        if (close) tableDepth = Math.max(0,tableDepth - 1);
        else { nestedTables += Number(tableDepth > 0); tableDepth++; }
      }
      if (name === 'ul' || name === 'ol') {
        if (close) listDepth = Math.max(0,listDepth - 1);
        else { nestedLists += Number(listDepth > 0); listDepth++; }
      }
      if (close) continue;
      counts[name] = (counts[name] ?? 0) + 1;
      if (name === 'td' || name === 'th') {
        for (const [kind, name] of [['row','rowspan'],['column','colspan']]) {
          const value = attr(tag,name);
          if (value !== undefined) spans[kind].push(value);
        }
        for (const name of ['scope','headers']) if (attr(tag,name) !== undefined) tokens.add(name);
      }
      if (name === 'ol') for (const name of ['start','type','reversed']) if (new RegExp(`\\b${name}(?:\\s|=|>)`,'i').test(tag)) tokens.add(`ol:${name}`);
      if (name === 'li' && attr(tag,'value') !== undefined) tokens.add('li:value');
    }
    for (const name of ['table','th','thead','tfoot','caption','ul','ol']) if (counts[name]) tokens.add(name);
    if (nestedTables) tokens.add('nested-table');
    if (nestedLists) tokens.add('nested-list');
    if (spans.row.some(value => Number(value) > 1)) tokens.add('rowspan>1');
    if (spans.column.some(value => Number(value) > 1)) tokens.add('colspan>1');
    if (spans.row.includes('0')) tokens.add('rowspan=0');
    if (counts.table && counts.li) tokens.add('table-and-list');
    candidates.push({opinion_id:row.id,cluster_id:row.cluster_id,field,range_index:row.range_index,
      bytes:Buffer.byteLength(markup),counts,spans,nested_tables:nestedTables,nested_lists:nestedLists,
      tokens:[...tokens],sha256:createHash('sha256').update(markup).digest('hex')});
  }
}
db.close();
const wanted = new Set(candidates.map(row => row.opinion_id));
const metadata = new Map(), catalogFile = path.join(root,'selection-catalog.jsonl');
const catalogHash = createHash('sha256');
const stream = fs.createReadStream(catalogFile);
stream.on('data',chunk => catalogHash.update(chunk));
for await (const line of createInterface({input:stream,crlfDelay:Infinity})) {
  const row = JSON.parse(line);
  if (wanted.has(row.opinion_id)) metadata.set(row.opinion_id,row);
}
const selected = [], covered = new Set(), opinionIds = new Set();
while (selected.length < 12) {
  let best = null, bestScore = -Infinity;
  for (const row of candidates) {
    const meta = metadata.get(row.opinion_id);
    if (opinionIds.has(row.opinion_id) || !meta?.url || meta.url_source !== 'official cluster id and slug') continue;
    const tokens = [...row.tokens,`court:${meta.court_id}`,`era:${meta.era}`];
    const score = tokens.reduce((sum,token) => sum + (covered.has(token) ? 0 : /^(?:rowspan|nested-|th$|thead$|tfoot$|caption$|colspan|scope$|headers$|ol:|li:)/.test(token) ? 20 : 3),0)
      - Math.log2(Math.max(row.bytes,1))/100;
    if (score > bestScore || (score === bestScore && row.sha256 < best.sha256)) { best = row; bestScore = score; }
  }
  if (!best) break;
  const meta = metadata.get(best.opinion_id);
  selected.push({...best,url:meta.url,court_id:meta.court_id,era:meta.era,jurisdiction:meta.jurisdiction,
    canonical_metadata:meta});
  opinionIds.add(best.opinion_id);
  for (const token of [...best.tokens,`court:${meta.court_id}`,`era:${meta.era}`]) covered.add(token);
}
const sourceFile = path.join(root,'sample/source.json');
const source = JSON.parse(fs.readFileSync(sourceFile,'utf8'));
const summary = {selected:selected.length,candidates:candidates.length,seconds:(performance.now()-started)/1000,
  total_selected_bytes:selected.reduce((sum,row) => sum + row.bytes,0),fields:[...new Set(selected.map(row=>row.field))],
  courts:[...new Set(selected.map(row=>row.court_id))],eras:[...new Set(selected.map(row=>row.era))],
  observed_features:[...covered].filter(token=>!token.startsWith('court:')&&!token.startsWith('era:'))};
const receipt = {schema:'courtlistener.table-list-selection.v1',summary,
  original_database:path.relative(process.cwd(),dbFile).replaceAll('\\','/'),source_snapshot:source.source,
  source_receipt_sha256:createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'),
  canonical_catalog_sha256:catalogHash.digest('hex'),
  selection:'One cached pass over real raw fields; uncovered structural features, then court/era/field breadth; one opinion per selected source; regex counts are selection hints, not independent gold',
  sources:selected.map(row=>({...row,compressed_range:source.ranges[row.range_index]}))};
fs.writeFileSync(selectionFile,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(summary));
