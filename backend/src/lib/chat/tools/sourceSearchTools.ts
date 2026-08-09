import { searchA2AJ } from "../../a2aj";
import { warmLocalA2AJSearch } from "../../a2ajLocalBulk";
import { searchLocalHansard, warmLocalHansardSearch } from "../../a2ajHansard";
import { citationAuthorityMetricsBatch } from "../../caselawCitator";
import { searchCourtlistenerCaseLaw } from "../../courtlistener";
import { warmLocalCourtlistenerSearch } from "../../courtlistenerLocalBulk";
import { searchJournalArticles, warmJournalSearch } from "../../journalArticles";
import type { OpenAIToolSchema } from "../../llm";

export const SEARCH_SOURCES_TOOL_NAME = "SearchSources";

export const SEARCH_SOURCES_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: SEARCH_SOURCES_TOOL_NAME,
    description:
      "Default discovery tool for requests about cases, legislation, journal commentary, Hansard, or legal authorities. Searches one or two installed legal-source corpora, not the user's uploaded Library. Apply filters here, start near 10 hits, then fetch plausible sources; refine instead of paging broadly. Exact known citations should be fetched directly. Results use SQLite FTS5/BM25 and are not evidence.",
    strict: true,
    parameters: {
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
  },
};

type Hit = Record<string, unknown>;

type CachedSearch = { expires: number; value: Record<string, unknown> };
const searchCache = new Map<string, CachedSearch>();
const SEARCH_CACHE_MS = 5 * 60_000;
const MAX_SEARCH_CACHE = 128;

export function warmSourceSearchIndexes() {
  return {
    a2aj: warmLocalA2AJSearch(),
    courtlistener: warmLocalCourtlistenerSearch(),
    hansard: warmLocalHansardSearch(),
    journals: warmJournalSearch(),
  };
}

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

function exactTermsQuery(query: string) {
  const tokens = query.match(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu) ?? [];
  if (!tokens.length) throw new Error("query must contain searchable terms");
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function country(value: unknown) {
  const folded = text(value).toLocaleLowerCase().replace(/[^a-z]/gu, "");
  if (!folded) return null;
  if (["us", "usa", "unitedstates", "unitedstatesofamerica"].includes(folded)) {
    return "US" as const;
  }
  if (["ca", "canada", "canadian"].includes(folded)) return "CA" as const;
  return "unsupported" as const;
}

function roundRobin(groups: Hit[][], limit: number) {
  const merged: Hit[] = [];
  for (let rank = 0; merged.length < limit; rank += 1) {
    let added = false;
    for (const group of groups) {
      if (group[rank]) {
        merged.push(group[rank]);
        added = true;
        if (merged.length === limit) break;
      }
    }
    if (!added) break;
  }
  return merged;
}

function rerankA2AJCases(
  rows: Awaited<ReturnType<typeof searchA2AJ>>,
  mode: "relevance" | "most_cited" | "most_discussed",
) {
  const metrics = citationAuthorityMetricsBatch(rows.map((row) => row.citation));
  const authorityOrder = rows
    .map((_, index) => index)
    .filter((index) => (metrics[index]?.citingCases ?? 0) > 0)
    .sort(
      (left, right) =>
        (metrics[right]?.distinctCitingParagraphs ?? 0) -
          (metrics[left]?.distinctCitingParagraphs ?? 0) ||
        (metrics[right]?.citingCases ?? 0) - (metrics[left]?.citingCases ?? 0),
    );
  const authorityRank = new Map(
    authorityOrder.map((index, rank) => [index, rank]),
  );
  const ranked = rows
    .map((row, textRank) => ({
      row,
      metric: metrics[textRank],
      textRank,
      score:
        1 / (60 + textRank) +
        (authorityRank.has(textRank)
          ? 0.15 / (60 + authorityRank.get(textRank)!)
          : 0),
    }))
  if (mode === "most_cited") {
    return ranked.sort(
      (left, right) =>
        (right.metric?.citingCases ?? 0) - (left.metric?.citingCases ?? 0) ||
        left.textRank - right.textRank,
    );
  }
  if (mode === "most_discussed") {
    return ranked.sort(
      (left, right) =>
        (right.metric?.distinctCitingParagraphs ?? 0) -
          (left.metric?.distinctCitingParagraphs ?? 0) ||
        (right.metric?.occurrences ?? 0) - (left.metric?.occurrences ?? 0) ||
        left.textRank - right.textRank,
    );
  }
  return ranked.sort(
    (left, right) => right.score - left.score || left.textRank - right.textRank,
  );
}

export async function searchSources(args: Record<string, unknown>) {
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
  const providerQuery = syntax === "fts5" ? query : exactTermsQuery(query);
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
  const sort =
    args.sort === "newest"
      ? "newest_first"
      : args.sort === "oldest"
        ? "oldest_first"
        : "default";
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
  const groups: Hit[][] = [];
  const unavailable: string[] = [];

  if (types.has("case") && jurisdiction !== "CA") {
    try {
      const response = await searchCourtlistenerCaseLaw({
        query: providerQuery,
        court: text(args.court) || text(args.collection) || undefined,
        filedAfter: startDate,
        filedBefore: endDate,
        limit: perProvider,
        querySyntax: "fts5",
      });
      const rows = Array.isArray((response as { results?: unknown }).results)
        ? ((response as { results: Array<Record<string, unknown>> }).results)
        : [];
      groups.push(
        rows.map((row) => ({
          provider: "courtlistener",
          source_type: "case",
          identifier: row.clusterId,
          title: row.caseName,
          citation: row.citation,
          date: row.dateFiled,
          collection: row.court,
          snippet: row.snippet,
          next: { tool: "courtlistener_get_cases", clusterIds: [row.clusterId] },
        })),
      );
    } catch (error) {
      unavailable.push(`courtlistener: ${error instanceof Error ? error.message : "unavailable"}`);
    }
  }

  if ((types.has("case") || types.has("legislation")) && jurisdiction !== "US") {
    for (const sourceType of ["case", "legislation"] as const) {
      if (!types.has(sourceType)) continue;
      try {
        const docType = sourceType === "case" ? "cases" : "laws";
        const rows = await searchA2AJ({
          query: providerQuery,
          docType,
          dataset: text(args.collection) || undefined,
          startDate,
          endDate,
          size: perProvider,
          sortResults: sort,
          querySyntax: "fts5",
        });
        const ranked =
          sourceType === "case" &&
          (requestedSort === "relevance" ||
            requestedSort === "most_cited" ||
            requestedSort === "most_discussed")
            ? rerankA2AJCases(rows, requestedSort)
            : rows.map((row, textRank) => ({
                row,
                metric: null,
                textRank,
                score: 0,
              }));
        groups.push(
          ranked.map(({ row, metric }) => ({
            provider: "a2aj",
            source_type: sourceType,
            identifier: row.citation,
            title: row.name,
            citation: row.citation,
            alternate_citation: row.alternateCitation,
            date: row.date,
            collection: row.dataset,
            snippet: row.snippet,
            ...(metric && metric.citingCases > 0
              ? {
                  citation_signal: {
                    citing_cases: metric.citingCases,
                    citing_paragraphs: metric.distinctCitingParagraphs,
                    occurrences: metric.occurrences,
                  },
                }
              : {}),
            next: {
              tool: "a2aj_fetch",
              citation: row.citation,
              doc_type: docType,
              dataset: row.dataset,
            },
          })),
        );
      } catch (error) {
        unavailable.push(`a2aj-${sourceType}: ${error instanceof Error ? error.message : "unavailable"}`);
      }
    }
  }

  if (types.has("journal")) {
    if (jurisdiction || args.court || args.collection) {
      unavailable.push("journal: jurisdiction and court metadata are not indexed");
    } else {
      try {
        groups.push(
          searchJournalArticles(providerQuery, perProvider, {
            querySyntax: "fts5",
            startDate,
            endDate,
          }).map((row) => ({
            provider: "journal",
            source_type: "journal",
            identifier: String(row.articleId),
            title: row.name,
            citation: row.citation,
            date: row.date,
            collection: row.journalName,
            authors: row.authors,
            snippet: row.snippet,
            next: {
              tool: "public_legal_source_fetch",
              provider: "journal",
              identifier: String(row.articleId),
            },
          })),
        );
      } catch (error) {
        unavailable.push(`journal: ${error instanceof Error ? error.message : "unavailable"}`);
      }
    }
  }

  if (types.has("hansard")) {
    if (jurisdiction === "US" || args.court || args.collection) {
      unavailable.push("hansard: only installed Canadian Hansard collections are searchable");
    } else {
      try {
        const rows = searchLocalHansard({
          query: providerQuery,
          querySyntax: "fts5",
          size: perProvider,
          speaker: text(args.speaker) || undefined,
          startDate,
          endDate,
          sortResults: sort,
        });
        if (rows === null) unavailable.push("hansard: corpus not installed");
        else {
          groups.push(
            rows.map((row) => ({
              provider: "hansard",
              source_type: "hansard",
              identifier: row.id,
              title: row.subjectOfBusiness ?? row.orderOfBusiness,
              date: row.date,
              collection: row.chamber,
              speaker: row.speaker,
              snippet: row.snippet,
              next: { tool: "hansard_fetch", id: row.id },
            })),
          );
        }
      } catch (error) {
        unavailable.push(`hansard: ${error instanceof Error ? error.message : "unavailable"}`);
      }
    }
  }

  const results = roundRobin(groups, limit);
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

export async function executeSearchSourcesTool(
  name: string,
  args: Record<string, unknown>,
) {
  if (name !== SEARCH_SOURCES_TOOL_NAME) return null;
  try {
    return await searchSources(args);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Search failed" };
  }
}
