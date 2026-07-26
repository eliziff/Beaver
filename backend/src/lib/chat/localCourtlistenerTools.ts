import {
  getCourtlistenerCases,
  getCourtlistenerOpinionDocumentText,
  lookupCourtlistenerOpinionLocator,
  searchCourtlistenerCaseLaw,
  verifyCourtlistenerCitations,
} from "../courtlistener";
import type { NormalizedToolCall, NormalizedToolResult } from "../llm";
import { COURTLISTENER_TOOL_NAMES } from "./tools/courtlistenerTools";
import { findTextMatches } from "./tools/documentOps";

type JsonRecord = Record<string, unknown>;

export type LocalCourtlistenerCase = {
  clusterId: number;
  caseName: string | null;
  citations: string[];
  url: string | null;
  pdfUrl: string | null;
  dateFiled: string | null;
  opinions: object[];
};

export type LocalCourtlistenerState = {
  casesByClusterId: Map<number, LocalCourtlistenerCase>;
};

const TOOL_NAMES = new Set<string>(Object.values(COURTLISTENER_TOOL_NAMES));

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: JsonRecord | null, key: string) {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function integers(value: unknown) {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .map(integer)
            .filter((item): item is number => item !== null && item > 0),
        ),
      ]
    : [];
}

function result(
  call: NormalizedToolCall,
  content: unknown,
): NormalizedToolResult {
  return {
    tool_use_id: call.id,
    content: JSON.stringify(content),
  };
}

function opinionId(opinion: JsonRecord) {
  return integer(opinion.opinionId) ?? integer(opinion.id);
}

function selectedOpinionIds(args: JsonRecord) {
  if (Array.isArray(args.opinionIds)) return integers(args.opinionIds);
  if (Array.isArray(args.opinion_ids)) return integers(args.opinion_ids);
  const one = integer(args.opinionId) ?? integer(args.opinion_id);
  return one && one > 0 ? [one] : [];
}

function cachedCase(state: LocalCourtlistenerState, args: JsonRecord) {
  const clusterId = integer(args.clusterId) ?? integer(args.cluster_id);
  return {
    clusterId,
    caseRecord:
      clusterId === null ? undefined : state.casesByClusterId.get(clusterId),
  };
}

function compactOpinionMetadata(opinion: object) {
  const value = opinion as JsonRecord;
  const fullText =
    getCourtlistenerOpinionDocumentText(opinion) || text(value, "text") || "";
  return {
    opinion_id: opinionId(value),
    type: text(value, "type"),
    author: text(value, "author"),
    url: text(value, "url"),
    char_count: fullText.length,
  };
}

function cacheFetchedCases(
  state: LocalCourtlistenerState,
  requestedIds: number[],
  fetched: unknown[],
) {
  return fetched.flatMap((raw, index) => {
    const value = record(raw);
    if (!value) return [];
    const clusterId =
      integer(value.clusterId) ?? integer(value.id) ?? requestedIds[index];
    if (!clusterId) return [];
    const opinions = Array.isArray(value.opinions)
      ? value.opinions.filter(
          (opinion): opinion is object =>
            Boolean(opinion) && typeof opinion === "object",
        )
      : [];
    const cached: LocalCourtlistenerCase = {
      clusterId,
      caseName: text(value, "caseName"),
      citations: Array.isArray(value.citations)
        ? value.citations.filter(
            (citation): citation is string => typeof citation === "string",
          )
        : [],
      url: text(value, "url"),
      pdfUrl: text(value, "pdfUrl"),
      dateFiled: text(value, "dateFiled"),
      opinions,
    };
    state.casesByClusterId.set(clusterId, cached);
    return [cached];
  });
}

async function execute(
  call: NormalizedToolCall,
  state: LocalCourtlistenerState,
) {
  const args = call.input;
  if (call.name === COURTLISTENER_TOOL_NAMES.searchCaseLaw) {
    return searchCourtlistenerCaseLaw({
      query: typeof args.query === "string" ? args.query : "",
      court: typeof args.court === "string" ? args.court : undefined,
      filedAfter:
        typeof args.filedAfter === "string" ? args.filedAfter : undefined,
      filedBefore:
        typeof args.filedBefore === "string" ? args.filedBefore : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
  }

  if (call.name === COURTLISTENER_TOOL_NAMES.verifyCitations) {
    return verifyCourtlistenerCitations({
      citations: Array.isArray(args.citations)
        ? args.citations.filter(
            (citation): citation is string => typeof citation === "string",
          )
        : [],
    });
  }

  if (call.name === COURTLISTENER_TOOL_NAMES.getCases) {
    const ids = integers(
      args.clusterIds ?? args.cluster_ids ?? [args.clusterId],
    );
    const payload = await getCourtlistenerCases({ clusterIds: ids });
    const fetched =
      payload && Array.isArray((payload as { cases?: unknown[] }).cases)
        ? (payload as { cases: unknown[] }).cases
        : [];
    const cases = cacheFetchedCases(state, ids, fetched);
    return {
      ok:
        cases.length > 0 && cases.every(({ opinions }) => opinions.length > 0),
      case_count: cases.length,
      opinion_count: cases.reduce(
        (sum, caseRecord) => sum + caseRecord.opinions.length,
        0,
      ),
      cases: cases.map((caseRecord) => ({
        cluster_id: caseRecord.clusterId,
        case_name: caseRecord.caseName,
        citations: caseRecord.citations,
        dateFiled: caseRecord.dateFiled,
        opinion_count: caseRecord.opinions.length,
        opinions: caseRecord.opinions.map(compactOpinionMetadata),
      })),
      next_required_action:
        "Use courtlistener_find_in_case or courtlistener_lookup_case_locator before relying on the case.",
    };
  }

  const { clusterId, caseRecord } = cachedCase(state, args);
  if (!caseRecord) {
    return {
      ok: false,
      cluster_id: clusterId,
      error:
        "Case has not been fetched in this turn. Call courtlistener_get_cases first.",
    };
  }

  if (call.name === COURTLISTENER_TOOL_NAMES.findInCase) {
    const query = typeof args.query === "string" ? args.query : "";
    const maxResults =
      typeof args.max_results === "number"
        ? Math.min(Math.max(Math.trunc(args.max_results), 1), 50)
        : 20;
    const contextChars =
      typeof args.context_chars === "number"
        ? Math.min(Math.max(Math.trunc(args.context_chars), 40), 2000)
        : 160;
    const hits: Array<JsonRecord> = [];
    let totalMatches = 0;
    for (const opinion of caseRecord.opinions) {
      const value = opinion as JsonRecord;
      const opinionText =
        getCourtlistenerOpinionDocumentText(opinion) ||
        text(value, "text") ||
        "";
      const found = findTextMatches({
        text: opinionText,
        query,
        maxResults: Math.max(0, maxResults - hits.length),
        contextChars,
        startIndex: hits.length,
      });
      totalMatches += found.totalMatches;
      hits.push(
        ...found.hits.map((hit) => ({
          ...hit,
          opinion_id: opinionId(value),
          type: text(value, "type"),
          author: text(value, "author"),
        })),
      );
    }
    return {
      ok: true,
      cluster_id: caseRecord.clusterId,
      case_name: caseRecord.caseName,
      citation: caseRecord.citations[0] ?? null,
      query,
      total_matches: totalMatches,
      returned: hits.length,
      truncated: totalMatches > hits.length,
      hits,
    };
  }

  if (call.name === COURTLISTENER_TOOL_NAMES.lookupCaseLocator) {
    const kind =
      args.locator_type === "page"
        ? "page"
        : args.locator_type === "section"
          ? "section"
          : "paragraph";
    const locator = typeof args.locator === "string" ? args.locator : "";
    const contextBlocks =
      typeof args.context_blocks === "number" ? args.context_blocks : 0;
    const wanted = selectedOpinionIds(args);
    const matches = caseRecord.opinions.flatMap((opinion) => {
      const value = opinion as JsonRecord;
      const id = opinionId(value);
      if (wanted.length && (id === null || !wanted.includes(id))) return [];
      const lookup = lookupCourtlistenerOpinionLocator(
        opinion,
        kind,
        locator,
        contextBlocks,
      );
      return lookup?.status === "found" && lookup.block
        ? [{ opinionId: id, lookup }]
        : [];
    });
    if (matches.length !== 1) {
      return {
        ok: false,
        cluster_id: caseRecord.clusterId,
        status: matches.length ? "ambiguous" : "not_found",
        error: matches.length
          ? "The locator occurs in multiple opinions; pass opinionId."
          : "The requested locator was not found in the cached opinions.",
      };
    }
    const match = matches[0];
    return {
      ok: true,
      cluster_id: caseRecord.clusterId,
      case_name: caseRecord.caseName,
      citation: caseRecord.citations[0] ?? null,
      opinion_id: match.opinionId,
      requested: { kind, locator },
      ...match.lookup,
      block: { ...match.lookup.block, anchor: undefined },
    };
  }

  const wanted = selectedOpinionIds(args);
  const selected = wanted.length
    ? caseRecord.opinions.filter((opinion) => {
        const id = opinionId(opinion as JsonRecord);
        return id !== null && wanted.includes(id);
      })
    : caseRecord.opinions.length === 1
      ? caseRecord.opinions
      : [];
  if (!selected.length) {
    return {
      ok: false,
      cluster_id: caseRecord.clusterId,
      opinions: caseRecord.opinions.map(compactOpinionMetadata),
      error:
        caseRecord.opinions.length > 1
          ? "Multiple opinions are available; pass opinionId or opinionIds."
          : "No matching opinion was found.",
    };
  }
  return {
    ok: true,
    cluster_id: caseRecord.clusterId,
    case_name: caseRecord.caseName,
    citations: caseRecord.citations,
    opinion_count: caseRecord.opinions.length,
    returned_opinion_count: selected.length,
    opinions: selected.map((opinion) => {
      const value = opinion as JsonRecord;
      return {
        ...compactOpinionMetadata(opinion),
        text:
          getCourtlistenerOpinionDocumentText(opinion) ||
          text(value, "text") ||
          "",
      };
    }),
  };
}

export async function runLocalCourtlistenerTool(
  call: NormalizedToolCall,
  state: LocalCourtlistenerState,
): Promise<NormalizedToolResult | null> {
  if (!TOOL_NAMES.has(call.name)) return null;
  try {
    return result(call, await execute(call, state));
  } catch (error) {
    return result(call, {
      ok: false,
      source: "CourtListener",
      error:
        error instanceof Error ? error.message : "CourtListener tool failed.",
    });
  }
}
