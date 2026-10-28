// The works harvest: what the full texts of A2AJ's decisions and statutes, the journals database's articles and
// CourtListener's opinions tell of the works they are and the works they cite, kept compactly, one store per source.
//
// Each work: its provider's facts (name, year, pages, journal…), its own citations by the citation engine's key
// (a report's reporter, year, volume and first page kept apart, so a report's last page is the next one's first
// less one), and what its text gives of its extent: a decision's last numbered paragraph (legal-structure's case
// outline), a statute's sections (its statute outline), an opinion's star pages.
// Each work cited: how often, by how many works, the lowest and highest page, paragraph and section any citer
// pinpoints in it (a reference's pinpoint counted for the work it refers to), the names it is cited by and the
// short forms writers define for it. Everything is kept by provenance (a journal article's OCR'd text apart from a
// born-digital one's), strings once each, aggregates rather than occurrences, and no text.
//
// `index` gathers every store's reports into works-index.sqlite: each first page any work cites or is, by reporter
// volume, with how many works cite it, whether a harvested work is it, and the furthest page pinpointed in it. A
// report ends before the next first page in its volume, so the index bounds the reports no text was read for.
//
// `pack` writes what the locator rules read of those stores, compactly, to shared/work-extents-data.mjs, which the
// products bundle (shared/work-extents.mjs reads it): each decision's last paragraph, each report's and article's
// last page.
//
//   npx tsx scripts/harvest-works.ts a2aj|journals|courtlistener|index|pack [--out <dir>] [--workers N] [--limit N] [--snapshot 2026-09-30]
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { structureNative } from "../src/lib/structureNative";

/** Where a harvested fact comes from; journal articles by how their text was read. */
const PROVENANCE = { a2aj: 1, courtlistener: 2, journalDigital: 3, journalOcr: 4, journalOther: 5 } as const;
const KIND = { decision: 1, law: 2, article: 3, opinion: 4 } as const;

/** stdin to stdout through bz2, stream after stream (CourtListener's files are several concatenated). */
const BUNZIP = `import bz2, sys
source, sink = sys.stdin.buffer, sys.stdout.buffer
decompressor = bz2.BZ2Decompressor()
while chunk := source.read(1 << 20):
    while chunk:
        sink.write(decompressor.decompress(chunk))
        chunk = decompressor.unused_data if decompressor.eof else b""
        if decompressor.eof: decompressor = bz2.BZ2Decompressor()
sink.flush()`;

type Range = [number, number] | null;
type Cited = { n: number; page: Range; para: Range; section: Range; counts: [number, number, number]; names: Record<string, number>; shorts: Record<string, number> };
type Job = { id: string; kind: number; text: string; own: string; field?: string };
type Own = { key: string; reporter: string | null; year: number | null; volume: number | null; page: number | null };
type Harvest = { id: string; own: Own[]; paragraphs: number | null; sections: { count: number; first: string; last: string; low: number | null; high: number | null } | null;
  stars: Record<string, [number, number, number]> | null; words: number; cited: Record<string, Cited> };

const leading = (value: string) => { const found = /\d+/u.exec(value); return found ? Number(found[0]) : null; };
const widen = (range: Range, value: number | null): Range => value === null || !Number.isFinite(value) ? range
  : range ? [Math.min(range[0], value), Math.max(range[1], value)] : [value, value];

/** A report key's parts ("3:reporter:scr:scr:1997:1:196" is SCR, 1997, volume 1, page 196). */
function ownOf(citation: any): Own {
  const parts = String(citation.key ?? "").split(":");
  if (citation.format === "reporter" && parts[1] === "reporter") {
    // After the reporter's two names: its year, its volume where it numbers volumes within a year, its first page.
    const numbers = parts.slice(4).filter((part) => /^\d+$/u.test(part)).map(Number);
    if (numbers.length >= 2) return { key: citation.key, reporter: parts[2] ?? null, year: numbers[0],
      volume: numbers.length >= 3 ? numbers[1] : null, page: numbers[numbers.length - 1] };
  }
  return { key: citation.key, reporter: null, year: null, volume: null, page: null };
}

/** What one text gives: read on a worker. */
async function harvest(job: Job): Promise<Harvest> {
  const native = structureNative();
    // Each citation keyed as written: a report's pages are its own, whatever decision the alias table names it.
  const call = (text: string) => (native.citationEngineCall("extract", JSON.stringify({ text,
    options: { resolve: true, parallel: true, aliasKeys: false } })) as any).citations as any[];
  const own = job.own ? call(job.own).filter((citation) => citation.form === "full" && citation.key).map(ownOf) : [];
  const ownKeys = new Set(own.map((item) => item.key));
  let text = job.text, paragraphs: number | null = null, sections: Harvest["sections"] = null;
  // An opinion's pages, as the structure engine reads its rendition: printed star pagination, page numbers
  // and page breaks. Each run of consecutive pages is one series (an official and a regional reporter's).
  let stars: Harvest["stars"] = null;
  if (job.kind === KIND.opinion) {
    const plainText = job.field === "plain_text";
    const document = await native.deriveDocumentStructure({ kind: "native_markup", input: { provider: "courtlistener",
      id: job.id, text: plainText ? job.text : "", markup: plainText ? null : job.text } });
    text = native.documentText(document);
    const series: Array<[number, number, number]> = [];
    let last = 0;
    for (const block of native.documentAnchors(document)) {
      const number = Number(/(\d{1,5})$/u.exec(block.label)?.[1]);
      if (!number) continue;
      if (block.kind === "paragraph" && block.printedLabel) last = Math.max(last, number);
      if (block.kind !== "page") continue;
      const held = series.find((run) => run[1] === number - 1 || run[1] === number);
      if (held) { held[1] = number; held[2]++; } else series.push([number, number, 1]);
    }
    paragraphs = last || null;
    if (series.length) stars = Object.fromEntries(series.map((run, index) => [`p${index + 1}`, run]));
  }
  if (job.kind === KIND.law) {
    const labels = native.statuteOutline(text).filter((entry) => entry.kind === "section" || entry.kind === "article")
      .map((entry) => entry.label.trim().replace(/[.\s]+$/u, "")).filter(Boolean);
    if (labels.length) {
      const numbers = labels.map(leading).filter((value): value is number => value !== null);
      sections = { count: labels.length, first: labels[0], last: labels[labels.length - 1],
        low: numbers.length ? Math.min(...numbers) : null, high: numbers.length ? Math.max(...numbers) : null };
    }
  } else if (job.kind !== KIND.opinion) {
    let last = 0;
    for (const entry of native.caseOutline(text)) {
      if (entry.kind !== "paragraph") continue;
      const number = Number(/^(?:¶\s*)?\[?(\d{1,4})\]?\.?$/u.exec(entry.label.trim())?.[1]);
      if (number > last) last = number;
    }
    paragraphs = last || null;
  }
  const citations = call(text);
  const byIndex = new Map(citations.map((citation) => [citation.index, citation]));
  const groupKey = (citation: any) => citation.key as string | undefined;
  const cited: Record<string, Cited> = {};
  const entry = (key: string) => cited[key] ??= { n: 0, page: null, para: null, section: null, counts: [0, 0, 0], names: {}, shorts: {} };
  const pin = (target: Cited, pinpoints: any[] | undefined) => {
    for (const pinpoint of pinpoints ?? []) {
      const first = leading(String(pinpoint.first ?? "")), last = pinpoint.last ? leading(String(pinpoint.last)) : null;
      const field = pinpoint.kind === "page" ? "page" : pinpoint.kind === "paragraph" ? "para"
        : ["section", "subsection", "article", "rule", "schedule", "clause"].includes(pinpoint.kind) ? "section" : null;
      if (!field) continue;
      target[field] = widen(widen(target[field], first), last);
      target.counts[field === "page" ? 0 : field === "para" ? 1 : 2]++;
    }
  };
  for (const citation of citations) {
    if (citation.form === "full") {
      const key = groupKey(citation);
      if (!key || ownKeys.has(key)) continue;
      const target = entry(key);
      target.n++;
      pin(target, citation.pinpoints);
      const style = citation.style?.text?.trim();
      if (style && style.length <= 120 && !style.includes("\n") && /\p{L}/u.test(style)) target.names[style] = (target.names[style] ?? 0) + 1;
      const short = (citation.explicitShortName ?? citation.explicit_short_name)?.trim();
      if (short && short.length <= 80) target.shorts[short] = (target.shorts[short] ?? 0) + 1;
    } else if (citation.antecedent != null) {
      const antecedent = byIndex.get(citation.antecedent);
      const key = antecedent && groupKey(antecedent);
      if (!key || ownKeys.has(key)) continue;
      pin(entry(key), citation.pinpoints);
    }
  }
  return { id: job.id, own, paragraphs, sections, stars, words: text.split(/\s+/u).filter(Boolean).length, cited };
}

if (!isMainThread) {
  parentPort!.on("message", async (jobs: Job[] | null) => {
    if (!jobs) process.exit(0);
    const results = [];
    for (const job of jobs) {
      try { results.push(await harvest(job)); }
      catch (error) { results.push({ id: job.id, own: [], paragraphs: null, sections: null, stars: null, words: 0, cited: {}, error: String(error) }); }
    }
    parentPort!.postMessage(results);
  });
} else void (async () => {
  const source = process.argv[2];
  const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback; };
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const dir = argument("--out", path.join(local, "OpenLegalData", "providers", "inventory"));
  const workers = Number(argument("--workers", String(Math.max(1, os.availableParallelism() - 2))));
  const limit = Number(argument("--limit", "0")) || Infinity;
  if (!["a2aj", "journals", "courtlistener", "index", "pack"].includes(source)) throw new Error("harvest-works.ts a2aj|journals|courtlistener|index|pack");
  fs.mkdirSync(dir, { recursive: true });
  if (source === "index") { indexVolumes(dir); return; }
  if (source === "pack") { packExtents(dir); return; }
  const db = new DatabaseSync(path.join(dir, `works-${source}.sqlite`));
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA page_size = 4096;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS str (id INTEGER PRIMARY KEY, s TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS work (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, kind INTEGER, provenance INTEGER,
      name INTEGER, year INTEGER, paragraphs INTEGER, sections INTEGER, first_section INTEGER, last_section INTEGER,
      section_low INTEGER, section_high INTEGER, words INTEGER, pages INTEGER, first_page INTEGER, last_page INTEGER,
      journal INTEGER, volume INTEGER, issue INTEGER, authors INTEGER, court INTEGER, stars TEXT);
    CREATE TABLE IF NOT EXISTS own (work INTEGER, key INTEGER, reporter INTEGER, year INTEGER, volume INTEGER, page INTEGER,
      PRIMARY KEY (work, key)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cited (key INTEGER, provenance INTEGER, n INTEGER, works INTEGER, page_low INTEGER, page_high INTEGER,
      para_low INTEGER, para_high INTEGER, section_low INTEGER, section_high INTEGER, pages INTEGER, paras INTEGER, sections INTEGER,
      PRIMARY KEY (key, provenance)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS failure (source_id TEXT PRIMARY KEY, error TEXT);
    CREATE TABLE IF NOT EXISTS cited_as (key INTEGER, form INTEGER, kind INTEGER, provenance INTEGER, n INTEGER,
      PRIMARY KEY (key, form, kind, provenance)) WITHOUT ROWID;
  `);
  const ids = new Map<string, number>();
  const getStr = db.prepare("SELECT id FROM str WHERE s = ?"), addStr = db.prepare("INSERT INTO str (s) VALUES (?) RETURNING id");
  const str = (value: string | null | undefined): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const held = ids.get(value);
    if (held !== undefined) return held;
    const id = ((getStr.get(value) as { id: number } | undefined) ?? (addStr.get(value) as { id: number })).id;
    // Only short, repeating strings (reporters, courts, statuses) are worth holding, and as copies: a string sliced
    // from a decompressed chunk keeps the whole chunk alive.
    if (value.length <= 48 && ids.size < 2_000_000) ids.set(Buffer.from(value, "utf8").toString("utf8"), id);
    return id;
  };
  const addWork = db.prepare(`INSERT OR REPLACE INTO work (source_id, kind, provenance, name, year, paragraphs, sections, first_section,
    last_section, section_low, section_high, words, pages, first_page, last_page, journal, volume, issue, authors, court, stars)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`);
  const addOwn = db.prepare("INSERT OR IGNORE INTO own VALUES (?, ?, ?, ?, ?, ?)");
  const low = (column: string) => `${column} = CASE WHEN ${column} IS NULL THEN excluded.${column} WHEN excluded.${column} IS NULL THEN ${column} ELSE min(${column}, excluded.${column}) END`;
  const high = (column: string) => `${column} = CASE WHEN ${column} IS NULL THEN excluded.${column} WHEN excluded.${column} IS NULL THEN ${column} ELSE max(${column}, excluded.${column}) END`;
  const addCited = db.prepare(`INSERT INTO cited VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key, provenance) DO UPDATE SET
    n = n + excluded.n, works = works + excluded.works, pages = pages + excluded.pages, paras = paras + excluded.paras,
    sections = sections + excluded.sections, ${low("page_low")}, ${high("page_high")}, ${low("para_low")}, ${high("para_high")},
    ${low("section_low")}, ${high("section_high")}`);
  const addCitedAs = db.prepare(`INSERT INTO cited_as VALUES (?, ?, ?, ?, ?) ON CONFLICT (key, form, kind, provenance) DO UPDATE SET n = n + excluded.n`);
  const held = new Set((db.prepare("SELECT source_id FROM work").all() as Array<{ source_id: string }>).map((row) => row.source_id));

  type Facts = { provenance: number; kind: number; name?: string | null; year?: number | null; pages?: number | null; firstPage?: number | null;
    lastPage?: number | null; journal?: string | null; volume?: number | null; issue?: number | null; authors?: string | null; court?: string | null };
  const facts = new Map<string, Facts>();
  const addFailure = db.prepare("INSERT OR REPLACE INTO failure VALUES (?, ?)");
  function write(results: Array<Harvest & { error?: string }>) {
    db.exec("BEGIN");
    for (const result of results) {
      const f = facts.get(result.id)!; facts.delete(result.id);
      // A text the engine failed on is kept apart, to be read again once the engine reads it.
      if (result.error) { addFailure.run(result.id, result.error.slice(0, 500)); continue; }
      const s = result.sections;
      const { id } = addWork.get(result.id, f.kind, f.provenance, str(f.name), f.year ?? null, result.paragraphs, s?.count ?? null,
        str(s?.first), str(s?.last), s?.low ?? null, s?.high ?? null, result.words, f.pages ?? null, f.firstPage ?? null, f.lastPage ?? null,
        str(f.journal), f.volume ?? null, f.issue ?? null, str(f.authors), str(f.court),
        result.stars ? Object.entries(result.stars).map(([group, [a, b, n]]) => `${group}:${a}-${b}/${n}`).join(" ") : null) as { id: number };
      for (const item of result.own) addOwn.run(id, str(item.key), str(item.reporter), item.year, item.volume, item.page);
      for (const [key, c] of Object.entries(result.cited)) {
        const keyId = str(key);
        addCited.run(keyId, f.provenance, c.n, 1, c.page?.[0] ?? null, c.page?.[1] ?? null, c.para?.[0] ?? null, c.para?.[1] ?? null,
          c.section?.[0] ?? null, c.section?.[1] ?? null, c.counts[0], c.counts[1], c.counts[2]);
        for (const [name, n] of Object.entries(c.names)) addCitedAs.run(keyId, str(name), 1, f.provenance, n);
        for (const [short, n] of Object.entries(c.shorts)) addCitedAs.run(keyId, str(short), 2, f.provenance, n);
      }
    }
    db.exec("COMMIT");
  }

  // A pool of workers fed batches; the main thread writes what they return.
  const pool = Array.from({ length: workers }, () => new Worker(
    `require(${JSON.stringify(require.resolve("tsx/cjs"))}); require(${JSON.stringify(__filename)});`, { eval: true }));
  const idle = [...pool], waiting: Array<() => void> = [];
  let inFlight = 0, harvested = 0, failed = 0;
  const started = Date.now();
  const send = (jobs: Job[]) => new Promise<void>((resolve) => {
    const go = () => {
      const worker = idle.pop()!;
      inFlight++;
      worker.once("message", (results: Array<Harvest & { error?: string }>) => {
        failed += results.filter((result) => result.error).length;
        write(results);
        harvested += results.length;
        if (Math.floor(harvested / 5000) !== Math.floor((harvested - results.length) / 5000))
          console.log(`${source}: ${harvested} works, ${(harvested / ((Date.now() - started) / 1000)).toFixed(0)}/s`);
        inFlight--; idle.push(worker); waiting.shift()?.();
      });
      worker.postMessage(jobs);
      resolve();
    };
    if (idle.length) go(); else waiting.push(go);
  });
  let batch: Job[] = [];
  const queue = async (job: Job, fact: Facts) => {
    facts.set(job.id, fact);
    batch.push(job);
    if (batch.length >= 16) { const jobs = batch; batch = []; await send(jobs); }
  };
  const drain = async () => {
    if (batch.length) await send(batch);
    batch = [];
    while (inFlight) await new Promise<void>((resolve) => waiting.push(() => resolve()));
  };

  if (source === "a2aj") {
    const a2aj = new DatabaseSync(argument("--a2aj", path.join(local, "OpenLegalData", "providers", "a2aj", "a2aj.sqlite")), { readOnly: true });
    const ids = (a2aj.prepare(`SELECT id FROM document ORDER BY CASE WHEN dataset = 'SCC' THEN 0 WHEN doc_type = 'laws' THEN 1
      WHEN dataset LIKE '%CA' THEN 2 ELSE 3 END, id`).all() as Array<{ id: unknown }>).map((row) => String(row.id))
      .filter((id) => !held.has(`a2aj:${id}`)).slice(0, limit);
    const row = a2aj.prepare(`SELECT doc_type, dataset, citation_en, citation2_en, name_en, document_date_en, unofficial_text_en
      FROM document WHERE id = ?`);
    for (const id of ids) {
      const document = row.get(id) as Record<string, any>;
      if (!document?.unofficial_text_en) continue;
      const law = document.doc_type === "laws";
      await queue({ id: `a2aj:${id}`, kind: law ? KIND.law : KIND.decision, text: document.unofficial_text_en,
        own: [...new Set([document.citation_en, document.citation2_en].filter(Boolean))].join("; ") },
        { provenance: PROVENANCE.a2aj, kind: law ? KIND.law : KIND.decision, name: document.name_en,
          year: Number(String(document.document_date_en ?? "").slice(0, 4)) || null, court: document.dataset });
    }
  } else if (source === "journals") {
    const journals = new DatabaseSync(argument("--journals", path.join(os.homedir(), "Desktop", "Open Access Journals Database", "oajd", "journals.db")), { readOnly: true });
    const rows = journals.prepare(`SELECT article_id FROM articles WHERE hidden IS NOT 1 AND length(pdf_text_raw_extracted) > 500`).all() as Array<{ article_id: number }>;
    const row = journals.prepare(`SELECT pdf_type, citation_en, name_en, name_fr, authors, journal_abbrev, journal_name, volume, issue,
      first_page, last_page, pdf_page_count, document_date_en, pdf_text_raw_extracted FROM articles WHERE article_id = ?`);
    const number = (value: unknown) => /^\d+$/u.test(String(value ?? "").trim()) ? Number(value) : null;
    for (const { article_id } of rows.slice(0, limit)) {
      if (held.has(`oajd:${article_id}`)) continue;
      const a = row.get(article_id) as Record<string, any>;
      const provenance = a.pdf_type === "digital_born" ? PROVENANCE.journalDigital
        : a.pdf_type === "scanned_ocr" ? PROVENANCE.journalOcr : PROVENANCE.journalOther;
      // An article's own citation as writers give it, where the database holds none: "(2019) 64:3 McGill LJ 495".
      const year = String(a.document_date_en ?? "").slice(0, 4);
      const own = a.citation_en || (a.journal_abbrev && number(a.volume) && number(a.first_page) && /^\d{4}$/u.test(year)
        ? `(${year}) ${a.volume}${number(a.issue) ? `:${a.issue}` : ""} ${a.journal_abbrev} ${a.first_page}` : "");
      await queue({ id: `oajd:${article_id}`, kind: KIND.article, text: a.pdf_text_raw_extracted, own },
        { provenance, kind: KIND.article, name: a.name_en ?? a.name_fr, year: Number(String(a.document_date_en ?? "").slice(0, 4)) || null,
          pages: number(a.pdf_page_count), firstPage: number(a.first_page), lastPage: number(a.last_page),
          journal: a.journal_abbrev ?? a.journal_name, volume: number(a.volume), issue: number(a.issue), authors: a.authors });
    }
  } else {
    // CourtListener: every bulk file streamed once from its public bucket through Python's bz2.
    const snapshot = argument("--snapshot", "2026-09-30");
    const bucket = "https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/";
    db.exec(`
      CREATE TABLE IF NOT EXISTS court (id INTEGER PRIMARY KEY, name INTEGER, citation_string INTEGER, jurisdiction INTEGER, parent INTEGER);
      CREATE TABLE IF NOT EXISTS cluster (id INTEGER PRIMARY KEY, docket INTEGER, name INTEGER, short_name INTEGER, date INTEGER,
        status INTEGER, citations INTEGER);
      CREATE TABLE IF NOT EXISTS cluster_cite (cluster INTEGER, reporter INTEGER, volume INTEGER, page INTEGER, type INTEGER,
        PRIMARY KEY (cluster, reporter, volume, page)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS docket (id INTEGER PRIMARY KEY, court INTEGER);
    `);
    const done = (file: string) => !!db.prepare("SELECT 1 FROM meta WHERE key = ?").get(`done:${file}`);
    const finish = (file: string, rows: number) => db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run(`done:${file}`, String(rows));
    async function* records(file: string): AsyncGenerator<Record<string, string>> {
      // Python's bz2 on native pipes: Git for Windows' bzip2 deadlocks on a Windows pipe partway through a file.
      const bzip = spawn("python", ["-I", "-c", BUNZIP], { stdio: ["pipe", "pipe", "inherit"] });
      bzip.stdin.on("error", () => {});
      let received = 0, total = Infinity, stopped = false, current: import("node:http").ClientRequest | null = null, lastRow = Date.now();
      // A stream that stops yielding rows is dropped, and the download resumes at the byte it reached.
      let yielded = 0;
      const progress = setInterval(() => console.log(`${file}: ${yielded} rows, ${received} of ${total} bytes (bz2 in ${bzip.stdin.writableLength}, out ${bzip.stdout.readableLength})`), 30_000);
      const watchdog = setInterval(() => {
        if (Date.now() - lastRow < 300_000) return;
        console.log(`${file}: no rows for five minutes at byte ${received} (bz2 in ${bzip.stdin.writableLength}, out ${bzip.stdout.readableLength}); resuming`);
        lastRow = Date.now();
        current?.destroy(new Error("stalled"));
      }, 60_000);
      // One request at a time, piped into bzip2 (which paces it); a broken one resumes at the byte it reached.
      const download = () => new Promise<void>((resolve, reject) => {
        if (stopped) { resolve(); return; }
        current = https.get(`${bucket}${file}`, { headers: received ? { Range: `bytes=${received}-` } : {} }, (response) => {
          if (response.statusCode !== 200 && response.statusCode !== 206) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
          if (!received) total = Number(response.headers["content-length"] ?? Infinity);
          response.on("data", (chunk: Buffer) => { received += chunk.length; });
          response.pipe(bzip.stdin, { end: false });
          response.on("end", () => resolve());
          response.on("error", reject);
          response.on("aborted", () => reject(new Error("aborted")));
        });
        current.setTimeout(300_000, () => current?.destroy(new Error("idle")));
        current.on("error", reject);
      });
      void (async () => {
        let attempts = 0;
        while (received < total && !stopped) {
          try { await download(); attempts = 0; }
          catch (error) {
            if (stopped) return;
            if (++attempts > 30) { bzip.stdin.destroy(error as Error); return; }
            console.log(`${file}: ${String(error)} at byte ${received}; resuming`);
            await new Promise((wait) => setTimeout(wait, 3000 * attempts));
          }
        }
        bzip.stdin.end();
      })();
      // PostgreSQL CSV (ESCAPE '\'): quoted with ", a quote or backslash inside quotes escaped by a backslash.
      let header: string[] | null = null, field = "", row: string[] = [], quoted = false, escaped = false;
      const special = /["\\]/gu, delimiter = /[",\n]/gu;
      bzip.stdout.setEncoding("utf8");
      try {
        for await (const chunk of bzip.stdout as AsyncIterable<string>) {
          const emitted: Array<Record<string, string>> = [];
          let i = 0;
          while (i < chunk.length) {
            if (quoted) {
              if (escaped) { escaped = false; const c = chunk[i]; field += c === "\"" || c === "\\" ? c : `\\${c}`; i++; continue; }
              special.lastIndex = i;
              const found = special.exec(chunk);
              if (!found) { field += chunk.slice(i); break; }
              field += chunk.slice(i, found.index); i = found.index + 1;
              if (found[0] === "\\") escaped = true; else quoted = false;
              continue;
            }
            delimiter.lastIndex = i;
            const found = delimiter.exec(chunk);
            if (!found) { field += chunk.slice(i); break; }
            field += chunk.slice(i, found.index); i = found.index + 1;
            if (found[0] === "\"") { quoted = true; continue; }
            row.push(found[0] === "\n" && field.endsWith("\r") ? field.slice(0, -1) : field);
            field = "";
            if (found[0] === "\n") {
              if (!header) header = row;
              else emitted.push(Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""])));
              row = [];
            }
          }
          if (emitted.length) { lastRow = Date.now(); yielded += emitted.length; }
          for (const record of emitted) yield record;
        }
      } finally {
        stopped = true; clearInterval(watchdog); clearInterval(progress); current?.destroy(); bzip.kill();
      }
    }
    const integer = (value: string) => /^\d+$/u.test(value) ? Number(value) : null;
    async function load(name: string, each: (record: Record<string, string>) => void) {
      const file = `${name}-${snapshot}.csv.bz2`;
      if (done(file)) return;
      let rows = 0;
      db.exec("BEGIN");
      for await (const record of records(file)) {
        each(record);
        if (++rows % 100_000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); }
        if (rows >= limit) break;
      }
      db.exec("COMMIT");
      if (rows < limit) finish(file, rows);
    }
    const court = db.prepare("INSERT OR REPLACE INTO court VALUES (?, ?, ?, ?, ?)");
    await load("courts", (r) => court.run(str(r.id), str(r.full_name), str(r.citation_string), str(r.jurisdiction), str(r.parent_court_id)));
    const cite = db.prepare("INSERT OR IGNORE INTO cluster_cite VALUES (?, ?, ?, ?, ?)");
    await load("citations", (r) => cite.run(Number(r.cluster_id), str(r.reporter), integer(r.volume), integer(r.page), integer(r.type)));
    const cluster = db.prepare("INSERT OR REPLACE INTO cluster VALUES (?, ?, ?, ?, ?, ?, ?)");
    await load("opinion-clusters", (r) => cluster.run(Number(r.id), integer(r.docket_id), str(r.case_name || r.case_name_full),
      str(r.case_name_short), integer(r.date_filed.replaceAll("-", "")), str(r.precedential_status), integer(r.citation_count)));
    if (!done(`dockets-${snapshot}.csv.bz2`)) {
      // Only the dockets clusters name, asked of an index: ten million ids do not fit a set in the heap.
      db.exec("CREATE INDEX IF NOT EXISTS cluster_docket ON cluster (docket)");
      const wanted = db.prepare("SELECT 1 FROM cluster WHERE docket = ? LIMIT 1");
      const docket = db.prepare("INSERT OR REPLACE INTO docket VALUES (?, ?)");
      await load("dockets", (r) => { const id = Number(r.id); if (wanted.get(id)) docket.run(id, str(r.court_id)); });
    }
    const file = `opinions-${snapshot}.csv.bz2`;
    if (!done(file)) {
      const fields = ["html_with_citations", "xml_harvard", "html_lawbox", "html_columbia", "html", "html_anon_2020", "plain_text", "xml_scan"];
      let rows = 0;
      for await (const r of records(file)) {
        if (++rows >= limit) break;
        if (held.has(`cl:${r.id}`)) continue;
        const field = fields.find((name) => r[name]?.trim());
        if (!field) continue;
        await queue({ id: `cl:${r.id}`, kind: KIND.opinion, text: r[field], own: "", field },
          { provenance: PROVENANCE.courtlistener, kind: KIND.opinion, name: `${r.cluster_id}:${r.type}`, pages: integer(r.page_count) });
      }
      await drain();
      if (rows < limit) finish(file, rows);
    }
  }
  await drain();
  for (const worker of pool) worker.postMessage(null);
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  console.log(JSON.stringify({ source, harvested, failed, minutes: ((Date.now() - started) / 60_000).toFixed(1),
    works: count("work"), cited: count("cited"), citedAs: count("cited_as"), strings: count("str") }));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  process.exit(0);
})();

/** Every store's reports and articles by volume (see `index` above), written to works-index.sqlite in `dir`, each with
 * the last page it can run to: an article's own last page where the journals database gives it; else the page before
 * the next first page in its volume that a harvested work is or two works cite. That end stands where both first
 * pages are harvested works' own (A2AJ holds every report of a volume it covers, so a pinpoint past it is the
 * citer's mistake), and otherwise only where no citer has pinpointed past it. */
function indexVolumes(dir: string) {
  type Start = { citers: number; owners: number; open: boolean; pinHigh: number; last: number | null };
  const volumes = new Map<string, Map<number, Start>>();
  const start = (key: string) => {
    const parts = key.split(":");
    const page = Number(parts.pop());
    if (!Number.isInteger(page)) return null;
    const volume = parts.slice(1).join(":");
    if (!volumes.has(volume)) volumes.set(volume, new Map());
    const pages = volumes.get(volume)!;
    if (!pages.has(page)) pages.set(page, { citers: 0, owners: 0, open: false, pinHigh: 0, last: null });
    return pages.get(page)!;
  };
  const version = structureNative().citationLookupKey("2016 SCC 29").split(":")[0];
  const paged = `(s.s LIKE '${version}:reporter:%' OR s.s LIKE '${version}:journal:%')`;
  for (const file of fs.readdirSync(dir).filter((name) => /^works-(?!index)\w+\.sqlite$/u.test(name))) {
    const store = new DatabaseSync(path.join(dir, file), { readOnly: true, timeout: 10_000 });
    for (const row of store.prepare(`SELECT s.s AS key, sum(c.works) AS citers, max(c.page_high) AS pin_high FROM cited c
      JOIN str s ON s.id = c.key WHERE ${paged} GROUP BY c.key`).iterate() as Iterable<{ key: string; citers: number; pin_high: number | null }>) {
      const found = start(row.key);
      if (found) { found.citers += row.citers; found.pinHigh = Math.max(found.pinHigh, row.pin_high ?? 0); }
    }
    // An article's last page is the journals database's, else its first page and page count's. Articles of different
    // issues can share a first page ("(2010) 33:1 Dal LJ 1" and "33:2 Dal LJ 1"): the longest bounds the key, and one
    // whose end is unknown leaves the key's unknown.
    for (const row of store.prepare(`SELECT s.s AS key, coalesce(w.last_page, w.first_page + w.pages - 1) AS last
      FROM own o JOIN str s ON s.id = o.key JOIN work w ON w.id = o.work WHERE ${paged}`)
      .iterate() as Iterable<{ key: string; last: number | null }>) {
      const found = start(row.key);
      if (!found) continue;
      found.owners++;
      found.open ||= !row.last;
      if (row.last) found.last = Math.max(found.last ?? 0, row.last);
    }
    store.close();
  }
  const target = path.join(dir, "works-index.sqlite");
  fs.rmSync(target, { force: true });
  const db = new DatabaseSync(target);
  db.exec(`CREATE TABLE start (volume TEXT, page INTEGER, citers INTEGER, own INTEGER, pin_high INTEGER, last INTEGER,
    PRIMARY KEY (volume, page)) WITHOUT ROWID;`);
  const insert = db.prepare("INSERT INTO start VALUES (?, ?, ?, ?, ?, ?)");
  let reports = 0, bounded = 0;
  db.exec("BEGIN");
  for (const [volume, pages] of volumes) {
    const order = [...pages.keys()].sort((a, b) => a - b);
    const confirmed = order.filter((page) => pages.get(page)!.owners || pages.get(page)!.citers >= 2);
    for (const page of order) {
      const found = pages.get(page)!;
      const shared = found.owners > 1 && found.open;
      let last = shared ? null : found.last;
      if (last === null && !shared) {
        const next = confirmed.find((other) => other > page);
        const held = next !== undefined && found.owners > 0 && pages.get(next)!.owners > 0;
        if (next !== undefined && (held || found.pinHigh < next)) last = next - 1;
      }
      insert.run(volume, page, found.citers, found.owners ? 1 : 0, found.pinHigh || null, last);
      reports++;
      if (last !== null) bounded++;
    }
  }
  db.exec("COMMIT");
  db.close();
  console.log(JSON.stringify({ volumes: volumes.size, reports, bounded }));
}

/** The extents pack (see `pack` above), its fields tab-separated. Lines "N court year" list a court's decisions of a year by neutral
 * number, as number gaps, each "gap:last paragraph". Lines "V volume" list a volume's reports or articles by
 * first page, as page gaps, each "gap:pages[:last paragraph]", pages counted from the first, empty where unknown. */
function packExtents(dir: string) {
  const a2aj = new DatabaseSync(path.join(dir, "works-a2aj.sqlite"), { readOnly: true, timeout: 10_000 });
  const index = new DatabaseSync(path.join(dir, "works-index.sqlite"), { readOnly: true, timeout: 10_000 });
  const neutral = new Map<string, Array<[number, number]>>(), reported = new Map<string, number>();
  // A decision's numbered paragraphs run under 250 words on average in 99% of A2AJ's; a count averaging over 1,000 is a
  // numbered list's in a decision whose paragraphs are not numbered ("McKinney v University of Guelph, [1990] 3 SCR 229":
  // 73,197 words, "5 paragraphs"), and gives no extent.
  for (const { key, paragraphs } of a2aj.prepare(`SELECT s.s AS key, w.paragraphs FROM own o JOIN str s ON s.id = o.key
    JOIN work w ON w.id = o.work WHERE w.paragraphs IS NOT NULL AND w.words <= w.paragraphs * 1000`)
    .iterate() as Iterable<{ key: string; paragraphs: number }>) {
    const parts = key.split(":");
    if (parts[1] === "neutral" && /^\d+$/u.test(parts[4] ?? "") && parts.length === 5) {
      const group = `${parts[3]}\t${parts[2]}`;
      if (!neutral.has(group)) neutral.set(group, []);
      neutral.get(group)!.push([Number(parts[4]), paragraphs]);
    } else if (parts[1] === "reporter") reported.set(parts.slice(1).join(":"), paragraphs);
  }
  const lines: string[] = [];
  for (const [group, rows] of [...neutral].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort((a, b) => a[0] - b[0]);
    let previous = 0;
    lines.push(`N\t${group}\t` + rows.map(([number, paragraphs]) => { const gap = number - previous; previous = number; return `${gap}:${paragraphs}`; }).join(","));
  }
  const volumes = new Map<string, Array<[number, number | null, number | null]>>();
  for (const { volume, page, last } of index.prepare("SELECT volume, page, last FROM start ORDER BY volume, page")
    .iterate() as Iterable<{ volume: string; page: number; last: number | null }>) {
    const paragraphs = reported.get(`${volume}:${page}`) ?? null;
    if (last === null && paragraphs === null) continue;
    if (!volumes.has(volume)) volumes.set(volume, []);
    volumes.get(volume)!.push([page, last, paragraphs]);
  }
  for (const [volume, rows] of volumes) {
    let previous = 0;
    lines.push(`V\t${volume}\t` + rows.map(([page, last, paragraphs]) => {
      const gap = page - previous; previous = page;
      return `${gap}:${last === null ? "" : last - page}${paragraphs === null ? "" : `:${paragraphs}`}`;
    }).join(","));
  }
  // A statute's first and last numbered sections, by its key without the key version ("statute:ca:rsc:1985:c-46").
  let statutes = 0;
  for (const { key, low, high } of a2aj.prepare(`SELECT s.s AS key, w.section_low AS low, w.section_high AS high FROM own o
    JOIN str s ON s.id = o.key JOIN work w ON w.id = o.work WHERE w.section_low IS NOT NULL AND w.section_high >= w.section_low
    ORDER BY s.s`).iterate() as Iterable<{ key: string; low: number; high: number }>) {
    lines.push(`S\t${key.split(":").slice(1).join(":")}\t${low}:${high}`);
    statutes++;
  }
  const text = lines.join("\n");
  const target = path.resolve(__dirname, "../../shared/work-extents-data.mjs");
  fs.writeFileSync(target, `// Generated by backend/scripts/harvest-works.ts pack from the works harvest; read by work-extents.mjs.\n` +
    `export default ${JSON.stringify(text)};\n`);
  console.log(JSON.stringify({ decisions: [...neutral.values()].reduce((sum, rows) => sum + rows.length, 0),
    volumes: volumes.size, statutes, bytes: text.length }));
}
