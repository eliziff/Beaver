
import type { AskInputsEvent, AskInputsResponseEvent, WorkflowRunEvent, Message } from "@/app/lib/api/chat";
import type { Citation } from "@/app/lib/citations";
import type { EditAnnotation } from "@/app/lib/api/documents";
import { ASSISTANT_LIMITS, ASSISTANT_GENERIC_ERROR, FIELD_TEXT_LIMIT, SHORT_TEXT_LIMIT,
  parseAssistantCitations, parseAssistantProtocolEvent } from "./assistantProtocol";

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
  documentId: string;
  versionId: string;
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

const textValue = (value: unknown, limit = FIELD_TEXT_LIMIT) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const cleanValue = (value: unknown, limit = SHORT_TEXT_LIMIT) =>
  textValue(value, limit).trim();
const emptyAssistant = (id: string, turnId?: string): AssistantMessageState =>
  ({ id, role: "assistant", blocks: [], activities: [], workflowRuns: [], artifacts: [], citations: [], contextCompacted: false, contentFinal: false, ...(turnId && { turnId }) });

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
  const remaining = Math.max(0, ASSISTANT_LIMITS.text - messageContent(message.blocks).length);
  if (!text || !remaining) return message;
  return { ...message, blocks: [...message.blocks, {
    id: `content:${message.id}:${message.blocks.length}`, role: "assistant" as const,
    text: text.slice(0, remaining),
  }].slice(-ASSISTANT_LIMITS.blocks) };
}

function replaceContent(message: AssistantMessageState, text: string) {
  const lastSteering = message.blocks.findLastIndex((block) => block.role === "user");
  const firstContent = message.blocks.findIndex((block, index) => index > lastSteering && block.role === "assistant");
  const blocks = message.blocks.filter((block, index) => index <= lastSteering || block.role !== "assistant");
  const remaining = Math.max(0, ASSISTANT_LIMITS.text - messageContent(blocks).length);
  if (text && remaining) blocks.splice(firstContent < 0 ? blocks.length : Math.min(firstContent, blocks.length), 0, { id: `content:${message.id}:${firstContent < 0 ? blocks.length : firstContent}`, role: "assistant", text: text.slice(0, remaining) });
  return { ...message, blocks };
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
    const next = updateAssistant(state, (message) => ({ ...message, contextCompacted: event.status === "completed" || message.contextCompacted }));
    return { ...next, compaction: event.status };
  }
  if (event.type === "turn_status") return interrupt(state, event.status);
  if (event.type === "content_block") return updateAssistant(state, (message) => appendContent(message, event.text));
  if (event.type === "content_final")
    return finishContent(state, event.text, event.citations);
  if (event.type === "reasoning") {
    if (!event.text) return updateAssistant(state, (message) => ({
      ...message,
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
      return { ...message, activities: upsertById(message.activities, activity, ASSISTANT_LIMITS.activities) };
    });
  }
  if (event.type === "activity") {
    return updateAssistant(state, (message) => ({
      ...message,
      activities: upsertById(message.activities, event.activity, ASSISTANT_LIMITS.activities),
    }));
  }
  if (event.type === "artifact") return updateAssistant(state, (message) => ({
    ...message,
    artifacts: upsertArtifact(message.artifacts, event.artifact),
  }));
  if (event.type === "workflow_run") return updateAssistant(state, (message) => ({ ...message, workflowRuns: upsertById(message.workflowRuns, event.run, ASSISTANT_LIMITS.activities) }));
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
    const next = updateAssistant(state, (message) => ({ ...message, activities: upsertById(message.activities, activity, ASSISTANT_LIMITS.activities) }));
    return { ...next, readers: upsertById(next.readers, reader, ASSISTANT_LIMITS.readers) };
  }
  if (event.type === "ask_inputs") {
    let pending: AssistantPendingInput | null = null;
    const next = updateAssistant(state, (message) => {
      const id = `ask:${event.event.items.map((item) => item.id).join(",")}`;
      pending = { key: `${state.chatId ?? "new"}:${message.id}:${id}`, messageId: message.id, event: event.event };
      return {
        ...message,
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
    return { ...message, blocks };
  });
  if (event.type === "error") {
    const failed = updateAssistant(state, (message) => ({
      ...message,
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
      next = { ...next, messages: [...next.messages, userMessage({ id: message.id, role: "user", content: typeof message.content === "string" ? message.content : "", files: message.files ?? undefined, workflow: message.workflow ?? undefined, turnId: message.turn_id }, `user:${index}`)] };
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
  if (event.type === "run_finished") return state.run?.id === event.runId ? { ...state, run: null } : state;
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
