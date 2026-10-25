import crypto from "node:crypto";
import { cachedContent } from "../contentCache";
import { decisiaIndexUrl, verifiedDecisiaPdf,
  type VerifiedPdfEvidence } from "../legalSourcePresentation";
import { guardedRemoteFetch, networkFailure, RETRY_WAITS_MS, wait } from "../remoteUrlSafety";
import { a2ajStorePath, inSqliteRun, onSqliteRunEnd, storeExists, storeStat, useA2AJStore } from "../legalDataPath";
import { normalizeWhitespace } from "../text";
import { hasSearchOperators, searchFts5, searchLucene } from "../searchQuery";
import { nativeDocumentLive, structureNative, type A2AJStoreDocument, type A2AJStoreLookup,
  type NativeDocument } from "../structureNative";
import { objectValue as object } from "./remoteProvider";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import { indexedNumberedCase } from "./canlii";
import { isUnitedStatesSearch, keepLookupsLocal, lookupsLeaveComputer } from ".";
import type { LegalSourceProvider, LegalSourceReference, LegalSourceResolveRequest, LegalSourceSearchRequest } from ".";
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

const BASE_URL = "https://api.a2aj.ca";
const JURISDICTIONS = {
  FED: "Federal", AB: "Alberta", BC: "British Columbia", MB: "Manitoba",
  NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia",
  NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario",
  PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
} as const;
const TRIBUNALS = new Set([
  "CART", "CHRT", "CIRB", "CITT", "CT", "FPSLREB", "OHSTC", "OIC",
  "PSDPT", "RAD", "RLLR", "RPD", "SCT", "SST", "TATC",
]);
const documents = new Map<string, { expires: number; value: A2AJCompiledDocument }>();
// When each citation neither the store nor A2AJ holds may be asked for again: every step of a run cites it again.
const missing = new Map<string, number>();

// Some A2AJ texts carry Windows-1252 punctuation read as Latin-1 control characters ("\u0096" for "–"):
// the characters Windows-1252 puts at 0x80–0x9F, the five it leaves undefined kept as they are.
const WINDOWS_1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().replace(/[\u0080-\u009f]/gu,
    (character) => WINDOWS_1252[character.charCodeAt(0) - 0x80]) : null;

export type A2AJFailureReason = "rate-limited" | "error" | "timeout" | "unreachable" | "local-only";
/** A2AJ did not answer a lookup: the authority was not checked, which is not the same as not found. `transient`: no
 *  answer came, or A2AJ failed or held the lookup off, so asking again can answer it. */
export class A2AJUnavailable extends Error {
  constructor(readonly reason: A2AJFailureReason, readonly retryAt: number | null = null, detail?: string,
    readonly transient = reason === "rate-limited" || reason === "timeout" || reason === "unreachable") {
    super(detail || (reason === "rate-limited" ? "A2AJ is limiting requests."
      : reason === "timeout" ? "A2AJ did not answer in time."
      : reason === "unreachable" ? "A2AJ could not be reached."
      : reason === "local-only" ? "This source is not in the A2AJ corpus on this computer, and A2AJ is not asked while working locally only."
      : "A2AJ answered with an error."));
  }
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
  if (lookupsLeaveComputer() === !!options.localOnly) { documents.clear(); missing.clear(); }
  keepLookupsLocal(!!options.localOnly);
}
// A limit A2AJ sets (429, or a 503 that names a Retry-After) holds every lookup until it passes.
// Only a time A2AJ named is reported as when it allows lookups again; a hold of our own
// (a 429 without one, or one a page cannot read) is never presented as A2AJ's.
let paused = { until: 0, reason: "rate-limited" as A2AJFailureReason, named: false };
const pause = (reason: A2AJFailureReason, retryAfter: string | null, hold: number | null) => {
  const named = retryAt(retryAfter), until = named ?? (hold === null ? null : Date.now() + hold);
  if (until && until > paused.until) paused = { until, reason, named: !!named };
  return held(reason, named, until);
};
/** A lookup refused while a hold lasts, or that A2AJ failed (5xx), saying when lookups start again: A2AJ's own time
 *  when it named one, else the time of our own hold. Asking again can answer it. */
const held = (reason: A2AJFailureReason, named: number | null, until: number | null) => {
  const time = until && new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return new A2AJUnavailable(reason, named, reason !== "rate-limited" || !time ? undefined : named
    ? `A2AJ is limiting requests until ${time}.` : `A2AJ is limiting requests. Lookups start again at ${time}.`, true);
};
const retryAt = (value: string | null) => {
  const seconds = Number(value), date = value ? Date.parse(value) : NaN;
  const wait = value && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
    : Number.isFinite(date) ? date - Date.now() : null;
  return wait === null ? null : Date.now() + Math.min(Math.max(wait, 1000), 600_000);
};
/** The failure an answer from A2AJ stands for, or null when it answered the lookup. */
const refusal = (response: Response) => response.status === 429
  ? pause("rate-limited", response.headers.get("retry-after"), 60_000)
  : response.status >= 500 ? pause("error", response.headers.get("retry-after"), null) : null;

function apiError(status: number, body: unknown) {
  const detail = object(body)?.detail;
  const message = string(detail) ?? (Array.isArray(detail)
    ? detail.map((item) => string(object(item)?.msg)).filter(Boolean).join("; ")
    : "");
  return new A2AJUnavailable("error", null, message || `A2AJ API error (${status})`);
}

const A2AJ_POLICY = { label: "A2AJ request", allowedHosts: ["api.a2aj.ca"],
  defaultPortOnly: true, allowIpLiterals: false, timeoutMs: 15_000 };
/** One lookup sent to A2AJ, with every way it can go unanswered named for what it was. */
async function send(url: string, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await guardedRemoteFetch(url, { headers: { Accept: "application/json" }, signal }, {
      ...A2AJ_POLICY, response: { label: "A2AJ response", maxBytes: 64 * 1024 * 1024,
        contentTypes: ["application/json", "application/*+json"] } });
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as Error)?.name === "TimeoutError") throw new A2AJUnavailable("timeout");
    // A defect of our own keeps its own message; it is never blamed on A2AJ.
    if (!networkFailure(error)) throw error;
    // A page's fetch fails alike when nothing answered and when A2AJ answered without letting
    // the page read it, as its rate limit does: that 429 carries no CORS header, while every
    // answer A2AJ's API gives does. An opaque request resolves for any answer, which tells the
    // two apart; the limit's own Retry-After cannot be read, so it is held like a 429 without one.
    const answer = await guardedRemoteFetch(url, { method: "HEAD", mode: "no-cors", signal }, A2AJ_POLICY)
      .catch(() => null);
    signal?.throwIfAborted();
    if (!answer) throw new A2AJUnavailable("unreachable");
    await answer.body?.cancel().catch(() => undefined);
    if (answer.type === "opaque") throw pause("rate-limited", null, 60_000);
    throw refusal(answer) ?? new A2AJUnavailable("error", null,
      `A2AJ answered (${answer.status}) but the lookup failed: ${(error as Error).message}`);
  }
  const refused = refusal(response);
  if (refused) {
    await response.body?.cancel().catch(() => undefined);
    throw refused;
  }
  return response;
}

async function decisiaPdf(rawUrl: string | null, signal?: AbortSignal) {
  const index = rawUrl && decisiaIndexUrl(rawUrl);
  if (!index) return null;
  try {
    return await cachedContent<VerifiedPdfEvidence | null>({
      scope: "shared", kind: "legal-source-decisia-index", key: index.toString(),
      version: 2, ttlMs: 24 * 60 * 60_000,
      produce: async () => {
        const response = await guardedRemoteFetch(index.toString(), {
          headers: { Accept: "text/html,application/xhtml+xml" }, signal,
        }, {
          label: "Decisia index request", allowedHosts: [index.hostname],
          defaultPortOnly: true, allowIpLiterals: false, timeoutMs: 15_000,
          response: { label: "Decisia index response", maxBytes: 2_000_000,
            contentTypes: ["text/html", "application/xhtml+xml"] },
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        return verifiedDecisiaPdf(await response.text(), index);
      },
    });
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/** A citation searched as the words it is. A2AJ's full-text search reads brackets, parentheses,
 *  colons and the like as query syntax, and refuses "[2016] OJ No 1" as a query it cannot parse. */
const literalQuery = (text: string) => text.replace(/[+\-=&|<>!(){}[\]^"~*?:\\/]/gu, "\\$&");

// A2AJ's limits, as its API documents them (api.a2aj.ca/openapi.json): 1,000 requests an hour and 5,000 a day for an IP
// address. A request that would pass either waits as A2AJ's own limit would hold it, so A2AJ is never asked past them.
const LIMITS = [{ requests: 1000, ms: 60 * 60_000 }, { requests: 5000, ms: 24 * 60 * 60_000 }];
const sent: number[] = [];
function withinLimits() {
  const now = Date.now();
  while (sent.length && sent[0] <= now - LIMITS[1].ms) sent.shift();
  for (const { requests, ms } of LIMITS) {
    const recent = sent.filter((time) => time > now - ms);
    if (recent.length >= requests) throw pause("rate-limited", null, recent[0] + ms - now);
  }
  sent.push(now);
}

async function request(
  endpoint: "/fetch" | "/search" | "/coverage",
  params: Record<string, string | number | undefined>, signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!lookupsLeaveComputer()) throw new A2AJUnavailable("local-only");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const url = `${BASE_URL}${endpoint}?${query}`;
  const immutable = endpoint === "/fetch" && params.doc_type === "cases";
  const value = await cachedContent({
    scope: "shared", kind: "legal-source-a2aj", key: url, version: 1,
    ...(immutable ? {} : { ttlMs: 24 * 60 * 60_000 }),
    produce: async () => {
      // A lookup A2AJ left unanswered (no connection, no answer in time, a server error) is asked again after 1 s and
      // 4 s; one it holds off, when the hold ends, where that is within a minute. Past that its failure is the run's.
      for (let attempt = 1; ; attempt += 1) {
        signal?.throwIfAborted();
        try {
          if (Date.now() < paused.until) throw held(paused.reason, paused.named ? paused.until : null, paused.until);
          withinLimits();
          const response = await send(url, signal);
          const body = await response.json().catch(() => null);
          if (!response.ok) throw apiError(response.status, body);
          return object(body) ?? {};
        } catch (error) {
          const pause = error instanceof A2AJUnavailable && error.transient && attempt <= RETRY_WAITS_MS.length
            ? Math.max(RETRY_WAITS_MS[attempt - 1], paused.until - Date.now()) : Infinity;
          if (pause > 60_000) throw error;
          await wait(pause, signal);
        }
      }
    },
  });
  signal?.throwIfAborted();
  return value;
}

const citationKey = (value: string) => {
  try { return structureNative().citationLookupKey(value); } catch { return ""; }
};
// The records A2AJ's API answers with are read by the engine, as the store's rows are: the one answering a citation,
// the document it holds, a statute's provision, a search's listing.
const exactCitationRows = (results: unknown, citation: string, dataset?: string,
  expectedUrl?: string | null, aliases: string[] = []) => {
  const records = Array.isArray(results) ? results : [];
  return structureNative().a2ajRecordMatches(records, { citation, dataset, sourceUrl: expectedUrl, aliases })
    .map((at) => records[at]);
};
const recordDocument = (record: unknown, language: Language, docType: DocType) =>
  record ? structureNative().a2ajRecord(record, language, docType) : Promise.resolve(null);

const compiled = (metadata: Omit<A2AJCompiledDocument, "native" | "searchNative" | "searchText">,
  native: NativeDocument, searchNative: NativeDocument): A2AJCompiledDocument =>
  ({ ...metadata, searchText: () => structureNative().documentText(searchNative), searchNative, native });

// The store's documents an operation reads, held while it runs: the engine keeps a document only while it is held.
const running = new Set<A2AJCompiledDocument>();
// Its lookups too: each authority's forms ask the store for the same citations.
const lookups = new Map<string, Promise<A2AJStoreDocument | null>>();
onSqliteRunEnd(() => { running.clear(); lookups.clear(); });
async function storeDocument(lookup: A2AJStoreLookup) {
  if (!storeExists(a2ajStorePath())) return null;
  if (!inSqliteRun()) return structureNative().a2ajDocument(a2ajStorePath(), lookup);
  const key = JSON.stringify([a2ajStorePath(), lookup]);
  const ask = () => {
    const asked = structureNative().a2ajDocument(a2ajStorePath(), lookup);
    lookups.set(key, asked);
    return asked;
  };
  const kept = lookups.get(key);
  if (!kept) return ask();
  const found = await kept;
  // A document is lost with the engine that held it.
  return !found || nativeDocumentLive(found.native) ? found : ask();
}

async function document(args: {
  citation: string; docType?: DocType; language?: Language; dataset?: string;
  section?: string; sourceUrl?: string | null; signal?: AbortSignal;
  discoverPdf?: boolean;
}): Promise<A2AJCompiledDocument | null> {
  const citation = args.citation.trim();
  if (!citation) throw new Error("citation is required");
  args.signal?.throwIfAborted();
  const docType = args.docType ?? "cases";
  const language = args.language === "fr" ? "fr" : "en";
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
  if (section) {
    const full = await document({ ...args, section: undefined });
    if (!full) return null;
    // The store keeps each statute's sections; A2AJ is asked for one only when the store lacks the statute.
    const local = await structureNative().a2ajSection(a2ajStorePath(),
      { citation: full.citation, docType, language, dataset: full.dataset }, section, { citation: full.citation,
        url: full.url, alternateCitation: full.alternateCitation, dataset: full.dataset, name: full.name });
    let provision: NativeDocument | null = null;
    if (!local && lookupsLeaveComputer()) {
      const payload = await request("/fetch", {
        citation, doc_type: docType, output_language: language, section,
      }, args.signal);
      provision = await structureNative().a2ajRecordProvision(Array.isArray(payload.results) ? payload.results : [],
        { language, docType, dataset: args.dataset, sourceUrl: args.sourceUrl, section }, { citation: full.citation,
          url: full.url, alternateCitation: full.alternateCitation, dataset: full.dataset, name: full.name });
    }
    const result = local ? local.native ? { ...full, native: local.native } : full
      : provision ? { ...full, native: provision } : full;
    if (inSqliteRun()) running.add(result);
    documents.set(key, { expires: Date.now() + 60 * 60_000, value: result });
    return result;
  }
  // A decision cited by a CanLII number is found by the index each time: the index can change between runs.
  if ((missing.get(key) ?? 0) > Date.now()) return docType === "cases" ? numberedCase(args, citation, language) : null;
  const native = structureNative();
  const core = docType === "cases" ? native.citationOccurrencesInText(citation)
    .filter(({ kind }) => kind === "case").map(({ coreCitation }) => coreCitation.text) : [];
  // The Recueil des arrêts de la Cour suprême (R.C.S.) is the S.C.R. in French: same volume and page.
  const english = docType === "cases"
    ? citation.replace(/\bR\.?\s?C\.?\s?S\.?(?=\s+\d)/gu, "S.C.R.") : citation;
  const requested = [...new Set([citation, english, ...core])];
  const inventory = docType === "cases" ? structureNative().a2ajAliasGroups(a2ajStorePath(), requested) : [];
  if (!sourceUrl && inventory.some(({ ambiguous }) => ambiguous)) return null;
  const aliases = [...new Set(inventory.flatMap(({ keys }) => keys))];
  const forms = [...new Set([...requested, ...inventory.flatMap(({ forms }) => forms)])].slice(0, 12);
  const accept = (results: unknown, requestedCitation: string, exactKeys = aliases) => {
    const matches = exactCitationRows(results, requestedCitation, args.dataset, args.sourceUrl, exactKeys);
    // Distinct provider records with the same citation require an explicit URL.
    return matches.length === 1 ? matches[0] : null;
  };
  let local: A2AJStoreDocument | null = null, source: A2AJStoreDocument | null = null;
  for (const form of forms) {
    local = await storeDocument({ citation: form, docType, language, dataset: args.dataset,
      sourceUrl: args.sourceUrl ?? undefined });
    if (local) break;
  }
  // A2AJ is asked as the Python app asks it (a2aj_client.py, alr_quote_verifier.py): by citation alone, never with a
  // case's name before it, which only makes another request of each way it is written; for a court it holds; and
  // searched once, for the first form.
  const named = new Set(core.length ? [citation, english].filter((form) => !core.includes(form)) : []);
  const asked = local || !lookupsLeaveComputer() ? [] : await coveredForms(forms.filter((form) => !named.has(form)), docType, args.signal);
  if (!source) for (const form of asked) {
    args.signal?.throwIfAborted();
    const payload = await request("/fetch", { citation: form, doc_type: docType, output_language: language }, args.signal);
    source = await recordDocument(accept(payload.results, form), language, docType);
    if (source) break;
  }
  if (!source) for (const form of asked.slice(0, 1)) {
    const searched = await request("/search", { query: literalQuery(form), doc_type: docType,
      search_type: "full_text", search_language: language, size: 10, dataset: args.dataset?.trim() }, args.signal);
    const accepted = accept(searched.results, form);
    if (!accepted) continue;
    source = await recordDocument(accepted, language, docType);
    if (!source) {
      const canonical = structureNative().a2ajRecordListing(accepted, language)?.citation;
      if (canonical) {
        const retried = await request("/fetch", { citation: canonical, doc_type: docType, output_language: language }, args.signal);
        source = await recordDocument(accept(retried.results, canonical, [...aliases, citationKey(canonical)]), language,
          docType);
      }
    }
    if (source) break;
  }
  const found = local ?? source;
  if (!found) {
    missing.set(key, Date.now() + (docType === "cases" ? 24 * 60 * 60_000 : 60 * 60_000));
    if (missing.size > 4096) missing.delete(missing.keys().next().value!);
    return docType === "cases" ? numberedCase(args, citation, language) : null;
  }
  const verifiedPdf = args.discoverPdf === false || !lookupsLeaveComputer() ? null : await decisiaPdf(found.url, args.signal);
  let result: A2AJCompiledDocument;
  if (local) {
    const { native: provisions, searchNative, ...metadata } = local;
    result = compiled({ ...metadata, verifiedPdf }, provisions, searchNative);
  } else {
    // An answer's document gives its fields in this order, its PDF after its addresses.
    const { docType: kind, dataset, citation: cited, alternateCitation, name, date, url, publisherUrl, language: read,
      upstreamLicense, native: provisions, searchNative } = source!;
    result = compiled({ docType: kind, dataset, citation: cited, alternateCitation, name, date, url, publisherUrl,
      verifiedPdf, language: read, upstreamLicense }, provisions, searchNative);
  }
  if (inSqliteRun()) running.add(result);
  documents.set(key, {
    expires: Date.now() + (docType === "cases" ? 24 * 60 * 60_000 : 60 * 60_000),
    value: result,
  });
  if (documents.size > 32) documents.delete(documents.keys().next().value!);
  return result;
}

/** A decision cited by a CanLII number, which A2AJ never carries ("1991 CanLII 45 (SCC)"): the one decision A2AJ holds
 *  under the title the host's CanLII index gives the number, in its year, of its database's courts, as the Python
 *  app's identity_hints finds it. Null without an index, or where no one decision answers. */
async function numberedCase(args: Parameters<typeof document>[0], citation: string, language: Language) {
  const named = indexedNumberedCase(citation);
  if (!named) return null;
  const store = a2ajStorePath(), snapshot = storeExists(store) ? storeStat(store) : undefined;
  const key = JSON.stringify([named, language, store, snapshot?.size, snapshot?.mtimeMs]);
  let canonical = numbered.get(key);
  if (canonical === undefined) {
    canonical = snapshot ? structureNative().a2ajNamedCase(store, named) : null;
    if (!canonical && lookupsLeaveComputer()) {
      const searched = await request("/search", { query: named.name, doc_type: "cases", search_type: "name",
        search_language: language, size: 10 }, args.signal);
      const results = (Array.isArray(searched.results) ? searched.results : [])
        .map((item) => searchResult(item, language)).filter((item): item is A2AJSearchResult => !!item);
      const [wanted, ...names] = structureNative().a2ajNameKeys([named.name, ...results.map(({ name }) => name ?? "")]);
      const citations = new Set(results.filter(({ date, dataset }, index) => names[index] === wanted &&
        !!date?.startsWith(named.year) && (!named.courts.length || named.courts.some((court) => court.toUpperCase() === dataset.toUpperCase())))
        .map((result) => result.citation));
      canonical = citations.size === 1 ? [...citations][0] : null;
    }
    numbered.set(key, canonical);
    if (numbered.size > 4096) numbered.delete(numbered.keys().next().value!);
  }
  return canonical ? document({ ...args, citation: canonical }) : null;
}
// Each CanLII number's decision, found once: a workbook cites a decision in many notes, and A2AJ limits its requests.
const numbered = new Map<string, string | null>();

function searchResult(value: unknown, language: Language) {
  const listing = structureNative().a2ajRecordListing(value, language);
  return listing && { ...listing, snippet: listing.snippet?.slice(0, 1200) ?? null };
}

export type A2AJSearchResult = NonNullable<ReturnType<typeof searchResult>>;

async function search(input: LegalSourceSearchRequest, docType: DocType) {
  const query = input.text.trim();
  if (!query) throw new Error("query is required");
  const language = input.language === "fr" ? "fr" : "en";
  const size = input.perProviderLimit ?? input.limit;
  const sortResults = input.sort === "newest" ? "newest_first" as const
    : input.sort === "oldest" ? "oldest_first" as const : "default" as const;
  const local = structureNative().a2ajSearch(a2ajStorePath(), { query, docType, language, size, sortResults,
    searchType: input.searchType, dataset: input.collection, startDate: input.dateFrom, endDate: input.dateTo,
    match: searchFts5(query), operators: hasSearchOperators(query) });
  if (local !== null) return local;
  const payload = await request("/search", {
    query: searchLucene(query), doc_type: docType, search_type: input.searchType ?? "full_text",
    search_language: language, size: Math.min(Math.max(Math.floor(size ?? 10), 1), 50),
    dataset: input.collection?.trim(), start_date: input.dateFrom?.trim(),
    end_date: input.dateTo?.trim(), sort_results: sortResults,
  }, input.signal);
  return (Array.isArray(payload.results) ? payload.results : [])
    .map((item) => searchResult(item, language))
    .filter((item): item is A2AJSearchResult => !!item).slice(0, 50);
}

function jurisdiction(dataset: string, docType: DocType): keyof typeof JURISDICTIONS {
  if (docType === "laws") {
    const suffix = dataset.toUpperCase().match(/-([A-Z]{2,3})$/u)?.[1];
    if (suffix === "YK") return "YT";
    return suffix && suffix in JURISDICTIONS ? suffix as keyof typeof JURISDICTIONS : "FED";
  }
  const prefix = dataset.toUpperCase().slice(0, 2);
  if (prefix === "YK") return "YT";
  return prefix in JURISDICTIONS && prefix !== "FE"
    ? prefix as keyof typeof JURISDICTIONS : "FED";
}

/** The forms A2AJ is asked for, as the Python app asks it (alr_quote_verifier.py _a2aj_identity_citation and its
 *  coverage check): a neutral citation of a court A2AJ holds, or a Supreme Court Reports citation; a CanLII number, a
 *  US or other reporter is asked for only by such a form among its aliases. Legislation is asked for only where the
 *  citation names a Canadian jurisdiction whose legislation A2AJ holds: a US register or a bill is not. Where A2AJ's
 *  coverage cannot be read, every form of those kinds. */
async function coveredForms(forms: string[], docType: DocType, signal?: AbortSignal) {
  if (!forms.length) return forms;
  const rows = await coverage(docType).catch(() => []);
  signal?.throwIfAborted();
  if (docType === "laws") {
    const held = new Set(rows.map(({ jurisdictionCode }) => jurisdictionCode));
    const code = (form: string) => {
      const place = structureNative().providerCitationsInText(form).find(({ family }) => family === "statute")?.jurisdiction;
      return place === "ca" ? "FED" : place?.startsWith("ca-") ? place.slice(3).toUpperCase().replace(/^YK$/u, "YT") : undefined;
    };
    return forms.filter((form) => { const at = code(form); return !!at && (!held.size || held.has(at as keyof typeof JURISDICTIONS)); });
  }
  const held = new Set(rows.map(({ dataset }) => dataset));
  const dataset = (form: string) => {
    const cite = structureNative().providerCitationsInText(form)[0];
    const court = cite?.court?.replace(/[\s.]+/gu, "").toUpperCase();
    return cite?.family === "neutral" ? court : cite?.family === "reporter" && court === "SCR" ? "SCC" : undefined;
  };
  return forms.filter((form) => { const code = dataset(form); return !!code && (!held.size || held.has(code)); });
}

// A2AJ's courts and jurisdictions change rarely: a list is kept a day, a failed or empty one five minutes.
const covered = new Map<DocType, { expires: number; value: ReturnType<typeof readCoverage> }>();
function coverage(docType: DocType) {
  const kept = covered.get(docType);
  if (kept && kept.expires > Date.now()) return kept.value;
  const value = readCoverage(docType);
  covered.set(docType, { expires: Date.now() + 5 * 60_000, value });
  value.then((rows) => { if (rows.length) covered.set(docType, { expires: Date.now() + 24 * 60 * 60_000, value }); },
    () => undefined);
  return value;
}

async function readCoverage(docType: DocType) {
  const payload = await request("/coverage", { doc_type: docType });
  return (Array.isArray(payload.results) ? payload.results : []).flatMap((value) => {
    const record = object(value);
    const dataset = string(record?.dataset)?.toUpperCase();
    if (!record || !dataset) return [];
    const code = jurisdiction(dataset, docType);
    const count = Number.parseInt(String(record.number_of_documents ?? "0"), 10);
    return [{
      dataset,
      description: string(record.description_en) ?? string(record.description_fr) ?? dataset,
      descriptionFr: string(record.description_fr), docType,
      jurisdictionCode: code, jurisdiction: JURISDICTIONS[code],
      sourceKind: docType === "laws"
        ? dataset.startsWith("REGULATIONS-") ? "regulation" as const : "legislation" as const
        : TRIBUNALS.has(dataset) || /\b(?:board|commissioner|division|reporter|tribunal)\b/iu
          .test(string(record.description_en) ?? "") ? "tribunal" as const : "court" as const,
      earliestDate: string(record.earliest_document_date),
      latestDate: string(record.latest_document_date),
      documentCount: Number.isFinite(count) ? count : 0,
    }];
  }).sort((left, right) => left.jurisdiction.localeCompare(right.jurisdiction) ||
    left.description.localeCompare(right.description));
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
      outline: docType === "cases" ? structureNative().documentCaseOutline(compiled)
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
  canResolve: (request: LegalSourceResolveRequest) => request.kind === "legislation" ||
    (request.kind === "case" && structureNative().providerCitationsInText(request.text)
      .some(({ jurisdiction }) => jurisdiction === "ca" || jurisdiction?.startsWith("ca-"))),
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
  jurisdictions: JURISDICTIONS,
  document,
  viewer,
  coverage,
  clearCache: () => { documents.clear(); missing.clear(); numbered.clear(); paused = { until: 0, reason: "rate-limited", named: false }; sent.length = 0; },
});
