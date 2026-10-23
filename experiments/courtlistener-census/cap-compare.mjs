// Is CAP static a superset of CourtListener's xml_harvard? For every case in the sampled CAP volumes,
// find the CL cluster whose filepath_json_harvard names the same CAP case id, take its opinions'
// xml_harvard (and the cluster's headmatter), and compare ids, page labels, footnotes and text with
// the CAP case HTML. Also counts what CAP carries that CL's rendition has no place for.
//
//   node cap-compare.mjs CASES_TSV CAP_SAMPLE_ROOT STREAM_DIR OUT_JSON
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseRecord } from './lib.mjs';

const [tsv, capRoot, streamDir, outFile] = process.argv.slice(2);
const lines = fs.readFileSync(tsv, 'utf8').trim().split('\n'); const th = lines[0].split('\t');
const cases = lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [th[i], v])));
const want = new Map(cases.map((c) => [Number(c.cap_case_id), c]));

function* frameRows(dir, onlyFrames) {
  const frames = fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rowsFd = fs.openSync(path.join(dir, 'rows.bin'), 'r'); const fds = {}; let start = 0;
  for (const f of frames) {
    if (!onlyFrames || onlyFrames.has(f.frame)) {
      const shard = path.join(dir, 'shards', `shard-${String(f.shard).padStart(4, '0')}.zst`);
      const fd = fds[shard] ??= fs.openSync(shard, 'r');
      const b = Buffer.alloc(f.bytes); fs.readSync(fd, b, 0, f.bytes, f.offset); const raw = zlib.zstdDecompressSync(b);
      const idx = Buffer.alloc(32 * f.rows); fs.readSync(rowsFd, idx, 0, idx.length, start * 32);
      for (let i = 0; i < f.rows; i++) yield { row: start + i, rec: raw.subarray(idx.readUInt32LE(i * 32 + 8), idx.readUInt32LE(i * 32 + 8) + idx.readUInt32LE(i * 32 + 12)) };
    }
    start += f.rows;
  }
}

// 1. Clusters naming a sampled CAP case id.
const cDir = path.join(streamDir, 'clusters'); const cH = parseRecord(fs.readFileSync(path.join(cDir, 'header.csv')));
const cc = Object.fromEntries(cH.map((h, i) => [h, i]));
const clusterOf = new Map(); const clusterInfo = new Map();
for (const { rec } of frameRows(cDir)) {
  if (rec.indexOf('law.free.cap.') < 0) continue;
  const r = parseRecord(rec); const fp = r[cc.filepath_json_harvard]; const m = fp?.match(/\.(\d+)\.json$/);
  if (!m || !want.has(Number(m[1]))) continue;
  const id = Number(r[cc.id]); clusterOf.set(Number(m[1]), id);
  clusterInfo.set(id, { fp, headmatter: r[cc.headmatter], source: r[cc.source], date_filed: r[cc.date_filed] });
}
console.error(`clusters matched: ${clusterOf.size} of ${want.size} CAP cases`);

// 2. Their opinions, through cluster.bin.
const oDir = path.join(streamDir, 'opinions'); const oH = parseRecord(fs.readFileSync(path.join(oDir, 'header.csv')));
const oc = Object.fromEntries(oH.map((h, i) => [h, i]));
const cl = new Uint32Array(fs.readFileSync(path.join(oDir, 'cluster.bin')).buffer.slice(0));
const wantCl = new Set(clusterOf.values()); const wantRows = new Set();
for (let i = 0; i < cl.length; i++) if (wantCl.has(cl[i])) wantRows.add(i);
const frames = fs.readFileSync(path.join(oDir, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rowFrame = []; let s = 0; for (const f of frames) { rowFrame.push([s, f.frame]); s += f.rows; }
const needFrames = new Set(); { let k = 0; for (const r of [...wantRows].sort((a, b) => a - b)) { while (k + 1 < rowFrame.length && rowFrame[k + 1][0] <= r) k++; needFrames.add(rowFrame[k][1]); } }
const ops = new Map();
for (const { row, rec } of frameRows(oDir, needFrames)) {
  if (!wantRows.has(row)) continue;
  const r = parseRecord(rec); const c = Number(r[oc.cluster_id]);
  (ops.get(c) ?? ops.set(c, []).get(c)).push({ id: r[oc.id], type: r[oc.type], xml: r[oc.xml_harvard], hwc: r[oc.html_with_citations] });
}

// 3. Compare.
const tags = (s) => [...s.matchAll(/<([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map((m) => ({ tag: m[1], attrs: Object.fromEntries([...m[2].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], a[2]])) }));
const textKey = (s) => s.replace(/<[^>]*>/g, '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (a, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e.toLowerCase()] ?? a)).replace(/[\s ]+/g, '');
const T = {}; const inc = (k, n = 1) => { T[k] = (T[k] ?? 0) + n; }; const EX = {}; const ex = (k, v) => { (EX[k] ??= []).length < 5 && EX[k].push(v); };
const capOnly = {};
for (const c of cases) {
  inc('cap_cases');
  const capId = Number(c.cap_case_id); const clId = clusterOf.get(capId);
  if (!clId) { inc('not_in_cl'); continue; }
  const os = ops.get(clId) ?? []; inc('in_cl'); inc('cl_opinions', os.length);
  const xmls = os.map((o) => o.xml).filter(Boolean);
  if (!xmls.length) { inc('cl_no_xml_harvard'); ex('cl_no_xml_harvard', clId); continue; }
  const htmlPath = path.join(capRoot, 'volumes', c.reporter_slug, c.volume_folder, 'zip', 'html', c.file_name + '.html');
  if (!fs.existsSync(htmlPath)) { inc('cap_html_missing'); continue; }
  const cap = fs.readFileSync(htmlPath, 'utf8'); inc('compared');
  const capHead = cap.match(/<section class="head-matter"[\s\S]*?<\/section>/)?.[0] ?? '';
  const capOps = [...cap.matchAll(/<article class="opinion"[\s\S]*?<\/article>/g)].map((m) => m[0]);
  const capT = tags(cap), clT = xmls.flatMap(tags);
  // CAP-only features.
  for (const t of capT) {
    if (t.attrs['data-blocks']) capOnly['element with data-blocks (page order + bbox)'] = (capOnly['element with data-blocks (page order + bbox)'] ?? 0) + 1;
    if (t.attrs.class) for (const k of t.attrs.class.split(/\s+/)) capOnly[`${t.tag}.${k}`] = (capOnly[`${t.tag}.${k}`] ?? 0) + 1;
    for (const a of Object.keys(t.attrs)) capOnly[`${t.tag}@${a}`] = (capOnly[`${t.tag}@${a}`] ?? 0) + 1;
  }
  // Block ids.
  const isBlockId = (id) => id && !/^(p\d+|footnote_|ref_)/.test(id);
  const clIds = new Set(clT.map((t) => t.attrs.id).filter(Boolean));
  const capOpIds = new Set(capOps.flatMap(tags).map((t) => t.attrs.id).filter(isBlockId));
  const capHeadIds = new Set(tags(capHead).map((t) => t.attrs.id).filter(isBlockId));
  const clHm = clusterInfo.get(clId).headmatter ?? ''; const clHeadIds = new Set(tags(clHm).map((t) => t.attrs.id).filter(Boolean));
  inc('cl_body_ids', clIds.size); inc('cl_body_ids_in_cap_body', [...clIds].filter((x) => capOpIds.has(x)).length);
  inc('cap_body_ids', capOpIds.size); inc('cap_body_ids_in_cl', [...capOpIds].filter((x) => clIds.has(x)).length);
  if ([...clIds].some((x) => !capOpIds.has(x))) ex('cl_body_id_not_in_cap', `${clId}:${[...clIds].find((x) => !capOpIds.has(x))}`);
  inc('cap_head_ids', capHeadIds.size); inc('cl_cluster_headmatter_present', clHm ? 1 : 0);
  inc('cap_head_ids_in_cl_headmatter', [...capHeadIds].filter((x) => clHeadIds.has(x)).length);
  // Page labels.
  const capPages = capT.filter((t) => /\bpage-label\b/.test(t.attrs.class ?? '')).map((t) => `${t.attrs['data-citation-index']}:${t.attrs['data-label']}`);
  const clPages = clT.filter((t) => t.tag === 'page-number').map((t) => `${t.attrs['citation-index']}:${t.attrs.label}`)
    .concat(tags(clHm).filter((t) => t.tag === 'page-number' || /star-pagination/.test(t.attrs.class ?? '')).map((t) => `${t.attrs['citation-index']}:${t.attrs.label}`));
  inc('cap_page_labels', capPages.length); inc('cl_page_labels_incl_headmatter', clPages.length);
  const capPageSet = new Set(capPages); inc('cl_page_labels_in_cap', clPages.filter((p) => capPageSet.has(p)).length);
  if (capPages.length !== clPages.length) ex('page_label_count_differs', `${clId} cap ${capPages.length} cl ${clPages.length}`);
  // Footnotes.
  const capFn = capT.filter((t) => t.tag === 'aside' && /footnote/.test(t.attrs.class ?? '')).length;
  const clFn = clT.filter((t) => t.tag === 'footnote').length + tags(clHm).filter((t) => t.tag === 'footnote' || /footnote/.test(t.attrs.class ?? '')).length;
  inc('cap_footnotes', capFn); inc('cl_footnotes_incl_headmatter', clFn); if (capFn !== clFn) ex('footnote_count_differs', `${clId} cap ${capFn} cl ${clFn}`);
  // Text.
  const capText = textKey(capOps.join('')), clText = textKey(xmls.join(''));
  const rel = capText === clText ? 'equal' : capText.includes(clText) ? 'cap-contains-cl' : clText.includes(capText) ? 'cl-contains-cap' : 'differ';
  inc('text:' + rel); if (rel !== 'equal') ex('text:' + rel, clId);
  inc('opinion_count_equal', capOps.length === xmls.length ? 1 : 0); if (capOps.length !== xmls.length) ex('opinion_count_differs', `${clId} cap ${capOps.length} cl ${xmls.length}`);
}
const result = { totals: T, examples: EX, cap_markup_inventory_over_compared_cases: Object.fromEntries(Object.entries(capOnly).sort((a, b) => b[1] - a[1])) };
fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(JSON.stringify(T, null, 1));
