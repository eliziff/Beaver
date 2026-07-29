import type {
  AssistantEvent,
  AutomationToolName,
  EditAnnotation,
} from "@/app/components/shared/types";
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
const clean = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const clusterIds = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
const AUTOMATION_TOOLS = new Set<AutomationToolName>([
  "toa_submit_library_document",
  "toa_job_status",
  "library_fix_docx_supras",
  "library_link_docx_citations",
]);

export function parseAutomationRunEvent(
  data: Record<string, unknown>,
): Extract<AssistantEvent, { type: "automation_run" }> | null {
  const tool = data.tool;
  if (typeof tool !== "string" || !AUTOMATION_TOOLS.has(tool as AutomationToolName)) return null;
  const counts = Array.isArray(data.counts)
    ? data.counts.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        return clean(row.label) && typeof row.value === "number"
          ? [{ label: clean(row.label)!, value: row.value }]
          : [];
      })
    : undefined;
  const outputs = Array.isArray(data.outputs)
    ? data.outputs.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const name = clean(row.name);
        return name ? [{ name, ...(clean(row.url) ? { url: clean(row.url) } : {}) }] : [];
      })
    : undefined;
  return {
    type: "automation_run",
    id: clean(data.id) ?? `${tool}:${clean(data.job_id) ?? "run"}`,
    tool: tool as AutomationToolName,
    status: clean(data.status) ?? "unknown",
    stage: clean(data.stage) ?? "Automation",
    ...(typeof data.progress === "number" ? { progress: data.progress } : {}),
    ...(clean(data.message) ? { message: clean(data.message) } : {}),
    ...(counts?.length ? { counts } : {}),
    ...(clean(data.error) ? { error: clean(data.error) } : {}),
    ...(outputs?.length ? { outputs } : {}),
    ...(clean(data.app_url) ? { app_url: clean(data.app_url) } : {}),
    ...(clean(data.job_id) ? { job_id: clean(data.job_id) } : {}),
    ...(clean(data.document_id) ? { document_id: clean(data.document_id) } : {}),
    ...(clean(data.version_id) ? { version_id: clean(data.version_id) } : {}),
    ...(typeof data.version_number === "number" ? { version_number: data.version_number } : {}),
  };
}
type AskInputsItem = Extract<AssistantEvent, { type: "ask_inputs" }>["items"][number];
function parseAskInputs(data: Record<string, unknown>): Extract<AssistantEvent, { type: "ask_inputs" }> | null {
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems.reduce<AskInputsItem[]>((items, item, index) => {
    if (!item || typeof item !== "object") return items;
    const row = item as Record<string, unknown>;
    const id = clean(row.id) ?? `input-${index + 1}`;
    if (row.kind === "choice") {
      const options = Array.isArray(row.options)
        ? row.options.flatMap((option) => {
            if (!option || typeof option !== "object") return [];
            const value = clean((option as Record<string, unknown>).value) ??
              clean((option as Record<string, unknown>).label);
            return value ? [{ value }] : [];
          })
        : [];
      items.push({
        id,
        kind: "choice" as const,
        question: clean(row.question) ?? "Please choose an option.",
        options,
        allow_other: row.allow_other !== false,
        other_label: clean(row.other_label) ?? "Other",
        ...(clean(row.response_prefix) ? { response_prefix: clean(row.response_prefix) } : {}),
      });
      return items;
    }
    if (row.kind === "documents") {
      const document_types = Array.isArray(row.document_types)
        ? row.document_types.flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : [])
        : [];
      items.push({
        id,
        kind: "documents" as const,
        document_types,
        ...(clean(row.response_prefix) ? { response_prefix: clean(row.response_prefix) } : {}),
      });
      return items;
    }
    return items;
  }, []);
  return items.length
    ? { type: "ask_inputs", items }
    : null;
}
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
  if (data.type === "automation_run") {
    const event = parseAutomationRunEvent(data);
    return event ? { events: append(events, event) } : null;
  }
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
  if (data.type === "tool_call_start") {
    return { events: append(events, { type: "tool_call_start", name: string(data.name), isStreaming: true }) };
  }
  if (data.type === "workflow_applied") {
    return { events: append(events, { type: "workflow_applied", workflow_id: string(data.workflow_id), title: string(data.title) }) };
  }
  if (data.type === "mcp_tool_start") {
    const name = string(data.name);
    return { events: append(events, { type: "mcp_tool_call", connector_id: "", connector_name: "", tool_name: name, openai_tool_name: name, status: "ok", isStreaming: true }) };
  }
  if (data.type === "mcp_tool_result") {
    const name = string(data.name);
    return {
      events: thinking(
        replaceLast(
          events,
          (event) => event.type === "mcp_tool_call" && event.openai_tool_name === name && !!event.isStreaming,
          {
            type: "mcp_tool_call",
            connector_id: "",
            connector_name: string(data.connector_name),
            tool_name: string(data.tool_name) || name,
            openai_tool_name: name,
            status: data.status === "error" ? "error" : "ok",
            ...(typeof data.error === "string" ? { error: data.error } : {}),
            isStreaming: false,
          },
        ),
      ),
    };
  }
  if (data.type === "ask_inputs") {
    const event = parseAskInputs(data);
    return event ? { events: append(events, event) } : null;
  }
  if (data.type === "doc_find_start") {
    return { events: append(events, { type: "doc_find", filename: string(data.filename), query: string(data.query), total_matches: 0, isStreaming: true }) };
  }
  if (data.type === "doc_find") {
    const filename = string(data.filename);
    const query = string(data.query);
    return {
      events: thinking(
        replaceLast(
          events,
          (event) => event.type === "doc_find" && event.filename === filename && event.query === query && !!event.isStreaming,
          { type: "doc_find", filename, query, total_matches: number(data.total_matches), isStreaming: false },
        ),
      ),
    };
  }
  if (data.type === "doc_created_start") {
    return { events: append(events, { type: "doc_created", filename: string(data.filename), download_url: "", isStreaming: true }) };
  }
  if (data.type === "doc_download") {
    return { events: append(events, { type: "doc_download", filename: string(data.filename), download_url: string(data.download_url) }) };
  }
  if (data.type === "doc_created") {
    const filename = string(data.filename);
    return {
      events: thinking(
        replaceLast(
          events,
          (event) => event.type === "doc_created" && event.filename === filename && !!event.isStreaming,
          {
            type: "doc_created",
            filename,
            download_url: string(data.download_url),
            ...(clean(data.document_id) ? { document_id: clean(data.document_id) } : {}),
            ...(clean(data.version_id) ? { version_id: clean(data.version_id) } : {}),
            ...(typeof data.version_number === "number" ? { version_number: data.version_number } : {}),
            isStreaming: false,
          },
        ),
      ),
    };
  }
  if (data.type === "doc_edited_start") {
    return { events: append(events, { type: "doc_edited", filename: string(data.filename), document_id: "", version_id: "", download_url: "", annotations: [], isStreaming: true }) };
  }
  if (data.type === "doc_edited") {
    const filename = string(data.filename);
    return {
      events: thinking(
        replaceLast(
          events,
          (event) => event.type === "doc_edited" && event.filename === filename && !!event.isStreaming,
          {
            type: "doc_edited",
            filename,
            document_id: string(data.document_id),
            version_id: string(data.version_id),
            ...(typeof data.version_number === "number" ? { version_number: data.version_number } : {}),
            download_url: string(data.download_url),
            annotations: Array.isArray(data.annotations) ? data.annotations as EditAnnotation[] : [],
            ...(typeof data.error === "string" ? { error: data.error } : {}),
            isStreaming: false,
          },
        ),
      ),
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
