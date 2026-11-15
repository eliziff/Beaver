import crypto from "node:crypto";
import type { VerifiedPdfEvidence } from "../legalSourcePresentation";
import { a2ajStorePath, inSqliteRun, onSqliteRunEnd, storeExists, storeStat, useA2AJStore } from "../legalDataPath";
import { normalizeWhitespace } from "../text";
import { nativeDocumentLive, structureNative, type NativeDocument } from "../structureNative";
import type { RemoteOutcome } from "mike/shared/engine-types/RemoteOutcome";
import type { RemoteUnavailable } from "mike/shared/engine-types/RemoteUnavailable";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import { indexedNumberedCase } from "./canlii";
import { isUnitedStatesSearch, keepLookupsLocal, lookupsLeaveComputer } from ".";
import type { LegalSourceProvider, LegalSourceReference, LegalSourceSearchRequest } from ".";
import type { LegalSourceSearchHit } from "mike/shared/runtime/clientContracts.mjs";

type DocType = "cases" | "laws";
type Language = "en" | "fr";
export type A2AJLocatorKind = "paragraph" | "page" | "section";

export type A2AJDocument = {
  docType?: DocType; dataset: string;
  citation: string; alternateCitation: string | null;
  name: string | null; date: string | null; url: string | null; publisherUrl?: string | null;
  verifiedPdf: VerifiedPdfEvidence | null;
  text: string; language: Language; upstreamLicense: string | null;
  sectionMap?: Record<string, string>;
};

export type A2AJCompiledDocument = Omit<A2AJDocument, "text" | "sectionMap"> & {
  /** The document's CanLII page, as the engine read it off its citations. */
  canliiUrl: string | null;
  /** Original A2AJ text, which Law Web searches for its markdown tokens: searchNative's text, read when wanted. */
  searchText(): string;
  /** Full-text coordinates used exclusively for URL fragment planning. */
  searchNative: NativeDocument;
  /** Provider section-map coordinates used for structured reads. */
  native: NativeDocument;
};

export function stableA2AJSourceId(source: Pick<A2AJDocument,
  "dataset" | "citation" | "language">) {
  return ["a2aj", source.language, source.dataset.trim().toLowerCase(),
    normalizeWhitespace(source.citation).toLowerCase()].join(":");
}

const documents = new Map<string, { expires: number; value: A2AJCompiledDocument }>();
// The documents kept by their reading, least recently used out first (see document()).
const DOCUMENTS_KEPT = 256;

export type A2AJFailureReason = RemoteUnavailable["reason"] | "local-only";
/** A source did not answer a lookup: the authority was not checked, which is not the same as not found. `transient`:
 *  asking again can answer it. */
export class A2AJUnavailable extends Error {
  constructor(readonly reason: A2AJFailureReason, readonly retryAt: number | null = null, detail?: string | null,
    readonly transient = reason === "rate-limited" || reason === "timeout" || reason === "unreachable", until?: number | null) {
    // When a hold ends: A2AJ's own time only where it named one, never a hold of ours presented as A2AJ's.
    const time = until && new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    super(detail || (reason === "rate-limited" && time ? retryAt ? `A2AJ is limiting requests until ${time}.`
      : `A2AJ is limiting requests. Lookups start again at ${time}.`
      : reason === "rate-limited" ? "A2AJ is limiting requests."
      : reason === "timeout" ? "A2AJ did not answer in time."
      : reason === "unreachable" ? "A2AJ could not be reached."
      : reason === "local-only" ? "This source is not in the A2AJ corpus on this computer, and A2AJ is not asked while working locally only."
      : "A2AJ answered with an error."));
  }
}

/** An engine lookup's value, or why its source did not answer. */
async function done<T>(lookup: RemoteOutcome<T> | Promise<RemoteOutcome<T>>): Promise<T> {
  const outcome = await lookup;
  if (outcome.status === "done") return outcome.value;
  throw new A2AJUnavailable(outcome.reason, outcome.retryAt, outcome.message, outcome.transient, outcome.until);
}

/** The A2AJ store a run's lookups read: a path to an a2aj.sqlite (legalDataPath's a2ajStorePath), or nothing for
 *  the configured one. */
export type A2AJCorpusInput = string;
/**
 * Points lookups at the store a run was given, and keeps every provider's lookups on this computer when `localOnly`:
 * a source the store lacks is then a miss, as in the Python app's local-only run, never asked of A2AJ.
 */
export function useA2AJCorpus(input: A2AJCorpusInput | null | undefined, options: { localOnly?: boolean } = {}) {
  useA2AJStore(typeof input === "string" && input ? input : null);
  if (lookupsLeaveComputer() === !!options.localOnly) documents.clear();
  keepLookupsLocal(!!options.localOnly);
}

const compiled = (metadata: Omit<A2AJCompiledDocument, "native" | "searchNative" | "searchText">,
  native: NativeDocument, searchNative: NativeDocument): A2AJCompiledDocument =>
  ({ ...metadata, searchText: () => structureNative().documentText(searchNative), searchNative, native });

// The store's documents an operation reads, held while it runs: the engine keeps a document only while it is held.
const running = new Set<A2AJCompiledDocument>();
onSqliteRunEnd(() => running.clear());

async function document(args: {
  citation: string; docType?: DocType; language?: Language; dataset?: string;
  section?: string; sourceUrl?: string | null; signal?: AbortSignal;
  discoverPdf?: boolean;
}): Promise<A2AJCompiledDocument | null> {
  const citation = args.citation.trim();
  if (!citation) throw new Error("citation is required");
  args.signal?.throwIfAborted();
  const docType = args.docType ?? "cases";
  const language: Language = args.language === "fr" ? "fr" : "en";
  const snapshot = storeExists(a2ajStorePath()) ? storeStat(a2ajStorePath()) : undefined;
  const cacheKey = (sourceUrl: string) => JSON.stringify([
    snapshot && [snapshot.ino, snapshot.size, snapshot.mtimeMs],
    docType, language, args.dataset?.trim().toLowerCase() ?? "",
    citation.toLowerCase(), sourceUrl, args.section?.trim() ?? "", args.discoverPdf !== false,
  ]), sourceUrl = args.sourceUrl?.trim() ?? "", key = cacheKey(sourceUrl);
  const hitKey = documents.has(key) || !sourceUrl ? key : cacheKey("");
  const cached = documents.get(hitKey);
  if (cached && cached.expires > Date.now() && (!sourceUrl || cached.value.url === sourceUrl) &&
      nativeDocumentLive(cached.value.native) && nativeDocumentLive(cached.value.searchNative)) {
    // Least recently used goes first: a book that cites a case on every page keeps it.
    documents.delete(hitKey); documents.set(hitKey, cached);
    return cached.value;
  }
  if (cached) documents.delete(hitKey);
  const section = args.section?.trim();
  const lookup = { citation, docType, language, dataset: args.dataset, sourceUrl: args.sourceUrl, remote: lookupsLeaveComputer() };
  if (section) {
    const full = await document({ ...args, section: undefined });
    if (!full) return null;
    // The store keeps each statute's sections; A2AJ is asked for one only when the store lacks the statute.
    const provision = await done(structureNative().a2ajProvisionLookup(a2ajStorePath(), lookup, section,
      { citation: full.citation, url: full.url, alternateCitation: full.alternateCitation, dataset: full.dataset,
        name: full.name }));
    const result = provision ? { ...full, native: provision } : full;
    if (inSqliteRun()) running.add(result);
    documents.set(key, { expires: Date.now() + 60 * 60_000, value: result });
    return result;
  }
  const looked = await done(structureNative().a2ajLookup(a2ajStorePath(), lookup));
  args.signal?.throwIfAborted();
  if (looked.status === "ambiguous") return null;
  // A decision cited by a CanLII number is found by the index each time: the index can change between runs.
  if (looked.status === "missing") return docType === "cases" ? numberedCase(args, citation, language) : null;
  const { native, searchNative, ...metadata } = looked.document;
  const verifiedPdf = args.discoverPdf === false || !lookupsLeaveComputer() || !metadata.url ? null
    : await structureNative().decisiaPdf(metadata.url);
  const result = compiled({ ...metadata, verifiedPdf }, native, searchNative);
  if (inSqliteRun()) running.add(result);
  documents.set(key, {
    expires: Date.now() + (docType === "cases" ? 24 * 60 * 60_000 : 60 * 60_000),
    value: result,
  });
  // Enough for every authority one document cites (a long article cites a few hundred): its later steps (finding its
  // sources, checking its quotations, its workbook) read them again, and an evicted one is parsed from the store again.
  if (documents.size > DOCUMENTS_KEPT) documents.delete(documents.keys().next().value!);
  return result;
}

/** A decision cited by a CanLII number, which A2AJ never carries ("1991 CanLII 45 (SCC)"): the one decision A2AJ holds
 *  under the title the host's CanLII index gives the number, in its year, of its database's courts, as the Python
 *  app's identity_hints finds it. Null without an index, or where no one decision answers. */
async function numberedCase(args: Parameters<typeof document>[0], citation: string, language: Language) {
  const named = indexedNumberedCase(citation);
  if (!named) return null;
  const canonical = await done(structureNative().a2ajNamedLookup(a2ajStorePath(), named, language, lookupsLeaveComputer()));
  return canonical ? document({ ...args, citation: canonical }) : null;
}

async function search(input: LegalSourceSearchRequest, docType: DocType) {
  const sortResults = input.sort === "newest" ? "newest_first" as const
    : input.sort === "oldest" ? "oldest_first" as const : "default" as const;
  return done(structureNative().a2ajSearch(a2ajStorePath(), { query: input.text, docType,
    language: input.language === "fr" ? "fr" : "en", size: input.perProviderLimit ?? input.limit, sortResults,
    searchType: input.searchType, dataset: input.collection, startDate: input.dateFrom, endDate: input.dateTo },
  lookupsLeaveComputer()));
}

/** The courts and tribunals (`cases`) or statute collections (`laws`) A2AJ holds, by jurisdiction and name (as the
 *  host's locale orders them); none where A2AJ is not asked or did not answer. */
async function coverage(docType: DocType) {
  const outcome = lookupsLeaveComputer() ? await structureNative().a2ajCoverage(docType) : null;
  return outcome?.status !== "done" ? [] : outcome.value.sort((left, right) =>
    left.jurisdiction.localeCompare(right.jurisdiction) || left.description.localeCompare(right.description));
}

async function viewer(args: {
  citation: string; docType?: DocType | "auto"; language?: Language;
  dataset?: string; maxChars?: number;
}) {
  const max = Math.min(Math.max(Math.trunc(args.maxChars ?? 5_000_000), 1), 10_000_000);
  const types: DocType[] = args.docType === "auto" ? ["cases", "laws"] : [args.docType ?? "cases"];
  for (const docType of types) {
    const found = await document({ ...args, docType });
    if (!found) continue;
    const compiled = found.native;
    await structureNative().readDocument(compiled);
    const viewer = structureNative()
      .legalSourceViewer(compiled, docType === "laws" ? "section" : "paragraph", max);
    const payload = {
      schemaVersion: "mike.legal-source.v1" as const, provider: "a2aj" as const,
      reference: { provider: "a2aj" as const, id: found.citation,
        kind: docType === "laws" ? "legislation" as const : "case" as const,
        docType, citation: found.citation, language: found.language,
        dataset: found.dataset || null, sourceSha256: viewer.documentRevision },
      metadata: {
        title: found.name || found.citation, citation: found.citation,
        alternateCitation: found.alternateCitation, date: found.date, dataset: found.dataset,
        url: found.url, pdfUrl: found.verifiedPdf?.url ?? null,
        language: found.language, upstreamLicense: found.upstreamLicense,
      },
      slices: viewer.slices,
      // What the reader styles as a judgment sets it: its front matter's parts and its headings' levels.
      outline: docType === "cases" ? structureNative().documentOutline(compiled)
        .filter((entry) => entry.role || entry.kind === "heading")
        .map(({ kind, level, role, start, end }) => ({ kind, level, role, start, end })) : [],
      truncated: viewer.truncated,
    };
    const digest = crypto.createHash("sha256").update(JSON.stringify([
      viewer.documentRevision, payload.reference, payload.metadata, max,
    ])).digest("base64url");
    return { payload, etag: `"${digest}"`, native: compiled };
  }
  return null;
}

export type A2AJViewerPayload = NonNullable<Awaited<ReturnType<typeof viewer>>>["payload"];

function reference(document: A2AJDocument | A2AJCompiledDocument,
  kind: "case" | "legislation") {
  return {
    provider: "a2aj", id: document.citation, kind, title: document.name,
    citation: document.citation, alternateCitation: document.alternateCitation,
    date: document.date, collection: document.dataset, language: document.language,
    url: document.url,
  } satisfies LegalSourceReference;
}

function rankCases(rows: LegalSourceSearchHit[], mode: "relevance" | "most_cited" | "most_discussed") {
  const metrics = structureNative().citatorMetrics(a2ajStorePath(), rows.map((row) => row.citation ?? "")) ?? [];
  const authority = rows.map((_, index) => index)
    .filter((index) => (metrics[index]?.citingCases ?? 0) > 0)
    .sort((a, b) => (metrics[b]?.distinctCitingParagraphs ?? 0) -
      (metrics[a]?.distinctCitingParagraphs ?? 0) ||
      (metrics[b]?.citingCases ?? 0) - (metrics[a]?.citingCases ?? 0));
  const rank = new Map(authority.map((index, place) => [index, place]));
  return rows.map((row, textRank) => ({ row, metric: metrics[textRank], textRank,
    score: 1 / (60 + textRank) + (rank.has(textRank) ? 0.15 / (60 + rank.get(textRank)!) : 0) }))
    .sort((a, b) => mode === "most_cited"
      ? (b.metric?.citingCases ?? 0) - (a.metric?.citingCases ?? 0) || a.textRank - b.textRank
      : mode === "most_discussed"
        ? (b.metric?.distinctCitingParagraphs ?? 0) - (a.metric?.distinctCitingParagraphs ?? 0) ||
          (b.metric?.occurrences ?? 0) - (a.metric?.occurrences ?? 0) || a.textRank - b.textRank
        : b.score - a.score || a.textRank - b.textRank)
    .map(({ row, metric }) => ({ ...row, ...(metric && metric.citingCases > 0 ? { authority: {
      citingCases: metric.citingCases, citingParagraphs: metric.distinctCitingParagraphs,
      occurrences: metric.occurrences,
    } } : {}) }));
}

const provider: LegalSourceProvider<A2AJCompiledDocument> = {
  id: "a2aj",
  canResolve: (request, citations) => request.kind === "legislation" ||
    (request.kind === "case" && citations.some(({ jurisdiction }) => jurisdiction === "ca" || jurisdiction?.startsWith("ca-"))),
  async resolve(request) {
    const kind = request.kind === "legislation" ? "legislation" : "case";
    const found = await document({ citation: request.text,
      docType: kind === "legislation" ? "laws" : "cases",
      language: request.language, dataset: request.collection, signal: request.signal, discoverPdf: request.discoverPdf });
    return found ? [reference(found, kind)] : [];
  },
  async readPassage(request) {
    const docType = request.source.kind === "legislation" ? "laws" : "cases";
    const citation = request.source.citation || request.source.id;
    if (request.locator?.kind === "footnote") return [];
    const load = async (section?: string) => {
      const found = await document({ citation, docType,
        language: request.source.language,
        dataset: request.source.collection ?? undefined, section,
        sourceUrl: request.source.url,
        signal: request.signal, discoverPdf: request.discoverPdf });
      if (!found) return [];
      // A passage read by its locator is read from the document's structure: derived off this thread first.
      if (request.locator) await structureNative().readDocument(found.native);
      return nativeDocumentPassages({ request,
        reference: reference(found, request.source.kind as "case" | "legislation"),
        document: found.native, native: found });
    };
    const passages = await load();
    if (passages.length || docType !== "laws" ||
        request.locator?.kind !== "section") return passages;
    const label = request.locator.value.trim();
    return label ? load(label) : [];
  },
  canSearch(request) {
    return !isUnitedStatesSearch(request) &&
      request.kinds.some((kind) => kind === "case" || kind === "legislation");
  },
  async search(request) {
    const hits: LegalSourceSearchHit[] = [];
    for (const kind of ["case", "legislation"] as const) {
      if (!request.kinds.includes(kind)) continue;
      const docType = kind === "case" ? "cases" : "laws";
      const rows = (await search(request, docType))
        .map((row): LegalSourceSearchHit => ({ provider: "a2aj", id: row.citation, kind,
          title: row.name, citation: row.citation, alternateCitation: row.alternateCitation,
          date: row.date, collection: row.dataset, language: request.language === "fr" ? "fr" : "en",
          url: row.url, snippet: row.snippet }));
      hits.push(...(kind === "case" && ["relevance", "most_cited", "most_discussed"].includes(request.sort ?? "")
        ? rankCases(rows, request.sort as "relevance" | "most_cited" | "most_discussed") : rows));
    }
    return hits;
  },
};

export const a2ajLegalSourceProvider = Object.assign(provider, {
  document,
  viewer,
  coverage,
  clearCache: () => { documents.clear(); structureNative().lookupsForget(); },
});
