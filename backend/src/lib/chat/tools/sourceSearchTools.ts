import { ApplicationError } from "../../applicationError";
import { legalSourceOperations } from "../../legalSourceApplication";
import type { Tool } from "../../llm";
import { researchSourceResource } from "../../researchFile";
import { trimmedText as text } from "../../value";
import { objectSchema, type BeaverToolPolicy } from "../toolRegistry";

const SEARCH_SOURCES_TOOL_NAME = "search_sources";

export const SEARCH_SOURCES_TOOL: Tool & BeaverToolPolicy = {
  name: SEARCH_SOURCES_TOOL_NAME,
  research: true,
  reader: ["CA", "US"],
  annotations: { readOnlyHint: true },
  description:
    "Search installed legal sources: one query matched against each source's name, citations and text, narrowed by the scope filters. Returns bounded results with snippets, not exhaustive coverage. For exhaustive work, partition the scope and track searches; an omitted source or zero returned results is not proof of absence. Inspect prior queries on demand when resuming. Read known sources with pattern to locate passages rather than rediscovering them. Use exact passages for conclusions.",
  inputSchema: objectSchema({
    query: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "Keywords, a case name or a citation. Every word is required; \"quoted phrase\", OR, NOT or -word, prefix* and (brackets) as on CanLII.",
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
        "Relevant source types.",
    },
    jurisdiction: {
      type: "string",
      description:
        "Country routing: US/United States or CA/Canada. Use collection for an exact court, tribunal, or legislation dataset.",
    },
    collection: {
      type: "string",
      description:
        "Exact court, tribunal or legislation collection code, such as ONCA, or a CourtListener court id such as scotus.",
    },
    speaker: {
      type: "string",
      description: "Speaker-name substring for Hansard.",
    },
    author: { type: "string", description: "Author-name substring for journal articles." },
    journal: { type: "string", description: "Journal name or abbreviation substring." },
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
      description: "Candidate count; start with 10.",
    },
  }, ["query", "source_types"]),
};

type CachedSearch = { expires: number; value: Record<string, unknown> };
const searchCache = new Map<string, CachedSearch>();
const SEARCH_CACHE_MS = 5 * 60_000;
const MAX_SEARCH_CACHE = 128;

function date(value: unknown, name: string) {
  const parsed = text(value);
  if (parsed && !/^\d{4}-\d{2}-\d{2}$/u.test(parsed)) {
    throw new ApplicationError(400, `${name} must be YYYY-MM-DD`);
  }
  return parsed || undefined;
}

function sourceTypes(value: unknown) {
  const allowed = new Set(["case", "legislation", "journal", "hansard"]);
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const valid = selected.filter((item) => allowed.has(item));
  if (!valid.length) throw new ApplicationError(400, "source_types must select at least one corpus");
  const unique = new Set(valid);
  if (unique.size > 2) throw new ApplicationError(400, "source_types may select at most two corpora");
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
  if (!query) throw new ApplicationError(400, "query is required");
  if (query.length > 256) throw new ApplicationError(400, "query must be at most 256 characters");
  const jurisdiction = country(args.jurisdiction);
  if (jurisdiction === "unsupported") {
    throw new ApplicationError(400, "jurisdiction is unavailable in the installed source indexes");
  }
  const types = sourceTypes(args.source_types);
  const startDate = date(args.date_from, "date_from");
  const endDate = date(args.date_to, "date_to");
  const limit = Math.max(1, Math.min(20, Math.trunc(Number(args.limit) || 10)));
  const perProvider = Math.min(20, Math.max(limit, 10));
  const requestedSort = ["most_cited", "most_discussed", "newest", "oldest"].includes(String(args.sort))
    ? args.sort as "most_cited" | "most_discussed" | "newest" | "oldest" : "relevance";
  const cacheKey = JSON.stringify([
    query,
    [...types].sort(),
    jurisdiction,
    text(args.collection),
    text(args.speaker),
    text(args.author),
    text(args.journal),
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
  const searched = await legalSourceOperations.search({
    text: query,
    kinds: [...types] as Array<"case" | "legislation" | "journal" | "hansard">,
    jurisdiction,
    collection: text(args.collection) || undefined,
    speaker: text(args.speaker) || undefined,
    author: text(args.author) || undefined,
    journal: text(args.journal) || undefined,
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
  const results = searched.results.map((hit) => ({ ...hit, resource: researchSourceResource(hit) }));
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
  if (!unavailable.length) searchCache.set(cacheKey, { expires: Date.now() + SEARCH_CACHE_MS, value });
  if (searchCache.size > MAX_SEARCH_CACHE) {
    searchCache.delete(searchCache.keys().next().value!);
  }
  return value;
}
