// Metadata pass over the re-encoded shards: joins every opinion to its cluster, docket and court,
// and counts rows, rendition presence (NULL / '' / text), source documents (download_url,
// local_path), and how renditions relate (html_with_citations vs CL's own source order; pairwise
// text equality of the independent renditions), by court x decade x cluster source.
//
//   node meta-pass.mjs STREAM_DIR OUT_DIR [--workers 3]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// ---- CSV field spans (no decoding of fields we do not need) ----------------
export function spans(rec) {
  const out = []; let i = 0; let end = rec.length; if (rec[end - 1] === 10) end--;
  for (;;) {
    if (i >= end) { out.push([i, i, false]); break; }
    if (rec[i] === 34) {
      let j = i + 1;
      for (;;) {
        const q = rec.indexOf(34, j);
        if (q < 0) throw new Error('unterminated quote');
        let b = q - 1, n = 0; while (b >= i + 1 && rec[b] === 92) { b--; n++; }
        if (n % 2 === 1) { j = q + 1; continue; }
        out.push([i + 1, q, true]); i = q + 1; break;
      }
      if (i >= end) break;
      i++; // comma
      if (i >= end) { out.push([i, i, false]); break; }
    } else {
      let c = rec.indexOf(44, i); if (c < 0 || c > end) c = end;
      out.push([i, c, false]); if (c >= end) break; i = c + 1;
    }
  }
  return out;
}
const unescape = (b) => (b.indexOf(92) < 0 ? b.toString('utf8') : b.toString('utf8').replace(/\\(["\\])/g, '$1'));
const val = (rec, s) => (!s[2] && s[0] === s[1] ? null : unescape(rec.subarray(s[0], s[1])));
const present = (s) => (!s[2] && s[0] === s[1] ? 0 : s[0] === s[1] ? 1 : 2); // 0 NULL, 1 '', 2 text

function* packFrames(dir) {
  const frames = fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let start = 0; for (const f of frames) { yield { f, start }; start += f.rows; }
}
function frameRecs(dir, f, fdCache, rowsFd) {
  const shard = path.join(dir, 'shards', `shard-${String(f.shard).padStart(4, '0')}.zst`);
  const fd = fdCache[shard] ??= fs.openSync(shard, 'r');
  const b = Buffer.alloc(f.bytes); fs.readSync(fd, b, 0, f.bytes, f.offset);
  return zlib.zstdDecompressSync(b);
}
function maxId(dir) {
  const fd = fs.openSync(path.join(dir, 'rows.bin'), 'r'); const b = Buffer.alloc(32 << 20); let pos = 0, max = 0, n;
  while ((n = fs.readSync(fd, b, 0, b.length, pos)) > 0) { for (let i = 0; i + 32 <= n; i += 32) { const v = b.readUInt32LE(i); if (v !== 0xffffffff && v > max) max = v; } pos += n; }
  fs.closeSync(fd); return max;
}
// Records of a decompressed frame, split by the same CSV state machine as the stream.
function* records(raw) {
  let inQ = false, start = 0, pos = 0; const n = raw.length;
  while (pos < n) {
    if (inQ) {
      const q = raw.indexOf(34, pos), b = raw.indexOf(92, pos);
      if (b >= 0 && b < q) { pos = b + 2; continue; }
      if (q < 0) throw new Error('frame ends inside a quoted field');
      inQ = false; pos = q + 1;
    } else {
      const q = raw.indexOf(34, pos), nl = raw.indexOf(10, pos);
      if (nl >= 0 && (q < 0 || nl < q)) { yield raw.subarray(start, nl + 1); start = pos = nl + 1; }
      else if (q >= 0) { inQ = true; pos = q + 1; } else break;
    }
  }
}

const RENDS = ['plain_text', 'html', 'html_lawbox', 'html_columbia', 'html_anon_2020', 'xml_harvard', 'xml_scan', 'html_with_citations'];
// CourtListener's own source order for html_with_citations (cl/citations/utils.py make_get_citations_kwargs).
const HWC_ORDER = ['xml_harvard', 'xml_scan', 'html_anon_2020', 'html_columbia', 'html_lawbox', 'html', 'plain_text'];
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const textKey = (s) => s.replace(/<[^>]*>/g, '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (a, e) => (e[0] === '#'
  ? (() => { try { return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch { return a; } })()
  : ENT[e.toLowerCase()] ?? a)).replace(/[\s\u00a0]+/g, '');

if (isMainThread) {
  const [streamDir, outDir] = process.argv.slice(2);
  const W = Number(process.argv[process.argv.indexOf('--workers') + 1] || 3) || 3;
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now(); const log = (s) => console.error(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`);

  // Courts: code -> index.
  const courtCodes = ['?']; const courtIdx = new Map([['?', 0]]);
  const ci = (c) => { if (!courtIdx.has(c)) { courtIdx.set(c, courtCodes.length); courtCodes.push(c); } return courtIdx.get(c); };
  const srcCodes = ['?']; const srcIdx = new Map([['?', 0]]);
  const si = (c) => { if (!srcIdx.has(c)) { srcIdx.set(c, srcCodes.length); srcCodes.push(c); } return srcIdx.get(c); };

  // Dockets: id -> court.
  const dockDir = path.join(streamDir, 'dockets');
  const dHead = fs.readFileSync(path.join(dockDir, 'header.csv'), 'utf8').trim().split(',');
  const dId = 0, dCourt = dHead.indexOf('court_id');
  const maxDock = maxId(dockDir); let docketRows = 0; const fdc = {};
  const docketCourt = new Uint16Array(new SharedArrayBuffer(2 * (maxDock + 1)));
  const docketSeen = new Uint8Array(new SharedArrayBuffer(maxDock + 1));
  for (const { f } of packFrames(dockDir)) {
    const raw = frameRecs(dockDir, f, fdc);
    for (const rec of records(raw)) {
      const s = spans(rec); const id = Number(val(rec, s[dId])); const court = val(rec, s[dCourt]) ?? '?';
      docketRows++; docketCourt[id] = ci(court); docketSeen[id] = 1;
    }
  }
  log(`dockets ${docketRows} max id ${maxDock} courts ${courtCodes.length}`);

  // Clusters: id -> docket, year, source; cluster text field presence.
  const clDir = path.join(streamDir, 'clusters'); const cHead = fs.readFileSync(path.join(clDir, 'header.csv'), 'utf8').trim().split(',');
  const cIdx = (k) => cHead.indexOf(k);
  const CLF = ['judges', 'procedural_history', 'attorneys', 'nature_of_suit', 'posture', 'syllabus', 'headnotes', 'summary',
    'disposition', 'history', 'other_dates', 'cross_reference', 'correction', 'arguments', 'headmatter', 'filepath_json_harvard', 'filepath_pdf_harvard'];
  const maxCl = maxId(clDir); let clusterRows = 0;
  const clDocket = new Uint32Array(new SharedArrayBuffer(4 * (maxCl + 1)));
  const clYear = new Uint16Array(new SharedArrayBuffer(2 * (maxCl + 1)));
  const clSrc = new Uint8Array(new SharedArrayBuffer(maxCl + 1));
  const clSeen = new Uint8Array(new SharedArrayBuffer(maxCl + 1));
  const clAgg = new Map(); const clMissingDocket = [];
  for (const { f } of packFrames(clDir)) {
    const raw = frameRecs(clDir, f, fdc);
    for (const rec of records(raw)) {
      const s = spans(rec); const id = Number(val(rec, s[0])); const dk = Number(val(rec, s[cIdx('docket_id')]));
      const df = val(rec, s[cIdx('date_filed')]); const year = df ? Number(df.slice(0, 4)) : 0;
      const src = val(rec, s[cIdx('source')]) ?? '?';
      clusterRows++; clDocket[id] = dk; clYear[id] = year; clSrc[id] = si(src); clSeen[id] = 1;
      const court = dk <= maxDock && docketSeen[dk] ? courtCodes[docketCourt[dk]] : (clMissingDocket.length < 1000 && clMissingDocket.push(id), '!no-docket');
      const key = `${court}|${Math.floor(year / 10) * 10}|${src}`;
      const a = clAgg.get(key) ?? { clusters: 0 }; a.clusters++;
      for (const k of CLF) { const p = present(s[cIdx(k)]); if (p === 2) a[k] = (a[k] ?? 0) + 1; }
      clAgg.set(key, a);
    }
  }
  log(`clusters ${clusterRows} max id ${maxCl}`);
  fs.writeFileSync(path.join(outDir, 'clusters-by-court-decade-source.json'), JSON.stringify(Object.fromEntries(clAgg)));

  // Opinions, on workers.
  const opDir = path.join(streamDir, 'opinions');
  const frames = [...packFrames(opDir)];
  const shared = { docketCourt, docketSeen, clDocket, clYear, clSrc, clSeen, maxDock, maxCl, courtCodes, srcCodes, opDir };
  let next = 0; const results = [];
  await Promise.all(Array.from({ length: W }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: shared });
    const feed = () => { if (next < frames.length) { w.postMessage(frames[next++]); } else { w.postMessage(null); } };
    w.on('message', (m) => { if (m.done) { results.push(m.agg); resolve(); } else { if (m.progress && m.progress % 500 === 0) log(`opinion frames ${m.progress}/${frames.length}`); feed(); } });
    w.on('error', reject); feed();
  })));
  // Merge.
  const agg = {};
  const merge = (dst, src) => { for (const [k, v] of Object.entries(src)) { if (typeof v === 'number') dst[k] = (dst[k] ?? 0) + v; else if (Array.isArray(v)) { dst[k] ??= []; for (const x of v) if (dst[k].length < 5) dst[k].push(x); } else merge(dst[k] ??= {}, v); } };
  for (const r of results) merge(agg, r);
  const receipt = { opinion_frames: frames.length, opinion_rows_index: fs.statSync(path.join(opDir, 'rows.bin')).size / 32,
    docket_rows: docketRows, cluster_rows: clusterRows, clusters_missing_docket_examples: clMissingDocket.slice(0, 50), seconds: (Date.now() - t0) / 1000 };
  fs.writeFileSync(path.join(outDir, 'opinions-agg.json'), JSON.stringify(agg));
  fs.writeFileSync(path.join(outDir, 'receipt.json'), JSON.stringify(receipt, null, 1));
  log('done ' + JSON.stringify(receipt));
} else {
  const S = workerData; const fdc = {}; const agg = { cells: {}, totals: {}, hwc: {}, pairs: {}, examples: {} };
  const H = fs.readFileSync(path.join(S.opDir, 'header.csv'), 'utf8').trim().split(',');
  const col = Object.fromEntries(H.map((h, i) => [h, i]));
  const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
  const ex = (k, id) => { const a = agg.examples[k] ??= []; if (a.length < 5) a.push(id); };
  let done = 0;
  parentPort.on('message', (job) => {
    if (!job) { parentPort.postMessage({ done: true, agg }); return; }
    const raw = frameRecs(S.opDir, job.f, fdc);
    for (const rec of records(raw)) {
      let s; try { s = spans(rec); } catch (e) { inc(agg.totals, 'parse_error'); continue; }
      if (s.length !== H.length) { inc(agg.totals, 'field_count_mismatch'); ex('field_count_mismatch', rec.subarray(0, 12).toString()); continue; }
      const id = Number(val(rec, s[0])); const cl = Number(val(rec, s[col.cluster_id]));
      inc(agg.totals, 'rows');
      let court = '!no-cluster', decade = '?', src = '?';
      if (cl <= S.maxCl && S.clSeen[cl]) {
        const dk = S.clDocket[cl]; decade = String(Math.floor(S.clYear[cl] / 10) * 10); src = S.srcCodes[S.clSrc[cl]];
        court = dk <= S.maxDock && S.docketSeen[dk] ? S.courtCodes[S.docketCourt[dk]] : '!no-docket';
      } else { inc(agg.totals, 'missing_cluster'); ex('missing_cluster', id); }
      const cell = agg.cells[`${court}|${decade}|${src}`] ??= {};
      inc(cell, 'rows');
      const have = [];
      for (const r of RENDS) { const p = present(s[col[r]]); inc(cell, `${r}:${['null', 'empty', 'text'][p]}`); if (p === 2) have.push(r); }
      inc(cell, 'combo:' + (have.join('+') || 'none'));
      const dl = val(rec, s[col.download_url]), lp = val(rec, s[col.local_path]);
      if (dl) { inc(cell, 'download_url'); inc(cell, 'dl_ext:' + (dl.match(/\.([A-Za-z0-9]{1,5})(?:[?#]|$)/)?.[1]?.toLowerCase() ?? '-')); }
      if (lp) {
        const kind = /^\/home\//.test(lp) ? 'importer-path' : lp.split('/')[0];
        inc(cell, 'local_path'); inc(cell, `lp:${kind}:${lp.split('.').pop().toLowerCase().slice(0, 5)}`);
        if (/^(pdf|html|txt|wpd|doc|docx)\//.test(lp)) ex(`lp:${court}|${decade}`, id);
      }
      inc(cell, 'ocr:' + (val(rec, s[col.extracted_by_ocr]) ?? 'null'));
      // html_with_citations against CourtListener's source order.
      if (have.includes('html_with_citations')) {
        const srcR = HWC_ORDER.find((r) => have.includes(r));
        const hk = textKey(val(rec, s[col.html_with_citations]));
        let verdict;
        if (!srcR) verdict = 'no-source';
        else if (textKey(val(rec, s[col[srcR]])) === hk) verdict = 'equals-rule-source';
        else { const other = HWC_ORDER.find((r) => r !== srcR && have.includes(r) && textKey(val(rec, s[col[r]])) === hk); verdict = other ? 'equals-other:' + other : 'equals-none'; }
        inc(agg.hwc, `${srcR ?? '-'}|${verdict}`); if (verdict !== 'equals-rule-source') ex(`hwc:${srcR}|${verdict}`, id);
      }
      // Pairwise text equality between the independent renditions an opinion carries.
      const ind = have.filter((r) => r !== 'html_with_citations');
      if (ind.length > 1) {
        const keys = Object.fromEntries(ind.map((r) => [r, textKey(val(rec, s[col[r]]))]));
        for (let i = 0; i < ind.length; i++) for (let j = i + 1; j < ind.length; j++) {
          const a = keys[ind[i]], b = keys[ind[j]];
          const rel = a === b ? 'equal' : a.includes(b) ? 'first-contains-second' : b.includes(a) ? 'second-contains-first' : 'differ';
          inc(agg.pairs, `${ind[i]}~${ind[j]}|${rel}`); ex(`pair:${ind[i]}~${ind[j]}|${rel}`, id);
        }
      }
    }
    done++; parentPort.postMessage({ progress: done });
  });
}
