import crypto from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { legalProviderDatabase } from "../legalDataPath";
import { positiveInteger as integer } from "../value";
import { sqliteText as string } from "../sqliteSearch";
import { nativeDocumentLive, structureNative, type NativeDocument } from "../structureNative";
import { isUnitedStatesSearch } from ".";
import type { LegalSourceProvider, LegalSourceSearchRequest, LegalSourceReference } from ".";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import { sequenceOpcodes } from "mike/shared/sequence-diff.mjs";
import { sourceUrl } from "../legalSourceLinks";

type Row = Record<string, unknown>;
type FinalContractPages = { filename: string; signature: string };
type JournalPageRow = { page_label: unknown; pdf_page: unknown };

export type JournalArticleSearchResult = {
  provider: "journal";
  hitId: string; articleId: number; dataset: string;
  citation: string; name: string; date: string | null; url: string | null;
  snippet: string | null; journalName: string | null; authors: string | null;
};

export type JournalArticleDocument = {
  provider: "journal";
  identity: string; articleId: number; dataset: string;
  citation: string; title: string; date: string | null; url: string;
  native: NativeDocument;
  upstreamLicense: string | null; journalName: string | null; authors: string | null;
  language: "en";
};

const documents = new Map<string, JournalArticleDocument>();
/** The articles each identifier names or cites exactly, per database snapshot: Sources and the quote check ask alike. */
const namedArticles = new Map<string, number[]>();
const MAX_DOCUMENT_CACHE = 16;

/** Each database family retains its own snapshot key and invalidation policy. */
function databaseCache(invalidate?: (filename: string) => void) {
  const entries = new Map<string, { connection: DatabaseSync; signature: string }>();
  return {
    open(filename: string, signature: string, validate: (connection: DatabaseSync) => boolean) {
      const cached = entries.get(filename);
      if (cached?.signature === signature) return cached.connection;
      if (cached) {
        cached.connection.close();
        entries.delete(filename);
        invalidate?.(filename);
      }
      const connection = new DatabaseSync(filename, { readOnly: true });
      let retained = false;
      try {
        if (!validate(connection)) return null;
        entries.set(filename, { connection, signature });
        retained = true;
        return connection;
      } finally {
        if (!retained) connection.close();
      }
    },
    close() {
      for (const { connection } of entries.values()) connection.close();
      entries.clear();
    },
  };
}

const databases = databaseCache((filename) => {
  for (const key of documents.keys()) {
    if (key.startsWith(`${filename}:`)) documents.delete(key);
  }
});
const searchDatabases = databaseCache();
const finalContractDatabases = databaseCache(() => documents.clear());

function closeDatabases() {
  for (const cache of [databases, searchDatabases, finalContractDatabases]) cache.close();
  documents.clear();
  namedArticles.clear();
}

function snapshotSignature(filename: string, source = statSync(filename)) {
  return `${path.resolve(filename)}:${source.size}:${Math.trunc(source.mtimeMs)}`;
}

function metadata(connection: DatabaseSync, table: "meta" | "export_metadata") {
  const values = connection.prepare(`SELECT key, value FROM ${table}`).all() as Array<{
    key: string; value: string;
  }>;
  return Object.fromEntries(values.map(({ key, value }) => [key, value]));
}

function trustedUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
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
  return databases.open(filename, snapshotSignature(filename), (connection) => {
    if (!connection.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='articles'",
    ).get()) throw new Error("Unsupported public_endpoint.db schema");
    return true;
  })!;
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
  return searchDatabases.open(filename, snapshotSignature(sourcePath, source), (connection) => {
    try {
      const indexed = metadata(connection, "meta");
      const sourceMetadata = metadata(database(), "export_metadata");
      const expectedSource = path.resolve(indexed.source_path ?? "");
      const matchesSource = process.platform === "win32"
        ? expectedSource.toLocaleLowerCase() === sourcePath.toLocaleLowerCase()
        : expectedSource === sourcePath;
      return indexed.schema_version === "2" &&
        indexed.source_size === String(source.size) &&
        indexed.source_mtime_ms === String(Math.trunc(source.mtimeMs)) && matchesSource &&
        indexed.source_schema_version === (sourceMetadata.schema_version ?? "") &&
        indexed.source_created_at === (sourceMetadata.created_at ?? "");
    } catch {
      return false;
    }
  });
}

function finalContractDatabase() {
  const configured = process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB?.trim();
  const filename = configured ? path.resolve(configured)
    : legalProviderDatabase("journals", "journals.db");
  if (!existsSync(filename)) return null;
  const connection = finalContractDatabases.open(filename, snapshotSignature(filename), (db) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_final_contracts'").get());
  return connection ? { connection, filename } : null;
}

/** McGill's form of an article row: byline, title, year, volume and issue, journal, first page. */
const displayCitation = (row: Row) => structureNative().citationEngineCall("formatArticle", JSON.stringify({
  authors: (string(row, "authors") ?? "").split(/\s*;\s*/u).filter(Boolean), title: string(row, "name_en") ?? "",
  year: string(row, "document_date_en"), volume: string(row, "volume"), issue: string(row, "issue"),
  journal: string(row, "journal_abbrev"), firstPage: string(row, "first_page") })) as string;

function queryTokens(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length > 1).slice(0, 8) ?? [];
}

function result(row: Row, query: string): JournalArticleSearchResult {
  const articleId = integer(row.article_id)!;
  const abstract = string(row, "abstract");
  const folded = abstract?.toLocaleLowerCase() ?? "";
  const position = queryTokens(query)
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

const SEARCH_COLUMNS = `article_id, dataset, citation_en, name_en, authors,
  document_date_en, volume, issue, first_page, journal_name,
  journal_abbrev, galley_url, url_en, abstract`;

function findArticles(
  query: string,
  size = 10,
  options: Pick<LegalSourceSearchRequest, "syntax" | "author" | "journal" | "dateFrom" | "dateTo" | "sort"> = {},
): JournalArticleSearchResult[] {
  query = query.trim();
  if (!query) throw new Error("query is required");
  const directId = query.match(/^(?:journal:)?(\d+)$/iu)?.[1];
  if (directId) {
    const row = database()
      .prepare(
        `SELECT ${SEARCH_COLUMNS} FROM articles
         WHERE article_id = ? AND text IS NOT NULL AND length(text) > 0`,
      )
      .get(Number(directId)) as Row | undefined;
    return row ? [result(row, query)] : [];
  }

  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const wanted = Math.min(Math.max(Math.trunc(size), 1), 25);
  const select = (predicate: string, values: SQLInputValue[],
    suffix = "", trailing: SQLInputValue[] = []) => {
    const filters: Array<[string, string]> = [];
    if (options.author) filters.push(["LOWER(authors) LIKE ?", `%${options.author.toLocaleLowerCase()}%`]);
    if (options.journal) filters.push([
      "LOWER(COALESCE(journal_name, '') || ' ' || COALESCE(journal_abbrev, '')) LIKE ?",
      `%${options.journal.toLocaleLowerCase()}%`,
    ]);
    if (options.dateFrom) filters.push(["document_date_en >= ?", options.dateFrom]);
    if (options.dateTo) filters.push(["document_date_en <= ?", options.dateTo]);
    return database().prepare(`SELECT ${SEARCH_COLUMNS} FROM articles WHERE ${predicate}
      ${filters.map(([condition]) => `AND ${condition}`).join(" ")} ${suffix}`)
      .all(...values, ...filters.map(([, value]) => value), ...trailing) as Row[];
  };
  const search = searchDatabase();
  if (search) {
    const ftsQuery = options.syntax === "fts5" ? query
      : tokens.map((token) => `"${token.replace(/"/gu, '""')}"`).join(" AND ");
    const candidateLimit =
      options.author || options.journal || options.dateFrom || options.dateTo
        ? Math.min(250, wanted * 10)
        : wanted;
    const ids = (search.prepare(
      `SELECT rowid AS article_id
       FROM article_search
       WHERE article_search MATCH ?
       ORDER BY bm25(article_search, 4.0, 1.0)
       LIMIT ?`,
    ).all(ftsQuery, candidateLimit) as Array<{ article_id: number }>).map(({ article_id }) => article_id);
    if (!ids.length) return [];
    const rows = select(`article_id IN (${ids.map(() => "?").join(",")})`, ids);
    const byId = new Map(rows.map((row) => [integer(row.article_id), row]));
    const found = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [result(row, query)] : [];
    });
    if (options.sort === undefined || options.sort === "newest" || options.sort === "oldest") {
      found.sort((left, right) => {
        const missing = "\uffff";
        if (options.sort === "newest") {
          return (right.date ?? "").localeCompare(left.date ?? "");
        }
        return (left.date ?? missing).localeCompare(right.date ?? missing);
      });
    }
    return found.slice(0, wanted);
  }
  if (options.syntax === "fts5") {
    throw new Error("Boolean search requires the journal FTS index");
  }
  const haystack = `LOWER(
    COALESCE(name_en, '') || ' ' || COALESCE(citation_en, '') || ' ' ||
    COALESCE(authors, '') || ' ' || COALESCE(journal_name, '') || ' ' ||
    COALESCE(journal_abbrev, '')
  )`;
  const rows = select(
    `text IS NOT NULL AND length(text) > 0 AND ${tokens.map(() => `${haystack} LIKE ?`).join(" AND ")}`,
    tokens.map((token) => `%${token}%`),
    `ORDER BY ${options.sort === "newest"
      ? "document_date_en DESC, article_id"
      : options.sort === "oldest"
        ? "document_date_en ASC, article_id"
        : "CASE WHEN LOWER(name_en) = LOWER(?) THEN 0 ELSE 1 END, article_id"} LIMIT ?`,
    [...(options.sort === "newest" || options.sort === "oldest" ? [] : [query]), wanted],
  );
  return rows.map((row) => result(row, query));
}

function inside(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function registeredPages(filename: string, sourceDir: string) {
  if (!sourceDir || path.isAbsolute(sourceDir) || /^[A-Za-z]:[\\/]/u.test(sourceDir)) return null;
  const relative = sourceDir.replace(/[\\/]+/gu, path.sep);
  const databaseDirectory = path.dirname(filename);
  for (const base of [databaseDirectory, path.dirname(databaseDirectory)]) {
    const candidate = path.resolve(base, relative, "pages.jsonl");
    if (!inside(base, candidate) || !existsSync(candidate)) continue;
    try {
      const realBase = realpathSync(base);
      const realCandidate = realpathSync(candidate);
      if (inside(realBase, realCandidate) && statSync(realCandidate).isFile()) return realCandidate;
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
  return filename ? { filename, signature: snapshotSignature(filename) } : null;
}

// Whole words of an identifier that the search index reads as whole tokens too: ASCII letters and digits set off
// by spaces or punctuation (an index token can run on into a neighbouring non-ASCII letter or symbol).
const INDEX_WORD = /(?<=^|[\s!"#%&'()*,\-./:;?@[\\\]_{}])[A-Za-z0-9]+(?=$|[\s!"#%&'()*,\-./:;?@[\\\]_{}])/gu;

/** False when no article with text is named or cited exactly as `identifier`, from the search index: every such
 *  article's name and citation are indexed, so one that matched would hold all of its whole words. */
function mayName(identifier: string) {
  const search = searchDatabase();
  const words = [...new Set(identifier.match(INDEX_WORD) ?? [])];
  if (!search || !words.length) return true;
  const ids = (search.prepare("SELECT rowid AS article_id FROM article_search WHERE article_search MATCH ?")
    .all(words.map((word) => `metadata : "${word}"`).join(" AND ")) as Row[]).map((row) => Number(row.article_id));
  if (ids.length > 30000) return true;
  return ids.length > 0 && !!database().prepare(`SELECT 1 FROM articles WHERE article_id IN (${ids.map(() => "?").join(",")})
     AND (LOWER(citation_en) = LOWER(?) OR LOWER(name_en) = LOWER(?)) LIMIT 1`).get(...ids, identifier, identifier);
}

function articleRow(identifier: string) {
  const articleId = identifier.match(/^(?:journal:)?(\d+)$/iu)?.[1];
  // Only articles with text are returned, so an identifier the index shows no such article answers to finds
  // nothing without scanning every article; one that some article answers to is matched exactly below.
  if (!articleId && !mayName(identifier)) return null;
  const key = `${snapshotSignature(journalDatabasePath())}\n${identifier}`;
  const ids = articleId ? [Number(articleId)] : namedArticles.get(key) ?? (database()
    .prepare(`SELECT article_id FROM articles
       WHERE (LOWER(citation_en) = LOWER(?) OR LOWER(name_en) = LOWER(?)) ORDER BY article_id LIMIT 8`)
    .all(identifier, identifier) as Row[]).map((row) => Number(row.article_id));
  if (!articleId) namedArticles.set(key, ids);
  const withText = database().prepare(
    "SELECT * FROM articles WHERE article_id = ? AND text IS NOT NULL AND length(text) > 0");
  const rows = ids.map((id) => withText.get(id) as Row | undefined).filter((row): row is Row => !!row).slice(0, 2);
  return rows.length === 1 ? rows[0] : null;
}

async function document(identifier: string): Promise<JournalArticleDocument | null> {
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
  if (cached && nativeDocumentLive(cached.native)) return cached;
  const pageRows = database()
    .prepare(
      `SELECT CAST(page_label AS TEXT) AS page_label,
              CAST(pdf_page AS INTEGER) AS pdf_page FROM article_pages
       WHERE article_id = ? ORDER BY page_order`,
    )
    .all(articleId) as JournalPageRow[];
  const native = await structureNative().deriveDocumentStructure({
    kind: "journal", article_id: articleId, url, page_rows: pageRows,
    ...(registered ? { filename: registered.filename } : { text: publicText }),
  });
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
  if (documents.size >= MAX_DOCUMENT_CACHE) documents.delete(documents.keys().next().value!);
  documents.set(cacheKey, document);
  return document;
}

async function viewer(identifier: string) {
  const article = await document(identifier);
  if (!article) return null;
  const viewer = structureNative().legalSourceViewer(article.native, "paragraph");
  const payload = {
    schemaVersion: "mike.legal-source.v1" as const,
    provider: "journal" as const,
    reference: {
      provider: "journal" as const, id: article.identity, kind: "journal" as const,
      docType: "articles" as const, citation: article.citation, sourceId: article.identity,
      language: article.language, dataset: article.dataset || null,
      sourceSha256: viewer.documentRevision,
    },
    metadata: {
      title: article.title, citation: article.citation, alternateCitation: null,
      date: article.date, dataset: article.dataset, url: article.url,
      language: article.language, upstreamLicense: article.upstreamLicense,
      authors: article.authors, journalName: article.journalName,
    },
    slices: viewer.slices,
    truncated: viewer.truncated,
  };
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([viewer.documentRevision, payload.reference, payload.metadata]))
    .digest("base64url");
  return { payload, native: article.native, etag: `"${digest}"` };
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

/** Python difflib's ratio of two titles, by character, after folding case and punctuation. */
function titleRatio(a: string, b: string) {
  const fold = (value: string) => [...value.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, "").replace(/\s+/gu, " ").trim()];
  const [x, y] = [fold(a), fold(b)];
  if (!x.length && !y.length) return 1;
  const same = sequenceOpcodes(x, y).filter(([tag]) => tag === "equal").reduce((sum, [, a0, a1]) => sum + a1 - a0, 0);
  return (2 * same) / (x.length + y.length);
}
/** The article a citation names by the title it quotes: the closest title the search finds for it,
 *  when close enough. After ALR-Quote-Verifier journal_search.py search_by_title (difflib ratio of at least
 *  0.7 between normalized titles), with candidates from this database's own title search. */
function titledArticle(citation: string) {
  let best: { score: number; articleId: number } | null = null;
  const titles = structureNative().citationEngineCall("quotedTitles", JSON.stringify({ text: citation })) as string[];
  for (const title of titles) for (const hit of findArticles(title, 5)) {
    const score = titleRatio(title, hit.name);
    if (!best || score > best.score) best = { score, articleId: hit.articleId };
  }
  return best && best.score >= 0.7 ? best.articleId : null;
}

/** An article's PDF opened at a printed page: the database's page map gives the PDF page, which
 *  counts cover and front pages the printed numbers skip. Null when the map lacks the page. */
function pageLink(identity: string, printedPage: string) {
  const row = articleRow(identity), url = row && trustedUrl(string(row, "galley_url") ?? string(row, "url_en"));
  if (!row || !url) return null;
  const page = database().prepare(`SELECT CAST(pdf_page AS INTEGER) AS pdf_page FROM article_pages
    WHERE article_id = ? AND CAST(page_label AS TEXT) = ? ORDER BY page_order LIMIT 1`)
    .get(integer(row.article_id)!, printedPage.trim()) as { pdf_page?: number } | undefined;
  return page?.pdf_page ? sourceUrl(url, `page=${page.pdf_page}`) : null;
}

function exactJournalIdentity(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const provider: LegalSourceProvider<{ document: JournalArticleDocument }> = {
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
    const matches = findArticles(candidates[0] ?? request.text, 10).filter((match) =>
      candidates.some((candidate) =>
        exactJournalIdentity(candidate) === exactJournalIdentity(match.citation) ||
        exactJournalIdentity(candidate) === exactJournalIdentity(match.name)));
    const titled = matches.length ? null : titledArticle(candidates[0] ?? request.text);
    if (matches.length !== 1 && !titled) return [];
    const article = await document(String(titled ?? matches[0].articleId));
    return article ? [journalReference(article)] : [];
  },
  canSearch: (request) => request.kinds.includes("journal"),
  async search(request) {
    if (request.court || request.collection || isUnitedStatesSearch(request)) {
      throw new Error("jurisdiction and court metadata are not indexed");
    }
    return findArticles(request.text, request.perProviderLimit ?? request.limit, request)
      .map((row) => ({
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
  closeDatabases,
  find: findArticles,
  pageLink,
  document,
  lookup(article: JournalArticleDocument, kind: "page" | "paragraph" | "section" | "footnote", value: string) {
    const block = structureNative()
      .readDocumentRange(article.native, kind, value, value, 0)
      ?.selected[0];
    return block
      ? { status: "found" as const, hitId: `journal:${article.articleId}:${kind}:${block.label}`,
          block, anchor: block.anchor ?? null }
      : { status: "unavailable" as const, block: null, anchor: null };
  },
  viewer,
});
