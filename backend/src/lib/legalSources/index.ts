export type LegalSourceKind = "case" | "legislation" | "journal" | "hansard";

export type LegalSourceLocator = {
  kind: "paragraph" | "section" | "page" | "footnote";
  value: string;
  endValue?: string;
};

export type LegalSourceReference = {
  provider: string;
  family?: string;
  id: string;
  part?: string;
  kind: LegalSourceKind;
  title?: string | null;
  citation?: string | null;
  alternateCitation?: string | null;
  date?: string | null;
  collection?: string | null;
  language?: "en" | "fr";
  url?: string | null;
};

export type LegalSourceSearchRequest = {
  text: string;
  kinds: readonly LegalSourceKind[];
  providers?: readonly string[];
  syntax?: "terms" | "fts5";
  jurisdiction?: string | null;
  collection?: string;
  court?: string;
  speaker?: string;
  author?: string;
  journal?: string;
  language?: "en" | "fr";
  searchType?: "full_text" | "name";
  dateFrom?: string;
  dateTo?: string;
  sort?: "relevance" | "most_cited" | "most_discussed" | "newest" | "oldest";
  limit?: number;
  perProviderLimit?: number;
  signal?: AbortSignal;
};

export type LegalSourceSearchHit = LegalSourceReference & {
  snippet?: string | null;
  authors?: string | null;
  speaker?: string | null;
  passageStart?: number;
  passageEnd?: number;
  authority?: {
    citingCases: number;
    citingParagraphs: number;
    occurrences: number;
  };
};

export type LegalSourceResolveRequest = {
  text: string;
  kind: LegalSourceKind;
  alternateTexts?: readonly string[];
  collection?: string;
  language?: "en" | "fr";
  signal?: AbortSignal;
};

export type LegalSourcePassageRequest = {
  source: LegalSourceReference;
  locator?: LegalSourceLocator;
  contextBlocks?: number;
  signal?: AbortSignal;
};

export type LegalSourcePassage<Artifact = unknown, Native = unknown> = {
  source: LegalSourceReference;
  locator: {
    requested: LegalSourceLocator | null;
    label: string;
    anchor?: string | null;
    pageScoped?: boolean;
  };
  role: "selected" | "context" | "document";
  text: string;
  textSha256: string;
  documentSha256: string;
  revision: string;
  blockArtifact?: Artifact;
  documentArtifact?: Artifact;
  native?: Native;
};

export type LegalSourceMatchResult<Value> =
  | { status: "found"; value: Value }
  | { status: "ambiguous"; providers: string[] }
  | { status: "not_found" | "unsupported"; providers: string[] };

export type LegalSourceReadResult<Artifact = unknown, Native = unknown> =
  | {
      status: "found";
      values: LegalSourcePassage<Artifact, Native>[];
    }
  | { status: "not_found" | "unsupported"; providers: string[] };

export type LegalSourceProvider<Artifact = unknown, Native = unknown> = {
  id: string;
  canResolve?: (request: LegalSourceResolveRequest) => boolean;
  resolve?: (
    request: LegalSourceResolveRequest,
  ) => Promise<readonly LegalSourceReference[]>;
  canSearch?: (request: LegalSourceSearchRequest) => boolean;
  search?: (
    request: LegalSourceSearchRequest,
  ) => Promise<readonly LegalSourceSearchHit[]>;
  readPassage?: (
    request: LegalSourcePassageRequest,
  ) => Promise<readonly LegalSourcePassage<Artifact, Native>[]>;
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

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

export function createLegalSourceRegistry<Artifact = unknown, Native = unknown>(
  providers: readonly LegalSourceProvider<Artifact, Native>[],
) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  if (byId.size !== providers.length) {
    throw new Error("Legal source provider ids must be unique");
  }

  return {
    async search(request: LegalSourceSearchRequest) {
      throwIfAborted(request.signal);
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
            throwIfAborted(request.signal);
            return { provider: provider.id, hits };
          } catch (error) {
            if (request.signal?.aborted) throw error;
            return {
              provider: provider.id,
              error: error instanceof Error ? error.message : "unavailable",
            };
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
      throwIfAborted(request.signal);
      const selected = providers.filter(
        (provider) =>
          provider.resolve && (provider.canResolve?.(request) ?? true),
      );
      if (!selected.length) return { status: "unsupported", providers: [] };
      const matches = (
        await Promise.all(selected.map(async (provider) => {
          const matches = await provider.resolve!(request);
          throwIfAborted(request.signal);
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
    ): Promise<LegalSourceReadResult<Artifact, Native>> {
      throwIfAborted(request.signal);
      const provider = byId.get(request.source.provider);
      if (!provider?.readPassage) {
        return { status: "unsupported", providers: [request.source.provider] };
      }
      const matches = await provider.readPassage(request);
      throwIfAborted(request.signal);
      if (!matches.length) {
        return { status: "not_found", providers: [provider.id] };
      }
      return { status: "found", values: [...matches] };
    },
  };
}

export type LegalSourceRegistry<Artifact = unknown, Native = unknown> = ReturnType<
  typeof createLegalSourceRegistry<Artifact, Native>
>;
