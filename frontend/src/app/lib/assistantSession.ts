import type {
  AskInputsEvent,
  AskInputsResponseEvent,
  AutomationRunEvent,
  CaseCitationEvent,
  CaseOpinionsEvent,
  Citation,
  DocumentCitation,
  EditAnnotation,
  Message,
  ToolActivitySource,
} from "@/app/components/shared/types";

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
type CitationDisplayFields = Pick<DocumentCitation, "display_form" | "source_class" | "external_url" | "authority" | "short_authority" | "locator_separator">;

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
  type: "created" | "edited" | "download";
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

type ProtocolEvent =
  | { type: "chat_id"; chatId: string; transcriptVersion?: number }
  | { type: "transcript_version"; transcriptVersion: number }
  | { type: "content_delta"; text: string }
  | { type: "content_block"; text: string }
  | { type: "content_snapshot"; text: string; final: boolean }
  | { type: "content_reset" }
  | { type: "content_end" }
  | { type: "reasoning"; text: string; append: boolean; done?: boolean }
  | { type: "activity"; activity: AssistantActivity }
  | { type: "document"; activity: AssistantActivity; artifact?: AssistantArtifact }
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

export type AssistantProtocolEvent = ProtocolEvent;

export type AssistantSessionEvent =
  | { type: "transcript_loaded"; chatId?: string; messages: Message[]; active?: boolean; transcriptVersion?: number; preserveRejected?: boolean }
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
  | { type: "chat_id_changed"; chatId?: string }
  | { type: "transcript_version_changed"; transcriptVersion: number }
  | { type: "local_exchange"; user: Message; assistantText: string };

type ParseResult =
  | { ok: true; event: ProtocolEvent }
  | { ok: false; reason: "malformed" | "unknown" | "unsafe" };

const fail = (reason: "malformed" | "unknown" | "unsafe"): ParseResult => ({ ok: false, reason });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, limit = FIELD_TEXT_LIMIT) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const clean = (value: unknown, limit = SHORT_TEXT_LIMIT) => string(value, limit).trim();
const finite = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const safeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const records = (value: unknown, limit = COLLECTION_LIMIT) =>
  Array.isArray(value) ? value.slice(0, limit).filter(isRecord) : [];
const strings = (value: unknown, limit = COLLECTION_LIMIT) =>
  Array.isArray(value)
    ? value.slice(0, limit).flatMap((item) => {
        const parsed = clean(item);
        return parsed ? [parsed] : [];
      })
    : [];

function containsUnsafeKey(value: unknown, depth = 0, budget = { value: 0 }): boolean {
  if (depth > 12 || ++budget.value > 4_096) return true;
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) =>
    key === "__proto__" || key === "prototype" || key === "constructor" ||
    containsUnsafeKey((value as Record<string, unknown>)[key], depth + 1, budget));
}

export function safeAssistantUrl(
  value: unknown,
  { relative = true }: { relative?: boolean } = {},
): string | null {
  const raw = clean(value, FIELD_TEXT_LIMIT);
  if (!raw || /[\u0000-\u001f\\]/u.test(raw)) return null;
  if (relative && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function parseSource(value: unknown): ToolActivitySource | undefined {
  if (!isRecord(value)) return undefined;
  const citation = clean(value.citation);
  if (!citation) return undefined;
  const clusterId = safeInteger(value.clusterId);
  const locator = clean(value.locator);
  const quote = clean(value.quote, FIELD_TEXT_LIMIT);
  return {
    provider: clean(value.provider),
    jurisdiction: clean(value.jurisdiction),
    citation,
    name: clean(value.name) || null,
    dataset: clean(value.dataset),
    url: safeAssistantUrl(value.url),
    ...(clusterId !== undefined && { clusterId }),
    ...(locator && { locator }),
    ...(quote && { quote }),
  };
}

function parseActivity(value: unknown): AssistantActivity | undefined {
  if (!isRecord(value)) return undefined;
  const id = clean(value.id);
  const tool = clean(value.tool);
  const label = clean(value.label);
  const status = value.status;
  if (
    !id || !tool || !label ||
    (status !== "running" && status !== "completed" && status !== "error" && status !== "interrupted" && status !== "cancelled")
  ) return undefined;
  const source = parseSource(value.source);
  return {
    id,
    tool,
    label,
    status: status === "cancelled" ? "interrupted" : status,
    ...(source && { source }),
  };
}

function parseEditAnnotation(value: unknown): EditAnnotation | undefined {
  if (!isRecord(value)) return undefined;
  const editId = clean(value.edit_id);
  const documentId = clean(value.document_id);
  const versionId = clean(value.version_id);
  const changeId = clean(value.change_id);
  const status = value.status;
  if (!editId || !documentId || !versionId || !changeId ||
      (status !== "pending" && status !== "accepted" && status !== "rejected")) return undefined;
  const diff = records(value.diff, 256).flatMap<EditAnnotation["diff"][number]>((part) => {
    if (part.kind !== "equal" && part.kind !== "delete" && part.kind !== "insert") return [];
    return [{ kind: part.kind, text: string(part.text, FIELD_TEXT_LIMIT) }];
  });
  const versionNumber = safeInteger(value.version_number);
  return {
    edit_id: editId,
    document_id: documentId,
    version_id: versionId,
    ...(versionNumber !== undefined && { version_number: versionNumber }),
    change_id: changeId,
    ...(clean(value.del_w_id) && { del_w_id: clean(value.del_w_id) }),
    ...(clean(value.ins_w_id) && { ins_w_id: clean(value.ins_w_id) }),
    deleted_text: string(value.deleted_text),
    inserted_text: string(value.inserted_text),
    ...(clean(value.context_before, FIELD_TEXT_LIMIT) && { context_before: clean(value.context_before, FIELD_TEXT_LIMIT) }),
    ...(clean(value.context_after, FIELD_TEXT_LIMIT) && { context_after: clean(value.context_after, FIELD_TEXT_LIMIT) }),
    ...(clean(value.reason, FIELD_TEXT_LIMIT) && { reason: clean(value.reason, FIELD_TEXT_LIMIT) }),
    diff,
    status,
  };
}

function citationDisplay(row: Record<string, unknown>): CitationDisplayFields {
  const displayForm = row.display_form === "full" || row.display_form === "pinpoint" || row.display_form === "supra"
    ? row.display_form : undefined;
  const sourceClass = row.source_class === "case" || row.source_class === "legislation" || row.source_class === "commentary"
    ? row.source_class : undefined;
  const separator = row.locator_separator === " at " || row.locator_separator === ", "
    ? row.locator_separator : undefined;
  const externalUrl = safeAssistantUrl(row.external_url);
  return {
    ...(displayForm && { display_form: displayForm }),
    ...(sourceClass && { source_class: sourceClass }),
    ...(externalUrl && { external_url: externalUrl }),
    ...(clean(row.authority) && { authority: clean(row.authority) }),
    ...(clean(row.short_authority) && { short_authority: clean(row.short_authority) }),
    ...(separator && { locator_separator: separator }),
  };
}

function legalLocator(row: Record<string, unknown>): CitationDisplayFields & {
  locator_kind?: "paragraph" | "page" | "section" | "footnote";
  locator?: string | null;
  pinpoint?: string | null;
} {
  const kind = row.locator_kind === "paragraph" || row.locator_kind === "page" || row.locator_kind === "section" || row.locator_kind === "footnote"
    ? row.locator_kind : undefined;
  return {
    ...citationDisplay(row),
    ...(kind && { locator_kind: kind }),
    ...(clean(row.locator) && { locator: clean(row.locator) }),
    ...(clean(row.pinpoint) && { pinpoint: clean(row.pinpoint) }),
  };
}

function parseCitation(value: unknown): Citation | undefined {
  if (!isRecord(value) || value.type !== "citation_data") return undefined;
  const ref = safeInteger(value.ref);
  if (ref === undefined) return undefined;
  const quoteRows = records(value.quotes, 32);
  if (value.kind === "case") {
    const clusterId = safeInteger(value.cluster_id);
    if (clusterId === undefined) return undefined;
    return {
      type: "citation_data", kind: "case", ref, cluster_id: clusterId,
      ...legalLocator(value),
      case_name: clean(value.case_name) || null,
      citation: clean(value.citation) || null,
      url: safeAssistantUrl(value.url),
      pdfUrl: safeAssistantUrl(value.pdfUrl),
      dateFiled: clean(value.dateFiled) || null,
      quotes: quoteRows.map((quote) => ({
        opinionId: safeInteger(quote.opinionId) ?? null,
        type: clean(quote.type) || null,
        author: clean(quote.author) || null,
        quote: string(quote.quote),
      })),
    };
  }
  if (value.kind === "a2aj") {
    return {
      type: "citation_data", kind: "a2aj", ref, ...legalLocator(value),
      citation: clean(value.citation) || null,
      name: clean(value.name) || null,
      dataset: clean(value.dataset) || null,
      url: safeAssistantUrl(value.url),
      quotes: quoteRows.map((quote) => ({ quote: string(quote.quote) })),
    };
  }
  if (value.kind === "public_legal") {
    const provider = value.provider;
    const identifier = clean(value.identifier);
    if (!identifier || (provider !== "tna" && provider !== "govuk-et" && provider !== "govinfo" && provider !== "journal")) return undefined;
    return {
      type: "citation_data", kind: "public_legal", ref, provider, identifier,
      ...legalLocator(value),
      title: clean(value.title) || null,
      citation: clean(value.citation) || null,
      url: safeAssistantUrl(value.url),
      quotes: quoteRows.map((quote) => ({ quote: string(quote.quote) })),
    };
  }
  if (value.kind === "tabular") {
    const colIndex = safeInteger(value.col_index);
    const rowIndex = safeInteger(value.row_index);
    const reviewId = clean(value.review_id);
    if (colIndex === undefined || rowIndex === undefined || !reviewId) return undefined;
    return {
      type: "citation_data", kind: "tabular", ref, review_id: reviewId,
      col_index: colIndex, row_index: rowIndex,
      col_name: clean(value.col_name), doc_name: clean(value.doc_name),
      ...citationDisplay(value),
      quotes: quoteRows.map((quote) => ({ quote: string(quote.quote) })),
    };
  }
  const documentId = clean(value.document_id) || clean(value.doc_id);
  const filename = clean(value.filename);
  if (!documentId || !filename || (value.kind !== undefined && value.kind !== "document")) return undefined;
  const locatorKind = value.locator_kind === "paragraph" || value.locator_kind === "page" || value.locator_kind === "section" || value.locator_kind === "footnote"
    ? value.locator_kind : undefined;
  const versionNumber = safeInteger(value.version_number);
  return {
    type: "citation_data", kind: "document", ref,
    doc_id: clean(value.doc_id) || documentId,
    document_id: documentId,
    filename,
    ...citationDisplay(value),
    ...(clean(value.version_id) && { version_id: clean(value.version_id) }),
    ...(versionNumber !== undefined && { version_number: versionNumber }),
    ...(locatorKind && { locator_kind: locatorKind }),
    ...(clean(value.locator) && { locator: clean(value.locator) }),
    ...(clean(value.pinpoint) && { pinpoint: clean(value.pinpoint) }),
    quotes: quoteRows.map((quote) => ({
      ...(typeof quote.page === "number" || typeof quote.page === "string" ? { page: typeof quote.page === "string" ? clean(quote.page) : quote.page } : {}),
      quote: string(quote.quote),
      ...(clean(quote.sheet) && { sheet: clean(quote.sheet) }),
      ...(clean(quote.cell) && { cell: clean(quote.cell) }),
    })),
  };
}

export function parseAssistantCitations(value: unknown): Citation[] {
  return Array.isArray(value)
    ? value.slice(0, ASSISTANT_LIMITS.citations).flatMap((item) => parseCitation(item) ?? [])
    : [];
}

function parseAskInputs(data: Record<string, unknown>) {
  const items = records(data.items, 32).flatMap<AskInputsEvent["items"][number]>((row, index) => {
    const id = clean(row.id) || `input-${index + 1}`;
    const responsePrefix = clean(row.response_prefix);
    if (row.kind === "choice") {
      const options = records(row.options, 32).flatMap((option) => {
        const value = clean(option.value) || clean(option.label);
        return value ? [{ value }] : [];
      });
      const question = clean(row.question, FIELD_TEXT_LIMIT);
      if (!question || !options.length) return [];
      return [{ id, kind: "choice", question, options, allow_other: true, other_label: "Write your own answer", ...(responsePrefix && { response_prefix: responsePrefix }) }];
    }
    if (row.kind !== "documents") return [];
    return [{ id, kind: "documents", document_types: strings(row.document_types, 32), ...(responsePrefix && { response_prefix: responsePrefix }) }];
  });
  return items.length ? ({ type: "ask_inputs", items } as const) : null;
}

function parseAskResponse(data: Record<string, unknown>) {
  const responses = records(data.responses, 32).flatMap<AskInputsResponseEvent["responses"][number]>((row) => {
    const id = clean(row.id);
    if (!id) return [];
    if (row.kind === "choice") return [{ id, kind: "choice", question: clean(row.question), ...(clean(row.answer, FIELD_TEXT_LIMIT) && { answer: clean(row.answer, FIELD_TEXT_LIMIT) }), ...(row.skipped === true && { skipped: true }) }];
    if (row.kind !== "documents") return [];
    const documents = records(row.documents, 32).flatMap((document) => {
      const documentId = clean(document.document_id);
      const filename = clean(document.filename);
      return documentId && filename ? [{ document_id: documentId, filename }] : [];
    });
    return [{ id, kind: "documents", filenames: strings(row.filenames, 32), ...(documents.length && { documents }), ...(row.skipped === true && { skipped: true }) }];
  });
  return { type: "ask_inputs_response", responses } as const;
}

function count(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}
function activityStatus(streaming: boolean, error: unknown): AssistantActivityStatus {
  return streaming ? "running" : clean(error) ? "error" : "completed";
}
function trackedActivity(args: {
  id: string; tool: string; status: AssistantActivityStatus;
  labels: [string, string, string]; detail?: string; items?: AssistantActivity["items"];
}) {
  return {
    id: args.id,
    tool: args.tool,
    status: args.status,
    label: args.labels[args.status === "running" ? 0 : args.status === "error" ? 1 : 2],
    ...(args.detail && { detail: args.detail }),
    ...(args.items?.length && { items: args.items }),
  } satisfies AssistantActivity;
}

function parseReader(data: Record<string, unknown>): AssistantReaderRun | null {
  const id = clean(data.id);
  const agent = data.agent;
  const status = data.status;
  if (!id || (agent !== "scout" && agent !== "planner" && agent !== "reviewer" && agent !== "native") ||
      (status !== "running" && status !== "completed" && status !== "error" && status !== "cancelled" && status !== "interrupted")) return null;
  const grounding = isRecord(data.grounding) ? data.grounding : null;
  const evidence = grounding && Array.isArray(grounding.evidence) ? grounding.evidence.slice(0, COLLECTION_LIMIT) : [];
  return {
    id, agent,
    task: string(data.task), model: clean(data.model), effort: clean(data.effort),
    status: status === "cancelled" ? "interrupted" : status,
    activities: (Array.isArray(data.activities) ? data.activities : [])
      .slice(0, ASSISTANT_LIMITS.activities)
      .flatMap((item) => parseActivity(item) ?? []),
    ...(clean(data.output, ASSISTANT_LIMITS.text) && { output: clean(data.output, ASSISTANT_LIMITS.text) }),
    ...(status === "error" && { error: "Reading agent failed." }),
    sources: (Array.isArray(data.sources) ? data.sources : []).slice(0, ASSISTANT_LIMITS.citations).flatMap((item) => parseSource(item) ?? []),
    verifiedPassages: grounding?.status === "passed" ? evidence.length : 0,
  };
}

function parseAutomation(data: Record<string, unknown>): AutomationRunEvent | null {
  const tool = data.tool;
  if (tool !== "create_table_of_authorities" && tool !== "fix_docx_supras" && tool !== "link_docx_citations") return null;
  const id = clean(data.id) || `${tool}:${clean(data.job_id) || "run"}`;
  const versionNumber = safeInteger(data.version_number);
  const counts = records(data.counts, 32).flatMap((row) =>
    clean(row.label) && typeof row.value === "number" && Number.isFinite(row.value)
      ? [{ label: clean(row.label), value: row.value }]
      : [],
  );
  const outputs = records(data.outputs, 32).flatMap((row) => {
    const name = clean(row.name);
    const url = safeAssistantUrl(row.url);
    return name ? [{ name, ...(url && { url }) }] : [];
  });
  return {
    type: "automation_run", id, tool,
    status: clean(data.status) || "unknown",
    stage: clean(data.stage) || "Automation",
    ...(typeof data.progress === "number" && Number.isFinite(data.progress) && { progress: Math.max(0, Math.min(1, data.progress)) }),
    ...(clean(data.message, FIELD_TEXT_LIMIT) && { message: clean(data.message, FIELD_TEXT_LIMIT) }),
    ...(counts.length && { counts }),
    ...(outputs.length && { outputs }),
    ...(safeAssistantUrl(data.app_url) && { app_url: safeAssistantUrl(data.app_url)! }),
    ...(clean(data.job_id) && { job_id: clean(data.job_id) }),
    ...(clean(data.document_id) && { document_id: clean(data.document_id) }),
    ...(clean(data.version_id) && { version_id: clean(data.version_id) }),
    ...(versionNumber !== undefined && { version_number: versionNumber }),
    ...(clean(data.error) && { error: "Automation failed." }),
  };
}

export function parseAssistantProtocolEvent(value: unknown): ParseResult {
  if (!isRecord(value)) return fail("malformed");
  if (containsUnsafeKey(value)) return fail("unsafe");
  const rawType = clean(value.type, 128);
  if (!rawType) return fail("malformed");
  if (rawType === "thinking" || rawType === "mcp_tool_start" || rawType === "mcp_tool_result" || rawType === "mcp_tool_call" || rawType === "legal_evidence_receipt" || rawType === "context_checkpoint") return { ok: true, event: { type: "noop" } };
  const streaming = rawType.endsWith("_start");
  const type = streaming ? rawType.slice(0, -6) : rawType;
  if (streaming && !new Set(["doc_find", "doc_created", "doc_edited", "doc_read", "courtlistener_search_case_law", "courtlistener_get_cases", "courtlistener_find_in_case", "courtlistener_read_case", "courtlistener_verify_citations"]).has(type)) return fail("unknown");

  if (rawType === "chat_id") {
    const chatId = clean(value.chatId);
    return chatId ? { ok: true, event: { type: "chat_id", chatId, ...(safeInteger(value.transcriptVersion) !== undefined && { transcriptVersion: safeInteger(value.transcriptVersion) }) } } : fail("malformed");
  }
  if (rawType === "transcript_version") {
    const transcriptVersion = safeInteger(value.transcriptVersion);
    return transcriptVersion === undefined ? fail("malformed") : { ok: true, event: { type: "transcript_version", transcriptVersion } };
  }
  if (rawType === "content_delta") return typeof value.text === "string" ? { ok: true, event: { type: "content_delta", text: string(value.text, 65_536) } } : fail("malformed");
  if (rawType === "content_snapshot" || rawType === "content_final") return typeof value.text === "string" ? { ok: true, event: { type: "content_snapshot", text: string(value.text, ASSISTANT_LIMITS.text), final: rawType === "content_final" } } : fail("malformed");
  if (rawType === "content_reset") return { ok: true, event: { type: "content_reset" } };
  if (rawType === "content_block_end") return { ok: true, event: { type: "content_end" } };
  if (rawType === "content_done") return { ok: true, event: { type: "noop" } };
  if (rawType === "reasoning_delta") return typeof value.text === "string" ? { ok: true, event: { type: "reasoning", text: string(value.text, 65_536), append: true } } : fail("malformed");
  if (rawType === "reasoning_block_end") return { ok: true, event: { type: "reasoning", text: "", append: false, done: true } };
  if (rawType === "reasoning") return typeof value.text === "string" ? { ok: true, event: { type: "reasoning", text: string(value.text), append: false, done: true } } : fail("malformed");
  if (rawType === "content") return typeof value.text === "string" ? { ok: true, event: { type: "content_block", text: string(value.text, ASSISTANT_LIMITS.text) } } : fail("malformed");
  if (rawType === "error" && typeof value.message !== "string") return fail("malformed");
  if (rawType === "error") return clean(value.message, FIELD_TEXT_LIMIT) === "Cancelled by user."
    ? { ok: true, event: { type: "turn_status", status: "cancelled" } }
    : { ok: true, event: { type: "error", message: ASSISTANT_GENERIC_ERROR, retryable: value.retryable !== false } };
  if (rawType === "turn_status" && (value.status === "cancelled" || value.status === "interrupted")) return { ok: true, event: { type: "turn_status", status: value.status } };
  if (rawType === "steering") {
    const id = clean(value.id); const text = clean(value.text, FIELD_TEXT_LIMIT);
    return id && text ? { ok: true, event: { type: "steering", id, text } } : fail("malformed");
  }
  if (rawType === "citations") {
    if (!Array.isArray(value.citations)) return fail("malformed");
    const status = value.status === "started" || value.status === "partial" || value.status === "final" ? value.status : "final";
    return { ok: true, event: { type: "citations", citations: parseAssistantCitations(value.citations), status } };
  }
  if (rawType === "ask_inputs") {
    const event = parseAskInputs(value);
    return event ? { ok: true, event: { type: "ask_inputs", event } } : fail("malformed");
  }
  if (rawType === "ask_inputs_response") return Array.isArray(value.responses) ? { ok: true, event: { type: "ask_inputs_response", event: parseAskResponse(value) } } : fail("malformed");
  if (rawType === "tool_activity") {
    const activity = parseActivity(value);
    return activity ? { ok: true, event: { type: "activity", activity } } : fail("malformed");
  }
  if (rawType === "automation_run") {
    const run = parseAutomation(value);
    return run ? { ok: true, event: { type: "automation", run } } : fail("malformed");
  }
  if (rawType === "subagent_run") {
    const reader = parseReader(value);
    return reader ? { ok: true, event: { type: "reader", reader } } : fail("malformed");
  }
  if (rawType === "context_usage") return typeof value.used_tokens === "number" && Number.isFinite(value.used_tokens) && typeof value.window_tokens === "number" && Number.isFinite(value.window_tokens)
    ? { ok: true, event: { type: "context_usage", usedTokens: Math.max(0, value.used_tokens), windowTokens: Math.max(1, value.window_tokens) } }
    : fail("malformed");
  if (rawType === "compaction" && (value.status === "running" || value.status === "completed" || value.status === "failed")) return { ok: true, event: { type: "compaction", status: value.status } };
  if (rawType === "workflow_applied") {
    const workflowId = clean(value.workflow_id); const title = clean(value.title);
    return workflowId && title ? { ok: true, event: { type: "activity", activity: { id: `workflow:${workflowId}`, tool: "workflow_applied", label: `Applied ${title}`, status: "completed", action: { type: "workflow", workflowId } } } } : fail("malformed");
  }

  if (type === "doc_read") {
    const filename = clean(value.filename); if (!filename) return fail("malformed");
    return { ok: true, event: { type: "document", activity: { id: `doc-read:${filename}`, tool: "doc_read", label: `${streaming ? "Reading" : "Read"} ${filename}`, status: streaming ? "running" : "completed", action: { type: "document", filename } } } };
  }
  if (type === "doc_find") {
    const filename = clean(value.filename); const query = clean(value.query, FIELD_TEXT_LIMIT); if (!filename || !query) return fail("malformed");
    const matches = Math.max(0, finite(value.total_matches));
    return { ok: true, event: { type: "document", activity: { id: `doc-find:${filename}:${query}`, tool: "doc_find", label: `${streaming ? "Searching" : "Searched"} ${filename}`, detail: `\u201c${query}\u201d${streaming ? "" : ` \u00b7 ${count(matches, "match")}`}`, status: streaming ? "running" : "completed" } } };
  }
  if (type === "doc_created" || rawType === "doc_download") {
    const filename = clean(value.filename); if (!filename) return fail("malformed");
    const candidateUrl = safeAssistantUrl(value.download_url);
    const downloadUrl = candidateUrl?.startsWith("/") ? candidateUrl : null;
    const documentId = clean(value.document_id); const versionId = clean(value.version_id); const versionNumber = safeInteger(value.version_number);
    const artifact = !streaming && downloadUrl ? { id: `created:${documentId || filename}`, type: rawType === "doc_download" ? "download" as const : "created" as const, filename, downloadUrl, ...(documentId && { documentId }), ...(versionId && { versionId }), ...(versionNumber !== undefined && { versionNumber }), annotations: [] } : undefined;
    return { ok: true, event: { type: "document", activity: { id: `doc-created:${filename}`, tool: "doc_created", label: `${streaming ? "Creating" : "Created"} ${filename}`, status: streaming ? "running" : "completed" }, ...(artifact && { artifact }) } };
  }
  if (type === "doc_edited") {
    const filename = clean(value.filename); const documentId = clean(value.document_id); if (!filename || (!streaming && !documentId)) return fail("malformed");
    const failed = !streaming && !!clean(value.error); const status = activityStatus(streaming, value.error);
    const candidateUrl = safeAssistantUrl(value.download_url);
    const downloadUrl = candidateUrl?.startsWith("/") ? candidateUrl : null;
    const versionId = clean(value.version_id); const versionNumber = safeInteger(value.version_number);
    const annotations = records(value.annotations, 256).flatMap((item) => parseEditAnnotation(item) ?? []);
    const artifact = !streaming && downloadUrl && documentId ? { id: `edited:${documentId}`, type: "edited" as const, filename, downloadUrl, documentId, ...(versionId && { versionId }), ...(versionNumber !== undefined && { versionNumber }), editMode: value.edit_mode === "auto" ? "auto" as const : "manual" as const, annotations } : undefined;
    return { ok: true, event: { type: "document", activity: { id: `doc-edited:${documentId || filename}`, tool: "doc_edited", label: `${streaming ? "Editing" : failed ? "Edit failed" : "Edited"} ${filename}`, status }, ...(artifact && { artifact }) } };
  }

  const toolStatus = activityStatus(streaming, value.error);
  if (type === "courtlistener_search_case_law") {
    const query = clean(value.query, FIELD_TEXT_LIMIT); if (!query) return fail("malformed");
    const results = Math.max(0, finite(value.result_count));
    return { ok: true, event: { type: "activity", activity: trackedActivity({ id: `case-search:${query}`, tool: type, status: toolStatus, labels: ["Searching case law", "Case law search failed", "Searched case law"], detail: streaming ? `for \u201c${query}\u201d` : `${count(results, "result")} for \u201c${query}\u201d` }) } };
  }
  if (type === "courtlistener_get_cases") {
    const ids = Array.isArray(value.cluster_ids) ? value.cluster_ids.slice(0, COLLECTION_LIMIT).flatMap((item) => safeInteger(item) ?? []) : [];
    const cases = records(value.cases).flatMap((item) => {
      const clusterId = safeInteger(item.cluster_id); if (!clusterId) return [];
      return [{ label: [clean(item.case_name), clean(item.citation)].filter(Boolean).join(", ") || `Cluster ${clusterId}`, url: safeAssistantUrl(item.url) }];
    });
    const caseCount = Math.max(0, finite(value.case_count, ids.length));
    return { ok: true, event: { type: "activity", activity: trackedActivity({ id: `cases:${ids.join(",")}`, tool: type, status: toolStatus, labels: [`Fetching ${count(caseCount, "case")}`, "Case fetch failed", `Fetched ${count(caseCount, "case")}`], items: cases }) } };
  }
  if (type === "courtlistener_find_in_case") {
    const searches = records(value.searches).map((item) => ({
      clusterId: safeInteger(item.cluster_id), query: clean(item.query, FIELD_TEXT_LIMIT), matches: Math.max(0, finite(item.total_matches)), caseName: clean(item.case_name), citation: clean(item.citation), error: !!clean(item.error),
    })).filter((item) => item.query);
    const clusterId = safeInteger(value.cluster_id); const query = clean(value.query, FIELD_TEXT_LIMIT);
    if (!searches.length && clusterId === undefined) return fail("malformed");
    const total = searches.length ? searches.reduce((sum, item) => sum + item.matches, 0) : Math.max(0, finite(value.total_matches));
    const cases = new Set(searches.map((item) => item.clusterId ?? `${item.caseName}|${item.citation}`)).size;
    const target = searches.length ? `${count(searches.length, "search")} in ${count(cases, "case")}` : ([clean(value.case_name), clean(value.citation)].filter(Boolean).join(", ") || `cluster ${clusterId}`);
    return { ok: true, event: { type: "activity", activity: trackedActivity({ id: searches.length ? "case-find:batch" : `case-find:${clusterId}:${query}`, tool: type, status: toolStatus, labels: [`${searches.length ? "Running" : "Searching"} ${target}`, "Case searches failed", `${searches.length ? "Ran" : "Searched"} ${target}`], detail: streaming ? undefined : count(total, "match"), items: searches.map((item) => ({ label: `\u201c${item.query}\u201d in ${[item.caseName, item.citation].filter(Boolean).join(", ") || `cluster ${item.clusterId}`}`, detail: count(item.matches, "match"), error: item.error })) }) } };
  }
  if (type === "courtlistener_read_case") {
    const clusterId = safeInteger(value.cluster_id); if (clusterId === undefined) return fail("malformed");
    const target = [clean(value.case_name), clean(value.citation)].filter(Boolean).join(", ") || `cluster ${clusterId}`;
    const opinions = Math.max(0, finite(value.opinion_count));
    return { ok: true, event: { type: "activity", activity: trackedActivity({ id: `case-read:${clusterId}`, tool: type, status: toolStatus, labels: [`Reading ${target}`, `Read failed ${target}`, `Read ${target}`], detail: opinions ? count(opinions, "opinion") : undefined }) } };
  }
  if (type === "courtlistener_verify_citations") {
    const total = Math.max(0, finite(value.citation_count)); const matches = Math.max(0, finite(value.match_count));
    return { ok: true, event: { type: "activity", activity: trackedActivity({ id: "case-verify", tool: type, status: toolStatus, labels: [`Verifying ${count(total, "citation")}`, "Citation verification failed", `Verified ${count(total, "citation")}`], detail: streaming ? undefined : count(matches, "match") }) } };
  }
  if (rawType === "case_citation") {
    const clusterId = safeInteger(value.cluster_id);
    const event: CaseCitationEvent = { type: "case_citation", cluster_id: clusterId ?? null, case_name: clean(value.case_name) || null, citation: clean(value.citation) || null, url: safeAssistantUrl(value.url) ?? "", pdfUrl: safeAssistantUrl(value.pdfUrl), dateFiled: clean(value.dateFiled) || null };
    return { ok: true, event: { type: "case_citation", event } };
  }
  if (rawType === "case_opinions") {
    const clusterId = safeInteger(value.cluster_id); if (clusterId === undefined || !isRecord(value.case)) return fail("malformed");
    const row = value.case;
    const opinions = records(row.opinions, 64).map((opinion) => ({ opinionId: safeInteger(opinion.opinionId) ?? null, apiUrl: safeAssistantUrl(opinion.apiUrl), type: clean(opinion.type) || null, author: clean(opinion.author) || null, url: safeAssistantUrl(opinion.url), text: clean(opinion.text, ASSISTANT_LIMITS.text) || null, html: null }));
    const event: CaseOpinionsEvent = { type: "case_opinions", cluster_id: clusterId, case: { id: safeInteger(row.id) ?? null, caseName: clean(row.caseName) || null, dateFiled: clean(row.dateFiled) || null, citations: strings(row.citations), url: safeAssistantUrl(row.url), pdfUrl: safeAssistantUrl(row.pdfUrl), opinions } };
    return { ok: true, event: { type: "case_opinions", event } };
  }
  return fail("unknown");
}

function emptyAssistant(id: string, turnId?: string): AssistantMessageState {
  return { id, role: "assistant", blocks: [], activities: [], automations: [], artifacts: [], citations: [], caseCitations: [], caseOpinions: [], contextCompacted: false, contentOpen: false, ...(turnId && { turnId }) };
}

function sanitizeFiles(value: Message["files"]) {
  return (value ?? []).slice(0, 64).flatMap((file) => {
    const filename = clean(file?.filename);
    return filename ? [{ filename, ...(clean(file.document_id) && { document_id: clean(file.document_id) }) }] : [];
  });
}

function userMessage(message: Message, fallbackId: string): UserMessageState {
  const files = sanitizeFiles(message.files);
  const workflow = message.workflow && clean(message.workflow.id) && clean(message.workflow.title)
    ? { id: clean(message.workflow.id), title: clean(message.workflow.title) } : undefined;
  return {
    id: clean(message.id) || fallbackId,
    role: "user",
    content: string(message.content, ASSISTANT_LIMITS.text),
    ...(files.length && { files }),
    ...(workflow && { workflow }),
    ...(clean(message.model) && { model: clean(message.model) }),
    ...(clean(message.reasoningEffort) && { reasoningEffort: clean(message.reasoningEffort) }),
    ...(message.editMode === "manual" || message.editMode === "auto" ? { editMode: message.editMode } : {}),
    ...(clean(message.turnId) && { turnId: clean(message.turnId) }),
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
  if (event.type === "activity" || event.type === "document") {
    return updateAssistant(state, (message) => ({
      ...message,
      contentOpen: false,
      activities: upsertById(
        message.activities.filter((activity) => activity.tool !== "reasoning"),
        event.activity,
        ASSISTANT_LIMITS.activities,
      ),
      ...(event.type === "document" && event.artifact ? { artifacts: upsertById(message.artifacts, event.artifact, ASSISTANT_LIMITS.artifacts) } : {}),
    }));
  }
  if (event.type === "automation") return updateAssistant(state, (message) => ({ ...message, contentOpen: false, automations: upsertById(message.automations, event.run, ASSISTANT_LIMITS.activities) }));
  if (event.type === "reader") {
    const task = event.reader.task.replace(/\s+/gu, " ").trim().slice(0, 100);
    const activity: AssistantActivity = {
      id: `reader:${event.reader.id}`, tool: "subagent_run",
      label: event.reader.status === "running" ? `Waiting for reading agent: ${task}` : event.reader.status === "error" ? "Reading agent failed" : event.reader.status === "interrupted" ? `Reading agent interrupted: ${task}` : `Reading agent completed: ${task}`,
      status: event.reader.status,
      ...(event.reader.output && { markdown: event.reader.output, sources: event.reader.sources }),
      ...(event.reader.verifiedPassages && { detail: count(event.reader.verifiedPassages, "verified passage") }),
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
      next = { ...next, messages: [...next.messages, userMessage(message, `user:${index}`)] };
      return;
    }
    const assistant = emptyAssistant(clean(message.id) || `assistant:${index}`, clean(message.turnId));
    next = { ...next, messages: [...next.messages, assistant] };
    const rawEvents = Array.isArray(message.events) ? message.events : [];
    for (const raw of rawEvents) {
      const parsed = parseAssistantProtocolEvent(raw);
      if (parsed.ok) next = applyProtocol(next, parsed.event);
    }
    const citations = parseAssistantCitations(message.citations);
    if (citations.length) next = applyProtocol(next, { type: "citations", citations, status: "final" });
    if (!rawEvents.length && message.content) next = applyProtocol(next, { type: "content_snapshot", text: string(message.content, ASSISTANT_LIMITS.text), final: true });
    if (message.error) next = applyProtocol(next, { type: "error", message: ASSISTANT_GENERIC_ERROR, retryable: true });
    if (message.turnStatus) next = interrupt(next, message.turnStatus);
    next = updateAssistant(next, (current) => current.id === assistant.id ? { ...current, turnComplete: message.turnComplete } : current);
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

export function createAssistantSessionState(args: { chatId?: string; messages?: Message[]; transcriptVersion?: number } = {}): AssistantSessionState {
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
  if (event.type === "chat_id_changed") return { ...state, chatId: event.chatId };
  if (event.type === "transcript_version_changed") return Number.isSafeInteger(event.transcriptVersion) && event.transcriptVersion >= 0 ? { ...state, transcriptVersion: event.transcriptVersion } : state;
  if (event.type === "local_exchange") {
    const user = userMessage(event.user, `user:local:${state.messages.length}`);
    const assistant = replaceContent(emptyAssistant(`assistant:local:${state.messages.length + 1}`), event.assistantText, true);
    return { ...state, messages: [...state.messages, user, assistant] };
  }
  return state;
}
