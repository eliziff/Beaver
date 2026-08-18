import {
  getCourtlistenerOpinionDocumentText,
  getCourtlistenerOpinionStructure,
  verifyCourtlistenerCitations,
} from "../courtlistener";
import { sha256 } from "../hash";
import type { NormalizedToolCall } from "../llm";
import { queueProviderPdfAttachment } from "../providerPdfLibraryBridge";
import { resourceReference } from "../resourceReferences";
import { COURTLISTENER_TOOL_NAMES } from "./tools/courtlistenerTools";
import { findTextMatches } from "./tools/documentOps";
import { hideLegalSourceUrls } from "./legalToolResultVisibility";
import { toolText, type BeaverOutcome } from "./toolRegistry";

type JsonRecord = Record<string, unknown>;

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

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: JsonRecord | null, key: string) {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function integer(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function opinionId(opinion: object) {
  const value = opinion as JsonRecord;
  return integer(value.opinionId) ?? integer(value.id) ?? integer(value.opinion_id);
}

export function captureCourtlistenerCase(
  state: CourtlistenerToolState,
  value: object,
) {
  const source = value as JsonRecord;
  const clusterId = integer(source.clusterId) ?? integer(source.id);
  if (!clusterId) return null;
  const cached: CourtlistenerCase = {
    clusterId,
    caseName: text(source, "caseName") ?? text(source, "case_name"),
    citations: Array.isArray(source.citations)
      ? source.citations.filter(
          (citation): citation is string => typeof citation === "string",
        )
      : [],
    url: text(source, "url"),
    pdfUrl: text(source, "pdfUrl") ?? text(source, "pdf_url"),
    dateFiled: text(source, "dateFiled") ?? text(source, "date_filed"),
    opinions: Array.isArray(source.opinions)
      ? source.opinions.filter(
          (opinion): opinion is object =>
            Boolean(opinion) && typeof opinion === "object",
        )
      : [],
  };
  state.casesByClusterId.set(clusterId, cached);
  return cached;
}

export async function courtlistenerPdfFallback(
  caseRecord: CourtlistenerCase,
  userId?: string,
) {
  const needsFallback = caseRecord.opinions.some(
    (opinion) =>
      !getCourtlistenerOpinionStructure(opinion)?.blocks.some(
        ({ origin }) => origin === "native",
      ),
  );
  if (!userId || !caseRecord.pdfUrl || !needsFallback) return null;
  try {
    const queued = await queueProviderPdfAttachment({
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
    return queued && {
      ...queued,
      resource: resourceReference.source("pdf", queued.reference_id),
    };
  } catch {
    return null;
  }
}

function findInCase(
  args: JsonRecord,
  state: CourtlistenerToolState,
) {
  const clusterId = integer(args.clusterId) ?? integer(args.cluster_id);
  const caseRecord = clusterId
    ? state.casesByClusterId.get(clusterId)
    : undefined;
  if (!caseRecord) {
    return {
      ok: false,
      cluster_id: clusterId,
      error: "Case has not been opened in this turn. Read its source resource first.",
    };
  }
  const query = typeof args.query === "string" ? args.query : "";
  const maxResults = typeof args.max_results === "number"
    ? Math.min(Math.max(Math.trunc(args.max_results), 1), 50)
    : 20;
  const contextChars = typeof args.context_chars === "number"
    ? Math.min(Math.max(Math.trunc(args.context_chars), 40), 2_000)
    : 160;
  const hits: JsonRecord[] = [];
  let totalMatches = 0;
  for (const opinion of caseRecord.opinions) {
    const value = opinion as JsonRecord;
    const body = getCourtlistenerOpinionDocumentText(opinion) ||
      text(value, "text") || "";
    const found = findTextMatches({
      text: body,
      query,
      maxResults: Math.max(0, maxResults - hits.length),
      contextChars,
      startIndex: hits.length,
    });
    totalMatches += found.totalMatches;
    hits.push(...found.hits.map((hit) => ({
      ...hit,
      opinion_id: opinionId(opinion),
      type: text(value, "type"),
      author: text(value, "author"),
    })));
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

function candidateRefs(payload: JsonRecord, state: CourtlistenerToolState) {
  const clusterId = integer(payload.cluster_id);
  const cached = clusterId ? state.casesByClusterId.get(clusterId) : undefined;
  const filename = text(payload, "case_name") ??
    cached?.citations[0] ?? `CourtListener ${clusterId ?? "case"}`;
  return (Array.isArray(payload.hits) ? payload.hits : []).flatMap(
    (raw, index) => {
      const hit = record(raw);
      const excerpt = text(hit, "excerpt");
      if (!hit || !excerpt) return [];
      const id = integer(hit.opinion_id);
      const opinion = cached?.opinions.find((value) => opinionId(value) === id);
      const sourceText = opinion
        ? getCourtlistenerOpinionDocumentText(opinion) || excerpt
        : excerpt;
      const at = typeof hit.at === "number" ? hit.at : -1;
      const context = at >= 0 && sourceText.slice(at, at + excerpt.length) === excerpt
        ? sourceText.slice(Math.max(0, at - 160), at + excerpt.length + 160)
        : excerpt;
      return [{
        handle: `courtlistener:${clusterId ?? "case"}:${id ?? "opinion"}:hit:${index}:${sha256(context)}`,
        filename,
        locator: `${id ? `opinion ${id}, ` : ""}search hit ${index + 1}`,
        text: context,
        exactSha256: sha256(context),
        kind: "candidate" as const,
      }];
    },
  );
}

function outcome(
  call: NormalizedToolCall,
  payload: JsonRecord,
  state: CourtlistenerToolState,
): BeaverOutcome {
  const visible = hideLegalSourceUrls("courtlistener_result", payload);
  return {
    result: toolText(visible, payload.ok === false),
    metadata: {
      status: payload.ok === false ? "error" : "ok",
      evidenceRefs: call.name === COURTLISTENER_TOOL_NAMES.findInCase
        ? candidateRefs(payload, state)
        : [],
    },
  };
}

function verifiedPayload(value: unknown) {
  const payload = record(value) ?? { ok: false, error: "Citation verification failed." };
  if (!Array.isArray(payload.citationLinks)) return payload;
  return {
    ...payload,
    citationLinks: payload.citationLinks.map((raw) => {
      const link = record(raw);
      if (!link) return raw;
      const clusterId = integer(link.clusterId);
      const { url: _url, pdfUrl: _pdfUrl, ...safe } = link;
      return {
        ...safe,
        ...(clusterId
          ? { resource: resourceReference.source("courtlistener", String(clusterId)) }
          : {}),
      };
    }),
  };
}

export async function runLocalCourtlistenerTool(
  call: NormalizedToolCall,
  state: CourtlistenerToolState,
  userId?: string,
  signal?: AbortSignal,
): Promise<BeaverOutcome | null> {
  try {
    if (call.name === COURTLISTENER_TOOL_NAMES.findInCase) {
      const payload = findInCase(call.input, state);
      if (payload.ok) {
        const cached = state.casesByClusterId.get(Number(payload.cluster_id));
        const fallback = cached && await courtlistenerPdfFallback(cached, userId);
        if (fallback) Object.assign(payload, { pdf_fallback: fallback });
      }
      return outcome(call, payload, state);
    }
    if (call.name === COURTLISTENER_TOOL_NAMES.verifyCitations) {
      const citations = Array.isArray(call.input.citations)
        ? call.input.citations.filter(
            (citation): citation is string => typeof citation === "string",
          )
        : [];
      const payload = verifiedPayload(
        await verifyCourtlistenerCitations({ citations, signal }),
      );
      return outcome(call, payload, state);
    }
    return null;
  } catch (error) {
    return outcome(call, {
      ok: false,
      error: error instanceof Error ? error.message : "CourtListener request failed.",
    }, state);
  }
}
