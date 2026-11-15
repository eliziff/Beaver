import path from "node:path";
import { answered, lookupsLeaveComputer, searchJurisdiction } from ".";
import type { LegalSourceProvider, LegalSourceReference } from ".";
import { legalProviderDatabase, storeExists } from "../legalDataPath";
import { structureNative } from "../structureNative";
import type { CourtListenerCase } from "mike/shared/engine-types/CourtListenerCase";
import type { RemoteOutcome } from "mike/shared/engine-types/RemoteOutcome";
import { nativeDocumentPassages } from "./nativeDocumentPassages";

/** Where the engine reads CourtListener (legal-structure-features courtlistener.rs): its bulk store on this computer,
 *  the API key from the environment, and whether lookups may leave the computer. */
function access() {
  const configured = process.env.MIKE_COURTLISTENER_BULK_DB?.trim();
  return { store: configured ? path.resolve(configured) : legalProviderDatabase("courtlistener", "courtlistener.sqlite"),
    token: process.env.COURTLISTENER_API_TOKEN?.trim() || null, remote: lookupsLeaveComputer("courtlistener") };
}

async function read<T>(lookup: Promise<RemoteOutcome<T>>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const value = answered(await lookup, "CourtListener");
  signal?.throwIfAborted();
  return value;
}

/** Whether the opinion was read from CourtListener's own markup, not reckoned from its text alone. */
const hasNativeOpinionStructure = (opinion: CourtListenerCase["opinions"][number]) =>
  !!opinion.native && structureNative().documentHasOrigin(opinion.native, "native");

const provider: LegalSourceProvider<{ case: CourtListenerCase }> = {
  id: "courtlistener",
  // CourtListener answers a citation lookup only with an API key (401 without one): with neither its bulk copy here
  // nor a key it is not asked, as a page that cannot reach it asks it nothing.
  canResolve: (request, citations) => {
    const { store, token, remote } = access();
    return request.kind === "case" && (storeExists(store) || remote && token !== null)
      && citations.some(({ jurisdiction }) => jurisdiction === "us");
  },
  async resolve(request) {
    const cluster = await read(structureNative().courtlistenerCluster(access(), request.text), request.signal);
    return cluster ? [{ provider: "courtlistener", id: String(cluster), kind: "case", citation: request.text }] : [];
  },
  canSearch: (request) => request.kinds.includes("case") && !["ca", "canada", "canadian"].includes(searchJurisdiction(request)),
  async search(request) {
    if (!request.text.trim()) return [];
    const hits = await read(structureNative().courtlistenerSearch(access(), { query: request.text, court: request.collection,
      filedAfter: request.dateFrom, filedBefore: request.dateTo, limit: request.perProviderLimit ?? request.limit }), request.signal);
    return hits.flatMap((hit) => hit.clusterId ? [{ provider: "courtlistener", id: String(hit.clusterId), kind: "case" as const,
      title: hit.caseName, citation: hit.citation, date: hit.dateFiled, collection: hit.court, url: hit.url, snippet: hit.snippet }] : []);
  },
  async readPassage(request) {
    const cluster = Number(request.source.id), wanted = request.source.part ? Number(request.source.part) : undefined;
    if (!Number.isSafeInteger(cluster) || cluster <= 0 || (wanted !== undefined && (!Number.isSafeInteger(wanted) || wanted <= 0))) return [];
    const found = await read(structureNative().courtlistenerCase(access(), cluster, wanted ?? null), request.signal);
    if (!found) return [];
    return found.opinions.flatMap((opinion) => {
      const url = opinion.url ?? found.url;
      if (!opinion.native || (wanted !== undefined && opinion.id !== wanted)) return [];
      const reference = { ...request.source, title: found.caseName ?? request.source.title, date: found.dateFiled ?? request.source.date,
        url, ...(opinion.id ? { part: String(opinion.id) } : {}) } satisfies LegalSourceReference;
      return nativeDocumentPassages({ request, reference, document: opinion.native, native: { case: found } });
    });
  },
};

/** Case metadata, PDF and full opinion text for one US reporter citation. A single cluster is this provider's
 *  uniqueness rule: a citation matching several clusters, or none, is refused rather than picked between. */
async function caseSource(citation: string, signal?: AbortSignal) {
  const cluster = await read(structureNative().courtlistenerCluster(access(), citation), signal);
  const found = cluster && await read(structureNative().courtlistenerCase(access(), cluster, null), signal);
  if (!found) return null;
  return { id: String(found.id), date: found.dateFiled, url: found.url, title: found.caseName, pdfUrl: found.pdfUrl,
    citation: found.citations[0] ?? citation,
    text: found.opinions.flatMap(({ native }) => native ? [structureNative().documentText(native)] : []).join("\n\n") };
}

export const courtlistenerLegalSourceProvider = Object.assign(provider, { caseSource, hasNativeOpinionStructure });
