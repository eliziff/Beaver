
import type {
  AskInputsEvent,
  AskInputsResponseEvent,
  WorkflowRunEvent,
  Citation,
  EditAnnotation,
  Message,
} from "@/app/components/shared/types";
import { safeAssistantUrl } from "./safeAssistantUrl";
export { safeAssistantUrl } from "./safeAssistantUrl";

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
  citations?: Citation[];
  action?: { type: "reader"; readerId: string };
};

export type AssistantReaderRun = {
  id: string;
  task: string;
  status: AssistantActivityStatus;
  activities: AssistantActivity[];
  output?: string;
  error?: string;
  citations: Citation[];
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
  workflowRuns: WorkflowRunEvent[];
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
  run: { id: string; status: "running" | "paused"; chatId?: string; jobId?: string } | null;
  rejectedTurn: RejectedAssistantTurn | null;
  transcriptVersion: number;
};

export type ProtocolEvent =
  | { type: "turn_queued"; jobId: string }
  | { type: "client_tool_call"; callId: string; name: string;
      input: Record<string, unknown> }
  | { type: "chat_id"; chatId: string; transcriptVersion?: number }
  | { type: "transcript_version"; transcriptVersion: number }
  | { type: "content_block"; text: string }
  | { type: "content_final"; text: string; citations: Citation[] }
  | { type: "reasoning"; text: string; append: boolean; done?: boolean }
  | { type: "activity"; activity: AssistantActivity }
  | { type: "artifact"; artifact: AssistantArtifact }
  | { type: "workflow_run"; run: WorkflowRunEvent }
  | { type: "reader"; reader: AssistantReaderRun }
  | { type: "ask_inputs"; event: AskInputsEvent }
  | { type: "ask_inputs_response"; event: AskInputsResponseEvent }
  | { type: "steering"; id: string; text: string }
  | { type: "context_usage"; usedTokens: number; windowTokens: number }
  | { type: "compaction"; status: "running" | "completed" | "failed" }
  | { type: "turn_status"; status: "cancelled" }
  | { type: "error"; message: string; retryable: boolean; accepted?: boolean };

export type AssistantSessionEvent =
  | { type: "transcript_loaded"; chatId?: string; messages: AssistantTranscriptMessage[]; active?: boolean; transcriptVersion?: number; preserveRejected?: boolean }
  | { type: "live_replay_started"; chatId: string; runId: string }
  | { type: "run_started"; runId: string; chatId?: string; message: Message; options?: AssistantTurnOptions }
  | { type: "protocol"; runId: string; chatId?: string; event: ProtocolEvent }
  | { type: "run_finished"; runId: string }
  | { type: "run_interrupted"; runId: string; status: "cancelled" | "interrupted" }
  | { type: "run_failed"; runId: string; message?: string; rejected?: RejectedAssistantTurn; removeOptimistic?: boolean }
  | { type: "turn_rejected"; rejected: RejectedAssistantTurn | null }
  | { type: "steering_queued"; runId: string; id: string; text: string }
  | { type: "compaction_changed"; status: "running" | "completed" | "failed"; error?: string }
  | { type: "new_chat"; chatId?: string; message?: Message }
  | { type: "transcript_version_changed"; transcriptVersion: number }
  | { type: "local_exchange"; user: Message; assistantText: string };

const INVALID = Symbol("invalid");
type Invalid = typeof INVALID;
type WireObject = Record<string, unknown>;
type Parsed<T> = T | Invalid;

const wireObject = (value: unknown): value is WireObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const strictObject = (value: unknown, keys: readonly string[]): Parsed<WireObject> =>
  wireObject(value) && Object.keys(value).every((key) => keys.includes(key)) ? value : INVALID;
const text = (value: unknown, limit = FIELD_TEXT_LIMIT): Parsed<string> =>
  typeof value === "string" && value.length <= limit ? value : INVALID;
const short = (value: unknown): Parsed<string> => {
  const parsed = text(value, SHORT_TEXT_LIMIT);
  return parsed === INVALID ? INVALID : parsed.trim();
};
const id = (value: unknown): Parsed<string> => {
  const parsed = short(value);
  return parsed !== INVALID && parsed ? parsed : INVALID;
};
const finite = (value: unknown): Parsed<number> =>
  typeof value === "number" && Number.isFinite(value) ? value : INVALID;
const safeInteger = (value: unknown): Parsed<number> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : INVALID;
const member = <const T extends readonly string[]>(value: unknown, values: T): Parsed<T[number]> =>
  typeof value === "string" && values.includes(value) ? value as T[number] : INVALID;
const status = (value: unknown): Parsed<AssistantActivityStatus> => {
  const parsed = member(value, ["running", "completed", "error", "interrupted", "cancelled"] as const);
  return parsed === "cancelled" ? "interrupted" : parsed;
};
const url = (value: unknown): Parsed<string | null> =>
  typeof value === "string" && value.length <= FIELD_TEXT_LIMIT
    ? safeAssistantUrl(value) : INVALID;
const validUrl = (value: unknown): Parsed<string> => {
  const parsed = url(value);
  return parsed === INVALID || parsed === null ? INVALID : parsed;
};
const relativeUrl = (value: unknown): Parsed<string> => {
  const parsed = validUrl(value);
  return parsed !== INVALID && parsed.startsWith("/") ? parsed : INVALID;
};
function parsedArray<T>(value: unknown, limit: number,
  parse: (item: unknown) => Parsed<T>, minimum = 0): Parsed<T[]> {
  if (!Array.isArray(value) || value.length < minimum || value.length > limit) return INVALID;
  const result: T[] = [];
  for (const raw of value) {
    const item = parse(raw);
    if (item === INVALID) return INVALID;
    result.push(item);
  }
  return result;
}
function put<T>(source: WireObject, target: WireObject, key: string,
  parse: (value: unknown) => Parsed<T>): boolean {
  if (source[key] === undefined) return true;
  const value = parse(source[key]);
  if (value === INVALID) return false;
  target[key] = value;
  return true;
}
function putNullish<T>(source: WireObject, target: WireObject, key: string,
  parse: (value: unknown) => Parsed<T>): boolean {
  if (source[key] === undefined) return true;
  if (source[key] === null) { target[key] = null; return true; }
  return put(source, target, key, parse);
}

const DISPLAY_KEYS = ["display_form", "source_class", "external_url", "authority",
  "short_authority", "locator_separator"] as const;
const LOCATOR_KEYS = [...DISPLAY_KEYS, "locator_kind", "locator", "pinpoint"] as const;
function putDisplay(source: WireObject, target: WireObject, locator: boolean) {
  return put(source, target, "display_form", (value) => member(value, ["full", "pinpoint", "supra"] as const)) &&
    put(source, target, "source_class", (value) => member(value, ["case", "legislation", "commentary"] as const)) &&
    put(source, target, "external_url", url) &&
    put(source, target, "authority", short) && put(source, target, "short_authority", short) &&
    put(source, target, "locator_separator", (value) => member(value, [" at ", ", "] as const)) &&
    (!locator || (put(source, target, "locator_kind", (value) => member(value,
      ["paragraph", "page", "section", "footnote"] as const)) &&
      putNullish(source, target, "locator", short) && putNullish(source, target, "pinpoint", short)));
}
function parseQuote(value: unknown): Parsed<{ quote: string }> {
  const row = strictObject(value, ["quote"]);
  if (row === INVALID) return INVALID;
  const quote = text(row.quote);
  return quote === INVALID ? INVALID : { quote };
}
const quoteList = (value: unknown) => parsedArray(value, 32, parseQuote);

function parseCitation(value: unknown): Parsed<Citation> {
  if (!wireObject(value)) return INVALID;
  const ref = safeInteger(value.ref);
  if (ref === INVALID) return INVALID;
  const common = (row: WireObject, out: WireObject, withLocator: boolean) => {
    const quotes = row.quotes === undefined ? [] : quoteList(row.quotes);
    if (quotes === INVALID || !putDisplay(row, out, withLocator)) return false;
    out.quotes = quotes; return true;
  };
  if (value.kind === "a2aj") {
    const row = strictObject(value, ["kind", "ref", "citation", "name", "dataset", "url", "quotes", ...LOCATOR_KEYS]);
    const out: WireObject = { kind: "a2aj", ref };
    if (row === INVALID || !putNullish(row, out, "citation", short) ||
      !putNullish(row, out, "name", short) || !putNullish(row, out, "dataset", short) ||
      !putNullish(row, out, "url", url) || !common(row, out, true)) return INVALID;
    return out as Citation;
  }
  if (value.kind === "public_legal") {
    const row = strictObject(value, ["kind", "ref", "provider", "identifier", "title", "citation", "url", "quotes", ...LOCATOR_KEYS]);
    const provider = row === INVALID ? INVALID : member(row.provider,
      ["courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"] as const);
    const identifier = row === INVALID ? INVALID : id(row.identifier);
    const out: WireObject = { kind: "public_legal", ref, provider, identifier };
    if (row === INVALID || provider === INVALID || identifier === INVALID ||
      !putNullish(row, out, "title", short) || !putNullish(row, out, "citation", short) ||
      !putNullish(row, out, "url", url) || !common(row, out, true)) return INVALID;
    return out as Citation;
  }
  if (value.kind === "tabular") {
    const row = strictObject(value, ["kind", "ref", "review_id", "col_index", "row_index",
      "col_name", "doc_name", "quotes", ...DISPLAY_KEYS]);
    if (row === INVALID) return INVALID;
    const reviewId = id(row.review_id), colIndex = safeInteger(row.col_index);
    const rowIndex = safeInteger(row.row_index);
    const colName = row.col_name === undefined ? "" : short(row.col_name);
    const docName = row.doc_name === undefined ? "" : short(row.doc_name);
    const out: WireObject = { kind: "tabular", ref, review_id: reviewId,
      col_index: colIndex, row_index: rowIndex, col_name: colName, doc_name: docName };
    if ([reviewId, colIndex, rowIndex, colName, docName].includes(INVALID) ||
      !common(row, out, false)) return INVALID;
    return out as Citation;
  }
  if (value.kind === "document") {
    const row = strictObject(value, ["kind", "ref", "document_id", "filename", "version_id",
      "version_number", "url", "quotes", ...LOCATOR_KEYS]);
    if (row === INVALID) return INVALID;
    const documentId = id(row.document_id), filename = id(row.filename);
    const out: WireObject = { kind: "document", ref, document_id: documentId, filename };
    const documentQuote = (raw: unknown): Parsed<WireObject> => {
      const quote = strictObject(raw, ["page", "quote", "sheet", "cell"]);
      if (quote === INVALID) return INVALID;
      const quoteText = text(quote.quote), page = quote.page === undefined ? undefined
        : typeof quote.page === "number" ? finite(quote.page) : short(quote.page);
      const parsed: WireObject = { quote: quoteText };
      if (quoteText === INVALID || page === INVALID || !put(quote, parsed, "sheet", short) ||
        !put(quote, parsed, "cell", short)) return INVALID;
      if (page !== undefined) parsed.page = page;
      return parsed;
    };
    const quotes = row.quotes === undefined ? [] : parsedArray(row.quotes, 32, documentQuote);
    if (documentId === INVALID || filename === INVALID || quotes === INVALID ||
      !put(row, out, "version_id", short) || !put(row, out, "version_number", safeInteger) ||
      !put(row, out, "url", url) || !putDisplay(row, out, true)) return INVALID;
    out.quotes = quotes;
    return out as Citation;
  }
  return INVALID;
}

export function parseAssistantCitations(value: unknown): Citation[] {
  try {
    if (!Array.isArray(value)) return [];
    return value.slice(0, ASSISTANT_LIMITS.citations).flatMap((raw) => {
      try { const citation = parseCitation(raw); return citation === INVALID ? [] : [citation]; }
      catch { return []; }
    });
  } catch { return []; }
}

function parseActivity(value: unknown): Parsed<AssistantActivity> {
  const row = strictObject(value, ["id", "tool", "label", "status", "citations"]);
  if (row === INVALID) return INVALID;
  const activityId = id(row.id), tool = id(row.tool), label = id(row.label);
  const activityStatus = status(row.status);
  if ([activityId, tool, label, activityStatus].includes(INVALID) ||
    row.citations !== undefined && !Array.isArray(row.citations)) return INVALID;
  return { id: activityId as string, tool: tool as string, label: label as string,
    status: activityStatus as AssistantActivityStatus,
    ...(row.citations !== undefined && { citations: parseAssistantCitations(row.citations) }) };
}

function parseAskItem(value: unknown): Parsed<AskInputsEvent["items"][number]> {
  if (!wireObject(value)) return INVALID;
  if (value.kind === "choice") {
    const row = strictObject(value, ["id", "kind", "question", "options"]);
    if (row === INVALID) return INVALID;
    const itemId = id(row.id), question = text(row.question);
    const options = parsedArray(row.options, 32, (raw) => {
      const option = strictObject(raw, ["value"]);
      if (option === INVALID) return INVALID;
      const optionValue = id(option.value);
      return optionValue === INVALID ? INVALID : { value: optionValue };
    }, 1);
    return itemId === INVALID || question === INVALID || options === INVALID ? INVALID
      : { id: itemId, kind: "choice", question, options };
  }
  if (value.kind === "documents") {
    const row = strictObject(value, ["id", "kind", "document_types"]);
    if (row === INVALID) return INVALID;
    const itemId = id(row.id), documentTypes = row.document_types === undefined ? []
      : parsedArray(row.document_types, 32, short);
    return itemId === INVALID || documentTypes === INVALID ? INVALID
      : { id: itemId, kind: "documents", document_types: documentTypes };
  }
  return INVALID;
}
function parseAskEvent(value: unknown): Parsed<AskInputsEvent> {
  const row = strictObject(value, ["type", "items"]);
  if (row === INVALID || row.type !== "ask_inputs") return INVALID;
  const items = parsedArray(row.items, 32, parseAskItem, 1);
  return items === INVALID ? INVALID : { type: "ask_inputs", items };
}
function parseAskResponse(value: unknown): Parsed<AskInputsResponseEvent> {
  const row = strictObject(value, ["type", "responses"]);
  if (row === INVALID || row.type !== "ask_inputs_response") return INVALID;
  const responses = parsedArray(row.responses, 32,
    (raw): Parsed<AskInputsResponseEvent["responses"][number]> => {
      if (!wireObject(raw)) return INVALID;
      const responseId = id(raw.id);
      if (raw.kind === "choice") {
        const choice = strictObject(raw, ["id", "kind", "answer"]);
        if (choice === INVALID || responseId === INVALID) return INVALID;
        const answer = choice.answer === undefined ? undefined : text(choice.answer);
        return answer === INVALID ? INVALID : { id: responseId, kind: "choice", ...(answer !== undefined && { answer }) };
      }
      if (raw.kind === "documents") {
        const documentResponse = strictObject(raw, ["id", "kind", "documents"]);
        if (documentResponse === INVALID || responseId === INVALID) return INVALID;
        const documents = documentResponse.documents === undefined ? []
          : parsedArray(documentResponse.documents, 32, (document) => {
              const item = strictObject(document, ["document_id", "filename"]);
              if (item === INVALID) return INVALID;
              const documentId = id(item.document_id), filename = id(item.filename);
              return documentId === INVALID || filename === INVALID ? INVALID
                : { document_id: documentId, filename };
            });
        return documents === INVALID ? INVALID
          : { id: responseId, kind: "documents", documents };
      }
      return INVALID;
    });
  return responses === INVALID ? INVALID : { type: "ask_inputs_response", responses };
}

function parseWorkflowRun(value: unknown): Parsed<WorkflowRunEvent> {
  const row = strictObject(value, ["type", "id", "tool", "status", "stage", "progress",
    "message", "counts", "outputs", "app_url", "job_id", "version_number", "error",
    "work_product", "requested_action"]);
  if (row === INVALID || row.type !== "workflow_run") return INVALID;
  const tool = member(row.tool, ["create_table_of_authorities", "update_work_product",
    "fix_docx_supras"] as const);
  const statusText = row.status === undefined ? "unknown" : short(row.status);
  const stage = row.stage === undefined ? "Workflow" : short(row.stage);
  const out: WireObject = { type: "workflow_run", tool, status: statusText, stage };
  const progress = (raw: unknown) => {
    const value = finite(raw); return value !== INVALID && value >= 0 && value <= 100 ? value : INVALID;
  };
  const counts = row.counts === undefined ? undefined : parsedArray(row.counts, 32, (raw) => {
    const count = strictObject(raw, ["label", "value"]);
    if (count === INVALID) return INVALID;
    const label = id(count.label), value = finite(count.value);
    return label === INVALID || value === INVALID ? INVALID : { label, value };
  });
  const outputs = row.outputs === undefined ? undefined : parsedArray(row.outputs, 32, (raw) => {
    const output = strictObject(raw, ["name", "url"]);
    if (output === INVALID) return INVALID;
    const name = id(output.name), outputUrl = output.url === undefined ? undefined : validUrl(output.url);
    return name === INVALID || outputUrl === INVALID ? INVALID
      : { name, ...(outputUrl !== undefined && { url: outputUrl }) };
  });
  const workProduct = row.work_product === undefined ? undefined : (() => {
    const item = strictObject(row.work_product, ["kind", "id", "revision"]);
    if (item === INVALID) return INVALID;
    const kind = member(item.kind, ["court-record", "authorities", "research-set"] as const);
    const workProductId = id(item.id), revision = safeInteger(item.revision);
    return kind === INVALID || workProductId === INVALID || revision === INVALID || revision < 1
      ? INVALID : { kind, id: workProductId, revision };
  })();
  const requestedAction = row.requested_action === undefined ? undefined
    : member(row.requested_action, ["open", "refresh", "build"] as const);
  if (tool === INVALID || statusText === INVALID || stage === INVALID || counts === INVALID ||
    outputs === INVALID || workProduct === INVALID || requestedAction === INVALID ||
    !put(row, out, "id", short) || !put(row, out, "progress", progress) ||
    !put(row, out, "message", text) || !put(row, out, "app_url", validUrl) ||
    !put(row, out, "job_id", short) || !putNullish(row, out, "version_number", safeInteger) ||
    !put(row, out, "error", short)) return INVALID;
  if (counts !== undefined) out.counts = counts;
  if (outputs !== undefined) out.outputs = outputs;
  if (workProduct !== undefined) out.work_product = workProduct;
  if (requestedAction !== undefined) out.requested_action = requestedAction;
  out.id = out.id || `${tool}:${out.job_id || "run"}`;
  if (out.error) out.error = "Workflow failed.";
  return out as WorkflowRunEvent;
}

function parseReader(value: unknown): Parsed<ProtocolEvent> {
  const row = strictObject(value, ["type", "id", "task", "status", "activity", "output",
    "error", "activities", "citations"]);
  if (row === INVALID || row.type !== "subagent_run") return INVALID;
  const readerId = id(row.id), task = text(row.task, ASSISTANT_LIMITS.text);
  const readerStatus = status(row.status);
  const activity = row.activity === undefined ? undefined : parseActivity(row.activity);
  const activities = row.activities === undefined ? undefined
    : parsedArray(row.activities, ASSISTANT_LIMITS.activities, parseActivity);
  if (row.citations !== undefined && !Array.isArray(row.citations)) return INVALID;
  const out: WireObject = { id: readerId, task, status: readerStatus,
    activities: activities ?? (activity === undefined ? [] : [activity]),
    citations: row.citations === undefined ? [] : parseAssistantCitations(row.citations) };
  if ([readerId, task, readerStatus, activity, activities].includes(INVALID) ||
    !put(row, out, "output", (raw) => text(raw, ASSISTANT_LIMITS.text)) ||
    !put(row, out, "error", short)) return INVALID;
  return { type: "reader", reader: out as AssistantReaderRun };
}

function parseEditAnnotation(value: unknown): Parsed<EditAnnotation> {
  const row = strictObject(value, ["edit_id", "document_id", "version_id", "version_number",
    "del_w_id", "ins_w_id", "deleted_text", "inserted_text", "context_before", "context_after",
    "reason", "diff", "status"]);
  if (row === INVALID) return INVALID;
  const editId = id(row.edit_id), documentId = id(row.document_id), versionId = id(row.version_id);
  const deletedText = row.deleted_text === undefined ? "" : text(row.deleted_text);
  const insertedText = row.inserted_text === undefined ? "" : text(row.inserted_text);
  const diff = row.diff === undefined ? [] : parsedArray(row.diff, 256, (raw) => {
    const item = strictObject(raw, ["kind", "text"]);
    if (item === INVALID) return INVALID;
    const kind = member(item.kind, ["equal", "delete", "insert"] as const), itemText = text(item.text);
    return kind === INVALID || itemText === INVALID ? INVALID : { kind, text: itemText };
  });
  const editStatus = member(row.status, ["pending", "accepted", "rejected"] as const);
  const out: WireObject = { edit_id: editId, document_id: documentId, version_id: versionId,
    deleted_text: deletedText, inserted_text: insertedText, diff, status: editStatus };
  if ([editId, documentId, versionId, deletedText, insertedText, diff, editStatus].includes(INVALID) ||
    !putNullish(row, out, "version_number", safeInteger) || !put(row, out, "del_w_id", short) ||
    !put(row, out, "ins_w_id", short) || !put(row, out, "context_before", text) ||
    !put(row, out, "context_after", text) || !put(row, out, "reason", text)) return INVALID;
  return out as unknown as EditAnnotation;
}
function parseArtifact(value: unknown): Parsed<ProtocolEvent> {
  const row = strictObject(value, ["type", "action", "filename", "document_id", "version_id",
    "version_number", "download_url", "edit_mode", "annotations"]);
  if (row === INVALID || row.type !== "document_artifact") return INVALID;
  const action = member(row.action, ["created", "edited"] as const), filename = id(row.filename);
  const documentId = id(row.document_id), versionId = id(row.version_id);
  const versionNumber = row.version_number === null ? null : safeInteger(row.version_number);
  const downloadUrl = relativeUrl(row.download_url);
  const editMode = row.edit_mode === undefined ? undefined : member(row.edit_mode, ["manual", "auto"] as const);
  const annotations = row.annotations === undefined ? [] : parsedArray(row.annotations, 256, parseEditAnnotation);
  if ([action, filename, documentId, versionId, versionNumber, downloadUrl, editMode,
    annotations].includes(INVALID)) return INVALID;
  return { type: "artifact", artifact: {
    id: `${action as string}:${documentId as string}`, type: action as "created" | "edited", filename: filename as string,
    downloadUrl: downloadUrl as string, documentId: documentId as string, versionId: versionId as string,
    versionNumber: versionNumber as number | null,
    ...(action === "edited" && { editMode: editMode as "manual" | "auto" | undefined ?? "manual" }),
    annotations: annotations as EditAnnotation[],
  } };
}

function parseProtocol(value: unknown): Parsed<ProtocolEvent> {
  if (!wireObject(value)) return INVALID;
  const rowFor = (keys: string[]) => strictObject(value, ["type", ...keys]);
  let row: Parsed<WireObject>;
  switch (value.type) {
    case "turn_queued": {
      row = rowFor(["jobId"]); const jobId = row === INVALID ? INVALID : id(row.jobId);
      return row === INVALID || jobId === INVALID ? INVALID : { type: "turn_queued", jobId };
    }
    case "client_tool_call": {
      row = rowFor(["callId", "name", "input"]);
      if (row === INVALID) return INVALID;
      const callId = id(row.callId), name = id(row.name);
      return callId === INVALID || name === INVALID || !wireObject(row.input) ? INVALID
        : { type: "client_tool_call", callId, name, input: { ...row.input } };
    }
    case "chat_id": {
      row = rowFor(["chatId", "transcriptVersion"]);
      if (row === INVALID) return INVALID;
      const chatId = id(row.chatId), version = row.transcriptVersion === undefined
        ? undefined : safeInteger(row.transcriptVersion);
      return chatId === INVALID || version === INVALID ? INVALID
        : { type: "chat_id", chatId, ...(version !== undefined && { transcriptVersion: version }) };
    }
    case "transcript_version": {
      row = rowFor(["transcriptVersion"]);
      const version = row === INVALID ? INVALID : safeInteger(row.transcriptVersion);
      return version === INVALID ? INVALID : { type: "transcript_version", transcriptVersion: version };
    }
    case "content": {
      row = rowFor(["text"]); const content = row === INVALID ? INVALID : text(row.text, ASSISTANT_LIMITS.text);
      return content === INVALID ? INVALID : { type: "content_block", text: content };
    }
    case "content_final": {
      row = rowFor(["text", "citations"]);
      const content = row === INVALID ? INVALID : text(row.text, ASSISTANT_LIMITS.text);
      return row === INVALID || content === INVALID || !Array.isArray(row.citations) ? INVALID
        : { type: "content_final", text: content, citations: parseAssistantCitations(row.citations) };
    }
    case "reasoning_delta": {
      row = rowFor(["text"]); const reasoning = row === INVALID ? INVALID : text(row.text, 65_536);
      return reasoning === INVALID ? INVALID : { type: "reasoning", text: reasoning, append: true };
    }
    case "reasoning": {
      row = rowFor(["text"]); const reasoning = row === INVALID ? INVALID : text(row.text, ASSISTANT_LIMITS.text);
      return reasoning === INVALID ? INVALID
        : { type: "reasoning", text: reasoning, append: false, done: true };
    }
    case "reasoning_block_end":
      return rowFor([]) === INVALID ? INVALID
        : { type: "reasoning", text: "", append: false, done: true };
    case "error": {
      row = rowFor(["message", "retryable", "accepted"]);
      if (row === INVALID) return INVALID;
      const message = text(row.message);
      if (message === INVALID || row.retryable !== undefined && typeof row.retryable !== "boolean" ||
        row.accepted !== undefined && typeof row.accepted !== "boolean") return INVALID;
      return message.trim() === "Cancelled by user." ? { type: "turn_status", status: "cancelled" }
        : { type: "error", message: ASSISTANT_GENERIC_ERROR, retryable: row.retryable !== false,
            ...(row.accepted !== undefined && { accepted: row.accepted as boolean }) };
    }
    case "turn_status":
      row = rowFor(["status"]); return row !== INVALID && row.status === "cancelled"
        ? { type: "turn_status", status: "cancelled" } : INVALID;
    case "steering": {
      row = rowFor(["id", "text"]);
      if (row === INVALID) return INVALID;
      const steeringId = id(row.id), steeringText = text(row.text);
      return steeringId === INVALID || steeringText === INVALID ? INVALID
        : { type: "steering", id: steeringId, text: steeringText };
    }
    case "ask_inputs": {
      const event = parseAskEvent(value);
      return event === INVALID ? INVALID : { type: "ask_inputs", event };
    }
    case "ask_inputs_response": {
      const event = parseAskResponse(value);
      return event === INVALID ? INVALID : { type: "ask_inputs_response", event };
    }
    case "tool_activity": {
      row = strictObject(value, ["type", "id", "tool", "label", "status", "citations"]);
      if (row === INVALID) return INVALID;
      const { type: _type, ...activityRow } = row;
      const activity = parseActivity(activityRow);
      return activity === INVALID ? INVALID : { type: "activity", activity };
    }
    case "workflow_run": {
      const run = parseWorkflowRun(value);
      return run === INVALID ? INVALID : { type: "workflow_run", run };
    }
    case "subagent_run": return parseReader(value);
    case "context_usage": {
      row = rowFor(["used_tokens", "window_tokens"]);
      if (row === INVALID) return INVALID;
      const used = finite(row.used_tokens), window = finite(row.window_tokens);
      return used === INVALID || used < 0 || window === INVALID || window <= 0 ? INVALID
        : { type: "context_usage", usedTokens: used, windowTokens: window };
    }
    case "compaction": {
      row = rowFor(["status"]); const compact = row === INVALID ? INVALID
        : member(row.status, ["running", "completed", "failed"] as const);
      return compact === INVALID ? INVALID : { type: "compaction", status: compact };
    }
    case "document_artifact": return parseArtifact(value);
    default: return INVALID;
  }
}

export function parseAssistantProtocolEvent(value: unknown) {
  try {
    const event = parseProtocol(value);
    return event === INVALID ? { ok: false as const } : { ok: true as const, event };
  } catch { return { ok: false as const }; }
}

const textValue = (value: unknown, limit = FIELD_TEXT_LIMIT) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const cleanValue = (value: unknown, limit = SHORT_TEXT_LIMIT) =>
  textValue(value, limit).trim();
const emptyAssistant = (id: string, turnId?: string): AssistantMessageState =>
  ({ id, role: "assistant", blocks: [], activities: [], workflowRuns: [], artifacts: [], citations: [], contextCompacted: false, contentFinal: false, contentOpen: false, ...(turnId && { turnId }) });

function userMessage(message: Message, fallbackId: string): UserMessageState {
  const files = (message.files ?? []).slice(0, 64).flatMap((file) => {
    const filename = cleanValue(file?.filename);
    const documentId = cleanValue(file.document_id);
    return filename && documentId ? [{ filename, document_id: documentId }] : [];
  });
  const workflowId = cleanValue(message.workflow?.id);
  const workflowVariantId = cleanValue(message.workflow?.variant_id);
  const workflowTitle = cleanValue(message.workflow?.title);
  const workflow = workflowId && workflowTitle ? {
    id: workflowId,
    ...(workflowVariantId && { variant_id: workflowVariantId }),
    title: workflowTitle,
  } : undefined;
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

function upsertArtifact(items: AssistantArtifact[], item: AssistantArtifact) {
  const current = items.find((candidate) => candidate.id === item.id);
  if (!current || current.versionId !== item.versionId)
    return upsertById(items, item, ASSISTANT_LIMITS.artifacts);
  const annotations = new Map([...current.annotations, ...item.annotations].map((annotation) =>
    [annotation.edit_id, annotation] as const));
  return upsertById(items, { ...item, annotations: [...annotations.values()] },
    ASSISTANT_LIMITS.artifacts);
}

const messageContent = (blocks: AssistantDialogueBlock[]) =>
  blocks.filter((block) => block.role === "assistant").map((block) => block.text).join("\n\n");

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
  return { ...message, blocks: blocks.slice(-ASSISTANT_LIMITS.blocks), contentOpen: true };
}

function replaceContent(message: AssistantMessageState, text: string) {
  const lastSteering = message.blocks.findLastIndex((block) => block.role === "user");
  const firstContent = message.blocks.findIndex((block, index) => index > lastSteering && block.role === "assistant");
  const blocks = message.blocks.filter((block, index) => index <= lastSteering || block.role !== "assistant");
  const remaining = Math.max(0, ASSISTANT_LIMITS.text - messageContent(blocks).length);
  if (text && remaining) blocks.splice(firstContent < 0 ? blocks.length : Math.min(firstContent, blocks.length), 0, { id: `content:${message.id}:${firstContent < 0 ? blocks.length : firstContent}`, role: "assistant", text: text.slice(0, remaining) });
  return { ...message, blocks, contentOpen: false };
}

const completeActivity = (activity: AssistantActivity): AssistantActivity =>
  activity.status === "running" ? { ...activity, status: "completed" } : activity;
const failActivity = (activity: AssistantActivity): AssistantActivity =>
  activity.status === "running" ? { ...activity, status: "error" } : activity;

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
  if (event.type === "turn_queued") return {
    ...state,
    run: state.run ? { ...state.run, jobId: event.jobId } : null,
  };
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
    artifacts: upsertArtifact(message.artifacts, event.artifact),
  }));
  if (event.type === "workflow_run") return updateAssistant(state, (message) => ({ ...message, contentOpen: false, workflowRuns: upsertById(message.workflowRuns, event.run, ASSISTANT_LIMITS.activities) }));
  if (event.type === "reader") {
    const previous = state.readers.find(({ id }) => id === event.reader.id);
    const reader = event.reader.status === "running" && previous ? {
      ...previous,
      status: event.reader.status,
      activities: event.reader.activities.reduce((items, activity) =>
        upsertById(items, activity, ASSISTANT_LIMITS.activities), previous.activities),
    } : event.reader;
    const task = reader.task.replace(/\s+/gu, " ").trim().slice(0, 100);
    const activity: AssistantActivity = {
      id: `reader:${reader.id}`, tool: "subagent_run",
      label: reader.status === "running" ? `Waiting for reading agent: ${task}` : reader.status === "error" ? "Reading agent failed" : reader.status === "interrupted" ? `Reading agent interrupted: ${task}` : `Reading agent completed: ${task}`,
      status: reader.status,
      ...(reader.output && { markdown: reader.output, citations: reader.citations }),
      ...(reader.citations.length && { detail: `${reader.citations.length} verified source${reader.citations.length === 1 ? "" : "s"}` }),
      action: { type: "reader", readerId: reader.id },
    };
    const next = updateAssistant(state, (message) => ({ ...message, contentOpen: false, activities: upsertById(message.activities, activity, ASSISTANT_LIMITS.activities) }));
    return { ...next, readers: upsertById(next.readers, reader, ASSISTANT_LIMITS.readers) };
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
  if (event.active) {
    const chatId = event.chatId ?? state.chatId;
    const last = next.messages.at(-1);
    if (last?.role === "user") next = {
      ...next,
      messages: [...next.messages, emptyAssistant(`assistant:active:${chatId}`, last.turnId)],
    };
    next = { ...next, run: state.run ?? {
      id: `durable:${chatId}`,
      status: "running",
      ...(chatId && { chatId }),
    } };
  }
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
  if (event.type === "live_replay_started") {
    const index = state.messages.findLastIndex((message) => message.role === "assistant");
    const messages = state.messages.slice();
    if (index >= 0) {
      const current = messages[index] as AssistantMessageState;
      messages[index] = emptyAssistant(current.id, current.turnId);
    }
    return { ...state, chatId: event.chatId, messages, readers: [], pendingInput: null,
      run: { id: event.runId, status: "running", chatId: event.chatId } };
  }
  if (event.type === "run_started") {
    const run = { id: event.runId, status: "running" as const, ...(event.chatId && { chatId: event.chatId }) };
    let next: AssistantSessionState = { ...state, run, rejectedTurn: null };
    if (event.options?.askInputsResponse) {
      next = applyProtocol(next, { type: "ask_inputs_response", event: event.options.askInputsResponse });
    } else {
      const retryAssistantIndex = event.options?.turnId
        ? next.messages.findLastIndex((message) =>
            message.role === "assistant" && message.turnId === event.options?.turnId)
        : -1;
      if (retryAssistantIndex >= 0) {
        next = {
          ...next,
          messages: next.messages.map((message, index) => index === retryAssistantIndex
            ? { ...message, turnStatus: undefined, error: undefined }
            : message),
        };
        return next;
      }
      const last = next.messages.at(-1);
      const user = userMessage(event.message, `user:${event.runId}`);
      const messages = last?.role === "user" && last.content === user.content ? next.messages : [...next.messages, user];
      next = { ...next, messages: [...messages, emptyAssistant(`assistant:${event.runId}`, event.options?.turnId)] };
    }
    return next;
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
    if (event.removeOptimistic) return {
      ...state,
      messages: state.messages.filter(({ id }) =>
        id !== `user:${event.runId}` && id !== `assistant:${event.runId}`),
      run: null,
      rejectedTurn: event.rejected ?? state.rejectedTurn,
    };
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
