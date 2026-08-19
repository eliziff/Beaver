import {
  searchLegalSources,
} from "../../legalSourceRegistry";
import type { Tool } from "../../llm";
import { resourceReference } from "../../resourceReferences";

export const SEARCH_SOURCES_TOOL_NAME = "search_sources";

export const SEARCH_SOURCES_TOOL: Tool = {
  name: SEARCH_SOURCES_TOOL_NAME,
  annotations: { readOnlyHint: true },
  description:
    "Default discovery tool for requests about cases, legislation, journal commentary, Hansard, or legal authorities. Searches one or two installed legal-source corpora, not the user's uploaded Library. Apply filters here, start near 10 hits, then fetch plausible sources; refine instead of paging broadly. Exact known citations should be fetched directly. Results use SQLite FTS5/BM25 and are not evidence.",
  inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Terms, or SQLite FTS5 syntax when syntax=boolean: quoted phrases, prefix*, NEAR(...), AND, OR, NOT, and parentheses.",
        },
        source_types: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["case", "legislation", "journal", "hansard"],
          },
          description:
            "One or more corpora to search. Choose only the corpora relevant to the question.",
        },
        syntax: {
          type: "string",
          enum: ["terms", "boolean"],
          description: "terms is the default; boolean uses native FTS5 syntax.",
        },
        jurisdiction: {
          type: "string",
          description:
            "Country routing: US/United States or CA/Canada. Use collection for an exact court, tribunal, or legislation dataset.",
        },
        collection: {
          type: "string",
          description:
            "Exact installed dataset or court collection code, such as ONCA. Availability is corpus-dependent.",
        },
        court: {
          type: "string",
          description: "Exact CourtListener court code when its indexed/API field is available.",
        },
        court_level: {
          type: "string",
          enum: ["supreme", "appellate", "trial", "tribunal"],
          description:
            "Requires an installed source index with court-level metadata; otherwise the tool refuses this filter.",
        },
        speaker: {
          type: "string",
          description: "Speaker-name substring for Hansard.",
        },
        date_from: { type: "string", description: "Inclusive YYYY-MM-DD lower bound." },
        date_to: { type: "string", description: "Inclusive YYYY-MM-DD upper bound." },
        sort: {
          type: "string",
          enum: ["relevance", "most_cited", "most_discussed", "newest", "oldest"],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Candidate count. Start with 10 and narrow the query before requesting more.",
        },
      },
      required: ["query", "source_types"],
      additionalProperties: false,
  },
};

type Hit = Record<string, unknown>;

type CachedSearch = { expires: number; value: Record<string, unknown> };
const searchCache = new Map<string, CachedSearch>();
const SEARCH_CACHE_MS = 5 * 60_000;
const MAX_SEARCH_CACHE = 128;

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

function date(value: unknown, name: string) {
  const parsed = text(value);
  if (parsed && !/^\d{4}-\d{2}-\d{2}$/u.test(parsed)) {
    throw new Error(`${name} must be YYYY-MM-DD`);
  }
  return parsed || undefined;
}

function sourceTypes(value: unknown) {
  const allowed = new Set(["case", "legislation", "journal", "hansard"]);
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const valid = selected.filter((item) => allowed.has(item));
  if (!valid.length) throw new Error("source_types must select at least one corpus");
  const unique = new Set(valid);
  if (unique.size > 2) throw new Error("source_types may select at most two corpora");
  return unique;
}

function country(value: unknown) {
  const folded = text(value).toLowerCase().replace(/[^a-z]/gu, "");
  if (!folded) return null;
  if (["us", "usa", "unitedstates", "unitedstatesofamerica"].includes(folded)) {
    return "US" as const;
  }
  if (["ca", "canada", "canadian"].includes(folded)) return "CA" as const;
  return "unsupported" as const;
}

export async function searchSources(
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const query = text(args.query);
  if (!query) throw new Error("query is required");
  if (query.length > 256) throw new Error("query must be at most 256 characters");
  if (/\b[\p{L}\p{N}]{1,2}\*/u.test(query)) {
    throw new Error("prefix terms must contain at least three characters");
  }
  if (args.court_level) {
    throw new Error(
      "court_level is unavailable: no installed search index exposes reliable court-level metadata",
    );
  }
  const jurisdiction = country(args.jurisdiction);
  if (jurisdiction === "unsupported") {
    throw new Error("jurisdiction is unavailable in the installed source indexes");
  }
  const types = sourceTypes(args.source_types);
  const syntax = args.syntax === "boolean" ? "fts5" : "terms";
  const startDate = date(args.date_from, "date_from");
  const endDate = date(args.date_to, "date_to");
  const limit = Math.max(1, Math.min(20, Math.trunc(Number(args.limit) || 10)));
  const perProvider = Math.min(20, Math.max(limit, 10));
  const requestedSort =
    args.sort === "most_cited" || args.sort === "most_discussed"
      ? args.sort
      : args.sort === "newest" || args.sort === "oldest"
        ? args.sort
        : "relevance";
  const cacheKey = JSON.stringify([
    query,
    [...types].sort(),
    syntax,
    jurisdiction,
    text(args.collection),
    text(args.court),
    text(args.speaker),
    startDate,
    endDate,
    requestedSort,
    limit,
  ]);
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, cached);
    return cached.value;
  }
  const searched = await searchLegalSources({
    text: query,
    kinds: [...types] as Array<"case" | "legislation" | "journal" | "hansard">,
    syntax,
    jurisdiction,
    collection: text(args.collection) || undefined,
    court: text(args.court) || undefined,
    speaker: text(args.speaker) || undefined,
    dateFrom: startDate,
    dateTo: endDate,
    sort: requestedSort,
    limit,
    perProviderLimit: perProvider,
    signal,
  });
  const unavailable = searched.unavailable.map(
    ({ provider, message }) => `${provider}: ${message}`,
  );
  const results: Hit[] = searched.results.map((row) => {
      const resource =
        row.provider === "a2aj"
          ? resourceReference.source(
              "a2aj",
              JSON.stringify([
                row.id,
                row.kind === "legislation" ? "laws" : "cases",
                row.collection ?? "",
              ]),
            )
          : resourceReference.source(row.provider, row.id);
      return {
        provider: row.provider,
        source_type: row.kind,
        identifier: row.id,
        title: row.title,
        citation: row.citation,
        alternate_citation: row.alternateCitation,
        date: row.date,
        collection: row.collection,
        authors: row.authors,
        speaker: row.speaker,
        snippet: row.snippet,
        passage_start: row.passageStart,
        passage_end: row.passageEnd,
        resource,
        ...(row.authority
          ? {
              citation_signal: {
                citing_cases: row.authority.citingCases,
                citing_paragraphs: row.authority.citingParagraphs,
                occurrences: row.authority.occurrences,
              },
            }
          : {}),
      };
  });
  const value = {
    ok: results.length > 0 || unavailable.length === 0,
    query,
    ranking:
      requestedSort === "relevance"
        ? "provider BM25/relevance with a 15% citator RRF signal where available"
        : requestedSort,
    results,
    ...(unavailable.length ? { unavailable } : {}),
  };
  searchCache.set(cacheKey, { expires: Date.now() + SEARCH_CACHE_MS, value });
  if (searchCache.size > MAX_SEARCH_CACHE) {
    searchCache.delete(searchCache.keys().next().value!);
  }
  return value;
}
