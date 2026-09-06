import type { AskInputsEvent, AskInputsResponseEvent, WorkflowRunEvent } from "@/app/lib/api/chat";
import type { Citation } from "@/app/lib/citations";
import type { EditAnnotation } from "@/app/lib/api/documents";
import type { AssistantActivity, AssistantReaderRun, ProtocolEvent } from "./assistantSession";
import { safeAssistantUrl } from "./safeAssistantUrl";
import { WORK_PRODUCT_KINDS } from "./workProducts";

export const ASSISTANT_LIMITS = {
  activities: 256,
  artifacts: 64,
  blocks: 128,
  citations: 256,
  readers: 32,
  text: 1_000_000,
} as const;

export const FIELD_TEXT_LIMIT = 8_192;
export const SHORT_TEXT_LIMIT = 512;
export const ASSISTANT_GENERIC_ERROR = "Unable to get a response. Try again.";

const INVALID = Symbol("invalid");
type Parsed<T> = T | typeof INVALID;
type Parser<T> = (value: unknown) => Parsed<T>;
type WireObject = Record<string, unknown>;
const wireObject = (value: unknown): value is WireObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// The same field map validates keys and values; only this boundary accepts unknown JSON.
function object<S extends Record<string, Parser<unknown>>>(fields: S) {
  const entries = Object.entries(fields), keys = new Set(Object.keys(fields));
  return (value: unknown): Parsed<{ [K in keyof S]: Exclude<ReturnType<S[K]>, typeof INVALID> }> => {
    if (!wireObject(value) || Object.keys(value).some((key) => !keys.has(key))) return INVALID;
    const result: WireObject = {};
    for (const [key, parse] of entries) {
      const field = parse(value[key]);
      if (field === INVALID) return INVALID;
      if (field !== undefined) result[key] = field;
    }
    return result as { [K in keyof S]: Exclude<ReturnType<S[K]>, typeof INVALID> };
  };
}
const optional = <T>(parse: Parser<T>): Parser<T | undefined> =>
  (value) => value === undefined ? undefined : parse(value);
const nullable = <T>(parse: Parser<T>): Parser<T | null> =>
  (value) => value === null ? null : parse(value);
const defaulted = <T>(parse: Parser<T>, fallback: () => T): Parser<T> =>
  (value) => value === undefined ? fallback() : parse(value);
const map = <T, U>(parse: Parser<T>, project: (value: T) => U): Parser<U> => (value) => {
  const parsed = parse(value);
  return parsed === INVALID ? INVALID : project(parsed);
};
const array = <T>(parse: Parser<T>, limit: number, minimum = 0): Parser<T[]> => (value) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > limit) return INVALID;
  const result: T[] = [];
  for (const raw of value) {
    const item = parse(raw);
    if (item === INVALID) return INVALID;
    result.push(item);
  }
  return result;
};
const choices = <const T extends readonly string[]>(...values: T): Parser<T[number]> =>
  (value) => typeof value === "string" && values.includes(value) ? value as T[number] : INVALID;
const text = (value: unknown, limit = FIELD_TEXT_LIMIT): Parsed<string> =>
  typeof value === "string" && value.length <= limit ? value : INVALID;
const short: Parser<string> = map((value) => text(value, SHORT_TEXT_LIMIT), (value) => value.trim());
const id: Parser<string> = (value) => short(value) || INVALID;
const finite: Parser<number> = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : INVALID;
const safeInteger: Parser<number> = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : INVALID;
const boolean: Parser<boolean> = (value) => typeof value === "boolean" ? value : INVALID;
const status = map(choices("running", "completed", "error", "interrupted", "cancelled"),
  (value) => value === "cancelled" ? "interrupted" as const : value);
const url: Parser<string | null> = (value) =>
  typeof value === "string" && value.length <= FIELD_TEXT_LIMIT ? safeAssistantUrl(value) : INVALID;
const validUrl: Parser<string> = (value) => url(value) ?? INVALID;
const relativeUrl: Parser<string> = (value) => {
  const parsed = validUrl(value);
  return parsed !== INVALID && parsed.startsWith("/") ? parsed : INVALID;
};
const longText: Parser<string> = (value) => text(value, ASSISTANT_LIMITS.text);
const displayFields = {
  display_form: optional(choices("full", "pinpoint", "supra")),
  source_class: optional(choices("case", "legislation", "commentary")),
  external_url: optional(url), authority: optional(short), short_authority: optional(short),
  locator_separator: optional(choices(" at ", ", ")),
};
const locatorFields = { ...displayFields,
  locator_kind: optional(choices("paragraph", "page", "section", "footnote")),
  locator: optional(nullable(short)), pinpoint: optional(nullable(short)),
};
const quotes = defaulted(array(object({ quote: text }), 32), () => []);
const citationParsers: Record<string, Parser<Citation>> = {
  a2aj: object({ kind: choices("a2aj"), ref: safeInteger,
    citation: optional(nullable(short)), name: optional(nullable(short)),
    dataset: optional(nullable(short)), url: optional(nullable(url)), quotes, ...locatorFields }),
  public_legal: object({ kind: choices("public_legal"), ref: safeInteger,
    provider: choices("courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"),
    identifier: id, title: optional(nullable(short)), citation: optional(nullable(short)),
    url: optional(nullable(url)), quotes, ...locatorFields }),
  tabular: object({ kind: choices("tabular"), ref: safeInteger, review_id: id,
    col_index: safeInteger, row_index: safeInteger, col_name: defaulted(short, () => ""),
    doc_name: defaulted(short, () => ""), quotes, ...displayFields }),
  document: object({ kind: choices("document"), ref: safeInteger, document_id: id, filename: id,
    version_id: optional(short), version_number: optional(safeInteger), url: optional(url),
    quotes: defaulted(array(object({ quote: text, sheet: optional(short), cell: optional(short),
      page: optional((value) => typeof value === "number" ? finite(value) : short(value)),
    }), 32), () => []), ...locatorFields }),
};
export function parseAssistantCitations(value: unknown): Citation[] {
  try {
    if (!Array.isArray(value)) return [];
    return value.slice(0, ASSISTANT_LIMITS.citations).flatMap((raw) => {
      try {
        if (!wireObject(raw) || typeof raw.kind !== "string" || !Object.hasOwn(citationParsers, raw.kind)) return [];
        const citation = citationParsers[raw.kind](raw);
        return citation === INVALID ? [] : [citation];
      } catch { return []; }
    });
  } catch { return []; }
}
const citations: Parser<Citation[]> = (value) =>
  Array.isArray(value) ? parseAssistantCitations(value) : INVALID;
const activityFields = { id, tool: id, label: id, status, citations: optional(citations) };
const activity: Parser<AssistantActivity> = object(activityFields);
const askItem: Parser<AskInputsEvent["items"][number]> = (value) => {
  if (!wireObject(value)) return INVALID;
  return value.kind === "choice" ? choiceItem(value) : documentItem(value);
};
const choiceItem = object({ id, kind: choices("choice"), question: text,
  options: array(object({ value: id }), 32, 1) });
const documentItem = object({ id, kind: choices("documents"),
  document_types: defaulted(array(short, 32), () => []) });
const askEvent: Parser<AskInputsEvent> = object({ type: choices("ask_inputs"),
  items: array(askItem, 32, 1) });
const choiceResponse = object({ id, kind: choices("choice"), answer: optional(text) });
const documentResponse = object({ id, kind: choices("documents"),
  documents: defaulted(array(object({ document_id: id, filename: id }), 32), () => []) });
const askResponse: Parser<AskInputsResponseEvent> = object({ type: choices("ask_inputs_response"),
  responses: array<AskInputsResponseEvent["responses"][number]>((value) => {
    if (!wireObject(value)) return INVALID;
    return value.kind === "choice" ? choiceResponse(value) : documentResponse(value);
  }, 32) });
const workflowRun: Parser<WorkflowRunEvent> = map(object({ type: choices("workflow_run"),
  tool: choices("create_table_of_authorities", "update_work_product"),
  id: optional(short), status: defaulted(short, () => "unknown"),
  stage: defaulted(short, () => "Workflow"), progress: optional((raw) => {
    const value = finite(raw);
    return value !== INVALID && value >= 0 && value <= 100 ? value : INVALID;
  }), message: optional(text), counts: optional(array(object({ label: id, value: finite }), 32)),
  outputs: optional(array(object({ name: id, url: optional(validUrl) }), 32)),
  app_url: optional(validUrl), job_id: optional(short), version_number: optional(nullable(safeInteger)),
  error: optional(short), requested_action: optional(choices("open", "refresh", "build")),
  work_product: optional(object({ kind: choices(...WORK_PRODUCT_KINDS), id,
    revision: (value) => safeInteger(value) || INVALID })),
}), (value) => ({ ...value, id: value.id || `${value.tool}:${value.job_id || "run"}`,
  ...(value.error && { error: "Workflow failed." }) }));
const reader = object({ type: choices("subagent_run"), id, task: longText, status,
  activity: optional(activity), activities: optional(array(activity, ASSISTANT_LIMITS.activities)),
  citations: defaulted(citations, () => []), output: optional(longText), error: optional(short) });
const annotation: Parser<EditAnnotation> = object({ edit_id: id, document_id: id, version_id: id,
  version_number: optional(nullable(safeInteger)), del_w_id: optional(short), ins_w_id: optional(short),
  deleted_text: defaulted(text, () => ""), inserted_text: defaulted(text, () => ""),
  context_before: optional(text), context_after: optional(text), reason: optional(text),
  diff: defaulted(array(object({ kind: choices("equal", "delete", "insert"), text }), 256), () => []),
  status: choices("pending", "accepted", "rejected") });
const artifact = object({ type: choices("document_artifact"), action: choices("created", "edited"),
  filename: id, document_id: id, version_id: id, version_number: nullable(safeInteger),
  download_url: relativeUrl, edit_mode: optional(choices("manual", "auto")),
  annotations: defaulted(array(annotation, 256), () => []) });
const parsers: Record<string, Parser<ProtocolEvent>> = {
  turn_queued: object({ type: choices("turn_queued"), jobId: id }),
  client_tool_call: object({ type: choices("client_tool_call"), callId: id, name: id,
    input: (value) => wireObject(value) ? { ...value } : INVALID }),
  chat_id: object({ type: choices("chat_id"), chatId: id, transcriptVersion: optional(safeInteger) }),
  transcript_version: object({ type: choices("transcript_version"), transcriptVersion: safeInteger }),
  content: map(object({ type: choices("content"), text: longText }),
    ({ text }) => ({ type: "content_block", text })),
  content_final: object({ type: choices("content_final"), text: longText, citations }),
  reasoning_delta: map(object({ type: choices("reasoning_delta"), text: (value) => text(value, 65_536) }),
    ({ text }) => ({ type: "reasoning", text, append: true })),
  reasoning: map(object({ type: choices("reasoning"), text: longText }),
    ({ text }) => ({ type: "reasoning", text, append: false, done: true })),
  reasoning_block_end: map(object({ type: choices("reasoning_block_end") }),
    () => ({ type: "reasoning", text: "", append: false, done: true })),
  error: map(object({ type: choices("error"), message: text,
    retryable: optional(boolean), accepted: optional(boolean) }), (value) =>
    value.message.trim() === "Cancelled by user." ? { type: "turn_status", status: "cancelled" }
      : { type: "error", message: ASSISTANT_GENERIC_ERROR, retryable: value.retryable !== false,
        ...(value.accepted !== undefined && { accepted: value.accepted }) }),
  turn_status: object({ type: choices("turn_status"), status: choices("cancelled") }),
  steering: object({ type: choices("steering"), id, text }),
  ask_inputs: map(askEvent, (event) => ({ type: "ask_inputs", event })),
  ask_inputs_response: map(askResponse, (event) => ({ type: "ask_inputs_response", event })),
  tool_activity: map(object({ type: choices("tool_activity"), ...activityFields }),
    ({ type: _type, ...activity }) => ({ type: "activity", activity })),
  workflow_run: map(workflowRun, (run) => ({ type: "workflow_run", run })),
  subagent_run: map(reader, ({ type: _type, activity, activities, ...value }) => ({ type: "reader",
    reader: { ...value, activities: activities ?? (activity === undefined ? [] : [activity]) } satisfies AssistantReaderRun })),
  context_usage: map(object({ type: choices("context_usage"), used_tokens: (raw) => {
    const value = finite(raw); return value !== INVALID && value >= 0 ? value : INVALID;
  }, window_tokens: (raw) => {
    const value = finite(raw); return value !== INVALID && value > 0 ? value : INVALID;
  } }), ({ used_tokens, window_tokens }) => ({ type: "context_usage", usedTokens: used_tokens, windowTokens: window_tokens })),
  compaction: object({ type: choices("compaction"), status: choices("running", "completed", "failed") }),
  document_artifact: map(artifact, (value) => ({ type: "artifact", artifact: {
    id: `${value.action}:${value.document_id}`, type: value.action, filename: value.filename,
    documentId: value.document_id, versionId: value.version_id,
    versionNumber: value.version_number, annotations: value.annotations,
    ...(value.action === "edited" && { editMode: value.edit_mode ?? "manual" }),
  } })),
};
export function parseAssistantProtocolEvent(value: unknown) {
  try {
    const event = wireObject(value) && typeof value.type === "string" && Object.hasOwn(parsers, value.type)
      ? parsers[value.type](value) : INVALID;
    return event === INVALID ? { ok: false as const } : { ok: true as const, event };
  } catch { return { ok: false as const }; }
}
