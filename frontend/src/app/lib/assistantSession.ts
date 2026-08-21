
import type {
  AskInputsEvent,
  AskInputsResponseEvent,
  AutomationRunEvent,
  Citation,
  EditAnnotation,
  Message,
  ToolActivitySource,
} from "@/app/components/shared/types";
import { z } from "zod";

export const ASSISTANT_LIMITS = {
  activities: 256,
  artifacts: 64,
  blocks: 128,
  citations: 256,
  readers: 32,
  text: 1_000_000,
} as const;

const FIELD_TEXT_LIMIT = 8_192;
const SHORT_TEXT_LIMIT = 512;
export const ASSISTANT_GENERIC_ERROR = "Unable to get a response. Try again.";
export type AssistantTranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  content: string | unknown[] | null;
  files?: Message["files"] | null;
  workflow?: Message["workflow"] | null;
  citations?: Citation[] | null;
  turn_id?: string;
  turn_complete?: boolean;
};

export type AssistantActivityStatus =
  | "running"
  | "completed"
  | "error"
  | "interrupted";

export type AssistantActivity = {
  id: string;
  tool: string;
  label: string;
  status: AssistantActivityStatus;
  detail?: string;
  markdown?: string;
  items?: { label: string; detail?: string; url?: string | null; error?: boolean }[];
  source?: ToolActivitySource;
  sources?: ToolActivitySource[];
  action?: { type: "reader"; readerId: string };
};

export type AssistantReaderRun = {
  id: string;
  task: string;
  status: AssistantActivityStatus;
  activities: AssistantActivity[];
  output?: string;
  sources: ToolActivitySource[];
};

export type AssistantArtifact = {
  id: string;
  type: "created" | "edited";
  filename: string;
  downloadUrl: string;
  documentId?: string;
  versionId?: string;
  versionNumber?: number | null;
  editMode?: "manual" | "auto";
  annotations: EditAnnotation[];
};

export type AssistantDialogueBlock = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

export type AssistantMessageState = {
  id: string;
  role: "assistant";
  blocks: AssistantDialogueBlock[];
  activities: AssistantActivity[];
  automations: AutomationRunEvent[];
  artifacts: AssistantArtifact[];
  citations: Citation[];
  contextCompacted: boolean;
  contentFinal: boolean;
  contentOpen: boolean;
  error?: string;
  turnId?: string;
  turnStatus?: "cancelled" | "interrupted";
  turnComplete?: boolean;
};

export type UserMessageState = Pick<
  Message,
  "id" | "content" | "files" | "workflow" | "model" | "reasoningEffort" | "editMode" | "turnId"
> & { id: string; role: "user" };

export type AssistantSessionMessage = UserMessageState | AssistantMessageState;

export type AssistantTurnOptions = {
  displayedDoc?: { documentId: string } | null;
  turnId?: string;
  askInputsResponse?: AskInputsResponseEvent;
};

export type RejectedAssistantTurn = {
  message: Message;
  options?: AssistantTurnOptions;
  detail?: string;
  retryable?: boolean;
};

export type AssistantPendingInput = {
  key: string;
  messageId: string;
  event: AskInputsEvent;
};

export type AssistantSessionState = {
  chatId?: string;
  messages: AssistantSessionMessage[];
  readers: AssistantReaderRun[];
  pendingInput: AssistantPendingInput | null;
  contextUsage?: { usedTokens: number; windowTokens: number };
  compaction?: "running" | "completed" | "failed";
  run: { id: string; status: "running" | "paused"; chatId?: string } | null;
  rejectedTurn: RejectedAssistantTurn | null;
  transcriptVersion: number;
};

export type ProtocolEvent =
  | { type: "chat_id"; chatId: string; transcriptVersion?: number }
  | { type: "transcript_version"; transcriptVersion: number }
  | { type: "content_block"; text: string }
  | { type: "content_final"; text: string; citations: Citation[] }
  | { type: "reasoning"; text: string; append: boolean; done?: boolean }
  | { type: "activity"; activity: AssistantActivity }
  | { type: "artifact"; artifact: AssistantArtifact }
  | { type: "automation"; run: AutomationRunEvent }
  | { type: "reader"; reader: AssistantReaderRun }
  | { type: "ask_inputs"; event: AskInputsEvent }
  | { type: "ask_inputs_response"; event: AskInputsResponseEvent }
  | { type: "steering"; id: string; text: string }
  | { type: "context_usage"; usedTokens: number; windowTokens: number }
  | { type: "compaction"; status: "running" | "completed" | "failed" }
  | { type: "turn_status"; status: "cancelled" }
  | { type: "error"; message: string; retryable: boolean };

export type AssistantSessionEvent =
  | { type: "transcript_loaded"; chatId?: string; messages: AssistantTranscriptMessage[]; active?: boolean; transcriptVersion?: number; preserveRejected?: boolean }
  | { type: "run_started"; runId: string; chatId?: string; message: Message; options?: AssistantTurnOptions }
  | { type: "run_resumed"; runId: string; chatId: string }
  | { type: "protocol"; runId: string; chatId?: string; event: ProtocolEvent }
  | { type: "run_finished"; runId: string }
  | { type: "run_interrupted"; runId: string; status: "cancelled" | "interrupted" }
  | { type: "run_failed"; runId: string; message?: string; rejected?: RejectedAssistantTurn }
  | { type: "turn_rejected"; rejected: RejectedAssistantTurn | null }
  | { type: "steering_queued"; runId: string; id: string; text: string }
  | { type: "compaction_changed"; status: "running" | "completed" | "failed"; error?: string }
  | { type: "new_chat"; chatId?: string; message?: Message }
  | { type: "transcript_version_changed"; transcriptVersion: number }
  | { type: "local_exchange"; user: Message; assistantText: string };

type ParseResult = { ok: true; event: ProtocolEvent } | { ok: false };
const shortText = z.string().max(SHORT_TEXT_LIMIT).transform((value) => value.trim());
const fieldText = z.string().max(FIELD_TEXT_LIMIT);
const longText = z.string().max(ASSISTANT_LIMITS.text);
const idText = shortText.pipe(z.string().min(1));
const countNumber = z.number().finite().nonnegative();
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const statusSchema = z.enum(["running", "completed", "error", "interrupted", "cancelled"])
  .transform((status): AssistantActivityStatus => status === "cancelled" ? "interrupted" : status);

function bounded(value: unknown, depth = 0, budget = { value: 0 }): boolean {
  if (depth > 12 || ++budget.value > 4_096) return false;
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, child]) =>
    key !== "__proto__" && key !== "prototype" && key !== "constructor" &&
    bounded(child, depth + 1, budget));
}
const boundedEvent = z.unknown().superRefine((value, context) => {
  if (!bounded(value)) context.addIssue({ code: "custom", message: "unsafe event" });
});

export function safeAssistantUrl(
  value: unknown,
  { relative = true }: { relative?: boolean } = {},
): string | null {
  const raw = typeof value === "string" ? value.trim().slice(0, FIELD_TEXT_LIMIT) : "";
  if (
    !raw ||
    raw.includes("\\") ||
    Array.from(raw).some((character) => character.charCodeAt(0) <= 0x1f)
  ) return null;
  if (relative && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
const safeUrl = z.string().max(FIELD_TEXT_LIMIT).transform((value) => safeAssistantUrl(value));
const validUrl = safeUrl.pipe(z.string());
const sourceSchema = z.strictObject({
  provider: shortText.default(""), jurisdiction: shortText.default(""), citation: idText,
  name: shortText.nullish().transform((value) => value || null),
  dataset: shortText.default(""), url: safeUrl.nullish().transform((value) => value ?? null),
  locator: shortText.optional(), quote: fieldText.optional(),
});
const activityFields = {
  id: idText, tool: idText, label: idText, status: statusSchema,
  source: sourceSchema.optional(),
};
const activitySchema = z.strictObject(activityFields);
const editAnnotationSchema = z.strictObject({
  edit_id: idText, document_id: idText, version_id: idText,
  version_number: safeInteger.nullish(),
  del_w_id: shortText.optional(), ins_w_id: shortText.optional(),
  deleted_text: fieldText.default(""), inserted_text: fieldText.default(""),
  context_before: fieldText.optional(), context_after: fieldText.optional(), reason: fieldText.optional(),
  diff: z.array(z.strictObject({
    kind: z.enum(["equal", "delete", "insert"]), text: fieldText,
  })).max(256).default([]),
  status: z.enum(["pending", "accepted", "rejected"]),
});
const displayFields = {
  display_form: z.enum(["full", "pinpoint", "supra"]).optional(),
  source_class: z.enum(["case", "legislation", "commentary"]).optional(),
  external_url: safeUrl.optional(), authority: shortText.optional(),
  short_authority: shortText.optional(), locator_separator: z.enum([" at ", ", "]).optional(),
};
const locatorFields = {
  ...displayFields, locator_kind: z.enum(["paragraph", "page", "section", "footnote"]).optional(),
  locator: shortText.nullish(), pinpoint: shortText.nullish(),
};
const citationQuote = z.strictObject({ quote: fieldText });
const citationSchema = z.union([
  z.strictObject({
    kind: z.literal("a2aj"), ref: safeInteger,
    citation: shortText.nullish(), name: shortText.nullish(), dataset: shortText.nullish(),
    url: safeUrl.nullish(), quotes: z.array(citationQuote).max(32).default([]), ...locatorFields,
  }),
  z.strictObject({
    kind: z.literal("public_legal"), ref: safeInteger,
    provider: z.enum(["courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"]), identifier: idText,
    title: shortText.nullish(), citation: shortText.nullish(), url: safeUrl.nullish(),
    quotes: z.array(citationQuote).max(32).default([]), ...locatorFields,
  }),
  z.strictObject({
    kind: z.literal("tabular"), ref: safeInteger,
    review_id: idText, col_index: safeInteger, row_index: safeInteger,
    col_name: shortText.default(""), doc_name: shortText.default(""),
    quotes: z.array(citationQuote).max(32).default([]), ...displayFields,
  }),
  z.strictObject({
    kind: z.literal("document"), ref: safeInteger,
    document_id: idText, filename: idText,
    version_id: shortText.optional(), version_number: safeInteger.optional(), url: safeUrl.optional(),
    quotes: z.array(z.strictObject({
      page: z.union([z.number().finite(), shortText]).optional(),
      quote: fieldText, sheet: shortText.optional(), cell: shortText.optional(),
    })).max(32).default([]), ...locatorFields,
  }),
]).transform((citation) => citation as Citation);
const citationListSchema = z.preprocess(
  (value) => Array.isArray(value) ? value.slice(0, ASSISTANT_LIMITS.citations) : value,
  z.array(z.unknown()),
).transform((values) => values.flatMap((value) => {
  const parsed = citationSchema.safeParse(value);
  return parsed.success ? [parsed.data] : [];
}));
export function parseAssistantCitations(value: unknown): Citation[] {
  const parsed = citationListSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

const askItemSchema = z.union([
  z.strictObject({
    id: idText, kind: z.literal("choice"), question: fieldText,
    options: z.array(z.strictObject({ value: idText })).min(1).max(32),
  }),
  z.strictObject({
    id: idText, kind: z.literal("documents"),
    document_types: z.array(shortText).max(32).default([]),
  }),
]);
const askEventSchema = z.strictObject({
  type: z.literal("ask_inputs"), items: z.array(askItemSchema).min(1).max(32),
});
const askResponseSchema = z.strictObject({
  type: z.literal("ask_inputs_response"),
  responses: z.array(z.union([
    z.strictObject({
      id: idText, kind: z.literal("choice"),
      answer: fieldText.optional(),
    }),
    z.strictObject({
      id: idText, kind: z.literal("documents"),
      documents: z.array(z.strictObject({
        document_id: idText, filename: idText,
      })).max(32).default([]),
    }),
  ])).max(32),
});
const automationSchema = z.strictObject({
  type: z.literal("automation_run"), id: shortText.optional(),
  tool: z.enum(["create_table_of_authorities", "fix_docx_supras"]),
  status: shortText.default("unknown"), stage: shortText.default("Automation"),
  progress: z.number().finite().min(0).max(100).optional(), message: fieldText.optional(),
  counts: z.array(z.strictObject({ label: idText, value: z.number().finite() })).max(32).optional(),
  outputs: z.array(z.strictObject({ name: idText, url: validUrl.optional() })).max(32).optional(),
  app_url: validUrl.optional(), job_id: shortText.optional(),
  version_number: safeInteger.nullish(), error: shortText.optional(),
}).transform((row): AutomationRunEvent => ({
  ...row, id: row.id || row.tool + ":" + (row.job_id || "run"),
  ...(row.error && { error: "Automation failed." }),
}));
const readerSchema = z.strictObject({
  type: z.literal("subagent_run"), id: idText,
  task: longText, status: statusSchema,
  activities: z.array(activitySchema).max(ASSISTANT_LIMITS.activities).default([]),
  output: longText.optional(),
  sources: z.array(sourceSchema).max(ASSISTANT_LIMITS.citations).default([]),
}).transform(({ type: _type, ...row }): AssistantReaderRun => row);

const marker = (type: string) => z.strictObject({ type: z.literal(type) });
const contentEvent = z.strictObject({ type: z.literal("content"), text: longText })
  .transform((row): ProtocolEvent => ({ type: "content_block", text: row.text }));
const relativeUrl = z.string().max(FIELD_TEXT_LIMIT)
  .transform((value) => safeAssistantUrl(value))
  .pipe(z.string().refine((value) => value.startsWith("/"), "relative URL required"));
const documentArtifactSchema = z.strictObject({
  type: z.literal("document_artifact"),
  action: z.enum(["created", "edited"]),
  filename: idText,
  document_id: idText,
  version_id: idText,
  version_number: safeInteger.nullable(),
  download_url: relativeUrl,
  edit_mode: z.enum(["manual", "auto"]).optional(),
  annotations: z.array(editAnnotationSchema).max(256).optional(),
}).transform((row): ProtocolEvent => ({
  type: "artifact",
  artifact: {
    id: `${row.action}:${row.document_id}`,
    type: row.action,
    filename: row.filename,
    downloadUrl: row.download_url,
    documentId: row.document_id,
    versionId: row.version_id,
    versionNumber: row.version_number,
    ...(row.action === "edited" && { editMode: row.edit_mode ?? "manual" }),
    annotations: row.annotations ?? [],
  },
}));
const protocolSchemas = [
  z.strictObject({ type: z.literal("chat_id"), chatId: idText,
    transcriptVersion: safeInteger.optional() })
    .transform((row): ProtocolEvent => ({ type: "chat_id", chatId: row.chatId,
      ...(row.transcriptVersion !== undefined && { transcriptVersion: row.transcriptVersion }) })),
  z.strictObject({ type: z.literal("transcript_version"), transcriptVersion: safeInteger })
    .transform((row): ProtocolEvent => row),
  contentEvent,
  z.strictObject({
    type: z.literal("content_final"), text: longText, citations: citationListSchema,
  }).transform((row): ProtocolEvent => ({
    type: "content_final", text: row.text,
    citations: row.citations,
  })),
  z.strictObject({ type: z.literal("reasoning_delta"), text: z.string().max(65_536) })
    .transform((row): ProtocolEvent => ({ type: "reasoning", text: row.text, append: true })),
  z.strictObject({ type: z.literal("reasoning"), text: longText })
    .transform((row): ProtocolEvent => ({
      type: "reasoning", text: row.text, append: false, done: true,
    })),
  marker("reasoning_block_end").transform(() => ({ type: "reasoning" as const,
    text: "", append: false, done: true })),
  z.strictObject({ type: z.literal("error"), message: fieldText, retryable: z.boolean().optional() })
    .transform((row): ProtocolEvent => row.message.trim() === "Cancelled by user."
      ? { type: "turn_status", status: "cancelled" }
      : { type: "error", message: ASSISTANT_GENERIC_ERROR, retryable: row.retryable !== false }),
  z.strictObject({ type: z.literal("turn_status"),
    status: z.literal("cancelled") }).transform((row): ProtocolEvent => row),
  z.strictObject({ type: z.literal("steering"), id: idText, text: fieldText })
    .transform((row): ProtocolEvent => row),
  askEventSchema.transform((event): ProtocolEvent => ({ type: "ask_inputs", event })),
  askResponseSchema.transform((event): ProtocolEvent => ({ type: "ask_inputs_response", event })),
  z.strictObject({ type: z.literal("tool_activity"), ...activityFields })
    .transform(({ type: _type, ...activity }): ProtocolEvent => ({ type: "activity", activity })),
  automationSchema.transform((run): ProtocolEvent => ({ type: "automation", run })),
  readerSchema.transform((reader): ProtocolEvent => ({ type: "reader", reader })),
  z.strictObject({ type: z.literal("context_usage"),
    used_tokens: countNumber, window_tokens: z.number().finite().positive() })
    .transform((row): ProtocolEvent => ({ type: "context_usage",
      usedTokens: row.used_tokens, windowTokens: row.window_tokens })),
  z.strictObject({ type: z.literal("compaction"),
    status: z.enum(["running", "completed", "failed"]) }).transform((row): ProtocolEvent => row),
  documentArtifactSchema,
];
const protocolSchema = boundedEvent.pipe(z.union(protocolSchemas as [
  (typeof protocolSchemas)[number], (typeof protocolSchemas)[number],
  ...(typeof protocolSchemas)[number][],
]));
export function parseAssistantProtocolEvent(value: unknown): ParseResult {
  const parsed = protocolSchema.safeParse(value);
  return parsed.success ? { ok: true, event: parsed.data as ProtocolEvent } : { ok: false };
}

function textValue(value: unknown, limit = FIELD_TEXT_LIMIT): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function cleanValue(value: unknown, limit = SHORT_TEXT_LIMIT): string {
  return textValue(value, limit).trim();
}

function emptyAssistant(id: string, turnId?: string): AssistantMessageState {
  return { id, role: "assistant", blocks: [], activities: [], automations: [], artifacts: [], citations: [], contextCompacted: false, contentFinal: false, contentOpen: false, ...(turnId && { turnId }) };
}

function userMessage(message: Message, fallbackId: string): UserMessageState {
  const files = (message.files ?? []).slice(0, 64).flatMap((file) => {
    const filename = cleanValue(file?.filename);
    const documentId = cleanValue(file.document_id);
    return filename && documentId ? [{ filename, document_id: documentId }] : [];
  });
  const workflowId = cleanValue(message.workflow?.id);
  const workflowTitle = cleanValue(message.workflow?.title);
  const workflow = workflowId && workflowTitle ? { id: workflowId, title: workflowTitle } : undefined;
  const model = cleanValue(message.model);
  const reasoningEffort = cleanValue(message.reasoningEffort);
  const turnId = cleanValue(message.turnId);
  return {
    id: cleanValue(message.id) || fallbackId,
    role: "user",
    content: textValue(message.content, ASSISTANT_LIMITS.text),
    ...(files.length && { files }),
    ...(workflow && { workflow }),
    ...(model && { model }),
    ...(reasoningEffort && { reasoningEffort }),
    ...(message.editMode === "manual" || message.editMode === "auto" ? { editMode: message.editMode } : {}),
    ...(turnId && { turnId }),
  };
}

function updateAssistant(state: AssistantSessionState, updater: (message: AssistantMessageState) => AssistantMessageState, create = true) {
  const index = state.messages.findLastIndex((message) => message.role === "assistant");
  if (index < 0) {
    if (!create) return state;
    return { ...state, messages: [...state.messages, updater(emptyAssistant(`assistant:${state.messages.length}`))] };
  }
  const messages = state.messages.slice();
  messages[index] = updater(messages[index] as AssistantMessageState);
  return { ...state, messages };
}

function upsertById<T extends { id: string }>(items: T[], item: T, limit: number) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item].slice(-limit);
  const next = items.slice(); next[index] = item; return next;
}

function messageContent(blocks: AssistantDialogueBlock[]) {
  return blocks.filter((block) => block.role === "assistant").map((block) => block.text).join("\n\n");
}

function appendContent(message: AssistantMessageState, text: string) {
  if (!text) return message;
  const blocks = message.blocks.slice();
  const last = blocks.at(-1);
  if (message.contentOpen && last?.role === "assistant") {
    const otherLength = messageContent(blocks.slice(0, -1)).length;
    const combined = (last.text + text).slice(0, Math.max(0, ASSISTANT_LIMITS.text - otherLength));
    blocks[blocks.length - 1] = { ...last, text: combined };
  } else {
    const remaining = Math.max(0, ASSISTANT_LIMITS.text - messageContent(blocks).length);
    if (remaining) blocks.push({ id: `content:${message.id}:${blocks.length}`, role: "assistant", text: text.slice(0, remaining) });
  }
  const limited = blocks.slice(-ASSISTANT_LIMITS.blocks);
  return { ...message, blocks: limited, contentOpen: true };
}

function replaceContent(message: AssistantMessageState, text: string) {
  const lastSteering = message.blocks.findLastIndex((block) => block.role === "user");
  const firstContent = message.blocks.findIndex((block, index) => index > lastSteering && block.role === "assistant");
  const blocks = message.blocks.filter((block, index) => index <= lastSteering || block.role !== "assistant");
  const remaining = Math.max(0, ASSISTANT_LIMITS.text - messageContent(blocks).length);
  if (text && remaining) blocks.splice(firstContent < 0 ? blocks.length : Math.min(firstContent, blocks.length), 0, { id: `content:${message.id}:${firstContent < 0 ? blocks.length : firstContent}`, role: "assistant", text: text.slice(0, remaining) });
  return { ...message, blocks, contentOpen: false };
}

function completeActivity(activity: AssistantActivity): AssistantActivity {
  return activity.status === "running"
    ? { ...activity, status: "completed" }
    : activity;
}

function failActivity(activity: AssistantActivity): AssistantActivity {
  return activity.status === "running" ? { ...activity, status: "error" } : activity;
}

function finishContent(
  state: AssistantSessionState,
  text: string,
  citations: Citation[],
) {
  const next = updateAssistant(state, (message) => ({
    ...replaceContent(message, text),
    citations,
    contentFinal: true,
    activities: message.activities.map(completeActivity),
  }));
  return {
    ...next,
    readers: next.readers.map((reader) => reader.status === "running"
      ? {
          ...reader,
          status: "completed" as const,
          activities: reader.activities.map(completeActivity),
        }
      : reader),
  };
}

function interrupt(state: AssistantSessionState, status: "cancelled" | "interrupted") {
  const interrupted = updateAssistant(state, (message) => ({
    ...message,
    contentOpen: false,
    turnStatus: status,
    activities: message.activities.map((activity) => activity.status === "running" ? { ...activity, status: "interrupted" as const } : activity),
  }), false);
  return {
    ...interrupted,
    readers: interrupted.readers.map((reader) => reader.status === "running" ? { ...reader, status: "interrupted" as const, activities: reader.activities.map((activity) => activity.status === "running" ? { ...activity, status: "interrupted" as const } : activity) } : reader),
    pendingInput: null,
    run: null,
  };
}

function applyProtocol(state: AssistantSessionState, event: ProtocolEvent): AssistantSessionState {
  if (event.type === "chat_id") return { ...state, chatId: event.chatId, transcriptVersion: event.transcriptVersion ?? state.transcriptVersion, run: state.run ? { ...state.run, chatId: event.chatId } : null };
  if (event.type === "transcript_version") return { ...state, transcriptVersion: event.transcriptVersion };
  if (event.type === "context_usage") return { ...state, contextUsage: { usedTokens: event.usedTokens, windowTokens: event.windowTokens } };
  if (event.type === "compaction") {
    const next = updateAssistant(state, (message) => ({ ...message, contextCompacted: event.status === "completed" || message.contextCompacted, contentOpen: false }));
    return { ...next, compaction: event.status };
  }
  if (event.type === "turn_status") return interrupt(state, event.status);
  if (event.type === "content_block") return updateAssistant(state, (message) => ({ ...appendContent({ ...message, contentOpen: false }, event.text), contentOpen: false }));
  if (event.type === "content_final")
    return finishContent(state, event.text, event.citations);
  if (event.type === "reasoning") {
    if (!event.text) return updateAssistant(state, (message) => ({
      ...message,
      contentOpen: false,
      activities: event.done ? message.activities.map((activity, index) =>
        activity.tool === "reasoning" && activity.status === "running" &&
          !message.activities.slice(index + 1).some((next) => next.tool === "reasoning")
          ? completeActivity(activity)
          : activity) : message.activities,
    }));
    const label = event.text.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1").replace(/[*_`~]+/gu, "").replace(/\s+/gu, " ").trim().slice(0, 120);
    if (!label) return state;
    return updateAssistant(state, (message) => {
      const current = message.activities.findLast((activity) =>
        activity.tool === "reasoning" && activity.status === "running");
      const id = current?.id ?? `reasoning:${message.activities.filter((activity) =>
        activity.tool === "reasoning").length}`;
      const activity: AssistantActivity = { id, tool: "reasoning", label, status: event.done ? "completed" : "running" };
      return { ...message, contentOpen: false, activities: upsertById(message.activities, activity, ASSISTANT_LIMITS.activities) };
    });
  }
  if (event.type === "activity") {
    return updateAssistant(state, (message) => ({
      ...message,
      contentOpen: false,
      activities: upsertById(message.activities, event.activity, ASSISTANT_LIMITS.activities),
    }));
  }
  if (event.type === "artifact") return updateAssistant(state, (message) => ({
    ...message,
    artifacts: upsertById(message.artifacts, event.artifact, ASSISTANT_LIMITS.artifacts),
  }));
  if (event.type === "automation") return updateAssistant(state, (message) => ({ ...message, contentOpen: false, automations: upsertById(message.automations, event.run, ASSISTANT_LIMITS.activities) }));
  if (event.type === "reader") {
    const task = event.reader.task.replace(/\s+/gu, " ").trim().slice(0, 100);
    const activity: AssistantActivity = {
      id: `reader:${event.reader.id}`, tool: "subagent_run",
      label: event.reader.status === "running" ? `Waiting for reading agent: ${task}` : event.reader.status === "error" ? "Reading agent failed" : event.reader.status === "interrupted" ? `Reading agent interrupted: ${task}` : `Reading agent completed: ${task}`,
      status: event.reader.status,
      ...(event.reader.output && { markdown: event.reader.output, sources: event.reader.sources }),
      ...(event.reader.sources.length && { detail: `${event.reader.sources.length} verified passage${event.reader.sources.length === 1 ? "" : "s"}` }),
      action: { type: "reader", readerId: event.reader.id },
    };
    const next = updateAssistant(state, (message) => ({ ...message, contentOpen: false, activities: upsertById(message.activities, activity, ASSISTANT_LIMITS.activities) }));
    return { ...next, readers: upsertById(next.readers, event.reader, ASSISTANT_LIMITS.readers) };
  }
  if (event.type === "ask_inputs") {
    let pending: AssistantPendingInput | null = null;
    const next = updateAssistant(state, (message) => {
      const id = `ask:${event.event.items.map((item) => item.id).join(",")}`;
      pending = { key: `${state.chatId ?? "new"}:${message.id}:${id}`, messageId: message.id, event: event.event };
      return {
        ...message,
        contentOpen: false,
        activities: upsertById(
          message.activities.map(completeActivity),
          { id, tool: "ask_inputs", label: "Waiting for input", status: "completed", items: event.event.items.map((item, index) => ({ label: `${index + 1}. ${item.kind === "choice" ? item.question : item.document_types.join(", ") || "Documents requested"}` })) },
          ASSISTANT_LIMITS.activities,
        ),
      };
    });
    return { ...next, pendingInput: pending, run: next.run ? { ...next.run, status: "paused" } : null };
  }
  if (event.type === "ask_inputs_response") {
    const pending = state.pendingInput;
    const next = updateAssistant(state, (message) => {
      const activity = pending ? message.activities.find((item) => item.id === `ask:${pending.event.items.map((entry) => entry.id).join(",")}`) : message.activities.findLast((item) => item.tool === "ask_inputs" && item.status === "running");
      if (!activity) return message;
      const responses = new Map(event.event.responses.map((response) => [response.id, response]));
      const items = (pending?.event.items ?? []).map((item, index) => {
        const answer = responses.get(item.id);
        const detail = !answer ? undefined : answer.kind === "choice"
          ? answer.answer || "Skipped"
          : answer.documents.map(({ filename }) => filename).join(", ") || "Skipped";
        return { label: `${index + 1}. ${item.kind === "choice" ? item.question : item.document_types.join(", ") || "Documents requested"}`, ...(detail && { detail }) };
      });
      return { ...message, activities: upsertById(message.activities, { ...activity, label: "Asked for input", status: "completed", items }, ASSISTANT_LIMITS.activities) };
    });
    return { ...next, pendingInput: null, run: next.run ? { ...next.run, status: "running" } : null };
  }
  if (event.type === "steering") return updateAssistant(state, (message) => {
    if (message.blocks.some((block) => block.id === `steering:${event.id}`)) return message;
    const blocks = [...message.blocks, { id: `steering:${event.id}`, role: "user" as const, text: event.text }].slice(-ASSISTANT_LIMITS.blocks);
    return { ...message, blocks, contentOpen: false };
  });
  if (event.type === "error") {
    const failed = updateAssistant(state, (message) => ({
      ...message,
      contentOpen: false,
      error: event.message,
      activities: message.activities.map(failActivity),
    }));
    return {
      ...failed,
      readers: failed.readers.map((reader) => reader.status === "running"
        ? { ...reader, status: "error", activities: reader.activities.map(failActivity) }
        : reader),
    };
  }
  return state;
}

function loadTranscript(state: AssistantSessionState, event: Extract<AssistantSessionEvent, { type: "transcript_loaded" }>) {
  let next: AssistantSessionState = { ...state, chatId: event.chatId ?? state.chatId, messages: [], readers: [], pendingInput: null, contextUsage: undefined, compaction: undefined, run: event.active ? state.run : null, rejectedTurn: event.preserveRejected ? state.rejectedTurn : null, transcriptVersion: event.transcriptVersion ?? state.transcriptVersion };
  event.messages.slice(0, 2_000).forEach((message, index) => {
    if (message.role === "user") {
      next = { ...next, messages: [...next.messages, userMessage({ role: "user", content: typeof message.content === "string" ? message.content : "", files: message.files ?? undefined, workflow: message.workflow ?? undefined, turnId: message.turn_id }, `user:${index}`)] };
      return;
    }
    const assistant = emptyAssistant(cleanValue(message.id) || `assistant:${index}`, cleanValue(message.turn_id));
    next = { ...next, messages: [...next.messages, assistant] };
    const rawEvents = Array.isArray(message.content) ? message.content : [];
    for (const raw of rawEvents) {
      const parsed = parseAssistantProtocolEvent(raw);
      if (parsed.ok) next = applyProtocol(next, parsed.event);
    }
    const citations = parseAssistantCitations(message.citations);
    if (!rawEvents.length && typeof message.content === "string" && message.content) {
      next = finishContent(next, textValue(message.content, ASSISTANT_LIMITS.text), citations);
    } else {
      next = updateAssistant(next, (current) => current.id === assistant.id
        ? { ...current, citations, contentFinal: message.turn_complete === true }
        : current);
    }
    next = updateAssistant(next, (current) => current.id === assistant.id
      ? {
          ...current,
          turnComplete: message.turn_complete,
          ...(message.turn_complete === true && {
            contentFinal: true,
            activities: current.activities.map(completeActivity),
          }),
        }
      : current);
    if (message.turn_complete === true) {
      next = {
        ...next,
        readers: next.readers.map((reader) => reader.status === "running"
          ? {
              ...reader,
              status: "completed" as const,
              activities: reader.activities.map(completeActivity),
            }
          : reader),
      };
    }
  });
  if (!event.active) {
    const last = next.messages.at(-1);
    const open = last?.role === "assistant" && (last.activities.some((activity) => activity.status === "running") || next.readers.some((reader) => reader.status === "running") || last.turnComplete === false);
    if (open) next = interrupt(next, "interrupted");
    else if (last?.role === "user" && last.turnId) next = { ...next, rejectedTurn: { message: { role: "user", content: last.content, files: last.files, workflow: last.workflow, turnId: last.turnId }, options: { turnId: last.turnId } } };
  }
  const lastAssistant = next.messages.findLast((message) => message.role === "assistant");
  if (!event.active && lastAssistant?.role === "assistant" && lastAssistant.turnStatus === "interrupted" && lastAssistant.turnId) {
    const original = next.messages.findLast((message) => message.role === "user" && message.turnId === lastAssistant.turnId);
    if (original?.role === "user") next = { ...next, rejectedTurn: { message: { role: "user", content: original.content, files: original.files, workflow: original.workflow, turnId: original.turnId }, options: { turnId: lastAssistant.turnId } } };
  }
  return next;
}

export function createAssistantSessionState(args: { chatId?: string; messages?: AssistantTranscriptMessage[]; transcriptVersion?: number } = {}): AssistantSessionState {
  const initial: AssistantSessionState = { chatId: args.chatId, messages: [], readers: [], pendingInput: null, run: null, rejectedTurn: null, transcriptVersion: args.transcriptVersion ?? 0 };
  return args.messages?.length ? loadTranscript(initial, { type: "transcript_loaded", chatId: args.chatId, messages: args.messages, transcriptVersion: args.transcriptVersion }) : initial;
}

export function assistantSessionReducer(state: AssistantSessionState, event: AssistantSessionEvent): AssistantSessionState {
  if (event.type === "transcript_loaded") return loadTranscript(state, event);
  if (event.type === "run_started") {
    const run = { id: event.runId, status: "running" as const, ...(event.chatId && { chatId: event.chatId }) };
    let next: AssistantSessionState = { ...state, run, rejectedTurn: null };
    if (event.options?.askInputsResponse) {
      next = applyProtocol(next, { type: "ask_inputs_response", event: event.options.askInputsResponse });
    } else {
      const last = next.messages.at(-1);
      const user = userMessage(event.message, `user:${event.runId}`);
      const messages = last?.role === "user" && last.content === user.content ? next.messages : [...next.messages, user];
      next = { ...next, messages: [...messages, emptyAssistant(`assistant:${event.runId}`, event.options?.turnId)] };
    }
    return next;
  }
  if (event.type === "run_resumed") {
    const messages = state.messages.at(-1)?.role === "assistant"
      ? state.messages
      : [...state.messages, emptyAssistant(`assistant:${event.runId}`)];
    return { ...state, messages, run: { id: event.runId, status: "running", chatId: event.chatId } };
  }
  if (event.type === "protocol") {
    if (state.run?.id !== event.runId) return state;
    if (event.chatId && state.chatId && event.chatId !== state.chatId) return state;
    if (event.event.type === "chat_id" && state.chatId && event.event.chatId !== state.chatId) return updateAssistant({ ...state, run: null }, (message) => ({ ...message, error: ASSISTANT_GENERIC_ERROR }));
    return applyProtocol(state, event.event);
  }
  if (event.type === "run_finished") return state.run?.id === event.runId ? { ...state, run: null, pendingInput: state.pendingInput, messages: state.messages.map((message) => message.role === "assistant" ? { ...message, contentOpen: false } : message) } : state;
  if (event.type === "run_interrupted") return state.run?.id === event.runId ? interrupt(state, event.status) : state;
  if (event.type === "run_failed") {
    if (state.run?.id !== event.runId) return state;
    const failed = applyProtocol(state, {
      type: "error",
      message: event.message ?? ASSISTANT_GENERIC_ERROR,
      retryable: true,
    });
    return { ...failed, run: null, rejectedTurn: event.rejected ?? failed.rejectedTurn };
  }
  if (event.type === "turn_rejected") return { ...state, rejectedTurn: event.rejected };
  if (event.type === "steering_queued") return state.run?.id === event.runId ? applyProtocol(state, { type: "steering", id: event.id, text: event.text }) : state;
  if (event.type === "compaction_changed") {
    const next = applyProtocol(state, { type: "compaction", status: event.status });
    return event.error ? updateAssistant(next, (message) => ({ ...message, error: ASSISTANT_GENERIC_ERROR })) : next;
  }
  if (event.type === "new_chat") return { ...createAssistantSessionState({ chatId: event.chatId }), messages: event.message ? [userMessage(event.message, "user:new")] : [] };
  if (event.type === "transcript_version_changed") return Number.isSafeInteger(event.transcriptVersion) && event.transcriptVersion >= 0 ? { ...state, transcriptVersion: event.transcriptVersion } : state;
  if (event.type === "local_exchange") {
    const user = userMessage(event.user, `user:local:${state.messages.length}`);
    const assistant = { ...replaceContent(emptyAssistant(`assistant:local:${state.messages.length + 1}`), event.assistantText), contentFinal: true };
    return { ...state, messages: [...state.messages, user, assistant] };
  }
  return state;
}
