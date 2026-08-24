import crypto from "node:crypto";
import {
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { legalProviderDatabase } from "../legalDataPath";
import { positiveInteger as integer } from "../value";
import {
  structureNative,
  type NativeDocument,
} from "../structureNative";
import type {
  LegalSourceProvider,
  LegalSourceReference,
} from ".";
import { nativeDocumentPassages } from "./nativeDocumentPassages";

type Row = Record<string, unknown>;
type FinalContractPages = { filename: string; signature: string };
type JournalPageRow = { page_label: unknown; pdf_page: unknown };

export type JournalArticleSearchResult = {
  provider: "journal";
  hitId: string;
  articleId: number;
  dataset: string;
  citation: string;
  name: string;
  date: string | null;
  url: string | null;
  snippet: string | null;
  journalName: string | null;
  authors: string | null;
};

export type JournalArticleDocument = {
  provider: "journal";
  identity: string;
  articleId: number;
  dataset: string;
  citation: string;
  title: string;
  date: string | null;
  url: string;
  native: NativeDocument;
  upstreamLicense: string | null;
  journalName: string | null;
  authors: string | null;
  language: "en";
};

const databases = new Map<
  string,
  { connection: DatabaseSync; sourceSignature: string }
>();
const searchDatabases = new Map<
  string,
  { connection: DatabaseSync; sourceSignature: string }
>();
const finalContractDatabases = new Map<
  string,
  { connection: DatabaseSync; sourceSignature: string }
>();
const documents = new Map<string, JournalArticleDocument>();
const MAX_DOCUMENT_CACHE = 16;

function string(row: Row, name: string) {
  const value = row[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function trustedUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function journalDatabasePath() {
  const configured = process.env.MIKE_PUBLIC_ENDPOINT_DB?.trim();
  if (configured) return path.resolve(configured);
  const shared = legalProviderDatabase("journals", "public_endpoint.db");
  if (existsSync(shared)) return shared;
  const search = journalSearchDatabasePath();
  if (!existsSync(search)) return shared;
  const connection = new DatabaseSync(search, { readOnly: true });
  try {
    const row = connection
      .prepare("SELECT value FROM meta WHERE key='source_path'")
      .get() as { value?: unknown } | undefined;
    const indexed = typeof row?.value === "string" ? row.value : "";
    return indexed && existsSync(indexed) ? path.resolve(indexed) : shared;
  } finally {
    connection.close();
  }
}

function journalSearchDatabasePath() {
  const configured = process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB?.trim();
  return configured
    ? path.resolve(configured)
    : legalProviderDatabase("journals", "public_endpoint-search.sqlite");
}

function database() {
  const filename = journalDatabasePath();
  if (!existsSync(filename)) {
    throw new Error(
      `Journal article database not found: ${filename}. Set MIKE_PUBLIC_ENDPOINT_DB or place public_endpoint.db in the shared journals provider directory.`,
    );
  }
  const source = statSync(filename);
  const sourceSignature = `${path.resolve(filename)}:${source.size}:${Math.trunc(source.mtimeMs)}`;
  const cached = databases.get(filename);
  if (cached?.sourceSignature === sourceSignature) return cached.connection;
  if (cached) {
    cached.connection.close();
    databases.delete(filename);
    for (const key of documents.keys()) {
      if (key.startsWith(`${filename}:`)) documents.delete(key);
    }
  }
  const connection = new DatabaseSync(filename, { readOnly: true });
  const schema = connection
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='articles'",
    )
    .get();
  if (!schema) {
    connection.close();
    throw new Error("Unsupported public_endpoint.db schema");
  }
  databases.set(filename, { connection, sourceSignature });
  return connection;
}

function searchDatabase() {
  const filename = journalSearchDatabasePath();
  if (!existsSync(filename)) return null;
  const sourcePath = path.resolve(journalDatabasePath());
  let source: ReturnType<typeof statSync>;
  try {
    source = statSync(sourcePath);
  } catch {
    return null;
  }
  const sourceSignature = `${sourcePath}:${source.size}:${Math.trunc(source.mtimeMs)}`;
  const cached = searchDatabases.get(filename);
  if (cached?.sourceSignature === sourceSignature) return cached.connection;
  if (cached) {
    cached.connection.close();
    searchDatabases.delete(filename);
  }
  const connection = new DatabaseSync(filename, { readOnly: true });
  try {
    const metadata = Object.fromEntries(
      (
        connection.prepare("SELECT key, value FROM meta").all() as Array<{
          key: string;
          value: string;
        }>
      ).map(({ key, value }) => [key, value]),
    );
    const sourceMetadata = Object.fromEntries(
      (
        database()
          .prepare("SELECT key, value FROM export_metadata")
          .all() as Array<{ key: string; value: string }>
      ).map(({ key, value }) => [key, value]),
    );
    const expectedSource = path.resolve(metadata.source_path ?? ""), actualSource = path.resolve(sourcePath);
    const matchesSource = process.platform === "win32"
      ? expectedSource.toLocaleLowerCase() === actualSource.toLocaleLowerCase() : expectedSource === actualSource;
    if (
      metadata.schema_version !== "2" ||
      metadata.source_size !== String(source.size) ||
      metadata.source_mtime_ms !== String(Math.trunc(source.mtimeMs)) ||
      !matchesSource ||
      metadata.source_schema_version !==
        (sourceMetadata.schema_version ?? "") ||
      metadata.source_created_at !== (sourceMetadata.created_at ?? "")
    ) {
      connection.close();
      return null;
    }
  } catch {
    connection.close();
    return null;
  }
  searchDatabases.set(filename, { connection, sourceSignature });
  return connection;
}

function finalContractDatabase() {
  const configured = process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB?.trim();
  const filename = configured ? path.resolve(configured)
    : legalProviderDatabase("journals", "journals.db");
  if (!existsSync(filename)) return null;
  const source = statSync(filename);
  const sourceSignature = `${path.resolve(filename)}:${source.size}:${Math.trunc(source.mtimeMs)}`;
  const cached = finalContractDatabases.get(filename);
  if (cached?.sourceSignature === sourceSignature) {
    return { connection: cached.connection, filename };
  }
  if (cached) {
    cached.connection.close();
    finalContractDatabases.delete(filename);
    documents.clear();
  }
  const connection = new DatabaseSync(filename, { readOnly: true });
  const schema = connection
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_final_contracts'",
    )
    .get();
  if (!schema) {
    connection.close();
    return null;
  }
  finalContractDatabases.set(filename, { connection, sourceSignature });
  return { connection, filename };
}

function displayCitation(row: Row) {
  const authors = (string(row, "authors") ?? "").split(/\s*;\s*/u).filter(Boolean);
  const byline = authors.length > 3 ? `${authors[0]} et al` : authors.join(" & ");
  const volume = string(row, "volume");
  const issue = string(row, "issue");
  const year = string(row, "document_date_en")?.match(/\d{4}/u)?.[0];
  return [
    `${byline}${byline ? "," : ""}`,
    `“${string(row, "name_en") ?? ""}”`,
    year ? `(${year})` : "",
    volume ? `${volume}${issue ? `:${issue}` : ""}` : "",
    string(row, "journal_abbrev"),
    string(row, "first_page"),
  ].filter(Boolean).join(" ");
}

function queryTokens(value: string) {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length > 1)
      .slice(0, 8) ?? []
  );
}

function result(row: Row, query: string): JournalArticleSearchResult {
  const articleId = integer(row.article_id)!;
  const abstract = string(row, "abstract");
  const tokens = queryTokens(query);
  const folded = abstract?.toLocaleLowerCase() ?? "";
  const position = tokens
    .map((token) => folded.indexOf(token))
    .find((index) => index >= 0);
  return {
    provider: "journal",
    hitId: `journal:${articleId}`,
    articleId,
    dataset: string(row, "dataset") ?? "",
    citation: displayCitation(row),
    name: string(row, "name_en") ?? `Article ${articleId}`,
    date: string(row, "document_date_en"),
    url: trustedUrl(string(row, "galley_url") ?? string(row, "url_en")),
    snippet: abstract
      ? abstract.slice(Math.max(0, (position ?? 0) - 120), (position ?? 0) + 880)
      : null,
    journalName: string(row, "journal_name"),
    authors: string(row, "authors"),
  };
}

function findArticles(
  query: string,
  size = 10,
  options: {
    querySyntax?: "terms" | "fts5";
    author?: string;
    journal?: string;
    startDate?: string;
    endDate?: string;
    sortResults?: "default" | "newest_first" | "oldest_first";
  } = {},
): JournalArticleSearchResult[] {
  query = query.trim();
  if (!query) throw new Error("query is required");
  const directId = query.match(/^(?:journal:)?(\d+)$/iu)?.[1];
  if (directId) {
    const row = database()
      .prepare(
        `SELECT article_id, dataset, citation_en, name_en, authors,
                document_date_en, volume, issue, first_page, journal_name,
                journal_abbrev, galley_url, url_en, abstract
         FROM articles
         WHERE article_id = ? AND text IS NOT NULL AND length(text) > 0`,
      )
      .get(Number(directId)) as Row | undefined;
    return row ? [result(row, query)] : [];
  }

  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const wanted = Math.min(Math.max(Math.trunc(size), 1), 25);
  const search = searchDatabase();
  if (search) {
    const ftsQuery =
      options.querySyntax === "fts5"
        ? query
        : tokens
            .map((token) => `"${token.replace(/"/gu, '""')}"`)
            .join(" AND ");
    const candidateLimit =
      options.author || options.journal || options.startDate || options.endDate
        ? Math.min(250, wanted * 10)
        : wanted;
    const ids = (
      search
        .prepare(
          `SELECT rowid AS article_id
           FROM article_search
           WHERE article_search MATCH ?
           ORDER BY bm25(article_search, 4.0, 1.0)
           LIMIT ?`,
        )
        .all(ftsQuery, candidateLimit) as Array<{ article_id: number }>
    ).map(({ article_id }) => article_id);
    if (!ids.length) return [];
    const rows = database()
      .prepare(
        `SELECT article_id, dataset, citation_en, name_en, authors,
                document_date_en, volume, issue, first_page, journal_name,
                journal_abbrev, galley_url, url_en, abstract
         FROM articles WHERE article_id IN (${ids.map(() => "?").join(",")})
           ${options.author ? "AND LOWER(authors) LIKE ?" : ""}
           ${options.journal ? "AND LOWER(COALESCE(journal_name, '') || ' ' || COALESCE(journal_abbrev, '')) LIKE ?" : ""}
           ${options.startDate ? "AND document_date_en >= ?" : ""}
           ${options.endDate ? "AND document_date_en <= ?" : ""}`,
      )
      .all(
        ...ids,
        ...(options.author ? [`%${options.author.toLocaleLowerCase()}%`] : []),
        ...(options.journal ? [`%${options.journal.toLocaleLowerCase()}%`] : []),
        ...(options.startDate ? [options.startDate] : []),
        ...(options.endDate ? [options.endDate] : []),
      ) as Row[];
    const byId = new Map(rows.map((row) => [integer(row.article_id), row]));
    const found = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [result(row, query)] : [];
    });
    if (options.sortResults !== "default") {
      found.sort((left, right) => {
        const missing = "\uffff";
        if (options.sortResults === "newest_first") {
          return (right.date ?? "").localeCompare(left.date ?? "");
        }
        return (left.date ?? missing).localeCompare(right.date ?? missing);
      });
    }
    return found.slice(0, wanted);
  }
  if (options.querySyntax === "fts5") {
    throw new Error("Boolean search requires the journal FTS index");
  }
  const haystack = `LOWER(
    COALESCE(name_en, '') || ' ' || COALESCE(citation_en, '') || ' ' ||
    COALESCE(authors, '') || ' ' || COALESCE(journal_name, '') || ' ' ||
    COALESCE(journal_abbrev, '')
  )`;
  const rows = database()
    .prepare(
      `SELECT article_id, dataset, citation_en, name_en, authors,
                document_date_en, volume, issue, first_page, journal_name,
              journal_abbrev, galley_url, url_en, abstract
       FROM articles
       WHERE text IS NOT NULL AND length(text) > 0
         AND ${tokens.map(() => `${haystack} LIKE ?`).join(" AND ")}
         ${options.author ? "AND LOWER(authors) LIKE ?" : ""}
         ${options.journal ? "AND LOWER(COALESCE(journal_name, '') || ' ' || COALESCE(journal_abbrev, '')) LIKE ?" : ""}
         ${options.startDate ? "AND document_date_en >= ?" : ""}
         ${options.endDate ? "AND document_date_en <= ?" : ""}
       ORDER BY ${options.sortResults === "newest_first"
         ? "document_date_en DESC, article_id"
         : options.sortResults === "oldest_first"
           ? "document_date_en ASC, article_id"
           : "CASE WHEN LOWER(name_en) = LOWER(?) THEN 0 ELSE 1 END, article_id"}
       LIMIT ?`,
    )
    .all(
      ...tokens.map((token) => `%${token}%`),
      ...(options.author ? [`%${options.author.toLocaleLowerCase()}%`] : []),
      ...(options.journal ? [`%${options.journal.toLocaleLowerCase()}%`] : []),
      ...(options.startDate ? [options.startDate] : []),
      ...(options.endDate ? [options.endDate] : []),
      ...(options.sortResults === "newest_first" || options.sortResults === "oldest_first"
        ? []
        : [query]),
      wanted,
    ) as Row[];
  return rows.map((row) => result(row, query));
}

function inside(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function registeredPages(filename: string, sourceDir: string) {
  if (
    !sourceDir ||
    path.isAbsolute(sourceDir) ||
    /^[A-Za-z]:[\\/]/u.test(sourceDir)
  ) {
    return null;
  }
  const relative = sourceDir.replace(/[\\/]+/gu, path.sep);
  const databaseDirectory = path.dirname(filename);
  for (const base of [
    databaseDirectory,
    path.dirname(databaseDirectory),
  ]) {
    const candidate = path.resolve(base, relative, "pages.jsonl");
    if (!inside(base, candidate) || !existsSync(candidate)) continue;
    try {
      const realBase = realpathSync(base);
      const realCandidate = realpathSync(candidate);
      if (inside(realBase, realCandidate) && statSync(realCandidate).isFile()) {
        return realCandidate;
      }
    } catch {
      // An unreadable registration is equivalent to no canonical package.
    }
  }
  return null;
}

function finalContractPages(articleId: number): FinalContractPages | null {
  const registered = finalContractDatabase();
  if (!registered) return null;
  const row = registered.connection
    .prepare("SELECT source_dir FROM article_final_contracts WHERE article_id = ?")
    .get(articleId) as Row | undefined;
  if (!row) return null;
  const sourceDir = string(row, "source_dir");
  const filename = sourceDir ? registeredPages(registered.filename, sourceDir) : null;
  if (!filename) return null;
  const source = statSync(filename);
  return { filename, signature: `${filename}:${source.size}:${Math.trunc(source.mtimeMs)}` };
}

function finalContractSource(
  articleId: number, url: string, pages: FinalContractPages, pageRows: JournalPageRow[],
) {
  return structureNative().deriveDocumentStructure({ kind: "journal", article_id: articleId, url,
    filename: pages.filename, page_rows: pageRows });
}

function articleRow(identifier: string) {
  const articleId = identifier.match(/^(?:journal:)?(\d+)$/iu)?.[1];
  const exactSql = articleId
    ? "article_id = ?"
    : "(LOWER(citation_en) = LOWER(?) OR LOWER(name_en) = LOWER(?))";
  const values = articleId ? [Number(articleId)] : [identifier, identifier];
  const rows = database()
    .prepare(
      `SELECT * FROM articles
       WHERE ${exactSql} AND text IS NOT NULL AND length(text) > 0
       ORDER BY article_id LIMIT 2`,
    )
    .all(...values) as Row[];
  return rows.length === 1 ? rows[0] : null;
}

async function document(
  identifier: string,
): Promise<JournalArticleDocument | null> {
  identifier = identifier.trim();
  if (!identifier) throw new Error("identifier is required");
  database();
  const row = articleRow(identifier);
  if (!row) return null;
  const articleId = integer(row.article_id)!;
  const publicText = string(row, "text");
  const url = trustedUrl(string(row, "galley_url") ?? string(row, "url_en"));
  if (!publicText || !url) return null;
  const registered = finalContractPages(articleId);
  const cacheKey = `${journalDatabasePath()}:${articleId}:${registered?.signature ?? "public"}`;
  const cached = documents.get(cacheKey);
  if (cached) return cached;
  const pageRows = database()
    .prepare(
      `SELECT CAST(page_label AS TEXT) AS page_label,
              CAST(pdf_page AS INTEGER) AS pdf_page FROM article_pages
       WHERE article_id = ? ORDER BY page_order`,
    )
    .all(articleId) as JournalPageRow[];
  const native = registered
    ? await finalContractSource(articleId, url, registered, pageRows)
    : await structureNative().deriveDocumentStructure({ kind: "journal", article_id: articleId, url,
        text: publicText, page_rows: pageRows });
  const document: JournalArticleDocument = {
    provider: "journal",
    identity: String(articleId),
    articleId,
    dataset: string(row, "dataset") ?? "",
    citation: displayCitation(row),
    title: string(row, "name_en") ?? `Article ${articleId}`,
    date: string(row, "document_date_en"),
    url,
    native,
    upstreamLicense: string(row, "upstream_license"),
    journalName: string(row, "journal_name"),
    authors: string(row, "authors"),
    language: "en",
  };
  if (documents.size >= MAX_DOCUMENT_CACHE) {
    documents.delete(documents.keys().next().value!);
  }
  documents.set(cacheKey, document);
  return document;
}

async function viewer(identifier: string) {
  const article = await document(identifier);
  if (!article) return null;
  const viewer = structureNative().legalSourceViewer(
    article.native,
    "paragraph",
  );
  const payload = {
    schemaVersion: "mike.legal-source.v1" as const,
    provider: "journal" as const,
    reference: {
      docType: "articles" as const,
      citation: article.citation,
      sourceId: article.identity,
      language: article.language,
      dataset: article.dataset || null,
    },
    metadata: {
      title: article.title,
      citation: article.citation,
      alternateCitation: null,
      date: article.date,
      dataset: article.dataset,
      url: article.url,
      language: article.language,
      upstreamLicense: article.upstreamLicense,
      authors: article.authors,
      journalName: article.journalName,
    },
    slices: viewer.slices,
    truncated: viewer.truncated,
  };
  return {
    payload,
    native: article.native,
    etag: `"${crypto
      .createHash("sha256")
      .update(JSON.stringify([
        viewer.documentRevision, payload.reference, payload.metadata,
      ]))
      .digest("base64url")}"`,
  };
}

function journalReference(document: JournalArticleDocument) {
  return {
    provider: "journal",
    id: document.identity,
    kind: "journal",
    title: document.title,
    citation: document.citation,
    date: document.date,
    collection: document.journalName ?? document.dataset,
    language: document.language,
    url: document.url,
  } satisfies LegalSourceReference;
}

function exactJournalIdentity(value: string) {
  return value
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const provider: LegalSourceProvider<{
    document: JournalArticleDocument;
  }> = {
  id: "journal",
  canResolve: ({ kind }) => kind === "journal",
  async resolve(request) {
    const candidates = [request.text, ...(request.alternateTexts ?? [])]
      .map((value) => value.trim().replace(/\s+/gu, " "))
      .filter(Boolean);
    for (const candidate of candidates) {
      const article = await document(candidate);
      if (article) return [journalReference(article)];
    }
    const matches = findArticles(candidates[0] ?? request.text, 10).filter(
      (match) =>
        candidates.some(
          (candidate) =>
            exactJournalIdentity(candidate) === exactJournalIdentity(match.citation) ||
            exactJournalIdentity(candidate) === exactJournalIdentity(match.name),
        ),
    );
    if (matches.length !== 1) return [];
    const article = await document(String(matches[0].articleId));
    return article ? [journalReference(article)] : [];
  },
  canSearch: (request) => request.kinds.includes("journal"),
  async search(request) {
    const jurisdiction = request.jurisdiction
      ?.toLocaleLowerCase()
      .replace(/[^a-z]/gu, "");
    if (
      request.court ||
      request.collection ||
      ["us", "usa", "unitedstates", "unitedstatesofamerica"].includes(
        jurisdiction ?? "",
      )
    ) {
      throw new Error("jurisdiction and court metadata are not indexed");
    }
    return findArticles(
      request.text,
      request.perProviderLimit ?? request.limit,
      {
        querySyntax: request.syntax,
        author: request.author,
        journal: request.journal,
        startDate: request.dateFrom,
        endDate: request.dateTo,
        sortResults:
          request.sort === "newest"
            ? "newest_first"
            : request.sort === "oldest"
              ? "oldest_first"
              : "default",
      },
    ).map((row) => ({
      provider: "journal",
      id: String(row.articleId),
      kind: "journal" as const,
      title: row.name,
      citation: row.citation,
      date: row.date,
      collection: row.journalName,
      url: row.url,
      snippet: row.snippet,
      authors: row.authors,
    }));
  },
  async readPassage(request) {
    const article = await document(request.source.id);
    if (!article) return [];
    return nativeDocumentPassages({
      request,
      reference: journalReference(article),
      document: article.native,
    });
  },
};

export const journalLegalSourceProvider = Object.assign(provider, {
  viewer,
});
