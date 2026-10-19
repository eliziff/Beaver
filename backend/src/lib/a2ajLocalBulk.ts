import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { A2AJDocument, A2AJSearchResult } from "./legalSources/a2aj";
import { structureNative } from "./structureNative";
import { boundedSize, sqliteText as string } from "./sqliteSearch";
import { hasSearchOperators, searchFts5 } from "./searchQuery";
import { legalProviderDatabase, storeExists, withSearchReadonlySqlite,
  withReadonlySqlite } from "./legalDataPath";

type Row = Record<string, unknown>;
type Language = "en" | "fr";
type DocType = "cases" | "laws";

// Beaver's one local A2AJ store: a2aj.sqlite, installed and updated by a2ajInstall.ts. The engine finds and reads its
// documents and citation aliases (structureNative's a2ajDocument); searches and the installer's inventory read it here
// with node:sqlite, and a browser runtime reads a store file the user picked through the same API.
let chosenStore: string | null = null;
/** Reads the store at this path instead of the configured one; null returns to the configured one. */
export function useA2AJStore(filename: string | null) { chosenStore = filename; }

export function a2ajLocalBulkPath() {
  if (chosenStore) return chosenStore;
  const configured = process.env.MIKE_A2AJ_BULK_DB?.trim();
  return configured ? path.resolve(configured) : legalProviderDatabase("a2aj", "a2aj.sqlite");
}

function withDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  return withReadonlySqlite(a2ajLocalBulkPath(), operation);
}

export type A2AJStoreCourt = { docType: DocType; court: string; documents: number;
  /** The Parquet file the court was installed from, when the installer recorded it. */
  sha256: string | null; size: number | null; revision: string | null };
/** Every court and jurisdiction in the store, with how many documents each has. */
export function a2ajStoreCourts(filename = a2ajLocalBulkPath()): A2AJStoreCourt[] | null {
  return withReadonlySqlite(filename, (database) => {
    const recorded = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'source_file'").get()
      ? database.prepare("SELECT doc_type, dataset, sha256, size, revision FROM source_file").all() as Row[] : [];
    const files = new Map(recorded.map((row) => [`${row.doc_type}/${row.dataset}`, row]));
    return (database.prepare("SELECT doc_type, dataset, COUNT(*) AS documents FROM document GROUP BY doc_type, dataset")
      .all() as Row[]).map((row) => {
      const file = files.get(`${row.doc_type}/${row.dataset}`);
      return { docType: row.doc_type === "laws" ? "laws" : "cases", court: String(row.dataset), documents: Number(row.documents),
        sha256: file ? String(file.sha256) : null, size: file ? Number(file.size) : null,
        revision: file ? String(file.revision) : null };
    });
  });
}

export type CitationAliasGroup = { keys: string[]; forms: string[]; ambiguous: boolean };

/** Exact aliases and their authored forms from the installed provider inventory. */
export function a2ajCitationAliasGroups(citations: string[]): CitationAliasGroup[] | null {
  const store = a2ajLocalBulkPath();
  return storeExists(store) ? structureNative().a2ajAliasGroups(store, citations) : null;
}

function withSearchDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  return withSearchReadonlySqlite(a2ajLocalBulkPath(), operation);
}

function languageField(row: Row, field: string, language: Language) {
  return string(row, `${field}_${language}`) ??
    string(row, `${field}_${language === "en" ? "fr" : "en"}`);
}

function sectionMap(row: Row, language: Language) {
  const value = languageField(row, "unofficial_sections", language);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const entries = Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return entries.length ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}

function documentMetadata(row: Row, language: Language) {
  const citation = languageField(row, "citation", language) ??
    languageField(row, "citation2", language);
  if (!citation) return null;
  return {
    dataset: string(row, "dataset") ?? "",
    citation,
    alternateCitation: languageField(row, "citation2", language),
    name: languageField(row, "name", language),
    date: languageField(row, "document_date", language)?.slice(0, 10) ?? null,
    url: languageField(row, "url", language),
  };
}

function a2ajDocumentFromRow(row: Row, language: Language,
  maxChars: number): A2AJDocument | null {
  const actualLanguage = string(row, `unofficial_text_${language}`)
    ? language : language === "en" ? "fr" : "en";
  const text = languageField(row, "unofficial_text", actualLanguage);
  const metadata = documentMetadata(row, actualLanguage);
  if (!text || !metadata) return null;
  return {
    ...metadata,
    publisherUrl: metadata.url,
    docType: string(row, "doc_type") === "laws" ? "laws" : "cases",
    verifiedPdf: null,
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    language: actualLanguage,
    upstreamLicense: string(row, "upstream_license"),
    sectionMap: sectionMap(row, actualLanguage) ?? undefined,
  };
}

/**
 * Batched rowid fetch for samplers that already hold document ids. Keeps one
 * connection for the whole set; per-call fetches open and close the bulk
 * database each time.
 */
export function fetchLocalA2AJDocumentsByIds(args: {
  ids: readonly number[]; docType?: DocType; language?: Language; maxChars?: number;
}): Map<number, A2AJDocument> {
  const ids = args.ids.filter((id) => Number.isSafeInteger(id) && id >= 1);
  const out = new Map<number, A2AJDocument>();
  if (!ids.length) return out;
  const maxChars = boundedSize(args.maxChars, 50_000, Number.MAX_SAFE_INTEGER);
  const docType = args.docType ?? "cases";
  const language = args.language === "fr" ? "fr" : "en";
  withDatabase((database) => {
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500);
      const marks = chunk.map(() => "?").join(",");
      const rows = new Map((database.prepare(
        `SELECT id, doc_type, dataset,
                citation_en, citation_fr, citation2_en, citation2_fr,
                name_en, name_fr, document_date_en, document_date_fr,
                url_en, url_fr, unofficial_text_en, unofficial_text_fr,
                unofficial_sections_en, unofficial_sections_fr, upstream_license
         FROM document
         WHERE document.id IN (${marks}) AND document.doc_type = ?`,
      ).all(...chunk, docType) as Row[]).map((row) => [Number(row.id), row]));
      for (const id of chunk) {
        const row = rows.get(id);
        const result = row ? a2ajDocumentFromRow(row, language, maxChars) : null;
        if (result) out.set(id, result);
      }
    }
  });
  return out;
}

function addDatasetFilter(filters: string[], values: Array<string | number>,
  value?: string) {
  const datasets = [...new Set((value ?? "").split(",")
    .map((dataset) => dataset.trim()).filter(Boolean))].slice(0, 50);
  if (!datasets.length) return;
  filters.push(`LOWER(document.dataset) IN (${datasets.map(() => "LOWER(?)").join(", ")})`);
  values.push(...datasets);
}

/** What names a source, as CanLII's second search box reads: its name and its citations ("Hryniak v Mauldin 2014 SCC
 *  7" names a case by both). */
const NAME_COLUMNS = ["name_en", "name_fr", "citation_en", "citation_fr", "citation2_en", "citation2_fr"];

function hasFts(database: DatabaseSync) {
  return !!database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_search'").get();
}

/** A name as the full-text index's tokenizer (unicode61, diacritics removed) reads its words. */
const nameWords = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u)
  .filter(Boolean);
const SEARCH_COLUMNS = `document.id, document.doc_type, document.dataset,
                document.citation_en, document.citation_fr,
                document.citation2_en, document.citation2_fr,
                document.name_en, document.name_fr,
                document.document_date_en, document.document_date_fr,
                document.url_en, document.url_fr`;
const storeDatasets = new Map<string, string[]>();
/** The store's collections, read down their index one name at a time. */
function datasets(database: DatabaseSync) {
  const filename = a2ajLocalBulkPath();
  let names = storeDatasets.get(filename);
  if (!names) storeDatasets.set(filename, names = (database.prepare(`WITH RECURSIVE next(name) AS (
      SELECT MIN(dataset) FROM document UNION ALL
      SELECT (SELECT MIN(dataset) FROM document WHERE dataset > name) FROM next WHERE name IS NOT NULL)
    SELECT name FROM next WHERE name IS NOT NULL`).all() as Row[]).map((row) => String(row.name)));
  return names;
}

export function searchLocalA2AJ(args: {
  query: string; docType?: DocType; searchType?: "full_text" | "name";
  language?: Language; size?: number; dataset?: string;
  startDate?: string; endDate?: string;
  sortResults?: "default" | "newest_first" | "oldest_first";
  /** False: the results are wanted in any order. */
  ordered?: boolean;
}): A2AJSearchResult[] | null {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  if (!/[\p{L}\p{N}]/u.test(query)) return [];
  const language = args.language === "fr" ? "fr" : "en";
  const wanted = boundedSize(args.size, 10, 50);
  const docType = args.docType ?? "cases";
  return withSearchDatabase((database) => {
    if (!hasFts(database)) return null;
    const filters = ["document.doc_type = ?"];
    const values: Array<string | number> = [docType];
    addDatasetFilter(filters, values, args.dataset);
    const date = `substr(COALESCE(NULLIF(document.document_date_${language}, ''), document.document_date_${
      language === "en" ? "fr" : "en"}, ''), 1, 10)`;
    if (args.startDate?.trim()) {
      filters.push(`${date} >= ?`);
      values.push(args.startDate.trim());
    }
    if (args.endDate?.trim()) {
      filters.push(`${date} <= ?`);
      values.push(args.endDate.trim());
    }
    // A name search in named collections, wanted in any order, reads those collections' names: the index's lists for
    // a common word ("of", "and") run through every document's text. Where more names match than are wanted, the
    // index chooses which.
    const words = nameWords(query);
    if (args.ordered === false && args.searchType === "name" && args.dataset?.trim() && !hasSearchOperators(query)) {
      const asked = new Set(args.dataset.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
      const names = datasets(database).filter((name) => asked.has(name.toLowerCase()));
      const rows = names.length ? (database.prepare(`SELECT ${SEARCH_COLUMNS} FROM document
        WHERE document.dataset IN (${names.map(() => "?").join(", ")}) AND ${filters.join(" AND ")}`)
        .all(...names, ...values) as Row[]).filter((row) => {
        const held = new Set(["name_en", "name_fr", "citation_en", "citation_fr", "citation2_en", "citation2_fr"]
          .flatMap((column) => nameWords(string(row, column) ?? "")));
        return words.every((word) => held.has(word));
      }) : [];
      if (rows.length <= wanted) return rows.flatMap((row) => {
        const metadata = documentMetadata(row, language);
        return metadata ? [{ ...metadata, snippet: null }] : [];
      });
    }
    const order = args.sortResults === "newest_first" ? `${date} DESC, document.id`
      : args.sortResults === "oldest_first" ? `${date} ASC, document.id` : "rank";
    const matching = (columns?: readonly string[]) => database.prepare(
      `SELECT ${SEARCH_COLUMNS}
       FROM document_search JOIN document ON document.id = document_search.rowid
       WHERE document_search MATCH ? AND ${filters.join(" AND ")}
       ORDER BY ${order}
       LIMIT ?`).all(searchFts5(query, columns), ...values, wanted) as Row[];
    // Ranked by relevance, the sources a query names (by name or citation) come before those whose text holds it, as
    // a search engine ranks a title match first: "Hryniak v Mauldin" or "2014 SCC 7" finds that case, not its citers.
    const named = args.searchType === "name" || order === "rank" ? matching(NAME_COLUMNS) : [];
    const rows = args.searchType === "name" ? named
      : [...new Map([...named, ...matching()].map((row) => [row.id, row])).values()].slice(0, wanted);
    return rows
      .flatMap((row) => {
        const metadata = documentMetadata(row, language);
        // The search projection deliberately excludes full text.
        return metadata ? [{ ...metadata, snippet: null }] : [];
      });
  });
}
