// The note-up graph (caselawCitator.ts reads it) built from the installed A2AJ store: for each decision with text,
// every full citation of a case it makes, with the paragraph it is in, its offset, its pinpoints and a bounded
// excerpt; the store's own curated cited/citing lists beside them; and, for each cited key the store holds, every
// key of that decision, so a note-up asked by any of its citations reaches the same edges. Citations, keys and
// paragraphs all come from the native engine; the graph is written to a new file and swapped in whole.
//
//   npx tsx scripts/build-citator-graph.ts [--courts SCC,ONCA] [--limit N] [--workers N] [--store a2aj.sqlite] [--out noteup.sqlite]
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { legalProviderDatabase } from "../src/lib/legalDataPath";
import { structureNative } from "../src/lib/structureNative";

type Job = { id: number; citation: string; dataset: string; text: string; own: string[] };
type Edge = { key: string; citation: string; short: string | null; paragraph: number | null; offset: number;
  pinpoints: string | null; excerpt: string };
type Result = { id: number; edges: Edge[]; kinds: Record<string, number>; occurrences: number; self: number; error?: string };

/** A citation's engine key; none for text the engine reads no citation in. */
function keyOf(citation: string) {
  try { return structureNative().caselawCitationLookupKey(citation); } catch { return ""; }
}

const EXCERPT_BEFORE = 250, EXCERPT_AFTER = 350, EXCERPT_MAX = 600;

/** UTF-16 offsets of the engine's UTF-8 byte offsets, found in one walk of the text. */
function utf16Offsets(text: string, bytes: number[]) {
  const wanted = [...new Set(bytes)].sort((a, b) => a - b), found = new Map<number, number>();
  let byte = 0, unit = 0, next = 0;
  for (const character of text) {
    while (next < wanted.length && wanted[next] <= byte) found.set(wanted[next++], unit);
    if (next === wanted.length) break;
    const code = character.codePointAt(0)!;
    byte += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    unit += character.length;
  }
  while (next < wanted.length) found.set(wanted[next++], unit);
  return found;
}

async function harvest(job: Job): Promise<Result> {
  const native = structureNative();
  const own = new Set(job.own.map(keyOf).filter(Boolean));
  const citations = (native.citationEngineCall("extract", JSON.stringify({ text: job.text,
    options: { resolve: true, parallel: true } })) as { citations: any[] }).citations.filter((c) => c.form === "full");
  const kinds: Record<string, number> = {};
  for (const citation of citations) {
    const kind = ({ can_lii: "canlii", statute_volume: "statute", regulation_series: "statute", code: "statute",
      publication: citation.authority } as Record<string, string>)[citation.format] ?? citation.format ?? citation.authority;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  const cases = citations.filter((citation) => citation.authority === "case" && citation.key);
  const result: Result = { id: job.id, edges: [], kinds, occurrences: cases.length, self: 0 };
  if (!cases.length) return result;
  const offsets = utf16Offsets(job.text, cases.flatMap((citation) => [citation.span.start, citation.span.end]));
  const document = await native.deriveDocumentStructure({ kind: "provider_text", input: { provider: "a2aj",
    citation: job.citation, source_kind: "cases", text: job.text, dataset: job.dataset,
    require_report_start: job.dataset.toUpperCase() === "SCC" } });
  const paragraphs = native.documentAnchors(document).filter(({ kind, parentLabel }) => kind === "paragraph" && !parentLabel);
  for (const citation of cases) {
    if (own.has(citation.key)) { result.self++; continue; }
    const start = offsets.get(citation.span.start)!, end = offsets.get(citation.span.end)!;
    const block = paragraphs.find((paragraph) => paragraph.start <= start && start < paragraph.end);
    const pinpoints = (citation.pinpoints ?? []).filter((pin: any) => pin.kind === "paragraph")
      .flatMap((pin: any) => [pin.first, pin.last].filter(Boolean).map((value: string) => `par${value}`));
    result.edges.push({ key: citation.key, citation: citation.span.text, short: citation.shortName ?? null,
      paragraph: block ? Number(/\d+/u.exec(block.label)?.[0]) || null : null, offset: start,
      pinpoints: pinpoints.join(",") || null,
      excerpt: job.text.slice(Math.max(0, start - EXCERPT_BEFORE), end + EXCERPT_AFTER).replace(/\s+/gu, " ").trim().slice(0, EXCERPT_MAX) });
  }
  return result;
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE case_doc (id INTEGER PRIMARY KEY, path TEXT, file_row_number INTEGER, citation TEXT, citation2 TEXT, name TEXT,
  court TEXT, date TEXT, url TEXT, language TEXT NOT NULL, occurrence_count INTEGER NOT NULL);
CREATE TABLE edge (id INTEGER PRIMARY KEY, cited_key TEXT NOT NULL, cited_citation TEXT NOT NULL, cited_short TEXT,
  case_id INTEGER NOT NULL REFERENCES case_doc(id), paragraph INTEGER, text_offset INTEGER NOT NULL, pinpoints TEXT, excerpt TEXT NOT NULL);
CREATE TABLE resolution (cited_key TEXT NOT NULL, path TEXT NOT NULL, file_row_number INTEGER NOT NULL, exact_value TEXT NOT NULL);
CREATE TABLE case_key (case_id INTEGER NOT NULL REFERENCES case_doc(id), citation_key TEXT NOT NULL,
  PRIMARY KEY (case_id, citation_key)) WITHOUT ROWID;
CREATE TABLE provider_edge (id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES case_doc(id),
  direction TEXT NOT NULL CHECK (direction IN ('cited', 'citing')), citation TEXT NOT NULL, citation_key TEXT NOT NULL);
CREATE TABLE authority_metric (cited_key TEXT PRIMARY KEY, citing_cases INTEGER NOT NULL, citing_paragraphs INTEGER NOT NULL,
  occurrences INTEGER NOT NULL) WITHOUT ROWID;`;
const INDEXES = `
CREATE INDEX edge_cited_idx ON edge(cited_key);
CREATE INDEX edge_case_idx ON edge(case_id);
CREATE INDEX case_doc_citation_idx ON case_doc(citation);
CREATE INDEX resolution_key_idx ON resolution(cited_key);
CREATE INDEX resolution_target_idx ON resolution(path, file_row_number);
CREATE INDEX case_key_key_idx ON case_key(citation_key);
CREATE INDEX provider_edge_key_idx ON provider_edge(citation_key, direction);
CREATE INDEX provider_edge_case_idx ON provider_edge(case_id);`;

if (!isMainThread) {
  parentPort!.on("message", async (jobs: Job[] | null) => {
    if (!jobs) process.exit(0);
    const results: Result[] = [];
    for (const job of jobs) {
      try { results.push(await harvest(job)); }
      catch (error) { results.push({ id: job.id, edges: [], kinds: {}, occurrences: 0, self: 0, error: String(error) }); }
    }
    parentPort!.postMessage(results);
  });
} else void (async () => {
  const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback; };
  const storePath = argument("--store", process.env.MIKE_A2AJ_BULK_DB?.trim() || legalProviderDatabase("a2aj", "a2aj.sqlite"));
  const output = argument("--out", process.env.MIKE_CITATOR_DB?.trim() || legalProviderDatabase("a2aj", "noteup.sqlite"));
  const courts = argument("--courts", "").split(",").map((court) => court.trim().toUpperCase()).filter(Boolean);
  const limit = Number(argument("--limit", "0")) || -1;
  const workers = Number(argument("--workers", String(Math.max(1, os.availableParallelism() - 2))));
  const started = Date.now();
  const store = new DatabaseSync(storePath, { readOnly: true });
  const temporary = `${output}.new`;
  fs.rmSync(temporary, { force: true });
  const graph = new DatabaseSync(temporary);
  graph.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY; ${SCHEMA}`);
  const native = structureNative();
  const counters = { rows_scanned: 0, cases_indexed: 0, rows_skipped_no_text: 0, rows_skipped_duplicate: 0,
    case_citation_occurrences: 0, self_citations_skipped: 0, edges: 0, failures: 0, provider_cited_docs: 0,
    provider_cited_edges: 0, provider_citing_edges: 0, provider_keys_mined_confirmed: 0, provider_keys_unmined: 0,
    mined_keys_unlisted: 0 };
  const kindTotals: Record<string, number> = {};
  const addCase = graph.prepare(`INSERT INTO case_doc VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const addEdge = graph.prepare(`INSERT INTO edge (cited_key, cited_citation, cited_short, case_id, paragraph, text_offset,
    pinpoints, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const addProvider = graph.prepare(`INSERT INTO provider_edge (case_id, direction, citation, citation_key) VALUES (?, ?, ?, ?)`);
  const addKey = graph.prepare(`INSERT OR IGNORE INTO case_key VALUES (?, ?)`);
  type Row = Record<string, any>;
  const pending = new Map<number, { row: Row; language: string; own: string[] }>();
  const list = (row: Row, base: string, language: string): string[] => {
    for (const candidate of [language, language === "en" ? "fr" : "en"]) {
      const value = row[`${base}_${candidate}`];
      if (value == null) continue;
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
    }
    return [];
  };
  function write(results: Result[]) {
    graph.exec("BEGIN");
    for (const result of results) {
      const { row, language, own } = pending.get(result.id)!;
      pending.delete(result.id);
      if (result.error) { counters.failures++; console.warn(`${row.dataset} ${row.citation_en}: ${result.error.slice(0, 200)}`); }
      const caseId = ++counters.cases_indexed;
      counters.case_citation_occurrences += result.occurrences;
      counters.self_citations_skipped += result.self;
      counters.edges += result.edges.length;
      for (const [kind, n] of Object.entries(result.kinds)) kindTotals[kind] = (kindTotals[kind] ?? 0) + n;
      addCase.run(caseId, row.dataset, row.id, row.citation_en || row.citation_fr || null, row.citation2_en || row.citation2_fr || null,
        row.name_en || row.name_fr || null, row.dataset, String(row.document_date_en || row.document_date_fr || "").slice(0, 10) || null,
        row.url_en || row.url_fr || null, language, result.edges.length);
      for (const edge of result.edges)
        addEdge.run(edge.key, edge.citation, edge.short, caseId, edge.paragraph, edge.offset, edge.pinpoints, edge.excerpt);
      for (const key of new Set(own.map(keyOf).filter(Boolean))) addKey.run(caseId, key);
      const mined = new Set(result.edges.map((edge) => edge.key));
      for (const direction of ["cited", "citing"] as const) {
        const citations = list(row, `cases_${direction}`, language);
        const keys = new Set<string>();
        for (const citation of citations) {
          const key = keyOf(citation);
          if (!key) continue;
          keys.add(key);
          addProvider.run(caseId, direction, citation, key);
          counters[`provider_${direction}_edges`]++;
        }
        if (direction === "cited" && citations.length) {
          counters.provider_cited_docs++;
          counters.provider_keys_mined_confirmed += [...keys].filter((key) => mined.has(key)).length;
          counters.provider_keys_unmined += [...keys].filter((key) => !mined.has(key)).length;
          counters.mined_keys_unlisted += [...mined].filter((key) => !keys.has(key)).length;
        }
      }
    }
    graph.exec("COMMIT");
  }

  const pool = Array.from({ length: workers }, () => new Worker(
    `require(${JSON.stringify(require.resolve("tsx/cjs"))}); require(${JSON.stringify(__filename)});`, { eval: true }));
  const idle = [...pool], waiting: Array<() => void> = [];
  let inFlight = 0;
  const send = (jobs: Job[]) => new Promise<void>((resolve) => {
    const go = () => {
      const worker = idle.pop()!;
      inFlight++;
      worker.once("message", (results: Result[]) => {
        write(results);
        if (Math.floor(counters.cases_indexed / 5000) !== Math.floor((counters.cases_indexed - results.length) / 5000))
          console.log(`${counters.cases_indexed} cases, ${counters.edges} edges, ${((Date.now() - started) / 1000).toFixed(0)} s`);
        inFlight--; idle.push(worker); waiting.shift()?.();
      });
      worker.postMessage(jobs);
      resolve();
    };
    if (idle.length) go(); else waiting.push(go);
  });

  const seen = new Set<string>();
  let batch: Job[] = [];
  const rows = store.prepare(`SELECT id, dataset, citation_en, citation_fr, citation2_en, citation2_fr, name_en, name_fr,
      document_date_en, document_date_fr, url_en, url_fr, unofficial_text_en, unofficial_text_fr,
      cases_cited_en, cases_cited_fr, cases_citing_en, cases_citing_fr
    FROM document WHERE doc_type = 'cases'${courts.length ? ` AND UPPER(dataset) IN (${courts.map(() => "?").join(", ")})` : ""}
    ORDER BY dataset, id LIMIT ?`).iterate(...courts, limit) as Iterable<Row>;
  for (const row of rows) {
    counters.rows_scanned++;
    const text = (row.unofficial_text_en || "").trim() ? row.unofficial_text_en : row.unofficial_text_fr;
    if (!text?.trim()) { counters.rows_skipped_no_text++; continue; }
    const identity = row.url_en || row.url_fr ? `u:${row.url_en || row.url_fr}` : row.citation_en ? `c:${row.citation_en}` : null;
    if (identity && seen.has(identity)) { counters.rows_skipped_duplicate++; continue; }
    if (identity) seen.add(identity);
    const own = [row.citation_en, row.citation2_en, row.citation_fr, row.citation2_fr].filter(Boolean);
    pending.set(row.id, { row: { ...row, unofficial_text_en: null, unofficial_text_fr: null },
      language: (row.unofficial_text_en || "").trim() ? "en" : "fr", own });
    batch.push({ id: row.id, citation: row.citation_en || row.citation_fr || "", dataset: row.dataset, text, own });
    if (batch.length >= 16) { const jobs = batch; batch = []; await send(jobs); }
  }
  if (batch.length) await send(batch);
  while (inFlight) await new Promise<void>((resolve) => waiting.push(resolve));
  for (const worker of pool) worker.postMessage(null);

  // Every key of each decision the store holds under a cited key: the store's own citation index.
  const keys = (graph.prepare("SELECT DISTINCT cited_key FROM edge").all() as Array<{ cited_key: string }>).map((row) => row.cited_key);
  const documentsOf = store.prepare("SELECT document_id FROM citation_lookup WHERE citation_key = ?");
  const documentRow = store.prepare(`SELECT dataset, citation_en, citation_fr, citation2_en, citation2_fr FROM document
    WHERE id = ? AND doc_type = 'cases'`);
  const addResolution = graph.prepare("INSERT INTO resolution VALUES (?, ?, ?, ?)");
  const resolved = new Set<number>();
  let resolvedKeys = 0, resolutionRows = 0;
  graph.exec("BEGIN");
  for (const key of keys) {
    const documents = documentsOf.all(key) as Array<{ document_id: number }>;
    if (documents.length) resolvedKeys++;
    for (const { document_id } of documents) {
      if (resolved.has(document_id)) continue;
      resolved.add(document_id);
      const document = documentRow.get(document_id) as Row | undefined;
      if (!document) continue;
      const forms = new Map<string, string>();
      for (const citation of [document.citation_en, document.citation_fr, document.citation2_en, document.citation2_fr])
        if (citation) { const form = keyOf(citation); if (form && !forms.has(form)) forms.set(form, citation); }
      for (const [form, citation] of forms) { addResolution.run(form, document.dataset, document_id, citation); resolutionRows++; }
    }
  }
  graph.exec("COMMIT");
  graph.exec(INDEXES);
  graph.exec(`INSERT INTO authority_metric SELECT cited_key, COUNT(DISTINCT case_id),
    COUNT(DISTINCT CAST(case_id AS TEXT) || ':' || COALESCE(CAST(paragraph AS TEXT), '')), COUNT(*) FROM edge GROUP BY cited_key`);
  const metadata: Record<string, string> = {
    schema_version: "3", built_at: new Date().toISOString(), source: "a2aj.sqlite", inputs: storePath,
    jurisdiction: courts.join(","), limit: String(limit), normalization: "legal-citations engine keys; host paragraphs from legal-structure",
    paragraph_compiler: "legal-structure", resolution: "the store's citation_lookup", resolved_edge_keys: String(resolvedKeys),
    resolution_rows: String(resolutionRows), distinct_cited: String(keys.length), anchor_counts: JSON.stringify(kindTotals),
    ...Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, String(value)])),
  };
  const addMeta = graph.prepare("INSERT INTO meta VALUES (?, ?)");
  for (const [key, value] of Object.entries(metadata)) addMeta.run(key, value);
  graph.exec("ANALYZE");
  graph.close();
  store.close();
  fs.renameSync(temporary, output);
  console.log(`Note-up graph written to ${output}: ${JSON.stringify(metadata, null, 1)}`);
  console.log(`${((Date.now() - started) / 1000).toFixed(0)} s`);
})();
