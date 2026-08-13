import {
  getCourtlistenerCases,
  getCourtlistenerOpinionDocumentText,
  getCourtlistenerOpinionStructure,
  lookupCourtlistenerOpinionLocator,
  searchCourtlistenerCaseLaw,
  verifyCourtlistenerCitations,
} from "../courtlistener";
import type { NormalizedToolCall, NormalizedToolResult } from "../llm";
import {
  queueProviderPdfAttachment,
  type ProviderPdfQueueResult,
} from "../providerPdfLibraryBridge";
import { sha256 } from "../hash";
import {
  createBenchmarkEvidence,
  registerLegalEvidence,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
} from "./legalEvidenceExperiment";
import { COURTLISTENER_TOOL_NAMES } from "./tools/courtlistenerTools";
import { findTextMatches } from "./tools/documentOps";

type JsonRecord = Record<string, unknown>;
type CourtlistenerCall = Pick<NormalizedToolCall, "name" | "input">;
type CourtlistenerToolOptions = {
  db?: Parameters<typeof getCourtlistenerCases>[0]["db"];
  apiToken?: string | null;
  pdfFallbackUserId?: string;
};

export type CourtlistenerCase = {
  clusterId: number;
  caseName: string | null;
  citations: string[];
  url: string | null;
  pdfUrl: string | null;
  dateFiled: string | null;
  opinions: object[];
};

export type CourtlistenerToolState = {
  casesByClusterId: Map<number, CourtlistenerCase>;
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
  state?: CourtlistenerToolState,
): NormalizedToolResult {
  const payload = record(content);
  const reported = text(payload, "status");
  const status: NormalizedToolResult["status"] =
    reported === "not_found" || reported === "ambiguous"
      ? reported
      : payload?.ok === false
        ? "error"
        : "ok";
  return {
    tool_use_id: call.id,
    content: JSON.stringify(content),
    status,
    evidenceRefs: payload
      ? courtlistenerEvidenceRefs(call, payload, state)
      : [],
  };
}

function courtlistenerEvidenceRefs(
  call: CourtlistenerCall,
  payload: JsonRecord,
  state?: CourtlistenerToolState,
): NonNullable<NormalizedToolResult["evidenceRefs"]> {
  const cluster = integer(payload.cluster_id);
  const filename =
    text(payload, "case_name") ??
    (Array.isArray(payload.citations) && typeof payload.citations[0] === "string"
      ? payload.citations[0]
      : `CourtListener ${cluster ?? "case"}`);
  if (call.name === COURTLISTENER_TOOL_NAMES.readCase) {
    return (Array.isArray(payload.opinions) ? payload.opinions : []).flatMap(
      (raw) => {
        const opinion = record(raw);
        const body = text(opinion, "text");
        if (!opinion || !body) return [];
        const opinionId = integer(opinion.opinion_id);
        return [
          {
            handle: `courtlistener:${cluster ?? "case"}:${opinionId ?? "opinion"}:${sha256(body)}`,
            filename,
            locator: opinionId ? `opinion ${opinionId}` : "opinion",
            text: body,
            exactSha256: sha256(body),
            kind: "evidence" as const,
          },
        ];
      },
    );
  }
  if (call.name === COURTLISTENER_TOOL_NAMES.lookupCaseLocator) {
    const requested = record(payload.requested);
    const blocks = [
      payload.block,
      ...(Array.isArray(payload.before) ? payload.before : []),
      ...(Array.isArray(payload.after) ? payload.after : []),
    ];
    return blocks.flatMap((raw, index) => {
      const block = record(raw);
      const body = text(block, "text");
      if (!block || !body) return [];
      const locator =
        text(block, "label") ??
        text(requested, "locator") ??
        `context ${index + 1}`;
      return [
        {
          handle: `courtlistener:${cluster ?? "case"}:${integer(payload.opinion_id) ?? "opinion"}:${locator}:${sha256(body)}`,
          filename,
          locator,
          text: body,
          exactSha256: sha256(body),
          kind: "evidence" as const,
        },
      ];
    });
  }
  if (call.name === COURTLISTENER_TOOL_NAMES.findInCase) {
    const cached = cluster === null ? undefined : state?.casesByClusterId.get(cluster);
    const contextChars =
      typeof call.input.context_chars === "number"
        ? Math.min(Math.max(Math.trunc(call.input.context_chars), 40), 2_000)
        : 160;
    return (Array.isArray(payload.hits) ? payload.hits : []).flatMap(
      (raw, index) => {
        const hit = record(raw);
        const excerpt = text(hit, "excerpt");
        if (!hit || !excerpt) return [];
        const hitOpinionId = integer(hit.opinion_id);
        const opinion = cached?.opinions.find(
          (candidate) => opinionId(candidate as JsonRecord) === hitOpinionId,
        );
        const fullText = opinion
          ? getCourtlistenerOpinionDocumentText(opinion) ||
            text(opinion as JsonRecord, "text") ||
            ""
          : "";
        const at = integer(hit.at);
        const exactContext =
          at !== null &&
          at >= 0 &&
          fullText.slice(at, at + excerpt.length) === excerpt
            ? fullText.slice(
                Math.max(0, at - contextChars),
                Math.min(fullText.length, at + excerpt.length + contextChars),
              )
            : excerpt;
        return [
          {
            handle: `courtlistener:${cluster ?? "case"}:${hitOpinionId ?? "opinion"}:hit:${index}:${sha256(exactContext)}`,
            filename,
            locator: `${hitOpinionId ? `opinion ${hitOpinionId}, ` : ""}search hit ${index + 1}`,
            text: exactContext,
            exactSha256: sha256(exactContext),
            kind: "candidate" as const,
          },
        ];
      },
    );
  }
  return [];
}

export function courtlistenerLegalEvidence(
  call: CourtlistenerCall,
  payload: Record<string, unknown>,
  state?: CourtlistenerToolState,
): LegalEvidenceReceipt[] {
  return courtlistenerEvidenceRefs(call, payload, state).map((ref) =>
    createBenchmarkEvidence({
      jurisdiction: "US",
      sourceClass: "case",
      stableSourceId: ref.handle,
      sourceText: ref.text,
      spanText: ref.text,
      citation: ref.filename ?? "CourtListener source",
      name: ref.filename ?? "CourtListener source",
      dataset: "courtlistener",
      locatorKind: "document",
      locatorLabel: ref.locator ?? "passage",
    }),
  );
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

function cachedCase(state: CourtlistenerToolState, args: JsonRecord) {
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
  state: CourtlistenerToolState,
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
    const cached: CourtlistenerCase = {
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

async function queueCourtlistenerPdfFallback(
  caseRecord: CourtlistenerCase,
  userId?: string,
) {
  // A PDF fallback is only worth importing when no opinion carries
  // provider-native structure.
  const needsFallback = caseRecord.opinions.some(
    (opinion) =>
      !getCourtlistenerOpinionStructure(opinion)?.blocks.some(
        ({ origin }) => origin === "native",
      ),
  );
  if (!userId || !caseRecord.pdfUrl || !needsFallback) return null;
  try {
    return await queueProviderPdfAttachment({
      provider: "courtlistener",
      identity: String(caseRecord.clusterId),
      structureSource: "flat_text",
      url: caseRecord.pdfUrl,
      canonicalUrl: caseRecord.url,
      title:
        caseRecord.caseName ||
        caseRecord.citations[0] ||
        `CourtListener ${caseRecord.clusterId}`,
    });
  } catch {
    return null;
  }
}

async function execute(
  call: CourtlistenerCall,
  state: CourtlistenerToolState,
  options: CourtlistenerToolOptions,
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
      apiToken: options.apiToken,
    });
  }

  if (call.name === COURTLISTENER_TOOL_NAMES.verifyCitations) {
    return verifyCourtlistenerCitations({
      citations: Array.isArray(args.citations)
        ? args.citations.filter(
            (citation): citation is string => typeof citation === "string",
          )
        : [],
      db: options.db,
      apiToken: options.apiToken,
    });
  }

  if (call.name === COURTLISTENER_TOOL_NAMES.getCases) {
    const ids = integers(
      args.clusterIds ?? args.cluster_ids ?? [args.clusterId],
    );
    const payload = await getCourtlistenerCases({
      clusterIds: ids,
      db: options.db,
      apiToken: options.apiToken,
    });
    const fetched =
      payload && Array.isArray((payload as { cases?: unknown[] }).cases)
        ? (payload as { cases: unknown[] }).cases
        : [];
    const cases = cacheFetchedCases(state, ids, fetched);
    const errors = fetched
      .map((item) => text(record(item), "error"))
      .filter((error): error is string => !!error);
    const error =
      text(record(payload), "error") ?? (errors.join("; ") || null);
    const pdfFallbacks = new Map<number, ProviderPdfQueueResult>();
    if (
      options.pdfFallbackUserId &&
      ids.length === 1 &&
      cases.length === 1
    ) {
      const caseRecord = cases[0];
      const fallback = await queueCourtlistenerPdfFallback(
        caseRecord,
        options.pdfFallbackUserId,
      );
      if (fallback) pdfFallbacks.set(caseRecord.clusterId, fallback);
    }
    return {
      ok:
        !error &&
        cases.length > 0 &&
        cases.every(({ opinions }) => opinions.length > 0),
      case_count: cases.length,
      opinion_count: cases.reduce(
        (sum, caseRecord) => sum + caseRecord.opinions.length,
        0,
      ),
      cases: cases.map((caseRecord) => ({
        cluster_id: caseRecord.clusterId,
        case_name: caseRecord.caseName,
        citation: caseRecord.citations[0] ?? null,
        citations: caseRecord.citations,
        dateFiled: caseRecord.dateFiled,
        url: caseRecord.url,
        pdfUrl: caseRecord.pdfUrl,
        opinion_count: caseRecord.opinions.length,
        opinions: caseRecord.opinions.map(compactOpinionMetadata),
        pdf_fallback: pdfFallbacks.get(caseRecord.clusterId) ?? null,
      })),
      ...(error ? { error } : {}),
      // The schemas teach probe shape and opinion selection; only the cache
      // fact and the multi-opinion warning are new here.
      next_required_action: cases.some(({ opinions }) => opinions.length > 1)
        ? "This result does not include opinion text; at least one case has multiple opinions."
        : "This result does not include opinion text.",
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
  const pdfFallback = await queueCourtlistenerPdfFallback(
    caseRecord,
    options.pdfFallbackUserId,
  );

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
          url: text(value, "url"),
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
      pdf_fallback: pdfFallback,
    };
  }

  if (call.name === COURTLISTENER_TOOL_NAMES.lookupCaseLocator) {
    const kind =
      args.locator_type === "page"
        ? "page"
        : args.locator_type === "footnote"
          ? "footnote"
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
        pdf_fallback: pdfFallback,
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
      pdf_fallback: pdfFallback,
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
    pdf_fallback: pdfFallback,
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
  state: CourtlistenerToolState,
  userId?: string,
  legalEvidenceState?: LegalEvidenceTurnState,
): Promise<NormalizedToolResult | null> {
  const payload = await executeCourtlistenerTool(call, state, {
    pdfFallbackUserId: userId,
  });
  if (!payload) return null;
  const evidences = courtlistenerLegalEvidence(call, payload, state);
  for (const evidence of evidences) {
    if (legalEvidenceState) registerLegalEvidence(legalEvidenceState, evidence);
  }
  return result(
    call,
    evidences.length
      ? { ...payload, evidence_ids: evidences.map((item) => item.evidence_id) }
      : payload,
    state,
  );
}

export async function executeCourtlistenerTool(
  call: CourtlistenerCall,
  state: CourtlistenerToolState,
  options: CourtlistenerToolOptions = {},
): Promise<JsonRecord | null> {
  if (!TOOL_NAMES.has(call.name)) return null;
  try {
    return (await execute(call, state, options)) as JsonRecord;
  } catch (error) {
    return {
      ok: false,
      source: "CourtListener",
      error:
        error instanceof Error ? error.message : "CourtListener tool failed.",
    };
  }
}
