import crypto from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { legalProviderDatabase } from "./legalDataPath";
import {
  createSourceDoc,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLocatorKind,
  type SourceDocLookup,
} from "./sourceDoc";
import {
  lookupLegalSourceDoc,
  summarizeLegalSourceDoc,
} from "./sourceDocNativeMarkup";

type Row = Record<string, unknown>;
type PageRow = { page_label: unknown; pdf_page: unknown };

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
  text: string;
  structure: SourceDoc;
  upstreamLicense: string | null;
  journalName: string | null;
  authors: string | null;
  language: "en";
};

export type JournalArticleLookup = SourceDocLookup & {
  provider: "journal";
  identifier: string;
  hitId: string;
  url: string;
  anchor: string | null;
};

const databases = new Map<
  string,
  { connection: DatabaseSync; sourceSignature: string }
>();
const searchDatabases = new Map<
  string,
  { connection: DatabaseSync; sourceSignature: string }
>();
const documents = new Map<string, JournalArticleDocument>();
const MAX_DOCUMENT_CACHE = 16;

function string(row: Row, name: string) {
  const value = row[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function samePath(left: string, right: string) {
  left = path.resolve(left);
  right = path.resolve(right);
  return process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
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
  const configured =
    process.env.MIKE_PUBLIC_ENDPOINT_DB?.trim() ||
    process.env.ALR_PUBLIC_ENDPOINT_DB?.trim();
  return configured
    ? path.resolve(configured)
    : legalProviderDatabase("journals", "public_endpoint.db");
}

function journalSearchDatabasePath() {
  const configured = process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB?.trim();
  return configured
    ? path.resolve(configured)
    : legalProviderDatabase("journals", "public_endpoint-search.sqlite");
}

export function closeJournalDatabases() {
  for (const { connection } of databases.values()) connection.close();
  for (const { connection } of searchDatabases.values()) connection.close();
  databases.clear();
  searchDatabases.clear();
  documents.clear();
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
    if (
      metadata.schema_version !== "2" ||
      metadata.source_size !== String(source.size) ||
      metadata.source_mtime_ms !== String(Math.trunc(source.mtimeMs)) ||
      !samePath(metadata.source_path ?? "", sourcePath) ||
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

function displayCitation(row: Row) {
  const citation = string(row, "citation_en");
  if (citation) return citation;
  const title = string(row, "name_en") ?? `Article ${row.article_id}`;
  const publication = [
    string(row, "document_date_en"),
    string(row, "volume"),
    string(row, "journal_abbrev") ?? string(row, "journal_name"),
    string(row, "first_page"),
  ]
    .filter(Boolean)
    .join(" ");
  return publication ? `“${title}” (${publication})` : title;
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

export function searchJournalArticles(
  query: string,
  size = 10,
): JournalArticleSearchResult[] {
  query = query.trim();
  if (!query) throw new Error("query is required");
  const directId = query.match(/^(?:journal:)?(\d+)$/iu)?.[1];
  if (directId) {
    const row = database()
      .prepare(
        `SELECT article_id, dataset, citation_en, name_en, authors,
                document_date_en, volume, first_page, journal_name,
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
    const ftsQuery = tokens
      .map((token) => `"${token.replace(/"/gu, '""')}"*`)
      .join(" AND ");
    const ids = (
      search
        .prepare(
          `SELECT rowid AS article_id
           FROM article_search
           WHERE article_search MATCH ?
           ORDER BY bm25(article_search, 4.0, 1.0)
           LIMIT ?`,
        )
        .all(ftsQuery, wanted) as Array<{ article_id: number }>
    ).map(({ article_id }) => article_id);
    if (!ids.length) return [];
    const rows = database()
      .prepare(
        `SELECT article_id, dataset, citation_en, name_en, authors,
                document_date_en, volume, first_page, journal_name,
                journal_abbrev, galley_url, url_en, abstract
         FROM articles WHERE article_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Row[];
    const byId = new Map(rows.map((row) => [integer(row.article_id), row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [result(row, query)] : [];
    });
  }
  const haystack = `LOWER(
    COALESCE(name_en, '') || ' ' || COALESCE(citation_en, '') || ' ' ||
    COALESCE(authors, '') || ' ' || COALESCE(journal_name, '') || ' ' ||
    COALESCE(journal_abbrev, '')
  )`;
  const rows = database()
    .prepare(
      `SELECT article_id, dataset, citation_en, name_en, authors,
              document_date_en, volume, first_page, journal_name,
              journal_abbrev, galley_url, url_en, abstract
       FROM articles
       WHERE text IS NOT NULL AND length(text) > 0
         AND ${tokens.map(() => `${haystack} LIKE ?`).join(" AND ")}
       ORDER BY CASE WHEN LOWER(name_en) = LOWER(?) THEN 0 ELSE 1 END,
                article_id
       LIMIT ?`,
    )
    .all(
      ...tokens.map((token) => `%${token}%`),
      query,
      wanted,
    ) as Row[];
  return rows.map((row) => result(row, query));
}

function addRanges(
  matches: Array<Omit<SourceDocBlock, "end">>,
  textLength: number,
) {
  return matches.map((block, index): SourceDocBlock => ({
    ...block,
    end: matches[index + 1]?.start ?? textLength,
  }));
}

/**
 * The `[page N]` markers in `text` are rendered by the journals database
 * export from its own page map, so the map (`article_pages`, in page_order)
 * is the authority on which pages exist: walk it and locate each label's
 * marker line, rather than regex-discovering markers. This also carries
 * non-numeric labels ("PDF 1", "-5") and repeated labels, which discovery
 * by numeric regex plus a label-keyed anchor map cannot.
 */
function pageBlocks(text: string, pageRows: PageRow[]) {
  const found: Array<Omit<SourceDocBlock, "end">> = [];
  let cursor = 0;
  for (const row of pageRows) {
    const label = String(row.page_label ?? "").trim();
    if (!label) continue;
    const marker = `[page ${label}]`;
    let at = text.indexOf(marker, cursor);
    while (at >= 0) {
      const lineStart = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
      const lineEnd = at + marker.length;
      const nextBreak = text.indexOf("\n", lineEnd);
      const tail = text.slice(
        lineEnd,
        nextBreak < 0 ? text.length : nextBreak,
      );
      if (
        !/[^ \t]/u.test(text.slice(lineStart, at)) &&
        !/[^ \t\r]/u.test(tail)
      ) {
        const pdfPage = integer(row.pdf_page);
        found.push({
          kind: "page",
          label: /^\d+$/u.test(label) ? `page${Number(label)}` : `page${label}`,
          start: lineStart,
          anchor: pdfPage ? `page=${pdfPage}` : undefined,
          aliases: [label],
          origin: "native",
        });
        cursor = lineEnd;
        break;
      }
      at = text.indexOf(marker, lineEnd);
    }
  }
  return found;
}

function journalSourceDoc(
  articleId: number,
  url: string,
  text: string,
  pageRows: PageRow[],
): SourceDoc {
  const pages = addRanges(pageBlocks(text, pageRows), text.length);
  const sections = addRanges(
    [...text.matchAll(/^[ \t]*([IVXLCDM]+|[A-Z])\.[ \t]+([^\n\b]{3,180})$/gmu)]
      .map((match) => {
        const title = match[2].replace(/\s+/gu, " ").trim();
        const titleAlias = title
          .toLocaleLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim();
        return {
          kind: "section" as const,
          label: `sec${match[1]}`,
          start: match.index,
          aliases: [
            match[1],
            ...(titleAlias ? [`sectitle:${titleAlias}`] : []),
          ],
          origin: "heuristic" as const,
        };
      }),
    text.length,
  );
  const footnotes = addRanges(
    [...text.matchAll(/^[ \t]*(\d{1,5})\t[ \t]*(?:\r?\n)?/gmu)].map(
      (match) => ({
        kind: "footnote" as const,
        label: `fn${Number(match[1])}`,
        start: match.index,
        aliases: [match[1]],
        origin: "heuristic" as const,
      }),
    ),
    text.length,
  );
  const paragraphs = [...text.matchAll(/\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/gu)]
    .filter((match) => !/^\[page [^\]\n]{1,40}\]/iu.test(match[0]))
    .map(
      (match, index): SourceDocBlock => ({
        kind: "paragraph",
        label: `par${index + 1}`,
        start: match.index,
        end: match.index + match[0].length,
        origin: "heuristic",
      }),
    );
  const blocks = [...pages, ...sections, ...footnotes, ...paragraphs].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  return createSourceDoc({
    provider: "journal",
    id: String(articleId),
    url,
    text,
    blocks,
  });
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

export function fetchJournalArticle(
  identifier: string,
): JournalArticleDocument | null {
  identifier = identifier.trim();
  if (!identifier) throw new Error("identifier is required");
  database();
  const numericId = identifier.match(/^(?:journal:)?(\d+)$/iu)?.[1];
  const cacheKey = numericId ? `${journalDatabasePath()}:${numericId}` : "";
  const cached = cacheKey ? documents.get(cacheKey) : undefined;
  if (cached) return cached;
  const row = articleRow(identifier);
  if (!row) return null;
  const articleId = integer(row.article_id)!;
  const text = string(row, "text");
  const url = trustedUrl(string(row, "galley_url") ?? string(row, "url_en"));
  if (!text || !url) return null;
  const pageRows = database()
    .prepare(
      `SELECT page_label, pdf_page FROM article_pages
       WHERE article_id = ? ORDER BY page_order`,
    )
    .all(articleId) as PageRow[];
  const document: JournalArticleDocument = {
    provider: "journal",
    identity: String(articleId),
    articleId,
    dataset: string(row, "dataset") ?? "",
    citation: displayCitation(row),
    title: string(row, "name_en") ?? `Article ${articleId}`,
    date: string(row, "document_date_en"),
    url,
    text,
    structure: journalSourceDoc(articleId, url, text, pageRows),
    upstreamLicense: string(row, "upstream_license"),
    journalName: string(row, "journal_name"),
    authors: string(row, "authors"),
    language: "en",
  };
  if (documents.size >= MAX_DOCUMENT_CACHE) {
    documents.delete(documents.keys().next().value!);
  }
  documents.set(`${journalDatabasePath()}:${articleId}`, document);
  return document;
}

export function lookupJournalArticle(
  document: JournalArticleDocument,
  kind: SourceDocLocatorKind,
  locator: string,
  contextBlocks = 0,
): JournalArticleLookup {
  const lookup = lookupLegalSourceDoc(
    document.structure,
    kind,
    locator,
    contextBlocks,
  );
  const label = lookup.block?.label ?? lookup.requestedLabel;
  return {
    ...lookup,
    provider: "journal",
    identifier: document.identity,
    hitId: `journal:${document.articleId}:${kind}:${label}`,
    url: document.url,
    anchor: lookup.block?.anchor ?? null,
  };
}

export function resolveJournalViewerDocument(identifier: string) {
  const document = fetchJournalArticle(identifier);
  if (!document) return null;
  const summary = summarizeLegalSourceDoc(document.structure);
  const payload = {
    schemaVersion: "mike.legal-source.v1" as const,
    provider: "journal" as const,
    reference: {
      docType: "articles" as const,
      citation: document.citation,
      sourceId: document.identity,
      language: document.language,
      dataset: document.dataset || null,
    },
    metadata: {
      title: document.title,
      citation: document.citation,
      alternateCitation: null,
      date: document.date,
      dataset: document.dataset,
      url: document.url,
      language: document.language,
      upstreamLicense: document.upstreamLicense,
      authors: document.authors,
      journalName: document.journalName,
    },
    text: document.text,
    structure: {
      status: summary.status,
      source: summary.source,
      blocks: document.structure.blocks,
      counts: summary.counts,
    },
    truncated: false,
  };
  return {
    payload,
    etag: `"${crypto
      .createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("base64url")}"`,
  };
}
