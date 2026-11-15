import crypto from "node:crypto";
import path from "node:path";
import { legalProviderDatabase, storeExists } from "../legalDataPath";
import { structureNative } from "../structureNative";
import { isUnitedStatesSearch } from ".";
import type { LegalSourceProvider, LegalSourceSearchRequest, LegalSourceReference } from ".";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import type { JournalDocument } from "mike/shared/engine-types/JournalDocument";

export type JournalArticleDocument = JournalDocument;

// Where the journal files are, as this host's settings place them; the engine reads them.
export const journalStores = () => {
  const configured = (name: string) => process.env[name]?.trim() ? path.resolve(process.env[name]!.trim()) : null;
  return {
    configured: configured("MIKE_PUBLIC_ENDPOINT_DB"),
    shared: legalProviderDatabase("journals", "public_endpoint.db"),
    search: configured("MIKE_PUBLIC_ENDPOINT_FTS_DB") ?? legalProviderDatabase("journals", "public_endpoint-search.sqlite"),
    contracts: configured("MIKE_JOURNAL_FINAL_CONTRACT_DB") ?? legalProviderDatabase("journals", "journals.db"),
  };
};

/** `names` searches only what a citation names an article by, in the index's small table of those. */
const findArticles = (query: string, size?: number, options: Pick<LegalSourceSearchRequest,
  "author" | "journal" | "dateFrom" | "dateTo" | "sort"> & { names?: boolean } = {}) =>
  structureNative().journalSearch(journalStores(), { query, size, author: options.author, journal: options.journal,
    dateFrom: options.dateFrom, dateTo: options.dateTo, sort: options.sort, names: options.names });

const document = (identifier: string) => structureNative().journalDocument(journalStores(), identifier);

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

const provider: LegalSourceProvider<{ document: JournalArticleDocument }> = {
  id: "journal",
  // An article is looked for only where the journals database is on this computer.
  canResolve: ({ kind }) => kind === "journal" && storeExists(structureNative().journalPath(journalStores())),
  async resolve(request) {
    const articleId = structureNative().journalNamed(journalStores(), [request.text, ...(request.alternateTexts ?? [])]);
    const article = articleId === null ? null : await document(String(articleId));
    return article ? [journalReference(article)] : [];
  },
  // In a search of several kinds, filters journals do not index (a court, a collection, the US) leave journals out.
  canSearch: (request) => request.kinds.includes("journal") && !(request.kinds.length > 1 &&
    (request.collection || isUnitedStatesSearch(request))),
  async search(request) {
    if (request.collection || isUnitedStatesSearch(request)) {
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
  closeDatabases: () => structureNative().journalForget(),
  find: findArticles,
  /** An article's PDF opened at a printed page; null when its page map lacks the page. */
  pageLink: (identity: string, printedPage: string) => structureNative().journalPageLink(journalStores(), identity, printedPage),
  document,
  lookup(article: JournalArticleDocument, kind: "page" | "paragraph" | "section" | "footnote", value: string) {
    const block = structureNative()
      .readDocumentRange(article.native, kind, value, value, 0)
      ?.selected[0];
    return block
      ? { status: "found" as const, hitId: `journal:${article.articleId}:${kind}:${block.node.label ?? ""}`,
          block, anchor: block.node.anchor ?? null }
      : { status: "unavailable" as const, block: null, anchor: null };
  },
  viewer,
});
