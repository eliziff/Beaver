// Installs and updates Beaver's local A2AJ store (a2aj.sqlite, read by a2ajLocalBulk.ts) from the
// Parquet files A2AJ publishes on Hugging Face (a2aj/canadian-case-law, a2aj/canadian-laws), one court
// or jurisdiction at a time. A court's file is downloaded beside the store (a stopped download resumes),
// verified by its SHA-256, read into the store in one transaction and then deleted; the store records
// the file's hash and revision, so an update fetches only the courts whose file changed. A document the
// store already has keeps its id, and is rewritten only when its content changed.
//
// Ported from ALR-Quote-Verifier local_a2aj.py (LocalA2AJCorpus.fetch_metadata, status,
// bytes_to_download, install_or_update, _download_file) and from Beaver's former
// backend/scripts/import_a2aj_bulk.py (document_values, name_key, schema version 3) and
// consolidate_a2aj_sqlite.py (identity-preserving merge).
/// <reference path="./hyparquetThrift.d.ts" />
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer, type FileMetaData } from "hyparquet";
import { deserializeTCompactProtocol } from "hyparquet/src/thrift.js";
import { a2ajLocalBulkPath, a2ajStoreCourts } from "./a2ajLocalBulk";
import { structureNative } from "./structureNative";

export type A2AJKind = "cases" | "laws";
export const A2AJ_KINDS: readonly A2AJKind[] = ["cases", "laws"];
const REPOSITORIES: Record<A2AJKind, string> = { cases: "a2aj/canadian-case-law", laws: "a2aj/canadian-laws" };

export type A2AJRemoteFile = { court: string; path: string; sha256: string; size: number };
export type A2AJSnapshot = { kind: A2AJKind; repository: string; revision: string; lastModified: string;
  files: A2AJRemoteFile[] };

/** The dataset's current revision and its Parquet files (one per court), from Hugging Face. */
export async function fetchA2AJSnapshot(kind: A2AJKind, signal?: AbortSignal): Promise<A2AJSnapshot> {
  const repository = REPOSITORIES[kind];
  const response = await fetch(`https://huggingface.co/api/datasets/${repository}/revision/main?blobs=true`, { signal });
  if (!response.ok) throw new Error(`Hugging Face did not list ${repository} (${response.status}).`);
  const payload = await response.json() as { sha?: string; lastModified?: string;
    siblings?: Array<{ rfilename?: string; size?: number; lfs?: { sha256?: string; size?: number } }> };
  const files = (payload.siblings ?? []).flatMap((item) => {
    const file = String(item.rfilename ?? ""), court = file.split("/")[0];
    if (!file.endsWith(".parquet") || !/^[A-Z][A-Z0-9-]*$/u.test(court)) return [];
    const sha256 = String(item.lfs?.sha256 ?? "");
    if (sha256.length !== 64) throw new Error(`Hugging Face omitted the SHA-256 of ${repository}/${file}.`);
    return [{ court, path: file, sha256, size: Number(item.lfs?.size ?? item.size ?? 0) }];
  }).sort((left, right) => left.court.localeCompare(right.court));
  if (!files.length) throw new Error(`Hugging Face listed no Parquet files for ${repository}.`);
  return { kind, repository, revision: String(payload.sha ?? ""), lastModified: String(payload.lastModified ?? ""), files };
}

export type A2AJCourtStatus = { kind: A2AJKind; court: string;
  /** What the store holds of this court: documents, and the file it came from when recorded. */
  installed: { documents: number; sha256: string | null; size: number | null; revision: string | null } | null;
  /** The current revision's file, when the snapshot was given. */
  remote: A2AJRemoteFile | null;
  /** Bytes of the current file already downloaded by an install that stopped. */
  partial: number };

const downloads = (store: string) => path.join(path.dirname(store), "downloads");
const download = (store: string, kind: A2AJKind, court: string) => path.join(downloads(store), kind, `${court}.parquet`);
const sizeOf = (file: string) => stat(file).then((info) => info.size, () => 0);

/** Every court the store or the snapshots have: what is installed, what is current, what is partly downloaded. */
export async function a2ajStoreStatus(snapshots: Partial<Record<A2AJKind, A2AJSnapshot>> = {},
  store = a2ajLocalBulkPath()): Promise<A2AJCourtStatus[]> {
  const installed = new Map((a2ajStoreCourts(store) ?? []).map((court) => [`${court.docType}/${court.court}`, court]));
  const remote = new Map<string, A2AJRemoteFile>(A2AJ_KINDS.flatMap((kind) => snapshots[kind]?.files.map((file) => [`${kind}/${file.court}`, file] as const) ?? []));
  const keys = [...new Set([...installed.keys(), ...remote.keys()])].sort();
  return Promise.all(keys.map(async (key) => {
    const [kind, court] = key.split("/") as [A2AJKind, string], have = installed.get(key), file = remote.get(key) ?? null;
    const partial = file && have?.sha256 !== file.sha256
      ? Math.min(Math.max(await sizeOf(`${download(store, kind, court)}.part`), await sizeOf(download(store, kind, court))), file.size) : 0;
    return { kind, court, remote: file, partial, installed: have
      ? { documents: have.documents, sha256: have.sha256, size: have.size, revision: have.revision } : null };
  }));
}

/** Whether an installed court differs from the current revision's file (or its file was never recorded). */
export const a2ajCourtStale = (court: A2AJCourtStatus) =>
  !!court.installed && !!court.remote && court.installed.sha256 !== court.remote.sha256;

/** Bytes still to fetch to have these courts ("cases/SCC") current. */
export const a2ajBytesToDownload = (status: A2AJCourtStatus[], courts: Iterable<string>) => {
  const wanted = new Set(courts);
  return status.reduce((total, court) => !wanted.has(`${court.kind}/${court.court}`) || !court.remote ||
    court.installed?.sha256 === court.remote.sha256 ? total : total + court.remote.size - court.partial, 0);
};

export type A2AJInstallProgress = { kind: A2AJKind; court: string;
  phase: "download" | "import" | "installed" | "removed";
  /** Bytes fetched in this install, of the bytes it set out to fetch; documents read into the store for this court. */
  downloaded: number; toDownload: number; documents: number };

async function sha256File(file: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The court's file, downloaded (resuming a stopped download) and verified. */
async function fetchFile(store: string, snapshot: A2AJSnapshot, file: A2AJRemoteFile,
  options: { signal?: AbortSignal; fetched: (bytes: number) => void }) {
  const target = download(store, snapshot.kind, file.court), part = `${target}.part`;
  if (await sizeOf(target) === file.size && await sha256File(target, options.signal) === file.sha256) return target;
  await mkdir(path.dirname(target), { recursive: true });
  let written = await sizeOf(part);
  if (written > file.size) { await rm(part); written = 0; }
  if (written < file.size) {
    const url = `https://huggingface.co/datasets/${snapshot.repository}/resolve/${snapshot.revision}/${
      file.path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, { signal: options.signal, headers: written ? { Range: `bytes=${written}-` } : {} });
    if (!response.ok || !response.body) throw new Error(`Hugging Face did not send ${snapshot.repository}/${file.path} (${response.status}).`);
    if (written && response.status !== 206) written = 0;
    const handle = await open(part, written ? "r+" : "w");
    try {
      await handle.truncate(written);
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        await handle.write(chunk, 0, chunk.byteLength, written);
        written += chunk.byteLength;
        options.fetched(chunk.byteLength);
      }
      await handle.sync();
    } finally { await handle.close(); }
  }
  // What an earlier, stopped download kept is hashed again with the rest rather than trusted.
  if (await sizeOf(part) !== file.size || await sha256File(part, options.signal) !== file.sha256) {
    await rm(part, { force: true });
    throw new Error(`The downloaded ${snapshot.repository}/${file.path} did not match its published SHA-256. Install it again.`);
  }
  await rename(part, target);
  return target;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document (
  id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, dataset TEXT NOT NULL,
  citation_en TEXT, citation_fr TEXT, citation2_en TEXT, citation2_fr TEXT, name_en TEXT, name_fr TEXT,
  document_date_en TEXT, document_date_fr TEXT, url_en TEXT, url_fr TEXT,
  unofficial_text_en TEXT, unofficial_text_fr TEXT, unofficial_sections_en TEXT, unofficial_sections_fr TEXT,
  cases_cited_en TEXT, cases_cited_fr TEXT, cases_citing_en TEXT, cases_citing_fr TEXT,
  citing_cases_count INTEGER, upstream_license TEXT);
CREATE TABLE IF NOT EXISTS citation_lookup (citation_key TEXT NOT NULL, document_id INTEGER NOT NULL,
  PRIMARY KEY (citation_key, document_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS name_lookup (name_key TEXT NOT NULL, document_id INTEGER NOT NULL,
  PRIMARY KEY (name_key, document_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS source_file (doc_type TEXT NOT NULL, dataset TEXT NOT NULL, path TEXT NOT NULL,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, revision TEXT NOT NULL, installed_at TEXT NOT NULL,
  PRIMARY KEY (doc_type, dataset));
CREATE INDEX IF NOT EXISTS document_dataset_idx ON document(doc_type, dataset);
CREATE INDEX IF NOT EXISTS document_date_en_idx ON document(document_date_en);
CREATE INDEX IF NOT EXISTS document_date_fr_idx ON document(document_date_fr);
CREATE INDEX IF NOT EXISTS citation_lookup_document_idx ON citation_lookup(document_id);
CREATE INDEX IF NOT EXISTS name_lookup_document_idx ON name_lookup(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(citation_en, citation_fr, citation2_en, citation2_fr,
  name_en, name_fr, unofficial_text_en, unofficial_text_fr, content='document', content_rowid='id');`;
const COLUMNS = ["doc_type", "dataset", "citation_en", "citation_fr", "citation2_en", "citation2_fr", "name_en", "name_fr",
  "document_date_en", "document_date_fr", "url_en", "url_fr", "unofficial_text_en", "unofficial_text_fr",
  "unofficial_sections_en", "unofficial_sections_fr", "cases_cited_en", "cases_cited_fr", "cases_citing_en",
  "cases_citing_fr", "citing_cases_count", "upstream_license"] as const;
const SEARCHED = ["citation_en", "citation_fr", "citation2_en", "citation2_fr", "name_en", "name_fr",
  "unofficial_text_en", "unofficial_text_fr"] as const;
type Value = string | number | null;
type Document = Record<(typeof COLUMNS)[number], Value>;

/** A style of cause compared as its words (import_a2aj_bulk.py name_key). */
export function a2ajNameKey(value: string) {
  return value.replace(/(\w)\.(\w)\.?/gu, "$1$2").replace(/\s+v\.?\s+/giu, " v ")
    .replace(/[-‐-―/]+/gu, " ").replace(/[^\p{L}\p{N}_\s]/gu, "")
    .split(/\s+/u).filter(Boolean).join(" ").toLowerCase();
}

/** A Parquet value as the store keeps it: text as given, times as A2AJ's API gives them, lists as JSON. */
function stored(value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.trim() ? text : null;
}

function documentOf(kind: A2AJKind, court: string, record: Record<string, unknown>): Document {
  const field = (name: string, language?: "en" | "fr") => stored(record[language ? `${name}_${language}` : name]);
  const document = { doc_type: kind, dataset: court, citing_cases_count: field("citing_cases_count"),
    upstream_license: field("upstream_license") } as Document;
  for (const language of ["en", "fr"] as const) {
    for (const name of ["citation", "citation2", "name", "document_date", "unofficial_text", "unofficial_sections",
      "cases_cited", "cases_citing"]) document[`${name}_${language}` as keyof Document] = field(name, language);
    document[`url_${language}`] = field("source_url", language) ?? field("url", language);
  }
  return document;
}

/** Where each data page of a column chunk starts, read from the page headers: A2AJ's files have one
 *  row group and no page index, so this is what lets a window of rows read only its own pages. */
async function columnPages(file: AsyncBuffer, start: number, end: number) {
  type Header = { field_1: number; field_3: number; field_5?: { field_1: number }; field_8?: { field_3: number } };
  const pages: Array<{ offset: bigint; compressed_page_size: number; first_row_index: bigint }> = [];
  let offset = start, row = 0;
  while (offset < end) {
    let header: Header | undefined, length = 0;
    // A header carries the page's statistics, so its length is not known before reading it.
    for (let span = 16 * 1024; !header; span *= 8) {
      const reader = { view: new DataView(await file.slice(offset, Math.min(offset + span, end))), offset: 0 };
      try { header = deserializeTCompactProtocol(reader) as unknown as Header; length = reader.offset; }
      catch (error) { if (offset + span >= end) throw error; }
    }
    // Type 2 is the dictionary page, which the reader finds from the column's own metadata.
    if (header.field_1 !== 2) pages.push({ offset: BigInt(offset), compressed_page_size: length + header.field_3, first_row_index: BigInt(row) });
    if (header.field_1 !== 2) row += header.field_5?.field_1 ?? header.field_8?.field_3 ?? 0;
    offset += length + header.field_3;
  }
  return pages;
}

/** The file's rows, a window at a time: each window is the rows of one page of the file's largest
 *  column, so memory holds a page or two of judgments, not the court. */
async function* parquetWindows(filename: string) {
  const handle = await open(filename, "r");
  try {
    const size = (await handle.stat()).size;
    const file: AsyncBuffer = { byteLength: size, async slice(start, end = size) {
      const bytes = new Uint8Array(end - start);
      await handle.read(bytes, 0, bytes.length, start);
      return bytes.buffer;
    } };
    const metadata: FileMetaData = await parquetMetadataAsync(file);
    const chunks = metadata.row_groups.length === 1 ? metadata.row_groups[0].columns.flatMap(({ meta_data: meta }) =>
      meta && meta.path_in_schema.length === 1 ? [meta] : []) : [];
    if (!chunks.length) throw new Error(`${path.basename(filename)} is not laid out as A2AJ's corpus files are.`);
    const pages = Object.fromEntries(await Promise.all(chunks.map(async (meta) => {
      const start = Number(meta.dictionary_page_offset || meta.data_page_offset);
      return [meta.path_in_schema[0], await columnPages(file, start, start + Number(meta.total_compressed_size))] as const;
    })));
    const largest = chunks.reduce((left, right) => Number(right.total_compressed_size) > Number(left.total_compressed_size) ? right : left);
    const starts = pages[largest.path_in_schema[0]].map((page) => Number(page.first_row_index));
    const rows = Number(metadata.num_rows);
    for (let index = 0; index < starts.length; index++) {
      const rowStart = starts[index], rowEnd = starts[index + 1] ?? rows;
      yield await parquetReadObjects({ file, metadata, rowStart, rowEnd,
        pageLocationsByGroup: [pages] } as Parameters<typeof parquetReadObjects>[0]) as Array<Record<string, unknown>>;
    }
  } finally { await handle.close(); }
}

function openStore(store: string) {
  const database = new DatabaseSync(store);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-262144; ${SCHEMA}`);
  database.prepare("INSERT OR IGNORE INTO meta VALUES ('schema_version', '3')").run();
  return database;
}

const ftsValues = (row: Record<string, unknown>) => SEARCHED.map((column) => row[column] as Value);
const citationKeys = (rows: Array<Record<string, unknown>>) => structureNative().citationLookupKeys(rows.flatMap((row) =>
  [row.citation_en, row.citation_fr, row.citation2_en, row.citation2_fr].map((value) => typeof value === "string" ? value : "")));

/** The version of Beaver's citation lookup keys ("3" in "3:neutral:2016:scc:29"): lookups find a
 *  document only through keys of the version the engine makes. */
export const a2ajCitationKeyVersion = () => structureNative().citationLookupKey("2016 SCC 29").split(":")[0];

/** Rebuilds every document's citation lookup keys when the store's were made by another key version. */
function rekey(database: DatabaseSync) {
  const version = a2ajCitationKeyVersion();
  const stored = database.prepare("SELECT value FROM meta WHERE key = 'citation_key_version'").get() as { value: string } | undefined;
  if (stored?.value === version) return;
  const page = database.prepare("SELECT id, citation_en, citation_fr, citation2_en, citation2_fr FROM document WHERE id > ? ORDER BY id LIMIT 5000");
  const add = database.prepare("INSERT OR IGNORE INTO citation_lookup VALUES (?, ?)");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM citation_lookup");
    for (let last = 0, rows = page.all(0) as Array<Record<string, unknown>>; rows.length; rows = page.all(last) as Array<Record<string, unknown>>) {
      const keys = citationKeys(rows);
      rows.forEach((row, index) => { for (const key of new Set(keys.slice(index * 4, index * 4 + 4))) if (key) add.run(key, Number(row.id)); });
      last = Number(rows.at(-1)!.id);
    }
    database.prepare("INSERT OR REPLACE INTO meta VALUES ('citation_key_version', ?)").run(version);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Replaces one court's documents with a file's: documents with the same citations keep their ids,
 *  unchanged ones are not rewritten, documents the file no longer has are removed. One transaction. */
async function importCourt(database: DatabaseSync, filename: string, kind: A2AJKind, court: string,
  report: (documents: number) => void, signal?: AbortSignal) {
  const identity = (row: Record<string, unknown>) => JSON.stringify([row.citation_en, row.citation_fr, row.citation2_en, row.citation2_fr]);
  const existing = new Map<string, number[]>();
  for (const row of database.prepare("SELECT id, citation_en, citation_fr, citation2_en, citation2_fr FROM document WHERE doc_type = ? AND dataset = ? ORDER BY id")
    .all(kind, court) as Record<string, unknown>[]) {
    const key = identity(row);
    existing.set(key, [...existing.get(key) ?? [], Number(row.id)]);
  }
  const marks = SEARCHED.map(() => "?").join(", ");
  const ftsDelete = database.prepare(`INSERT INTO document_search(document_search, rowid, ${SEARCHED.join(", ")}) VALUES ('delete', ?, ${marks})`);
  const ftsInsert = database.prepare(`INSERT INTO document_search(rowid, ${SEARCHED.join(", ")}) VALUES (?, ${marks})`);
  const select = database.prepare(`SELECT ${COLUMNS.join(", ")} FROM document WHERE id = ?`);
  const insert = database.prepare(`INSERT INTO document (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`);
  const update = database.prepare(`UPDATE document SET ${COLUMNS.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`);
  const remove = database.prepare("DELETE FROM document WHERE id = ?");
  const citationRow = database.prepare("INSERT OR IGNORE INTO citation_lookup VALUES (?, ?)");
  const nameRow = database.prepare("INSERT OR IGNORE INTO name_lookup VALUES (?, ?)");
  const kept = new Set<number>();
  let documents = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM citation_lookup WHERE document_id IN (SELECT id FROM document WHERE doc_type = ? AND dataset = ?)").run(kind, court);
    database.prepare("DELETE FROM name_lookup WHERE document_id IN (SELECT id FROM document WHERE doc_type = ? AND dataset = ?)").run(kind, court);
    for await (const records of parquetWindows(filename)) {
      signal?.throwIfAborted();
      const rows = records.map((record) => documentOf(kind, court, record));
      const keys = citationKeys(rows);
      rows.forEach((row, index) => {
        const citations = [...new Set(keys.slice(index * 4, index * 4 + 4).filter(Boolean))];
        // A document without a citation cannot be looked up, as the former importer skipped it.
        if (!citations.length) return;
        const values = COLUMNS.map((column) => row[column]);
        const claimed = existing.get(identity(row))?.shift();
        let id = claimed;
        if (id === undefined) {
          id = Number(insert.run(...values).lastInsertRowid);
          ftsInsert.run(id, ...ftsValues(row));
        } else {
          const before = select.get(id) as Record<string, unknown>;
          if (COLUMNS.some((column) => before[column] !== row[column])) {
            ftsDelete.run(id, ...ftsValues(before));
            update.run(...values, id);
            ftsInsert.run(id, ...ftsValues(row));
          }
        }
        kept.add(id);
        for (const key of citations) citationRow.run(key, id);
        for (const name of new Set([row.name_en, row.name_fr].flatMap((value) => typeof value === "string" ? [a2ajNameKey(value)] : [])))
          if (name) nameRow.run(name, id);
        documents++;
      });
      report(documents);
    }
    for (const ids of existing.values()) for (const id of ids) {
      if (kept.has(id)) continue;
      ftsDelete.run(id, ...ftsValues(select.get(id) as Record<string, unknown>));
      remove.run(id);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return documents;
}

function removeCourt(database: DatabaseSync, kind: A2AJKind, court: string) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`INSERT INTO document_search(document_search, rowid, ${SEARCHED.join(", ")})
      SELECT 'delete', id, ${SEARCHED.join(", ")} FROM document WHERE doc_type = ? AND dataset = ?`).run(kind, court);
    for (const table of ["citation_lookup", "name_lookup"])
      database.prepare(`DELETE FROM ${table} WHERE document_id IN (SELECT id FROM document WHERE doc_type = ? AND dataset = ?)`).run(kind, court);
    database.prepare("DELETE FROM document WHERE doc_type = ? AND dataset = ?").run(kind, court);
    database.prepare("DELETE FROM source_file WHERE doc_type = ? AND dataset = ?").run(kind, court);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Makes these courts ("cases/SCC", "laws/LEGISLATION-FED") current in the store from the snapshots,
 * and removes the courts in `remove`. Each court is committed on its own, so stopping keeps every court
 * finished so far, and installing again resumes a court's download where it stopped.
 */
export async function installA2AJCourts(snapshots: Partial<Record<A2AJKind, A2AJSnapshot>>, courts: Iterable<string>,
  options: { remove?: Iterable<string>; store?: string; signal?: AbortSignal;
    progress?: (progress: A2AJInstallProgress) => void } = {}) {
  const store = options.store ?? a2ajLocalBulkPath(), wanted = new Set(courts), removing = new Set(options.remove ?? []);
  await mkdir(path.dirname(store), { recursive: true });
  const status = await a2ajStoreStatus(snapshots, store);
  const toDownload = a2ajBytesToDownload(status, wanted);
  let downloaded = 0;
  const database = openStore(store);
  try {
    rekey(database);
    for (const court of status) {
      const key = `${court.kind}/${court.court}`;
      if (!removing.has(key) || wanted.has(key) || !court.installed) continue;
      removeCourt(database, court.kind, court.court);
      options.progress?.({ kind: court.kind, court: court.court, phase: "removed", downloaded, toDownload, documents: 0 });
    }
    for (const court of status) {
      options.signal?.throwIfAborted();
      const snapshot = snapshots[court.kind], file = court.remote;
      if (!wanted.has(`${court.kind}/${court.court}`) || !snapshot || !file || court.installed?.sha256 === file.sha256) continue;
      const report = (phase: A2AJInstallProgress["phase"], documents = 0) =>
        options.progress?.({ kind: court.kind, court: court.court, phase, downloaded, toDownload, documents });
      report("download");
      const filename = await fetchFile(store, snapshot, file, { signal: options.signal,
        fetched: (bytes) => { downloaded += bytes; report("download"); } });
      const documents = await importCourt(database, filename, court.kind, court.court, (count) => report("import", count), options.signal);
      database.prepare("INSERT OR REPLACE INTO source_file VALUES (?, ?, ?, ?, ?, ?, ?)").run(court.kind, court.court,
        file.path, file.sha256, file.size, snapshot.revision, new Date().toISOString());
      await rm(filename, { force: true });
      report("installed", documents);
    }
    const count = (sql: string) => String((database.prepare(sql).get() as { n: number }).n);
    const meta = database.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)");
    meta.run("fts", "true");
    meta.run("document_count", count("SELECT COUNT(*) AS n FROM document"));
    meta.run("citation_count", count("SELECT COUNT(*) AS n FROM citation_lookup"));
    meta.run("name_count", count("SELECT COUNT(*) AS n FROM name_lookup"));
    meta.run("imported_at", new Date().toISOString());
    // The per-court source_file table records what each court was installed from.
    database.prepare("DELETE FROM meta WHERE key IN ('source_revisions', 'consolidated_snapshots', 'file_count', 'skipped_count')").run();
  } finally {
    // An empty log lets a page read the store without SQLite's shared memory.
    try { database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { database.close(); }
  }
  await rm(downloads(store), { recursive: true, force: true }).catch(() => undefined);
}
