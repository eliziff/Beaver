import type { AssistantEvent } from "@/app/components/shared/types";
import {
  parseCourtlistenerCaseSearches,
  parseCourtlistenerEventCases,
} from "./assistantEvents";

export type StreamEventReduction = {
  events: AssistantEvent[];
  deferPaint?: boolean;
};

const string = (value: unknown) =>
  typeof value === "string" ? value : "";
const number = (value: unknown) =>
  typeof value === "number" ? value : 0;
const clusterId = (value: unknown) =>
  typeof value === "number" ? value : null;
const error = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const clusterIds = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];

export const isStreamingPlaceholder = (event: AssistantEvent) =>
  (event.type === "thinking" || event.type === "tool_call_start") &&
  !!event.isStreaming;

function withoutPlaceholders(events: AssistantEvent[]) {
  return events.filter((event) => !isStreamingPlaceholder(event));
}

function finalizeReasoning(events: AssistantEvent[]) {
  const last = events[events.length - 1];
  return last?.type === "reasoning" && last.isStreaming
    ? [...events.slice(0, -1), { type: "reasoning" as const, text: last.text }]
    : events;
}

function append(events: AssistantEvent[], event: AssistantEvent) {
  return [...finalizeReasoning(withoutPlaceholders(events)), event];
}

function thinking(events: AssistantEvent[]) {
  const next = withoutPlaceholders(events);
  return [
    ...next,
    { type: "thinking" as const, isStreaming: true },
  ];
}

function replaceLast(
  events: AssistantEvent[],
  predicate: (event: AssistantEvent) => boolean,
  replacement: AssistantEvent,
) {
  const index = events.findLastIndex(predicate);
  if (index < 0) return events;
  const next = [...events];
  next[index] = replacement;
  return next;
}

export function reduceAssistantStreamEvent(
  events: AssistantEvent[],
  data: Record<string, unknown>,
): StreamEventReduction | null {
  if (data.type === "reasoning_delta") {
    const text = string(data.text);
    const cleaned = withoutPlaceholders(events);
    const last = cleaned[cleaned.length - 1];
    return {
      deferPaint: true,
      events:
        last?.type === "reasoning" && last.isStreaming
          ? [
              ...cleaned.slice(0, -1),
              { type: "reasoning", text: last.text + text, isStreaming: true },
            ]
          : [...finalizeReasoning(cleaned), { type: "reasoning", text, isStreaming: true }],
    };
  }

  if (data.type === "reasoning_block_end") {
    return { events: thinking(finalizeReasoning(events)) };
  }

  if (data.type === "content_delta") {
    const text = string(data.text);
    const cleaned = finalizeReasoning(withoutPlaceholders(events));
    const contentIndex = cleaned.findLastIndex(
      (event) => event.type === "content" && !!event.isStreaming,
    );
    const next = [...cleaned];
    if (contentIndex >= 0) {
      const content = cleaned[contentIndex] as Extract<
        AssistantEvent,
        { type: "content" }
      >;
      next[contentIndex] = {
        type: "content",
        text: content.text + text,
        isStreaming: true,
      };
    } else {
      next.push({ type: "content", text, isStreaming: true });
    }
    return {
      deferPaint: true,
      events: next,
    };
  }

  if (data.type === "courtlistener_search_case_law_start") {
    return {
      events: append(events, {
        type: "courtlistener_search_case_law",
        query: string(data.query),
        isStreaming: true,
      }),
    };
  }

  if (data.type === "courtlistener_search_case_law") {
    const query = string(data.query);
    return {
      events: thinking(
        replaceLast(
          events,
          (event) =>
            event.type === "courtlistener_search_case_law" &&
            event.query === query &&
            !!event.isStreaming,
          {
            type: "courtlistener_search_case_law",
            query,
            result_count: number(data.result_count),
            error: error(data.error),
            isStreaming: false,
          },
        ),
      ),
    };
  }

  if (data.type === "courtlistener_get_cases_start") {
    return {
      events: append(events, {
        type: "courtlistener_get_cases",
        cluster_ids: clusterIds(data.cluster_ids),
        isStreaming: true,
      }),
    };
  }

  if (data.type === "courtlistener_get_cases") {
    return {
      events: thinking(
        replaceLast(
          events,
          (event) =>
            event.type === "courtlistener_get_cases" && !!event.isStreaming,
          {
            type: "courtlistener_get_cases",
            cluster_ids: clusterIds(data.cluster_ids),
            case_count: number(data.case_count),
            opinion_count: number(data.opinion_count),
            cases: parseCourtlistenerEventCases(data.cases),
            error: error(data.error),
            isStreaming: false,
          },
        ),
      ),
    };
  }

  if (
    data.type === "courtlistener_find_in_case_start" ||
    data.type === "courtlistener_find_in_case"
  ) {
    const searches = parseCourtlistenerCaseSearches(data.searches);
    const id = searches?.length ? null : clusterId(data.cluster_id);
    const query = searches?.length ? "" : string(data.query);
    const event: Extract<
      AssistantEvent,
      { type: "courtlistener_find_in_case" }
    > = {
      type: "courtlistener_find_in_case",
      cluster_id: id,
      query,
      searches,
      ...(data.type.endsWith("_start")
        ? { isStreaming: true }
        : {
            total_matches: number(data.total_matches),
            case_name: string(data.case_name) || null,
            citation: string(data.citation) || null,
            error: error(data.error),
            isStreaming: false,
          }),
    };
    if (data.type.endsWith("_start")) return { events: append(events, event) };
    return {
      events: thinking(
        replaceLast(
          events,
          (candidate) =>
            candidate.type === "courtlistener_find_in_case" &&
            !!candidate.isStreaming &&
            (searches?.length
              ? Array.isArray(candidate.searches)
              : candidate.cluster_id === id && candidate.query === query),
          event,
        ),
      ),
    };
  }

  if (
    data.type === "courtlistener_read_case_start" ||
    data.type === "courtlistener_read_case"
  ) {
    const id = clusterId(data.cluster_id);
    const event: Extract<
      AssistantEvent,
      { type: "courtlistener_read_case" }
    > = {
      type: "courtlistener_read_case",
      cluster_id: id,
      ...(data.type.endsWith("_start")
        ? { isStreaming: true }
        : {
            case_name: string(data.case_name) || null,
            citation: string(data.citation) || null,
            opinion_count: number(data.opinion_count),
            error: error(data.error),
            isStreaming: false,
          }),
    };
    if (data.type.endsWith("_start")) return { events: append(events, event) };
    return {
      events: thinking(
        replaceLast(
          events,
          (candidate) =>
            candidate.type === "courtlistener_read_case" &&
            candidate.cluster_id === id &&
            !!candidate.isStreaming,
          event,
        ),
      ),
    };
  }

  if (
    data.type === "courtlistener_verify_citations_start" ||
    data.type === "courtlistener_verify_citations"
  ) {
    const event: Extract<
      AssistantEvent,
      { type: "courtlistener_verify_citations" }
    > = {
      type: "courtlistener_verify_citations",
      citation_count: number(data.citation_count),
      ...(data.type.endsWith("_start")
        ? { isStreaming: true }
        : {
            match_count: number(data.match_count),
            error: error(data.error),
            isStreaming: false,
          }),
    };
    if (data.type.endsWith("_start")) return { events: append(events, event) };
    return {
      events: thinking(
        replaceLast(
          events,
          (candidate) =>
            candidate.type === "courtlistener_verify_citations" &&
            !!candidate.isStreaming,
          event,
        ),
      ),
    };
  }

  if (data.type === "case_citation") {
    return {
      events: append(events, {
        type: "case_citation",
        cluster_id: clusterId(data.cluster_id),
        case_name: string(data.case_name) || null,
        citation: string(data.citation) || null,
        url: string(data.url),
        pdfUrl: string(data.pdfUrl) || null,
        dateFiled: string(data.dateFiled) || null,
      }),
    };
  }

  if (data.type === "case_opinions") {
    return {
      events: append(events, {
        type: "case_opinions",
        cluster_id: number(data.cluster_id),
        case: data.case as Extract<
          AssistantEvent,
          { type: "case_opinions" }
        >["case"],
      }),
    };
  }

  if (data.type === "doc_read_start") {
    return {
      events: append(events, {
        type: "doc_read",
        filename: string(data.filename),
        document_id: string(data.document_id) || undefined,
        isStreaming: true,
      }),
    };
  }

  if (data.type === "doc_read") {
    const filename = string(data.filename);
    const current = events.findLast(
      (event) =>
        event.type === "doc_read" &&
        event.filename === filename &&
        !!event.isStreaming,
    );
    return {
      events: thinking(
        replaceLast(
          events,
          (event) =>
            event.type === "doc_read" &&
            event.filename === filename &&
            !!event.isStreaming,
          {
            type: "doc_read",
            filename,
            document_id:
              string(data.document_id) ||
              (current?.type === "doc_read"
                ? current.document_id
                : undefined),
            isStreaming: false,
          },
        ),
      ),
    };
  }

  return null;
}
