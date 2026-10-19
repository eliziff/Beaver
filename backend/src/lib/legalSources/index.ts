import { type LegalSourceSearchHit } from "mike/shared/runtime/clientContracts.mjs";
import { safeErrorLog } from "../safeError";
import { ApplicationError } from "../applicationError";
import { searchMatcher } from "../searchQuery";
import type { NativeDocument, NativeDocumentBlock } from "../structureNative";

export type LegalSourceKind = "case" | "legislation" | "journal" | "hansard";

export type LegalSourceLocator = {
  kind: "paragraph" | "section" | "page" | "footnote";
  value: string;
  endValue?: string;
};

export { legalSourceReferenceSchema, type LegalSourceReference } from "mike/shared/runtime/legalSourceReference.mjs";
import type { LegalSourceReference } from "mike/shared/runtime/legalSourceReference.mjs";

export type LegalSourceSearchRequest = {
  /** The search in the shared syntax (searchQuery.ts, CanLII's): words are all required; quotes, OR, NOT or -, * and
   *  brackets as CanLII reads them. Each store compiles it for its own index. */
  text: string;
  kinds: readonly LegalSourceKind[];
  providers?: readonly string[];
  jurisdiction?: string | null;
  /** A court, tribunal or legislation collection code (ONCA, SCC, LEGISLATION-ON, a CourtListener court id). */
  collection?: string;
  speaker?: string;
  author?: string;
  journal?: string;
  language?: "en" | "fr";
  /** name: only what names a source (case name, title, citation), as CanLII's second search box reads. */
  searchType?: "full_text" | "name";
  dateFrom?: string;
  dateTo?: string;
  sort?: "relevance" | "most_cited" | "most_discussed" | "newest" | "oldest";
  /** False: the results are wanted in any order. */
  ordered?: boolean;
  limit?: number;
  perProviderLimit?: number;
  signal?: AbortSignal;
};

/** A request's jurisdiction hint, case-folded and reduced to letters. */
export function searchJurisdiction(request: Pick<LegalSourceSearchRequest, "jurisdiction">) {
  return request.jurisdiction?.toLocaleLowerCase().replace(/[^a-z]/gu, "") ?? "";
}

/** The spellings a request may use for the United States, in one place. */
export function isUnitedStatesSearch(request: Pick<LegalSourceSearchRequest, "jurisdiction">) {
  return ["us", "usa", "unitedstates", "unitedstatesofamerica"]
    .includes(searchJurisdiction(request));
}

export type LegalSourceResolveRequest = {
  text: string;
  kind: LegalSourceKind;
  alternateTexts?: readonly string[];
  collection?: string;
  language?: "en" | "fr";
  /** Only these providers answer, when given. */
  providers?: readonly string[];
  /** False: no provider looks for a publisher's PDF of the source. */
  discoverPdf?: boolean;
  signal?: AbortSignal;
};

// "Use only local data": while it holds, a provider that would ask a host on the network is not a place a lookup
// looks, as the Python app's local-only run asks none.
let local = false;
export const keepLookupsLocal = (value: boolean) => { local = value; };
// A runtime that cannot reach the US and UK publishers' hosts (AuthoritiesHelper's page built without them) looks
// for no decision there, as a draft that leaves them out looks for none: their providers are not asked.
let foreignCaseHosts = true;
export const reachForeignCaseHosts = (value: boolean) => { foreignCaseHosts = value; };
export const lookupsLeaveComputer = (provider?: string) =>
  !local && (foreignCaseHosts || !FOREIGN_CASE_PROVIDERS.has(provider ?? ""));

/** The providers of US and UK decisions, which a draft can leave out (its foreignCaseLookup setting). */
export const FOREIGN_CASE_PROVIDERS: ReadonlySet<string> = new Set(["courtlistener", "tna", "govuk-et", "govinfo"]);

export type LegalSourcePassageRequest = {
  source: LegalSourceReference;
  locator?: LegalSourceLocator;
  contextBlocks?: number;
  /** False: no provider looks for a publisher's PDF of the source. */
  discoverPdf?: boolean;
  signal?: AbortSignal;
};

export type LegalSourcePassage<Native = unknown> = {
  source: LegalSourceReference;
  locator: {
    requested: LegalSourceLocator | null;
    label: string;
    anchor?: string | null;
    pageScoped?: boolean;
  };
  role: "selected" | "context" | "document";
  text: string;
  blockArtifact?: NativeDocumentBlock;
  documentArtifact: NativeDocument;
  native?: Native;
};

export type LegalSourceMatchResult<Value> =
  | { status: "found"; value: Value }
  | { status: "ambiguous"; providers: string[] }
  | { status: "not_found" | "unsupported"; providers: string[] };

export type LegalSourceReadResult<Native = unknown> =
  | {
      status: "found";
      values: LegalSourcePassage<Native>[];
    }
  | { status: "not_found" | "unsupported"; providers: string[] };

export type LegalSourceProvider<Native = unknown> = {
  id: string;
  canResolve?: (request: LegalSourceResolveRequest) => boolean;
  resolve?: (
    request: LegalSourceResolveRequest,
  ) => Promise<readonly LegalSourceReference[]>;
  canSearch?: (request: LegalSourceSearchRequest) => boolean;
  /** null means the optional corpus is not installed; [] means no matches. */
  search?: (
    request: LegalSourceSearchRequest,
  ) => Promise<readonly LegalSourceSearchHit[] | null>;
  readPassage?: (
    request: LegalSourcePassageRequest,
  ) => Promise<readonly LegalSourcePassage<Native>[]>;
};

function roundRobin(groups: readonly (readonly LegalSourceSearchHit[])[], limit: number) {
  const results: LegalSourceSearchHit[] = [];
  for (let rank = 0; results.length < limit; rank += 1) {
    let added = false;
    for (const group of groups) {
      const hit = group[rank];
      if (!hit) continue;
      results.push(hit);
      added = true;
      if (results.length === limit) break;
    }
    if (!added) break;
  }
  return results;
}

export function createLegalSourceRegistry<Native = unknown>(
  providers: readonly LegalSourceProvider<Native>[],
) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  if (byId.size !== providers.length) {
    throw new Error("Legal source provider ids must be unique");
  }

  return {
    providerIds: providers.map(({ id }) => id),
    async search(request: LegalSourceSearchRequest) {
      request.signal?.throwIfAborted();
      if (!searchMatcher(request.text)) throw new ApplicationError(400, "The query could not be read: close each quotation mark and bracket, and give each AND, OR and NOT a term on both sides.");
      const selected = providers.filter(
        (provider) =>
          provider.search &&
          (provider.canSearch?.(request) ?? true) &&
          (!request.providers || request.providers.includes(provider.id)),
      );
      const settled = await Promise.all(
        selected.map(async (provider) => {
          try {
            const hits = await provider.search!(request);
            request.signal?.throwIfAborted();
            if (hits === null) return { provider: provider.id, error: "not_installed" };
            return { provider: provider.id, hits };
          } catch (error) {
            // A request the asker must correct reaches them; any other failure leaves that provider out.
            if (request.signal?.aborted || error instanceof ApplicationError) throw error;
            console.warn("[legal-source] provider unavailable", {
              provider: provider.id, ...safeErrorLog(error),
            });
            return { provider: provider.id, error: "unavailable" };
          }
        }),
      );
      const unavailable = settled.flatMap((result) =>
        "error" in result ? [{ provider: result.provider, message: result.error }] : [],
      );
      const groups = settled.flatMap((result) => {
        if (!("hits" in result) || !result.hits) return [];
        const byKind = new Map<LegalSourceKind, LegalSourceSearchHit[]>();
        for (const hit of result.hits) {
          const group = byKind.get(hit.kind) ?? [];
          group.push(hit);
          byKind.set(hit.kind, group);
        }
        return request.kinds.flatMap((kind) => {
          const group = byKind.get(kind);
          return group?.length ? [group] : [];
        });
      });
      const limit = Math.max(1, Math.min(50, Math.trunc(request.limit ?? 10)));
      return { results: roundRobin(groups, limit), unavailable };
    },

    async resolve(
      request: LegalSourceResolveRequest,
    ): Promise<LegalSourceMatchResult<LegalSourceReference>> {
      request.signal?.throwIfAborted();
      const selected = providers.filter(
        (provider) =>
          provider.resolve && (provider.canResolve?.(request) ?? true) &&
          (!request.providers || request.providers.includes(provider.id)),
      );
      if (!selected.length) return { status: "unsupported", providers: [] };
      const matches = (
        await Promise.all(selected.map(async (provider) => {
          const matches = await provider.resolve!(request);
          request.signal?.throwIfAborted();
          return matches;
        }))
      ).flat();
      const unique = [
        ...new Map(matches.map((source) => [`${source.provider}\n${source.id}`, source])).values(),
      ];
      if (!unique.length) {
        return { status: "not_found", providers: selected.map(({ id }) => id) };
      }
      if (unique.length > 1) {
        return {
          status: "ambiguous",
          providers: [...new Set(unique.map(({ provider }) => provider))],
        };
      }
      return { status: "found", value: unique[0] };
    },

    async readPassage(
      request: LegalSourcePassageRequest,
    ): Promise<LegalSourceReadResult<Native>> {
      request.signal?.throwIfAborted();
      const provider = byId.get(request.source.provider);
      if (!provider?.readPassage) {
        return { status: "unsupported", providers: [request.source.provider] };
      }
      const matches = await provider.readPassage(request);
      request.signal?.throwIfAborted();
      if (!matches.length) {
        return { status: "not_found", providers: [provider.id] };
      }
      return { status: "found", values: [...matches] };
    },
  };
}
