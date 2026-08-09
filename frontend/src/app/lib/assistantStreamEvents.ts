import type {
  AssistantEvent,
  AutomationToolName,
  EditAnnotation,
} from "@/app/components/shared/types";

type StreamEventReduction = {
  events: AssistantEvent[];
  deferPaint?: boolean;
};
type EventOf<T extends AssistantEvent["type"]> = Extract<
  AssistantEvent,
  { type: T }
>;
type AskItem = EventOf<"ask_inputs">["items"][number];

const text = (value: unknown) => (typeof value === "string" ? value : "");
const clean = (value: unknown) => {
  const valueText = text(value).trim();
  return valueText || undefined;
};
const num = (value: unknown) => (typeof value === "number" ? value : 0);
const id = (value: unknown) => (typeof value === "number" ? value : null);
const numbers = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
const records = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : [];

export function parseCourtlistenerEventCases(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return records(value)
    .map((row) => ({
      cluster_id: typeof row.cluster_id === "number" ? row.cluster_id : 0,
      case_name: typeof row.case_name === "string" ? row.case_name : null,
      citation: typeof row.citation === "string" ? row.citation : null,
      dateFiled: typeof row.dateFiled === "string" ? row.dateFiled : null,
      url: typeof row.url === "string" ? row.url : null,
    }))
    .filter((item) => item.cluster_id > 0);
}
export function parseCourtlistenerCaseSearches(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return records(value).map((row) => ({
    cluster_id: typeof row.cluster_id === "number" ? row.cluster_id : null,
    query: text(row.query),
    total_matches: num(row.total_matches),
    case_name: typeof row.case_name === "string" ? row.case_name : null,
    citation: typeof row.citation === "string" ? row.citation : null,
    error: clean(row.error),
  }));
}

const AUTOMATION_TOOLS = new Set<AutomationToolName>([
  "toa_submit_library_document",
  "toa_job_status",
  "library_fix_docx_supras",
  "library_link_docx_citations",
]);
const START_EVENTS = new Set([
  "doc_find",
  "doc_created",
  "doc_edited",
  "doc_read",
  "courtlistener_search_case_law",
  "courtlistener_get_cases",
  "courtlistener_find_in_case",
  "courtlistener_read_case",
  "courtlistener_verify_citations",
]);
const TOOL_ACTIVITY_FAMILIES: Record<string, string> = {
  ask_inputs: "ask_inputs",
  generate_docx: "doc_created",
  library_create_docx: "doc_created",
  edit_document: "doc_edited",
  library_revise_docx: "doc_edited",
  read_document: "doc_read",
  fetch_documents: "doc_read",
  find_in_document: "doc_find",
  toa_submit_library_document: "automation_run",
  toa_job_status: "automation_run",
  library_link_docx_citations: "automation_run",
  library_fix_docx_supras: "automation_run",
  delegate_read: "subagent_run",
};

function parseAutomationRunEvent(
  data: Record<string, unknown>,
): EventOf<"automation_run"> | null {
  const tool = data.tool;
  if (
    typeof tool !== "string" ||
    !AUTOMATION_TOOLS.has(tool as AutomationToolName)
  )
    return null;
  const counts = records(data.counts).flatMap((row) => {
    const label = clean(row.label);
    return label && typeof row.value === "number"
      ? [{ label, value: row.value }]
      : [];
  });
  const outputs = records(data.outputs).flatMap((row) => {
    const name = clean(row.name);
    const url = clean(row.url);
    return name ? [{ name, ...(url ? { url } : {}) }] : [];
  });
  return {
    type: "automation_run",
    id: clean(data.id) ?? `${tool}:${clean(data.job_id) ?? "run"}`,
    tool: tool as AutomationToolName,
    status: clean(data.status) ?? "unknown",
    stage: clean(data.stage) ?? "Automation",
    ...(typeof data.progress === "number" && { progress: data.progress }),
    ...(clean(data.message) && { message: clean(data.message) }),
    ...(counts.length && { counts }),
    ...(clean(data.error) && { error: clean(data.error) }),
    ...(outputs.length && { outputs }),
    ...(clean(data.app_url) && { app_url: clean(data.app_url) }),
    ...(clean(data.job_id) && { job_id: clean(data.job_id) }),
    ...(clean(data.document_id) && { document_id: clean(data.document_id) }),
    ...(clean(data.version_id) && { version_id: clean(data.version_id) }),
    ...(typeof data.version_number === "number" && {
      version_number: data.version_number,
    }),
  };
}

function parseAskInputs(data: Record<string, unknown>): EventOf<"ask_inputs"> | null {
  const items = records(data.items).flatMap<AskItem>((row, index) => {
    const id = clean(row.id) ?? `input-${index + 1}`;
    const responsePrefix = clean(row.response_prefix);
    if (row.kind === "choice") {
      const options = records(row.options).flatMap((option) => {
        const value = clean(option.value) ?? clean(option.label);
        return value ? [{ value }] : [];
      });
      return [{
        id,
        kind: "choice",
        question: clean(row.question) ?? "Please choose an option.",
        options,
        allow_other: true,
        other_label: "Write your own answer",
        ...(responsePrefix && { response_prefix: responsePrefix }),
      }];
    }
    if (row.kind !== "documents") return [];
    return [{
      id,
      kind: "documents",
      document_types: Array.isArray(row.document_types)
        ? row.document_types.flatMap((value) => clean(value) ?? [])
        : [],
      ...(responsePrefix && { response_prefix: responsePrefix }),
    }];
  });
  return items.length ? { type: "ask_inputs", items } : null;
}

export const isStreamingPlaceholder = (event: AssistantEvent) =>
  event.type === "thinking" && !!event.isStreaming;

export function finishAssistantStreamEvents(events: AssistantEvent[]) {
  let next: AssistantEvent[] | null = null;
  events.forEach((event, index) => {
    if (isStreamingPlaceholder(event)) {
      next ??= events.slice(0, index);
    } else if ("isStreaming" in event && event.isStreaming) {
      next ??= events.slice(0, index);
      const { isStreaming: _, ...finished } = event;
      next.push(finished as AssistantEvent);
    } else {
      next?.push(event);
    }
  });
  return next ?? events;
}

const withoutPlaceholders = (events: AssistantEvent[]) =>
  events
    .filter((event) => !isStreamingPlaceholder(event))
    .map((event) =>
      event.type === "tool_call_start" && event.isStreaming
        ? { ...event, isStreaming: false }
        : event,
    );
const finalizeReasoning = (events: AssistantEvent[]) => {
  const last = events.at(-1);
  return last?.type === "reasoning" && last.isStreaming
    ? [
        ...events.slice(0, -1),
        {
          type: "reasoning" as const,
          text: last.text,
          ...(last.debug && { debug: true }),
        },
      ]
    : events;
};
const append = (events: AssistantEvent[], event: AssistantEvent) => [
  ...finalizeReasoning(withoutPlaceholders(events)).filter(
    (candidate) =>
      event.type === "tool_call_start" ||
      candidate.type !== "tool_call_start" ||
      assistantActivityFamily(candidate) !== assistantActivityFamily(event),
  ),
  event,
];
const thinking = (events: AssistantEvent[]) => [
  ...withoutPlaceholders(events),
  { type: "thinking" as const, isStreaming: true },
];

export function assistantEventKey(event: AssistantEvent) {
  if (event.type === "doc_read") return `doc-read:${event.filename}`;
  if (event.type === "doc_find")
    return `doc-find:${event.filename}:${event.query}`;
  if (event.type === "doc_created") return `doc-created:${event.filename}`;
  if (event.type === "doc_edited") return `doc-edited:${event.filename}`;
  if (event.type === "workflow_applied")
    return `workflow:${event.workflow_id}`;
  if (event.type === "ask_inputs")
    return `ask:${event.items.map((item) => item.id).join(",")}`;
  if (event.type === "mcp_tool_call")
    return `mcp:${event.openai_tool_name}`;
  if (event.type === "tool_call_start")
    return event.id
      ? `tool:${event.id}`
      : `tool:${event.name}:${event.label ?? ""}`;
  if (event.type === "automation_run")
    return `automation:${event.job_id ?? event.id}`;
  if (event.type === "subagent_run") return `subagent:${event.id}`;
  if (event.type === "courtlistener_search_case_law")
    return `case-search:${event.query}`;
  if (event.type === "courtlistener_get_cases")
    return `cases:${event.cluster_ids.join(",")}`;
  if (event.type === "courtlistener_find_in_case")
    return event.searches?.length
      ? "case-find:batch"
      : `case-find:${event.cluster_id}:${event.query}`;
  if (event.type === "courtlistener_read_case")
    return `case-read:${event.cluster_id}`;
  if (event.type === "courtlistener_verify_citations") return "case-verify";
  return event.type;
}
export function assistantActivityFamily(event: AssistantEvent) {
  return event.type === "tool_call_start"
    ? TOOL_ACTIVITY_FAMILIES[event.name] ?? event.name
    : event.type;
}
function track(
  events: AssistantEvent[],
  event: AssistantEvent,
): StreamEventReduction {
  if ("isStreaming" in event && event.isStreaming)
    return { events: append(events, event) };
  const key = assistantEventKey(event);
  const index = events.findLastIndex(
    (candidate) =>
      candidate.type === event.type &&
      "isStreaming" in candidate &&
      !!candidate.isStreaming &&
      assistantEventKey(candidate) === key,
  );
  if (index < 0) return { events: thinking(append(events, event)) };
  const next = [...events];
  next[index] = event;
  return { events: thinking(next) };
}
const reduceEvent = (events: AssistantEvent[], event: AssistantEvent) =>
  "isStreaming" in event
    ? track(events, event)
    : { events: append(events, event) };

function upsertSubagentEvent(
  events: AssistantEvent[],
  event: EventOf<"subagent_run">,
): StreamEventReduction {
  const key = assistantEventKey(event);
  const index = events.findLastIndex(
    (candidate) => assistantEventKey(candidate) === key,
  );
  if (index < 0) return { events: append(events, event) };
  const next = [...events];
  next[index] = event;
  return { events: next };
}

export function reduceAssistantStreamEvent(
  events: AssistantEvent[],
  data: Record<string, unknown>,
): StreamEventReduction | null {
  const rawType = text(data.type);
  const baseType = rawType.replace(/_start$/u, "");
  const streaming = rawType !== baseType && START_EVENTS.has(baseType);
  const type = streaming ? baseType : rawType;

  if (rawType === "automation_run") {
    const event = parseAutomationRunEvent(data);
    return event ? reduceEvent(events, event) : null;
  }
  if (rawType === "reasoning_delta") {
    const cleaned = withoutPlaceholders(events);
    const last = cleaned.at(-1);
    return {
      deferPaint: true,
      events:
        last?.type === "reasoning" && last.isStreaming
          ? [
              ...cleaned.slice(0, -1),
              {
                ...last,
                text: last.text + text(data.text),
                ...(data.debug === true && { debug: true }),
              },
            ]
          : [
              ...finalizeReasoning(cleaned),
              {
                type: "reasoning",
                text: text(data.text),
                ...(data.debug === true && { debug: true }),
                isStreaming: true,
              },
            ],
    };
  }
  if (rawType === "reasoning_block_end")
    return { events: thinking(finalizeReasoning(events)) };
  if (rawType === "content_delta") {
    const cleaned = finalizeReasoning(withoutPlaceholders(events));
    const index = cleaned.findLastIndex(
      (event) => event.type === "content" && !!event.isStreaming,
    );
    if (index < 0)
      return {
        deferPaint: true,
        events: [
          ...cleaned,
          { type: "content", text: text(data.text), isStreaming: true },
        ],
      };
    const next = [...cleaned];
    const current = cleaned[index] as EventOf<"content">;
    next[index] = { ...current, text: current.text + text(data.text) };
    return { deferPaint: true, events: next };
  }
  if (rawType === "tool_call_start")
    return reduceEvent(events, {
      type: "tool_call_start",
      name: text(data.name),
      ...(clean(data.label) && { label: clean(data.label) }),
      ...(clean(data.id) && { id: clean(data.id) }),
      ...(data.input &&
      typeof data.input === "object" &&
      !Array.isArray(data.input)
        ? { input: data.input as Record<string, unknown> }
        : {}),
      isStreaming: true,
    });
  if (rawType === "mcp_tool_start") {
    const name = text(data.name);
    return reduceEvent(events, {
      type: "mcp_tool_call",
      connector_id: "",
      connector_name: "",
      tool_name: name,
      openai_tool_name: name,
      status: "ok",
      isStreaming: true,
    });
  }
  if (rawType === "mcp_tool_result") {
    const name = text(data.name);
    return reduceEvent(events, {
      type: "mcp_tool_call",
      connector_id: "",
      connector_name: text(data.connector_name),
      tool_name: text(data.tool_name) || name,
      openai_tool_name: name,
      status: data.status === "error" ? "error" : "ok",
      ...(clean(data.error) && { error: clean(data.error) }),
      isStreaming: false,
    });
  }
  if (rawType === "ask_inputs") {
    const event = parseAskInputs(data);
    return event ? reduceEvent(events, event) : null;
  }
  if (rawType === "subagent_run") {
    const agent = data.agent;
    const status = data.status;
    const grounding =
      data.grounding &&
      typeof data.grounding === "object" &&
      !Array.isArray(data.grounding)
        ? (data.grounding as Record<string, unknown>)
        : null;
    const activities: NonNullable<
      EventOf<"subagent_run">["activities"]
    > = Array.isArray(data.activities)
      ? data.activities.flatMap<
          NonNullable<EventOf<"subagent_run">["activities"]>[number]
        >((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const activity = value as Record<string, unknown>;
          const activityStatus = activity.status;
          const id = clean(activity.id);
          const label = clean(activity.label);
          const tool = clean(activity.tool);
          const input =
            activity.input &&
            typeof activity.input === "object" &&
            !Array.isArray(activity.input)
              ? (activity.input as Record<string, unknown>)
              : null;
          const sourceRow =
            activity.source &&
            typeof activity.source === "object" &&
            !Array.isArray(activity.source)
              ? (activity.source as Record<string, unknown>)
              : null;
          const sourceCitation = clean(sourceRow?.citation);
          const source = sourceCitation
            ? {
                provider: text(sourceRow?.provider),
                jurisdiction: text(sourceRow?.jurisdiction),
                citation: sourceCitation,
                name: clean(sourceRow?.name) || null,
                dataset: text(sourceRow?.dataset),
                url: clean(sourceRow?.url) || null,
                ...(typeof sourceRow?.clusterId === "number" && {
                  clusterId: sourceRow.clusterId,
                }),
              }
            : null;
          return id && label &&
            (activityStatus === "running" ||
              activityStatus === "completed" ||
              activityStatus === "error")
            ? [{
                id,
                label,
                status: activityStatus,
                ...(tool && { tool }),
                ...(input && { input }),
                ...(source && { source }),
              }]
            : [];
        })
      : [];
    const sources: NonNullable<EventOf<"subagent_run">["sources"]> =
      Array.isArray(data.sources)
        ? data.sources.flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            const source = value as Record<string, unknown>;
            const citation = clean(source.citation);
            if (!citation) return [];
            return [{
              provider: text(source.provider),
              jurisdiction: text(source.jurisdiction),
              citation,
              name: clean(source.name) || null,
              dataset: text(source.dataset),
              url: clean(source.url) || null,
              ...(typeof source.clusterId === "number" && {
                clusterId: source.clusterId,
              }),
            }];
          })
        : [];
    if (
      (agent !== "scout" && agent !== "planner" && agent !== "reviewer") ||
      (status !== "running" && status !== "completed" && status !== "error")
    ) {
      return null;
    }
    return upsertSubagentEvent(events, {
      type: "subagent_run",
      id: clean(data.id) ?? `${agent}:${text(data.task)}`,
      agent,
      task: text(data.task),
      model: text(data.model),
      effort: text(data.effort),
      status,
      ...(activities.length && { activities }),
      ...(sources.length && { sources }),
      ...(Array.isArray(data.reasoning) && {
        reasoning: data.reasoning.flatMap((value) => {
          const item = clean(value);
          return item ? [item] : [];
        }),
      }),
      ...(clean(data.output) && { output: clean(data.output) }),
      ...(clean(data.error) && { error: clean(data.error) }),
      ...(grounding &&
        (grounding.status === "passed" || grounding.status === "failed") && {
          grounding: {
            status: grounding.status,
            evidence: Array.isArray(grounding.evidence)
              ? grounding.evidence
              : [],
          },
        }),
      isStreaming: status === "running",
    });
  }

  if (type === "workflow_applied")
    return reduceEvent(events, {
      type,
      workflow_id: text(data.workflow_id),
      title: text(data.title),
    });
  if (type === "doc_find") {
    const filename = text(data.filename);
    const query = text(data.query);
    return reduceEvent(events, {
      type,
      filename,
      query,
      total_matches: num(data.total_matches),
      isStreaming: streaming,
    });
  }
  if (type === "doc_created") {
    const filename = text(data.filename);
    return reduceEvent(events, {
      type,
      filename,
      download_url: text(data.download_url),
      ...(clean(data.document_id) && { document_id: clean(data.document_id) }),
      ...(clean(data.version_id) && { version_id: clean(data.version_id) }),
      ...(typeof data.version_number === "number" && {
        version_number: data.version_number,
      }),
      isStreaming: streaming,
    });
  }
  if (type === "doc_edited") {
    const filename = text(data.filename);
    return reduceEvent(events, {
      type,
      filename,
      document_id: text(data.document_id),
      version_id: text(data.version_id),
      download_url: text(data.download_url),
      annotations: Array.isArray(data.annotations)
        ? (data.annotations as EditAnnotation[])
        : [],
      ...(typeof data.version_number === "number" && {
        version_number: data.version_number,
      }),
      ...(clean(data.error) && { error: clean(data.error) }),
      isStreaming: streaming,
    });
  }
  if (type === "doc_read") {
    const filename = text(data.filename);
    const current = events.findLast(
      (event) =>
        event.type === type &&
        event.filename === filename &&
        !!event.isStreaming,
    );
    return reduceEvent(events, {
      type,
      filename,
      document_id:
        text(data.document_id) ||
        (current?.type === type ? current.document_id : undefined),
      isStreaming: streaming,
    });
  }
  if (type === "courtlistener_search_case_law") {
    const query = text(data.query);
    return reduceEvent(events, {
      type,
      query,
      ...(!streaming && {
        result_count: num(data.result_count),
        error: clean(data.error),
      }),
      isStreaming: streaming,
    });
  }
  if (type === "courtlistener_get_cases")
    return reduceEvent(events, {
      type,
      cluster_ids: numbers(data.cluster_ids),
      ...(!streaming && {
        case_count: num(data.case_count),
        opinion_count: num(data.opinion_count),
        cases: parseCourtlistenerEventCases(data.cases),
        error: clean(data.error),
      }),
      isStreaming: streaming,
    });
  if (type === "courtlistener_find_in_case") {
    const searches = parseCourtlistenerCaseSearches(data.searches);
    const clusterId = searches?.length ? null : id(data.cluster_id);
    const query = searches?.length ? "" : text(data.query);
    return reduceEvent(events, {
      type,
      cluster_id: clusterId,
      query,
      searches,
      ...(!streaming && {
        total_matches: num(data.total_matches),
        case_name: clean(data.case_name) ?? null,
        citation: clean(data.citation) ?? null,
        error: clean(data.error),
      }),
      isStreaming: streaming,
    });
  }
  if (type === "courtlistener_read_case") {
    const clusterId = id(data.cluster_id);
    return reduceEvent(events, {
      type,
      cluster_id: clusterId,
      ...(!streaming && {
        case_name: clean(data.case_name) ?? null,
        citation: clean(data.citation) ?? null,
        opinion_count: num(data.opinion_count),
        error: clean(data.error),
      }),
      isStreaming: streaming,
    });
  }
  if (type === "courtlistener_verify_citations")
    return reduceEvent(events, {
      type,
      citation_count: num(data.citation_count),
      ...(!streaming && {
        match_count: num(data.match_count),
        error: clean(data.error),
      }),
      isStreaming: streaming,
    });
  if (type === "case_citation")
    return reduceEvent(events, {
      type,
      cluster_id: id(data.cluster_id),
      case_name: clean(data.case_name) ?? null,
      citation: clean(data.citation) ?? null,
      url: text(data.url),
      pdfUrl: clean(data.pdfUrl) ?? null,
      dateFiled: clean(data.dateFiled) ?? null,
    });
  if (type === "case_opinions")
    return reduceEvent(events, {
      type,
      cluster_id: num(data.cluster_id),
      case: data.case as EventOf<"case_opinions">["case"],
    });
  return null;
}
