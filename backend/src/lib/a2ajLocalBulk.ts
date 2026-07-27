import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { A2AJDocument, A2AJSearchResult } from "./a2aj";
import { legalProviderDatabase } from "./legalDataPath";
import type { SourceDoc } from "./sourceDoc";
import {
  compileA2AJSourceDoc,
  summarizeA2AJSourceDoc,
} from "./sourceDocA2AJ";

type Row = Record<string, unknown>;
type Language = "en" | "fr";
type DocType = "cases" | "laws";

const documentStructures = new WeakMap<A2AJDocument, SourceDoc>();

function a2ajLocalBulkPath() {
  const configured = process.env.MIKE_A2AJ_BULK_DB?.trim();
  if (configured) return path.resolve(configured);
  return legalProviderDatabase("a2aj", "a2aj.sqlite");
}

function withDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  const databasePath = a2ajLocalBulkPath();
  if (!existsSync(databasePath)) return null;
  const { DatabaseSync } =
    require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return operation(database);
  } finally {
    database.close();
  }
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

function citationKey(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2013\u2014]/gu, "-")
    .replace(/(?<=\d)\.(?=\d)/gu, "dot")
    .replace(/(?<=\d)-(?=\d)/gu, "dash")
    .replace(/(?<=\d)\/(?=\d)/gu, "slash")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
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
  const compiled = compileA2AJSourceDoc({
    citation,
    docType,
    text,
    url: languageField(row, "url", actualLanguage),
    alternateCitation: languageField(row, "citation2", actualLanguage),
    dataset: string(row, "dataset"),
    name: languageField(row, "name", actualLanguage),
    sectionMap: sectionMap(row, actualLanguage),
  });
  const document: A2AJDocument = {
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
  return document;
}

export function getLocalA2AJStructure(document: A2AJDocument) {
  return documentStructures.get(document) ?? null;
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
  return tokens.map((token) => `${fields}"${token}"*`).join(" AND ");
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
}): A2AJSearchResult[] | null {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const language = args.language === "fr" ? "fr" : "en";
  const wanted = boundedSize(args.size, 10, 50);
  return withDatabase((database) => {
    const fts = hasFts(database);
    const filters = ["document.doc_type = ?"];
    const values: Array<string | number> = [args.docType ?? "cases"];
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
      values.unshift(ftsQuery(tokens, args.searchType ?? "full_text"));
    } else {
      // ponytail: this is a linear fallback; build with --fts when corpus search matters.
      const fields =
        args.searchType === "name"
          ? ["name_en", "name_fr"]
          : [
              "citation_en",
              "citation_fr",
              "citation2_en",
              "citation2_fr",
              "name_en",
              "name_fr",
              "unofficial_text_en",
              "unofficial_text_fr",
            ];
      const haystack = `LOWER(${fields
        .map((field) => `COALESCE(document.${field}, '')`)
        .join(" || ' ' || ")})`;
      for (const token of tokens) {
        filters.push(`${haystack} LIKE ?`);
        values.push(`%${token.toLocaleLowerCase()}%`);
      }
    }
    const order =
      args.sortResults === "newest_first"
        ? `${date} DESC, document.id`
        : args.sortResults === "oldest_first"
          ? `${date} ASC, document.id`
          : fts
            ? `bm25(document_search), ${date} DESC, document.id`
            : `${date} DESC, document.id`;
    values.push(wanted);
    return database
      .prepare(
        `SELECT document.* FROM ${from}
         WHERE ${filters.join(" AND ")}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...values)
      .map((row) => searchResult(row as Row, language, tokens))
      .filter((row): row is A2AJSearchResult => !!row);
  });
}
