import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { A2AJDocument, A2AJSearchResult } from "./legalSources/a2aj";
import { structureNative } from "./structureNative";
import { boundedSize, searchTokens, sqliteText as string } from "./sqliteSearch";
import {
  legalProviderDatabase,
  withSearchReadonlySqlite,
  withReadonlySqlite,
} from "./legalDataPath";

type Row = Record<string, unknown>;
type Language = "en" | "fr";
type DocType = "cases" | "laws";

export function a2ajLocalBulkPath() {
  const configured = process.env.MIKE_A2AJ_BULK_DB?.trim();
  if (configured) return path.resolve(configured);
  return legalProviderDatabase("a2aj", "a2aj.sqlite");
}

function withDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  return withReadonlySqlite(a2ajLocalBulkPath(), operation);
}

export type CitationAliasGroup = { keys: string[]; forms: string[]; ambiguous: boolean };

/** Exact aliases and their authored forms from the installed provider inventory. */
export function a2ajCitationAliasGroups(citations: string[]): CitationAliasGroup[] | null {
  const keys = structureNative().citationLookupKeys(citations);
  return withDatabase((database) => {
    const targets = database.prepare("SELECT DISTINCT document_id FROM citation_lookup WHERE citation_key = ?");
    const aliases = database.prepare("SELECT citation_key FROM citation_lookup WHERE document_id = ?");
    const document = database.prepare("SELECT citation_en, citation2_en, citation_fr, citation2_fr FROM document WHERE id = ?");
    return keys.map((key) => {
      if (!key) return { keys: [], forms: [], ambiguous: false };
      const rows = targets.all(key) as Row[];
      if (rows.length !== 1) return { keys: [key], forms: [], ambiguous: rows.length > 1 };
      const id = Number(rows[0].document_id), row = document.get(id) as Row | undefined;
      return { keys: [...new Set([key, ...(aliases.all(id) as Row[]).map((row) => String(row.citation_key))])].sort(),
        forms: row ? Object.values(row).filter((value): value is string => typeof value === "string" && !!value.trim()) : [],
        ambiguous: false };
    });
  });
}

export function a2ajCitationAliasKeysBatch(citations: string[]): string[][] | null {
  return a2ajCitationAliasGroups(citations)?.map(({ keys }) => keys) ?? null;
}

function searchDatabasePath(docType: DocType) {
  const primary = a2ajLocalBulkPath();
  const indexed = path.join(
    path.dirname(primary),
    `a2aj-${docType}-fulltext.sqlite`,
  );
  return existsSync(indexed) ? indexed : primary;
}

function withSearchDatabase<T>(
  docType: DocType,
  operation: (database: DatabaseSync) => T,
): T | null {
  const filename = searchDatabasePath(docType);
  const cache = !process.env.MIKE_A2AJ_BULK_DB?.trim();
  return withSearchReadonlySqlite(filename, cache, operation);
}

function languageField(
  row: Row,
  field: string,
  language: Language,
) {
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
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
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
    date: languageField(row, "document_date", language),
    url: languageField(row, "url", language),
  };
}

function a2ajDocumentFromRow(
  row: Row, language: Language, maxChars: number,
): A2AJDocument | null {
  const requestedText = string(row, `unofficial_text_${language}`);
  const actualLanguage = requestedText
    ? language
    : language === "en"
      ? "fr"
      : "en";
  const text = languageField(row, "unofficial_text", actualLanguage);
  const metadata = documentMetadata(row, actualLanguage);
  if (!text || !metadata) return null;
  return {
    ...metadata,
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
  sourceUrl?: string;
  maxChars?: number;
}): A2AJDocument | null {
  const citation = args.citation.trim();
  if (!citation) throw new Error("citation is required");
  const key = structureNative().citationLookupKey(citation);
  if (!key) return null;
  return withDatabase((database) => {
    const filters = ["lookup.citation_key = ?", "document.doc_type = ?"];
    const values: Array<string | number> = [key, args.docType ?? "cases"];
    addDatasetFilter(filters, values, args.dataset);
    if (args.sourceUrl?.trim()) {
      filters.push("(document.url_en = ? OR document.url_fr = ?)");
      values.push(args.sourceUrl.trim(), args.sourceUrl.trim());
    }
    const rows = database
      .prepare(
        `SELECT DISTINCT document.*
         FROM citation_lookup AS lookup
         JOIN document ON document.id = lookup.document_id
         WHERE ${filters.join(" AND ")}
         ORDER BY document.id
         LIMIT 2`,
      )
      .all(...values) as Row[];
    const row = rows.length === 1 ? rows[0] : undefined;
    return row ? a2ajDocumentFromRow(row, args.language === "fr" ? "fr" : "en",
      boundedSize(args.maxChars, 50_000, Number.MAX_SAFE_INTEGER)) : null;
  });
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
    if (!hasFts(database)) return null;
    const filters = dedicatedIndex ? [] : ["document.doc_type = ?"];
    const values: Array<string | number> = dedicatedIndex ? [] : [docType];
    addDatasetFilter(filters, values, args.dataset);
    const date = `COALESCE(NULLIF(document.document_date_${language}, ''), document.document_date_${
      language === "en" ? "fr" : "en"}, '')`;
    if (args.startDate?.trim()) {
      filters.push(`${date} >= ?`);
      values.push(args.startDate.trim());
    }
    if (args.endDate?.trim()) {
      filters.push(`${date} <= ?`);
      values.push(args.endDate.trim());
    }
    filters.unshift("document_search MATCH ?");
    values.unshift(args.querySyntax === "fts5"
      ? query : ftsQuery(tokens, args.searchType ?? "full_text"));
    const order =
      args.sortResults === "newest_first"
        ? `${date} DESC, document.id`
        : args.sortResults === "oldest_first"
          ? `${date} ASC, document.id`
          : "rank";
    values.push(wanted);
    return database
      .prepare(
        `SELECT document.id, document.doc_type, document.dataset,
                document.citation_en, document.citation_fr,
                document.citation2_en, document.citation2_fr,
                document.name_en, document.name_fr,
                document.document_date_en, document.document_date_fr,
                document.url_en, document.url_fr
         FROM document_search JOIN document ON document.id = document_search.rowid
         WHERE ${filters.join(" AND ")}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...values)
      .flatMap((row) => {
        const metadata = documentMetadata(row, language);
        // The search projection deliberately excludes full text.
        return metadata ? [{ ...metadata, snippet: null }] : [];
      });
  });
}
