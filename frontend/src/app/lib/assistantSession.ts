
import type {
  AskInputsEvent,
  AskInputsResponseEvent,
  AutomationRunEvent,
  CaseCitationEvent,
  CaseOpinionsEvent,
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
const COLLECTION_LIMIT = 128;
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
  action?:
    | { type: "document"; filename: string }
    | { type: "reader"; readerId: string }
    | { type: "workflow"; workflowId: string };
};

export type AssistantReaderRun = {
  id: string;
  agent: "scout" | "planner" | "reviewer" | "native";
  task: string;
  model: string;
  effort: string;
  status: AssistantActivityStatus;
  activities: AssistantActivity[];
  output?: string;
  error?: string;
  sources: ToolActivitySource[];
  verifiedPassages: number;
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
  citationStatus?: "started" | "partial" | "final";
  caseCitations: CaseCitationEvent[];
  caseOpinions: CaseOpinionsEvent[];
  contextCompacted: boolean;
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
  displayedDoc?: { filename: string; documentId: string } | null;
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
  | { type: "content_delta"; text: string }
  | { type: "content_block"; text: string }
  | { type: "content_snapshot"; text: string; final: boolean }
  | { type: "content_reset" }
  | { type: "content_end" }
  | { type: "reasoning"; text: string; append: boolean; done?: boolean }
  | { type: "activity"; activity: AssistantActivity }
  | { type: "artifact"; artifact: AssistantArtifact }
  | { type: "automation"; run: AutomationRunEvent }
  | { type: "reader"; reader: AssistantReaderRun }
  | { type: "ask_inputs"; event: AskInputsEvent }
  | { type: "ask_inputs_response"; event: AskInputsResponseEvent }
  | { type: "steering"; id: string; text: string }
  | { type: "citations"; citations: Citation[]; status: "started" | "partial" | "final" }
  | { type: "case_citation"; event: CaseCitationEvent }
  | { type: "case_opinions"; event: CaseOpinionsEvent }
  | { type: "context_usage"; usedTokens: number; windowTokens: number }
  | { type: "compaction"; status: "running" | "completed" | "failed" }
  | { type: "turn_status"; status: "cancelled" | "interrupted" }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "noop" };

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
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}
const safeUrl = z.string().max(FIELD_TEXT_LIMIT).transform((value) => safeAssistantUrl(value));
const validUrl = safeUrl.pipe(z.string());
const sourceSchema = z.strictObject({
  provider: shortText.default(""), jurisdiction: shortText.default(""), citation: idText,
  name: shortText.nullish().transform((value) => value || null),
  dataset: shortText.default(""), url: safeUrl.nullish().transform((value) => value ?? null),
  clusterId: safeInteger.optional(), locator: shortText.optional(), quote: fieldText.optional(),
});
const activityItemSchema = z.strictObject({
  label: idText, detail: fieldText.optional(), url: safeUrl.nullish(), error: z.boolean().optional(),
});
const activityActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("document"), filename: idText }),
  z.strictObject({ type: z.literal("reader"), readerId: idText }),
  z.strictObject({ type: z.literal("workflow"), workflowId: idText }),
]);
const activityFields = {
  id: idText, tool: idText, label: idText, status: statusSchema,
  detail: fieldText.optional(), markdown: longText.optional(),
  items: z.array(activityItemSchema).max(COLLECTION_LIMIT).optional(),
  source: sourceSchema.optional(), sources: z.array(sourceSchema).max(ASSISTANT_LIMITS.citations).optional(),
  action: activityActionSchema.optional(),
};
const activitySchema = z.strictObject(activityFields);
const editAnnotationSchema = z.strictObject({
  type: z.literal("edit_data").optional(), kind: z.literal("edit").optional(),
  edit_id: idText, document_id: idText, version_id: idText,
  version_number: safeInteger.optional(), change_id: idText,
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
    type: z.literal("citation_data"), kind: z.literal("case"), ref: safeInteger,
    cluster_id: safeInteger, case_name: shortText.nullish(), citation: shortText.nullish(),
    url: safeUrl.nullish(), pdfUrl: safeUrl.nullish(), dateFiled: shortText.nullish(),
    quotes: z.array(z.strictObject({
      opinionId: safeInteger.nullish(), type: shortText.nullish(),
      author: shortText.nullish(), quote: fieldText,
    })).max(32).default([]), ...locatorFields,
  }),
  z.strictObject({
    type: z.literal("citation_data"), kind: z.literal("a2aj"), ref: safeInteger,
    citation: shortText.nullish(), name: shortText.nullish(), dataset: shortText.nullish(),
    url: safeUrl.nullish(), quotes: z.array(citationQuote).max(32).default([]), ...locatorFields,
  }),
  z.strictObject({
    type: z.literal("citation_data"), kind: z.literal("public_legal"), ref: safeInteger,
    provider: z.enum(["tna", "govuk-et", "govinfo", "journal"]), identifier: idText,
    title: shortText.nullish(), citation: shortText.nullish(), url: safeUrl.nullish(),
    quotes: z.array(citationQuote).max(32).default([]), ...locatorFields,
  }),
  z.strictObject({
    type: z.literal("citation_data"), kind: z.literal("tabular"), ref: safeInteger,
    review_id: idText, col_index: safeInteger, row_index: safeInteger,
    col_name: shortText.default(""), doc_name: shortText.default(""),
    quotes: z.array(citationQuote).max(32).default([]), ...displayFields,
  }),
  z.strictObject({
    type: z.literal("citation_data"), kind: z.literal("document").optional(), ref: safeInteger,
    document_id: idText, filename: idText,
    version_id: shortText.optional(), version_number: safeInteger.optional(), url: safeUrl.optional(),
    quotes: z.array(z.strictObject({
      page: z.union([z.number().finite(), shortText]).optional(),
      quote: fieldText, sheet: shortText.optional(), cell: shortText.optional(),
    })).max(32).default([]), ...locatorFields,
  }).transform((row) => ({ ...row, kind: "document" as const })),
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
    allow_other: z.boolean().optional(), other_label: shortText.optional(),
    response_prefix: shortText.optional(),
  }).transform((row) => ({ ...row, allow_other: true,
    other_label: row.other_label || "Write your own answer" })),
  z.strictObject({
    id: idText, kind: z.literal("documents"),
    document_types: z.array(shortText).max(32).default([]), response_prefix: shortText.optional(),
  }),
]);
const askEventSchema = z.strictObject({
  type: z.literal("ask_inputs"), items: z.array(askItemSchema).min(1).max(32),
});
const askResponseSchema = z.strictObject({
  type: z.literal("ask_inputs_response"),
  responses: z.array(z.union([
    z.strictObject({
      id: idText, kind: z.literal("choice"), question: shortText.default(""),
      answer: fieldText.optional(), skipped: z.boolean().optional(),
    }),
    z.strictObject({
      id: idText, kind: z.literal("documents"), filenames: z.array(shortText).max(32).default([]),
      documents: z.array(z.strictObject({
        document_id: idText, filename: idText,
      })).max(32).optional(), skipped: z.boolean().optional(),
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
  app_url: validUrl.optional(), job_id: shortText.optional(), document_id: shortText.optional(),
  version_id: shortText.optional(), version_number: safeInteger.nullish(), error: shortText.optional(),
}).transform((row): AutomationRunEvent => ({
  ...row, id: row.id || row.tool + ":" + (row.job_id || "run"),
  ...(row.error && { error: "Automation failed." }),
}));
const readerSchema = z.strictObject({
  type: z.literal("subagent_run"), id: idText,
  agent: z.enum(["scout", "planner", "reviewer", "native"]),
  task: longText, model: shortText, effort: shortText, status: statusSchema,
  activities: z.array(activitySchema).max(ASSISTANT_LIMITS.activities).default([]),
  output: longText.optional(), error: fieldText.optional(),
  sources: z.array(sourceSchema).max(ASSISTANT_LIMITS.citations).default([]),
  grounding: z.strictObject({
    status: z.string().max(32), evidence: z.array(z.unknown()).max(COLLECTION_LIMIT),
  }).optional(),
}).transform(({ grounding, type: _type, ...row }): AssistantReaderRun => ({
  ...row, ...(row.status === "error" && { error: "Reading agent failed." }),
  verifiedPassages: grounding?.status === "passed" ? grounding.evidence.length : 0,
}));

const noop = (type: string) => z.strictObject({ type: z.literal(type) })
  .transform((): ProtocolEvent => ({ type: "noop" }));
const textEvent = (type: "content_delta" | "content") =>
  z.strictObject({ type: z.literal(type), text: type === "content_delta"
    ? z.string().max(65_536) : longText })
    .transform((row): ProtocolEvent => type === "content_delta"
      ? { type, text: row.text } : { type: "content_block", text: row.text });
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
  resource: boundedEvent.optional(),
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
const caseCitationSchema = z.strictObject({
  type: z.literal("case_citation"), cluster_id: safeInteger.nullish(),
  case_name: shortText.nullish(), citation: shortText.nullish(),
  url: safeUrl.nullish(), pdfUrl: safeUrl.nullish(), dateFiled: shortText.nullish(),
}).transform((row): ProtocolEvent => ({ type: "case_citation", event: {
  ...row, cluster_id: row.cluster_id ?? null, case_name: row.case_name ?? null,
  citation: row.citation ?? null, url: row.url ?? "", dateFiled: row.dateFiled ?? null,
}}));
const opinionSchema = z.strictObject({
  opinionId: safeInteger.nullish(), apiUrl: safeUrl.nullish(), type: shortText.nullish(),
  author: shortText.nullish(), url: safeUrl.nullish(), text: longText.nullish(),
});
const caseOpinionsSchema = z.strictObject({
  type: z.literal("case_opinions"), cluster_id: safeInteger,
  case: z.strictObject({
    id: safeInteger.nullish(), caseName: shortText.nullish(), dateFiled: shortText.nullish(),
    citations: z.array(shortText).max(COLLECTION_LIMIT).optional(),
    url: safeUrl.nullish(), pdfUrl: safeUrl.nullish(), opinions: z.array(opinionSchema).max(64),
  }),
}).transform((row): ProtocolEvent => ({ type: "case_opinions", event: {
  ...row, case: { ...row.case, id: row.case.id ?? null,
    opinions: row.case.opinions.map((opinion) => ({ ...opinion,
      opinionId: opinion.opinionId ?? null, type: opinion.type ?? null,
      author: opinion.author ?? null, url: opinion.url ?? null })) },
}}));
const protocolSchemas = [
  z.strictObject({ type: z.literal("chat_id"), chatId: idText,
    transcriptVersion: safeInteger.optional() })
    .transform((row): ProtocolEvent => ({ type: "chat_id", chatId: row.chatId,
      ...(row.transcriptVersion !== undefined && { transcriptVersion: row.transcriptVersion }) })),
  z.strictObject({ type: z.literal("transcript_version"), transcriptVersion: safeInteger })
    .transform((row): ProtocolEvent => row),
  textEvent("content_delta"), textEvent("content"),
  z.strictObject({ type: z.enum(["content_snapshot", "content_final"]), text: longText })
    .transform((row): ProtocolEvent => ({ type: "content_snapshot", text: row.text,
      final: row.type === "content_final" })),
  noop("content_reset").transform(() => ({ type: "content_reset" as const })),
  noop("content_block_end").transform(() => ({ type: "content_end" as const })),
  noop("content_done"),
  z.strictObject({ type: z.literal("reasoning_delta"), text: z.string().max(65_536) })
    .transform((row): ProtocolEvent => ({ type: "reasoning", text: row.text, append: true })),
  noop("reasoning_block_end").transform(() => ({ type: "reasoning" as const,
    text: "", append: false, done: true })),
  z.strictObject({ type: z.literal("reasoning"), text: fieldText })
    .transform((row): ProtocolEvent => ({ type: "reasoning", text: row.text,
      append: false, done: true })),
  ...["thinking", "mcp_tool_start", "mcp_tool_result", "mcp_tool_call",
    "legal_evidence_receipt", "context_checkpoint"].map(noop),
  z.strictObject({ type: z.literal("error"), message: fieldText, retryable: z.boolean().optional() })
    .transform((row): ProtocolEvent => row.message.trim() === "Cancelled by user."
      ? { type: "turn_status", status: "cancelled" }
      : { type: "error", message: ASSISTANT_GENERIC_ERROR, retryable: row.retryable !== false }),
  z.strictObject({ type: z.literal("turn_status"),
    status: z.enum(["cancelled", "interrupted"]) }).transform((row): ProtocolEvent => row),
  z.strictObject({ type: z.literal("steering"), id: idText, text: fieldText })
    .transform((row): ProtocolEvent => row),
  z.strictObject({ type: z.literal("citations"),
    status: z.enum(["started", "partial", "final"]).default("final"), citations: z.unknown() })
    .transform((row): ProtocolEvent => ({ ...row, citations: parseAssistantCitations(row.citations) })),
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
  z.strictObject({ type: z.literal("workflow_applied"), workflow_id: idText, title: idText })
    .transform((row): ProtocolEvent => ({ type: "activity", activity: {
      id: "workflow:" + row.workflow_id, tool: "workflow_applied",
      label: "Applied " + row.title, status: "completed",
      action: { type: "workflow", workflowId: row.workflow_id },
    }})),
  documentArtifactSchema,
  caseCitationSchema, caseOpinionsSchema,
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
  return { id, role: "assistant", blocks: [], activities: [], automations: [], artifacts: [], citations: [], caseCitations: [], caseOpinions: [], contextCompacted: false, contentOpen: false, ...(turnId && { turnId }) };
}

function sanitizeFiles(value: Message["files"]) {
  return (value ?? []).slice(0, 64).flatMap((file) => {
    const filename = cleanValue(file?.filename);
    const documentId = cleanValue(file.document_id);
    return filename ? [{ filename, ...(documentId && { document_id: documentId }) }] : [];
  });
}

function userMessage(message: Message, fallbackId: string): UserMessageState {
  const files = sanitizeFiles(message.files);
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

function replaceContent(message: AssistantMessageState, text: string, final: boolean) {
  const lastSteering = final ? message.blocks.findLastIndex((block) => block.role === "user") : -1;
  const firstContent = message.blocks.findIndex((block, index) => index > lastSteering && block.role === "assistant");
  const blocks = message.blocks.filter((block, index) => index <= lastSteering || block.role !== "assistant");
  const remaining = Math.max(0, ASSISTANT_LIMITS.text - messageContent(blocks).length);
  if (text && remaining) blocks.splice(firstContent < 0 ? blocks.length : Math.min(firstContent, blocks.length), 0, { id: `content:${message.id}:${firstContent < 0 ? blocks.length : firstContent}`, role: "assistant", text: text.slice(0, remaining) });
  return { ...message, blocks, contentOpen: !final };
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
  if (event.type === "noop") return state;
  if (event.type === "chat_id") return { ...state, chatId: event.chatId, transcriptVersion: event.transcriptVersion ?? state.transcriptVersion, run: state.run ? { ...state.run, chatId: event.chatId } : null };
  if (event.type === "transcript_version") return { ...state, transcriptVersion: event.transcriptVersion };
  if (event.type === "context_usage") return { ...state, contextUsage: { usedTokens: event.usedTokens, windowTokens: event.windowTokens } };
  if (event.type === "compaction") {
    const next = updateAssistant(state, (message) => ({ ...message, contextCompacted: event.status === "completed" || message.contextCompacted, contentOpen: false }));
    return { ...next, compaction: event.status };
  }
  if (event.type === "turn_status") return interrupt(state, event.status);
  if (event.type === "content_delta") return updateAssistant(state, (message) => appendContent(message, event.text));
  if (event.type === "content_block") return updateAssistant(state, (message) => ({ ...appendContent({ ...message, contentOpen: false }, event.text), contentOpen: false }));
  if (event.type === "content_snapshot") return updateAssistant(state, (message) => replaceContent(message, event.text, event.final));
  if (event.type === "content_reset") return updateAssistant(state, (message) => ({
    ...message,
    blocks: message.blocks.filter((block) => block.role === "user"),
    activities: message.activities.filter((activity) => activity.tool !== "reasoning"),
    contentOpen: false,
  }));
  if (event.type === "content_end") return updateAssistant(state, (message) => ({ ...message, contentOpen: false }));
  if (event.type === "reasoning") {
    if (!event.text) return updateAssistant(state, (message) => ({ ...message, contentOpen: false }));
    const label = event.text.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1").replace(/[*_`~]+/gu, "").replace(/\s+/gu, " ").trim().slice(0, 120);
    if (!label) return state;
    return updateAssistant(state, (message) => {
      if (message.activities.some((activity) => activity.tool !== "reasoning")) {
        return { ...message, contentOpen: false };
      }
      const id = "reasoning:current";
      const current = message.activities.find((activity) => activity.id === id);
      const activity: AssistantActivity = { id, tool: "reasoning", label: event.append && current ? `${current.label}${label}`.slice(-120) : label, status: event.done ? "completed" : "running" };
      return { ...message, contentOpen: false, activities: upsertById(message.activities, activity, ASSISTANT_LIMITS.activities) };
    });
  }
  if (event.type === "activity") {
    return updateAssistant(state, (message) => ({
      ...message,
      contentOpen: false,
      activities: upsertById(
        message.activities.filter((activity) => activity.tool !== "reasoning"),
        event.activity,
        ASSISTANT_LIMITS.activities,
      ),
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
      ...(event.reader.verifiedPassages && { detail: `${event.reader.verifiedPassages} verified passage${event.reader.verifiedPassages === 1 ? "" : "s"}` }),
      action: { type: "reader", readerId: event.reader.id },
    };
    const next = updateAssistant(state, (message) => ({ ...message, contentOpen: false, activities: upsertById(message.activities.filter((entry) => entry.tool !== "reasoning"), activity, ASSISTANT_LIMITS.activities) }));
    return { ...next, readers: upsertById(next.readers, event.reader, ASSISTANT_LIMITS.readers) };
  }
  if (event.type === "ask_inputs") {
    let pending: AssistantPendingInput | null = null;
    const next = updateAssistant(state, (message) => {
      const id = `ask:${event.event.items.map((item) => item.id).join(",")}`;
      pending = { key: `${state.chatId ?? "new"}:${message.id}:${id}`, messageId: message.id, event: event.event };
      return { ...message, contentOpen: false, activities: upsertById(message.activities, { id, tool: "ask_inputs", label: "Waiting for input", status: "running", items: event.event.items.map((item, index) => ({ label: `${index + 1}. ${item.kind === "choice" ? item.question : item.document_types.join(", ") || "Documents requested"}` })) }, ASSISTANT_LIMITS.activities) };
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
        const detail = !answer ? undefined : answer.skipped ? "Skipped" : answer.kind === "choice" ? answer.answer : answer.filenames.join(", ") || "No documents attached";
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
  if (event.type === "citations") return updateAssistant(state, (message) => ({ ...message, citations: event.citations, citationStatus: event.citations.length || event.status !== "final" ? event.status : undefined }));
  if (event.type === "case_citation") return updateAssistant(state, (message) => {
    const caseCitations = [...message.caseCitations.filter((item) => item.cluster_id !== event.event.cluster_id), event.event].slice(-ASSISTANT_LIMITS.citations);
    const verify = message.activities.find((activity) => activity.id === "case-verify");
    const label = [event.event.case_name, event.event.citation].filter(Boolean).join(", ") || "Unknown case";
    return { ...message, caseCitations, activities: verify ? upsertById(message.activities, { ...verify, items: [...(verify.items ?? []), { label, url: event.event.url || null }].slice(-ASSISTANT_LIMITS.citations) }, ASSISTANT_LIMITS.activities) : message.activities };
  });
  if (event.type === "case_opinions") return updateAssistant(state, (message) => ({ ...message, caseOpinions: [...message.caseOpinions.filter((item) => item.cluster_id !== event.event.cluster_id), event.event].slice(-ASSISTANT_LIMITS.citations) }));
  if (event.type === "error") return updateAssistant(state, (message) => ({ ...message, contentOpen: false, error: event.message }));
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
    if (citations.length) next = applyProtocol(next, { type: "citations", citations, status: "final" });
    if (!rawEvents.length && typeof message.content === "string" && message.content) next = applyProtocol(next, { type: "content_snapshot", text: textValue(message.content, ASSISTANT_LIMITS.text), final: true });
    next = updateAssistant(next, (current) => current.id === assistant.id ? { ...current, turnComplete: message.turn_complete } : current);
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
    const failed = updateAssistant(state, (message) => ({ ...message, contentOpen: false, error: event.message ?? ASSISTANT_GENERIC_ERROR }));
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
    const assistant = replaceContent(emptyAssistant(`assistant:local:${state.messages.length + 1}`), event.assistantText, true);
    return { ...state, messages: [...state.messages, user, assistant] };
  }
  return state;
}
