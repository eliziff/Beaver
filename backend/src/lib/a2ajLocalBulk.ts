import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { A2AJDocument, A2AJSearchResult } from "./a2aj";
import { citationLookupKey } from "./citationKey";
import {
  legalProviderDatabase,
  withReadonlySqlite,
} from "./legalDataPath";
import type { SourceDoc } from "./sourceDoc";
import {
  compileA2AJSourceDoc,
  summarizeA2AJSourceDoc,
} from "./sourceDocA2AJ";

type Row = Record<string, unknown>;
type Language = "en" | "fr";
type DocType = "cases" | "laws";

const documentStructures = new WeakMap<A2AJDocument, SourceDoc>();
const documentSectionMaps = new WeakMap<
  A2AJDocument,
  Record<string, string>
>();

export function a2ajLocalBulkPath() {
  const configured = process.env.MIKE_A2AJ_BULK_DB?.trim();
  if (configured) return path.resolve(configured);
  return legalProviderDatabase("a2aj", "a2aj.sqlite");
}

function withDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  return withReadonlySqlite(a2ajLocalBulkPath(), operation);
}

function searchDatabasePath(docType: DocType) {
  const primary = a2ajLocalBulkPath();
  const indexed = path.join(
    path.dirname(primary),
    `a2aj-${docType}-fulltext.sqlite`,
  );
  return existsSync(indexed) ? indexed : primary;
}

let searchConnection:
  | { filename: string; database: DatabaseSync }
  | undefined;

function withSearchDatabase<T>(
  docType: DocType,
  operation: (database: DatabaseSync) => T,
): T | null {
  const filename = searchDatabasePath(docType);
  if (process.env.MIKE_A2AJ_BULK_DB?.trim()) {
    return withReadonlySqlite(filename, operation);
  }
  if (!existsSync(filename)) return null;
  if (searchConnection?.filename !== filename) {
    searchConnection?.database.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filename, { readOnly: true });
    database.exec(
      "PRAGMA query_only=ON; PRAGMA mmap_size=2147418112; PRAGMA cache_size=-131072",
    );
    searchConnection = { filename, database };
  }
  return operation(searchConnection.database);
}

export function warmLocalA2AJSearch() {
  return withSearchDatabase("cases", hasFts) ?? false;
}

function string(row: Row, field: string) {
  const value = row[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function languageField(
  row: Row,
  field: string,
  language: Language,
  fallback = true,
) {
  return (
    string(row, `${field}_${language}`) ??
    (fallback
      ? string(row, `${field}_${language === "en" ? "fr" : "en"}`)
      : null)
  );
}

const citationKey = citationLookupKey;

function sectionMap(row: Row, language: Language) {
  const value = languageField(row, "unofficial_sections", language);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return entries.length ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}

function document(row: Row, language: Language): A2AJDocument | null {
  const requestedText = languageField(row, "unofficial_text", language, false);
  const actualLanguage = requestedText
    ? language
    : language === "en"
      ? "fr"
      : "en";
  const text = languageField(row, "unofficial_text", actualLanguage);
  const citation =
    languageField(row, "citation", actualLanguage) ??
    languageField(row, "citation2", actualLanguage);
  if (!text || !citation) return null;
  const docType = string(row, "doc_type") === "laws" ? "laws" : "cases";
  const mappedSections = sectionMap(row, actualLanguage);
  const compiled = compileA2AJSourceDoc({
    citation,
    docType,
    text,
    url: languageField(row, "url", actualLanguage),
    alternateCitation: languageField(row, "citation2", actualLanguage),
    dataset: string(row, "dataset"),
    name: languageField(row, "name", actualLanguage),
  });
  const document: A2AJDocument = {
    docType,
    dataset: string(row, "dataset") ?? "",
    citation,
    alternateCitation: languageField(row, "citation2", actualLanguage),
    name: languageField(row, "name", actualLanguage),
    date: languageField(row, "document_date", actualLanguage),
    url: languageField(row, "url", actualLanguage),
    text,
    language: actualLanguage,
    upstreamLicense: string(row, "upstream_license"),
    structure: summarizeA2AJSourceDoc(compiled),
  };
  documentStructures.set(document, compiled);
  if (mappedSections) documentSectionMaps.set(document, mappedSections);
  return document;
}

export function getLocalA2AJStructure(document: A2AJDocument) {
  return documentStructures.get(document) ?? null;
}

/**
 * Rowid fetch for samplers that already hold document ids. `document.id` is
 * the primary key, so this is an index lookup where
 * `fetchLocalA2AJDocument` must resolve the citation key first.
 */
export function fetchLocalA2AJDocumentById(args: {
  id: number;
  docType?: DocType;
  language?: Language;
  maxChars?: number;
}): A2AJDocument | null {
  if (!Number.isSafeInteger(args.id) || args.id < 1) return null;
  return withDatabase((database) => {
    const row = database
      .prepare(
        `SELECT document.*
         FROM document
         WHERE document.id = ? AND document.doc_type = ?`,
      )
      .get(args.id, args.docType ?? "cases") as Row | undefined;
    const result = row
      ? document(row, args.language === "fr" ? "fr" : "en")
      : null;
    if (!result) return null;
    const maxChars = boundedSize(
      args.maxChars,
      50_000,
      Number.MAX_SAFE_INTEGER,
    );
    if (result.text.length > maxChars) {
      result.text = result.text.slice(0, maxChars);
    }
    return result;
  });
}

/**
 * Batched rowid fetch for samplers that already hold document ids. Keeps one
 * connection for the whole set; per-call fetches open and close the bulk
 * database each time.
 */
export function fetchLocalA2AJDocumentsByIds(args: {
  ids: readonly number[];
  docType?: DocType;
  language?: Language;
  maxChars?: number;
}): Map<number, A2AJDocument> {
  const ids = args.ids.filter((id) => Number.isSafeInteger(id) && id >= 1);
  const out = new Map<number, A2AJDocument>();
  if (!ids.length) return out;
  const maxChars = boundedSize(
    args.maxChars,
    50_000,
    Number.MAX_SAFE_INTEGER,
  );
  const docType = args.docType ?? "cases";
  const language = args.language === "fr" ? "fr" : "en";
  withDatabase((database) => {
    const statement = database.prepare(
      `SELECT document.*
       FROM document
       WHERE document.id = ? AND document.doc_type = ?`,
    );
    for (const id of ids) {
      const row = statement.get(id, docType) as Row | undefined;
      const result = row ? document(row, language) : null;
      if (!result) continue;
      if (result.text.length > maxChars) {
        result.text = result.text.slice(0, maxChars);
      }
      out.set(id, result);
    }
  });
  return out;
}

export function getLocalA2AJSectionMap(document: A2AJDocument) {
  return documentSectionMaps.get(document) ?? null;
}

function boundedSize(
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  return Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
}

function addDatasetFilter(
  filters: string[],
  values: Array<string | number>,
  value?: string,
) {
  const datasets = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((dataset) => dataset.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);
  if (!datasets.length) return;
  filters.push(
    `LOWER(document.dataset) IN (${datasets.map(() => "LOWER(?)").join(", ")})`,
  );
  values.push(...datasets);
}

export function fetchLocalA2AJDocument(args: {
  citation: string;
  docType?: DocType;
  language?: Language;
  dataset?: string;
  maxChars?: number;
}): A2AJDocument | null {
  const citation = args.citation.trim();
  if (!citation) throw new Error("citation is required");
  const key = citationKey(citation);
  if (!key) return null;
  return withDatabase((database) => {
    const filters = ["lookup.citation_key = ?", "document.doc_type = ?"];
    const values: Array<string | number> = [key, args.docType ?? "cases"];
    addDatasetFilter(filters, values, args.dataset);
    const row = database
      .prepare(
        `SELECT document.*
         FROM citation_lookup AS lookup
         JOIN document ON document.id = lookup.document_id
         WHERE ${filters.join(" AND ")}
         ORDER BY document.id
         LIMIT 1`,
      )
      .get(...values) as Row | undefined;
    const result = row
      ? document(row, args.language === "fr" ? "fr" : "en")
      : null;
    if (!result) return null;
    const maxChars = boundedSize(
      args.maxChars,
      50_000,
      Number.MAX_SAFE_INTEGER,
    );
    if (result.text.length > maxChars) {
      result.text = result.text.slice(0, maxChars);
    }
    return result;
  });
}

function searchTokens(query: string) {
  return query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
}

function ftsQuery(tokens: string[], searchType: "full_text" | "name") {
  const fields = searchType === "name" ? "{name_en name_fr} : " : "";
  return tokens.map((token) => `${fields}"${token}"`).join(" AND ");
}

function hasFts(database: DatabaseSync) {
  return !!database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_search'",
    )
    .get();
}

function dateExpression(language: Language) {
  const fallback = language === "en" ? "fr" : "en";
  return `COALESCE(NULLIF(document.document_date_${language}, ''), document.document_date_${fallback}, '')`;
}

function snippet(text: string | null, tokens: string[]) {
  if (!text) return null;
  const lower = text.toLocaleLowerCase();
  const position = tokens
    .map((token) => lower.indexOf(token.toLocaleLowerCase()))
    .find((index) => index >= 0);
  const start = Math.max(0, (position ?? 0) - 200);
  return text.slice(start, start + 1_200);
}

function searchResult(
  row: Row,
  language: Language,
  tokens: string[],
): A2AJSearchResult | null {
  const citation =
    languageField(row, "citation", language) ??
    languageField(row, "citation2", language);
  if (!citation) return null;
  return {
    dataset: string(row, "dataset") ?? "",
    citation,
    alternateCitation: languageField(row, "citation2", language),
    name: languageField(row, "name", language),
    date: languageField(row, "document_date", language),
    url: languageField(row, "url", language),
    snippet: snippet(languageField(row, "unofficial_text", language), tokens),
  };
}

export function searchLocalA2AJ(args: {
  query: string;
  docType?: DocType;
  searchType?: "full_text" | "name";
  language?: Language;
  size?: number;
  dataset?: string;
  startDate?: string;
  endDate?: string;
  sortResults?: "default" | "newest_first" | "oldest_first";
  querySyntax?: "terms" | "fts5";
}): A2AJSearchResult[] | null {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const language = args.language === "fr" ? "fr" : "en";
  const wanted = boundedSize(args.size, 10, 50);
  const docType = args.docType ?? "cases";
  const dedicatedIndex =
    path.basename(searchDatabasePath(docType)) ===
    `a2aj-${docType}-fulltext.sqlite`;
  return withSearchDatabase(docType, (database) => {
    const fts = hasFts(database);
    const filters = dedicatedIndex ? [] : ["document.doc_type = ?"];
    const values: Array<string | number> = dedicatedIndex ? [] : [docType];
    addDatasetFilter(filters, values, args.dataset);
    const date = dateExpression(language);
    if (args.startDate?.trim()) {
      filters.push(`${date} >= ?`);
      values.push(args.startDate.trim());
    }
    if (args.endDate?.trim()) {
      filters.push(`${date} <= ?`);
      values.push(args.endDate.trim());
    }
    let from = "document";
    if (fts) {
      from =
        "document_search JOIN document ON document.id = document_search.rowid";
      filters.unshift("document_search MATCH ?");
      values.unshift(
        args.querySyntax === "fts5"
          ? query
          : ftsQuery(tokens, args.searchType ?? "full_text"),
      );
    } else {
      if (args.querySyntax === "fts5") {
        throw new Error("Local A2AJ full-text index is unavailable");
      }
      return null;
    }
    const order =
      args.sortResults === "newest_first"
        ? `${date} DESC, document.id`
        : args.sortResults === "oldest_first"
          ? `${date} ASC, document.id`
          : fts
            ? "rank"
            : `${date} DESC, document.id`;
    values.push(wanted);
    return database
      .prepare(
        `SELECT document.id, document.doc_type, document.dataset,
                document.citation_en, document.citation_fr,
                document.citation2_en, document.citation2_fr,
                document.name_en, document.name_fr,
                document.document_date_en, document.document_date_fr,
                document.url_en, document.url_fr
         FROM ${from}
         WHERE ${filters.join(" AND ")}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...values)
      .map((row) => searchResult(row as Row, language, tokens))
      .filter((row): row is A2AJSearchResult => !!row);
  });
}
