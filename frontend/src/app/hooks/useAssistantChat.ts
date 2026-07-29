"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getChat,
  stopChat,
  streamChat,
} from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useGenerateChatTitle } from "./useGenerateChatTitle";
import type {
  AssistantEvent,
  AutomationToolName,
  Citation,
  Message,
} from "@/app/components/shared/types";
import { readSseData } from "@/app/lib/sse";
import { reduceAssistantStreamEvent } from "@/app/lib/assistantStreamEvents";
import {
  readSelectedModel,
  readSelectedReasoningEffort,
} from "./useSelectedModel";
interface UseAssistantChatOptions {
  initialMessages?: Message[];
  chatId?: string;
  projectId?: string;
}
export type AssistantTurnOptions = {
  displayedDoc?: { filename: string; documentId: string } | null;
  turnId?: string;
  askInputsResponse?: Extract<
    AssistantEvent,
    { type: "ask_inputs_response" }
  >;
};
export type RejectedAssistantTurn = {
  message: Message;
  options?: AssistantTurnOptions;
};
function readableStreamError(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return "Sorry, something went wrong.";
}
const AUTOMATION_TOOLS = new Set<AutomationToolName>([
  "toa_submit_library_document",
  "toa_job_status",
  "library_fix_docx_supras",
  "library_link_docx_citations",
]);
export function parseAutomationRunEvent(
  data: Record<string, unknown>,
): Extract<AssistantEvent, { type: "automation_run" }> | null {
  const tool = data.tool as AutomationToolName;
  if (!AUTOMATION_TOOLS.has(tool)) return null;
  const string = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const counts = Array.isArray(data.counts)
    ? data.counts.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const label = string(row.label);
        return label && typeof row.value === "number"
          ? [{ label, value: row.value }]
          : [];
      })
    : undefined;
  const outputs = Array.isArray(data.outputs)
    ? data.outputs.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const name = string(row.name);
        return name
          ? [{ name, ...(string(row.url) ? { url: string(row.url) } : {}) }]
          : [];
      })
    : undefined;
  return {
    type: "automation_run",
    id: string(data.id) ?? `${tool}:${string(data.job_id) ?? "run"}`,
    tool,
    status: string(data.status) ?? "unknown",
    stage: string(data.stage) ?? "Automation",
    ...(typeof data.progress === "number"
      ? { progress: data.progress }
      : {}),
    ...(string(data.message) ? { message: string(data.message) } : {}),
    ...(counts?.length ? { counts } : {}),
    ...(string(data.error) ? { error: string(data.error) } : {}),
    ...(outputs?.length ? { outputs } : {}),
    ...(string(data.app_url) ? { app_url: string(data.app_url) } : {}),
    ...(string(data.job_id) ? { job_id: string(data.job_id) } : {}),
    ...(string(data.document_id)
      ? { document_id: string(data.document_id) }
      : {}),
    ...(string(data.version_id)
      ? { version_id: string(data.version_id) }
      : {}),
    ...(typeof data.version_number === "number"
      ? { version_number: data.version_number }
      : {}),
  };
}
export function useAssistantChat({
  initialMessages = [],
  chatId: initialChatId,
  projectId,
}: UseAssistantChatOptions = {}) {
  const router = useRouter();
  const {
    replaceChatId,
    loadChats,
    saveChat,
    stagePendingChatMessage,
  } = useChatHistoryContext();
  const { generate: generateTitle } = useGenerateChatTitle();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isResponseLoading, setIsResponseLoading] = useState(false);
  const [isLoadingCitations, setIsLoadingCitations] = useState(false);
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);
  const [rejectedTurn, setRejectedTurn] =
    useState<RejectedAssistantTurn | null>(null);
  const transcriptVersionRef = useRef(0);
  const transcriptPollGenerationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const clearRejectedTurn = useCallback(() => setRejectedTurn(null), []);
  useEffect(
    () => () => {
      transcriptPollGenerationRef.current += 1;
    },
    [],
  );
  const eventsRef = useRef<AssistantEvent[]>([]);
  const pendingEventsSnapshotRef = useRef<AssistantEvent[] | null>(null);
  const pendingEventsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const updateLatestAssistantMessage = (
    updater: (message: Message) => Message,
  ) => {
    setMessages((prev) => {
      let assistantIndex = -1;
      for (let index = prev.length - 1; index >= 0; index--) {
        if (prev[index].role === "assistant") {
          assistantIndex = index;
          break;
        }
      }
      if (assistantIndex < 0) return prev;
      const updated = [...prev];
      updated[assistantIndex] = updater(updated[assistantIndex]);
      return updated;
    });
  };
  const flushPendingEventsSnapshot = () => {
    if (pendingEventsTimerRef.current !== null) {
      clearTimeout(pendingEventsTimerRef.current);
      pendingEventsTimerRef.current = null;
    }
    const snapshot = pendingEventsSnapshotRef.current;
    pendingEventsSnapshotRef.current = null;
    if (!snapshot) return;
    updateLatestAssistantMessage((message) => ({ ...message, events: snapshot }));
  };
  const scheduleEventsSnapshot = () => {
    pendingEventsSnapshotRef.current = [...eventsRef.current];
    if (pendingEventsTimerRef.current !== null) return;
    pendingEventsTimerRef.current = setTimeout(() => {
      pendingEventsTimerRef.current = null;
      const snapshot = pendingEventsSnapshotRef.current;
      pendingEventsSnapshotRef.current = null;
      if (!snapshot) return;
      updateLatestAssistantMessage((message) => ({ ...message, events: snapshot }));
    }, 16);
  };
  useEffect(() => {
    return () => {
      if (pendingEventsTimerRef.current !== null) {
        clearTimeout(pendingEventsTimerRef.current);
      }
    };
  }, []);
  const finalizeStreamingContent = () => {
    const events = eventsRef.current;
    let contentIndex = -1;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.type === "content" && event.isStreaming) {
        contentIndex = index;
        break;
      }
    }
    if (contentIndex < 0) return;
    flushPendingEventsSnapshot();
    const content = events[contentIndex] as Extract<
      AssistantEvent,
      { type: "content" }
    >;
    const next = [...events];
    next[contentIndex] = { type: "content", text: content.text };
    eventsRef.current = next;
    updateLatestAssistantMessage((message) => ({
      ...message,
      events: next,
    }));
  };
  const finalizeStreamingReasoning = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last?.type !== "reasoning" || !last.isStreaming) return;
    flushPendingEventsSnapshot();
    eventsRef.current = [
      ...events.slice(0, -1),
      { type: "reasoning", text: last.text },
    ];
    const snapshot = [...eventsRef.current];
    updateLatestAssistantMessage((message) => ({
      ...message,
      events: snapshot,
    }));
  };
  const isStreamingPlaceholder = (e: AssistantEvent) =>
    (e.type === "tool_call_start" || e.type === "thinking") && !!e.isStreaming;
  const cancelStreamingEvents = (events: AssistantEvent[]) =>
    events
      .filter((event) => !isStreamingPlaceholder(event))
      .map((event) => {
        if (!("isStreaming" in event) || !event.isStreaming) return event;
        const rest = { ...event };
        delete (rest as { isStreaming?: boolean }).isStreaming;
        return rest as AssistantEvent;
      });
  const appendCancellationEvent = (events: AssistantEvent[]) => {
    const cancelledEvents = cancelStreamingEvents(events);
    return [
      ...cancelledEvents,
      { type: "content" as const, text: "Cancelled by user." },
    ];
  };
  const cancel = () => {
    if (abortControllerRef.current) {
      if (chatId) void stopChat(chatId).catch(() => undefined);
      abortControllerRef.current.abort();
      flushPendingEventsSnapshot();
      const snapshot = cancelStreamingEvents(eventsRef.current);
      eventsRef.current = snapshot;
      updateLatestAssistantMessage((message) => ({
        ...message,
        events: snapshot,
      }));
      setIsResponseLoading(false);
      setIsLoadingCitations(false);
    }
  };
  const clearStreamingPlaceholders = () => {
    const before = eventsRef.current;
    const after = before.filter((e) => !isStreamingPlaceholder(e));
    if (after.length === before.length) return;
    flushPendingEventsSnapshot();
    eventsRef.current = after;
    const snapshot = [...after];
    updateLatestAssistantMessage((message) => ({ ...message, events: snapshot }));
  };
  const resetStreamingNarrative = () => {
    flushPendingEventsSnapshot();
    const snapshot = eventsRef.current.filter(
      (event) =>
        event.type !== "content" &&
        event.type !== "reasoning" &&
        !isStreamingPlaceholder(event),
    );
    eventsRef.current = snapshot;
    updateLatestAssistantMessage((message) => ({
      ...message,
      content: "",
      events: snapshot,
    }));
  };
  const pushThinkingPlaceholder = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last && isStreamingPlaceholder(last)) return;
    flushPendingEventsSnapshot();
    eventsRef.current = [
      ...events,
      { type: "thinking" as const, isStreaming: true },
    ];
    const snapshot = [...eventsRef.current];
    updateLatestAssistantMessage((message) => ({ ...message, events: snapshot }));
  };
  const pushEvent = (event: AssistantEvent) => {
    flushPendingEventsSnapshot();
    finalizeStreamingReasoning();
    const next = eventsRef.current.filter((e) => !isStreamingPlaceholder(e));
    eventsRef.current = [...next, event];
    const snapshot = [...eventsRef.current];
    updateLatestAssistantMessage((message) => ({ ...message, events: snapshot }));
  };
  const updateMatchingEvent = (
    predicate: (e: AssistantEvent) => boolean,
    updater: (e: AssistantEvent) => AssistantEvent,
  ) => {
    const events = eventsRef.current;
    let idx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (predicate(events[i])) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return false;
    flushPendingEventsSnapshot();
    const newEvents = [...events];
    newEvents[idx] = updater(events[idx]);
    eventsRef.current = newEvents;
    const snapshot = [...newEvents];
    updateLatestAssistantMessage((message) => ({ ...message, events: snapshot }));
    return true;
  };
  const pollForCompletedAnonymousTurn = (
    targetChatId: string,
    baselineVersion: number,
  ) => {
    const generation = ++transcriptPollGenerationRef.current;
    void (async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (generation !== transcriptPollGenerationRef.current) return;
        try {
          const latest = await getChat(targetChatId);
          const latestVersion =
            latest.chat.transcript_version ?? baselineVersion;
          const last = latest.messages[latest.messages.length - 1];
          if (
            latestVersion > baselineVersion &&
            last?.role === "assistant"
          ) {
            transcriptVersionRef.current = latestVersion;
            setMessages(latest.messages);
            void loadChats();
            return;
          }
        } catch {
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    })();
  };
  const handleChat = async (
    message: Message,
    opts?: AssistantTurnOptions,
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;
    const turnOptions =
      isAnonymousMode && !opts?.askInputsResponse
        ? { ...opts, turnId: opts?.turnId ?? crypto.randomUUID() }
        : opts;
    transcriptPollGenerationRef.current += 1;
    setRejectedTurn(null);
    flushPendingEventsSnapshot();
    setIsResponseLoading(true);
    const lastMessage = messages[messages.length - 1];
    const isMessageAlreadyAdded =
      lastMessage &&
      lastMessage.role === "user" &&
      lastMessage.content === message.content;
    const apiMessagesForTurn: Message[] = isMessageAlreadyAdded
      ? messages
      : [...messages, message];
    const askInputsResponseEvent = turnOptions?.askInputsResponse ?? null;
    const optimisticResponseEvent = askInputsResponseEvent;
    const userInputThinkingEvent = optimisticResponseEvent
      ? ({
          type: "thinking" as const,
          isStreaming: true,
        } satisfies AssistantEvent)
      : null;
    const displayMessages: Message[] = optimisticResponseEvent
      ? (() => {
          const updated = messages.map((item) => ({
            ...item,
            events: item.events ? [...item.events] : item.events,
          }));
          for (let i = updated.length - 1; i >= 0; i--) {
            const current = updated[i];
            if (current.role !== "assistant") continue;
            updated[i] = {
              ...current,
              events: [
                ...(current.events ?? []),
                optimisticResponseEvent,
                ...(userInputThinkingEvent ? [userInputThinkingEvent] : []),
              ],
            };
            return updated;
          }
          return updated;
        })()
      : apiMessagesForTurn;
    setMessages(
      optimisticResponseEvent
        ? displayMessages
        : [
            ...displayMessages,
            { role: "assistant", content: "", citations: [], events: [] },
          ],
    );
    let streamedChatId: string | null = null;
    eventsRef.current = optimisticResponseEvent
      ? ([...displayMessages]
          .reverse()
          .find((item) => item.role === "assistant")?.events ?? [])
      : [];
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const apiMessages = apiMessagesForTurn.map((currentMessage) => ({
        role: currentMessage.role,
        content: currentMessage.content,
        files: currentMessage.files,
        workflow: currentMessage.workflow,
      }));
      const model = message.model ?? readSelectedModel();
      const reasoningEffort =
        message.reasoningEffort ?? readSelectedReasoningEffort();
      const displayedDoc = turnOptions?.displayedDoc ?? null;
      const attachedDocs = (
        message.files?.filter((f) => !!f.document_id) ?? []
      ).map((f) => ({
        filename: f.filename,
        document_id: f.document_id as string,
      }));
      const currentTurn = turnOptions?.askInputsResponse
        ? {
            kind: "ask_inputs_response" as const,
            content: message.content,
            files: message.files,
            responses: turnOptions.askInputsResponse.responses,
          }
        : {
            kind: "message" as const,
            turn_id: turnOptions?.turnId,
            content: message.content,
            files: message.files,
            workflow: message.workflow,
          };
      const response = await streamChat({
        ...(isAnonymousMode
          ? {
              current_turn: currentTurn,
              expected_version: transcriptVersionRef.current,
            }
          : { messages: apiMessages }),
        chat_id: chatId,
        project_id: projectId,
        model,
        reasoning_effort: reasoningEffort,
        displayed_doc: displayedDoc
          ? {
              filename: displayedDoc.filename,
              document_id: displayedDoc.documentId,
            }
          : undefined,
        attached_documents:
          attachedDocs.length > 0 ? attachedDocs : undefined,
        ask_inputs_response: isAnonymousMode
          ? undefined
          : turnOptions?.askInputsResponse,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (isAnonymousMode && response.status === 409 && chatId) {
          const conflict = (await response.json().catch(() => ({}))) as {
            code?: unknown;
            current_version?: unknown;
            detail?: unknown;
          };
          const retryBlocked =
            conflict.code === "chat_retry_blocked_after_mutation";
          const turnAlreadyCompleted =
            conflict.code === "chat_turn_already_completed";
          if (!retryBlocked && !turnAlreadyCompleted) {
            setRejectedTurn({
              message: { ...message },
              options: turnOptions,
            });
          }
          const latest = await getChat(chatId);
          const currentVersion = Number.isSafeInteger(
            conflict.current_version,
          )
            ? (conflict.current_version as number)
            : (latest.chat.transcript_version ??
              transcriptVersionRef.current);
          transcriptVersionRef.current =
            latest.chat.transcript_version ?? currentVersion;
          const reloaded = [...latest.messages];
          if (turnAlreadyCompleted) {
            setRejectedTurn(null);
            setMessages(reloaded);
            setIsResponseLoading(false);
            setIsLoadingCitations(false);
            await loadChats();
            return null;
          }
          const last = reloaded[reloaded.length - 1];
          const conflictMessage =
            retryBlocked
              ? typeof conflict.detail === "string"
                ? conflict.detail
                : "The prior response changed local data before it stopped. Review that result before continuing."
              : conflict.code === "chat_turn_in_progress"
              ? "Another response is still running. Your draft has been restored and this chat will refresh when that response finishes."
              : "This conversation changed in another window. Review the latest messages; your draft has been restored.";
          if (last?.role === "assistant") {
            reloaded[reloaded.length - 1] = {
              ...last,
              error: conflictMessage,
            };
          } else {
            reloaded.push({
              role: "assistant",
              content: "",
              error: conflictMessage,
            });
          }
          setMessages(reloaded);
          if (conflict.code === "chat_turn_in_progress") {
            pollForCompletedAnonymousTurn(chatId, currentVersion);
          }
          setIsResponseLoading(false);
          setIsLoadingCitations(false);
          return null;
        }
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }
      if (!response.body) throw new Error("No response body");
      let sawDone = false;
      let sawFinalTranscriptVersion = !isAnonymousMode;
      for await (const dataStr of readSseData(response.body)) {
        if (dataStr === "[DONE]") {
          sawDone = true;
          continue;
        }
        try {
          const data = JSON.parse(dataStr);
            if (data.type === "chat_id") {
              streamedChatId = data.chatId;
              setChatId(data.chatId);
              if (Number.isSafeInteger(data.transcriptVersion)) {
                transcriptVersionRef.current = data.transcriptVersion;
              }
              continue;
            }
            if (
              data.type === "transcript_version" &&
              Number.isSafeInteger(data.transcriptVersion)
            ) {
              transcriptVersionRef.current = data.transcriptVersion;
              sawFinalTranscriptVersion = true;
              continue;
            }
            if (data.type === "content_done") {
              setIsLoadingCitations(true);
              continue;
            }
            if (data.type === "error") {
              const streamErrorMessage = readableStreamError(data.message);
              if (
                data.retryable !== false &&
                streamErrorMessage !== "Cancelled by user."
              ) {
                setRejectedTurn({
                  message: { ...message },
                  options: turnOptions,
                });
              }
              clearStreamingPlaceholders();
              finalizeStreamingContent();
              finalizeStreamingReasoning();
              eventsRef.current = [
                ...eventsRef.current,
                { type: "error", message: streamErrorMessage },
              ];
              const snapshot = [...eventsRef.current];
              updateLatestAssistantMessage((assistantMessage) => ({
                ...assistantMessage,
                events: snapshot,
                error: streamErrorMessage,
              }));
              setIsResponseLoading(false);
              setIsLoadingCitations(false);
              continue;
            }
            if (data.type === "content_final") {
              flushPendingEventsSnapshot();
              const text = typeof data.text === "string" ? data.text : "";
              const current = eventsRef.current.filter(
                (event) => !isStreamingPlaceholder(event),
              );
              const firstContent = current.findIndex(
                (event) => event.type === "content",
              );
              const next: AssistantEvent[] = current.filter(
                (event) => event.type !== "content",
              );
              if (text) {
                next.splice(
                  firstContent < 0
                    ? next.length
                    : Math.min(firstContent, next.length),
                  0,
                  { type: "content", text },
                );
              }
              eventsRef.current = next;
              updateLatestAssistantMessage((message) => ({
                ...message,
                content: text,
                events: next,
              }));
              continue;
            }
            if (data.type === "content_reset") {
              resetStreamingNarrative();
              continue;
            }
            const reduction = reduceAssistantStreamEvent(eventsRef.current, data);
            if (reduction) {
              eventsRef.current = reduction.events;
              if (reduction.deferPaint) {
                scheduleEventsSnapshot();
              } else {
                flushPendingEventsSnapshot();
                const snapshot = [...reduction.events];
                updateLatestAssistantMessage((message) => ({
                  ...message,
                  events: snapshot,
                }));
              }
              continue;
            }
            if (data.type === "tool_call_start") {
              pushEvent({
                type: "tool_call_start",
                name: (data.name as string) ?? "",
                isStreaming: true,
              });
              continue;
            }
            if (data.type === "automation_run") {
              const event = parseAutomationRunEvent(data);
              if (event) pushEvent(event);
              continue;
            }
            if (data.type === "workflow_applied") {
              pushEvent({
                type: "workflow_applied",
                workflow_id: data.workflow_id as string,
                title: data.title as string,
              });
              continue;
            }
            if (data.type === "mcp_tool_start") {
              pushEvent({
                type: "mcp_tool_call",
                connector_id: "",
                connector_name: "",
                tool_name: (data.name as string) ?? "",
                openai_tool_name: (data.name as string) ?? "",
                status: "ok",
                isStreaming: true,
              });
              continue;
            }
            if (data.type === "mcp_tool_result") {
              const openaiToolName = (data.name as string) ?? "";
              updateMatchingEvent(
                (e) =>
                  e.type === "mcp_tool_call" &&
                  e.openai_tool_name === openaiToolName &&
                  !!e.isStreaming,
                () => ({
                  type: "mcp_tool_call",
                  connector_id: "",
                  connector_name:
                    typeof data.connector_name === "string"
                      ? (data.connector_name as string)
                      : "",
                  tool_name:
                    typeof data.tool_name === "string"
                      ? (data.tool_name as string)
                      : openaiToolName,
                  openai_tool_name: openaiToolName,
                  status: data.status === "error" ? "error" : "ok",
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }
            if (data.type === "ask_inputs") {
              const rawItems = Array.isArray(data.items)
                ? (data.items as unknown[])
                : [];
              const items = rawItems.reduce<Extract<
                AssistantEvent,
                { type: "ask_inputs" }
              >["items"]>((acc, item, index) => {
                if (!item || typeof item !== "object") return acc;
                const row = item as Record<string, unknown>;
                const id =
                  typeof row.id === "string" && row.id.trim()
                    ? row.id.trim()
                    : `input-${index + 1}`;
                if (row.kind === "choice") {
                  const options = Array.isArray(row.options)
                    ? (row.options as unknown[]).flatMap((option) => {
                        if (!option || typeof option !== "object") return [];
                        const optionRow = option as Record<string, unknown>;
                        const value =
                          typeof optionRow.value === "string"
                            ? optionRow.value
                            : typeof optionRow.label === "string"
                              ? optionRow.label
                              : "";
                        if (!value.trim()) return [];
                        return [
                          {
                            value,
                          },
                        ];
                      })
                    : [];
                  acc.push({
                      id,
                      kind: "choice" as const,
                      question:
                        typeof row.question === "string"
                          ? row.question
                          : "Please choose an option.",
                      options,
                      allow_other: row.allow_other !== false,
                      other_label:
                        typeof row.other_label === "string"
                          ? row.other_label
                          : "Other",
                      response_prefix:
                        typeof row.response_prefix === "string"
                          ? row.response_prefix
                          : undefined,
                  });
                  return acc;
                }
                if (row.kind === "documents") {
                  const documentTypes = Array.isArray(row.document_types)
                    ? (row.document_types as unknown[])
                        .filter((type): type is string => typeof type === "string")
                        .map((type) => type.trim())
                        .filter(Boolean)
                    : [];
                  acc.push({
                      id,
                      kind: "documents" as const,
                      document_types: documentTypes,
                      response_prefix:
                        typeof row.response_prefix === "string"
                          ? row.response_prefix
                          : undefined,
                  });
                  return acc;
                }
                return acc;
              }, []);
              if (items.length > 0) {
                pushEvent({ type: "ask_inputs", items });
              }
              continue;
            }
            if (data.type === "doc_find_start") {
              pushEvent({
                type: "doc_find",
                filename: data.filename as string,
                query: (data.query as string) ?? "",
                total_matches: 0,
                isStreaming: true,
              });
              continue;
            }
            if (data.type === "doc_find") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_find" &&
                  e.filename === data.filename &&
                  e.query === (data.query as string) &&
                  !!e.isStreaming,
                (e) => ({
                  ...e,
                  isStreaming: false,
                  total_matches:
                    typeof data.total_matches === "number"
                      ? (data.total_matches as number)
                      : (
                          e as {
                            type: "doc_find";
                            total_matches: number;
                          }
                        ).total_matches,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }
            if (data.type === "doc_created_start") {
              pushEvent({
                type: "doc_created",
                filename: data.filename as string,
                download_url: "",
                isStreaming: true,
              });
              continue;
            }
            if (data.type === "doc_download") {
              pushEvent({
                type: "doc_download",
                filename: data.filename as string,
                download_url: data.download_url as string,
              });
              continue;
            }
            if (data.type === "doc_created") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_created" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                (e) => {
                  const next: Extract<AssistantEvent, { type: "doc_created" }> =
                    {
                      type: "doc_created",
                      filename: (e as { filename: string }).filename,
                      download_url: data.download_url as string,
                      isStreaming: false,
                    };
                  if (typeof data.document_id === "string") {
                    next.document_id = data.document_id as string;
                  }
                  if (typeof data.version_id === "string") {
                    next.version_id = data.version_id as string;
                  }
                  if (typeof data.version_number === "number") {
                    next.version_number = data.version_number as number;
                  }
                  return next;
                },
              );
              pushThinkingPlaceholder();
              continue;
            }
            if (data.type === "doc_edited_start") {
              pushEvent({
                type: "doc_edited",
                filename: data.filename as string,
                document_id: "",
                version_id: "",
                download_url: "",
                annotations: [],
                isStreaming: true,
              });
              continue;
            }
            if (data.type === "doc_edited") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_edited" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                () => ({
                  type: "doc_edited",
                  filename: data.filename as string,
                  document_id: (data.document_id as string) ?? "",
                  version_id: (data.version_id as string) ?? "",
                  version_number:
                    typeof data.version_number === "number"
                      ? (data.version_number as number)
                      : null,
                  download_url: (data.download_url as string) ?? "",
                  annotations: Array.isArray(data.annotations)
                    ? (data.annotations as import("@/app/components/shared/types").EditAnnotation[])
                    : [],
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }
            if (data.type === "citations") {
              const status =
                data.status === "started" ||
                data.status === "partial" ||
                data.status === "final"
                  ? data.status
                  : "final";
              const incoming = (data.citations ??
                []) as Citation[];
              if (status === "started" || status === "partial") {
                flushPendingEventsSnapshot();
                updateLatestAssistantMessage((message) => ({
                  ...message,
                  citations: incoming,
                  citationStatus: status,
                }));
                continue;
              }
              finalizeStreamingContent();
              clearStreamingPlaceholders();
              updateLatestAssistantMessage((message) => ({
                ...message,
                citations: incoming,
                citationStatus: incoming.length ? "final" : undefined,
              }));
              continue;
            }
        } catch (e) {
          console.warn(
            "[useAssistantChat] failed to parse SSE data:",
            dataStr,
            e,
          );
        }
      }
      if (!sawDone || !sawFinalTranscriptVersion) {
        throw new Error("Chat stream ended before completion.");
      }
      flushPendingEventsSnapshot();
      finalizeStreamingReasoning();
      setIsResponseLoading(false);
      setIsLoadingCitations(false);
      const finalChatId = streamedChatId || chatId || null;
      if (finalChatId && finalChatId !== chatId) {
        if (chatId) {
          replaceChatId(
            chatId,
            finalChatId,
            message.content.trim().slice(0, 120) || "New Chat",
          );
        }
        const chatBasePath = projectId
          ? `/projects/${projectId}/assistant/chat`
          : `/assistant/chat`;
        router.replace(`${chatBasePath}/${finalChatId}`);
      }
      await loadChats();
      const finalChatIdForTitle = streamedChatId || chatId || null;
      if (finalChatIdForTitle && apiMessagesForTurn.length === 1) {
        const titleParts = [message.content];
        if (message.workflow)
          titleParts.push(`Workflow: ${message.workflow.title}`);
        if (message.files?.length)
          titleParts.push(
            `Files: ${message.files.map((f) => f.filename).join(", ")}`,
          );
        void generateTitle(finalChatIdForTitle, titleParts.join("\n"));
      }
      return streamedChatId || null;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        finalizeStreamingContent();
        finalizeStreamingReasoning();
        const cancelledEvents = appendCancellationEvent(eventsRef.current);
        eventsRef.current = cancelledEvents;
        setMessages((prev) => {
          const assistantIndex = [...prev]
            .map((message, index) => ({ message, index }))
            .reverse()
            .find(({ message }) => message.role === "assistant")?.index;
          if (assistantIndex !== undefined) {
            const assistantMessage = prev[assistantIndex];
            const updated = [...prev];
            updated[assistantIndex] = {
              ...assistantMessage,
              events: cancelledEvents,
            };
            return updated;
          }
          eventsRef.current = [{ type: "content", text: "Cancelled by user." }];
          return [
            ...prev,
            {
              role: "assistant",
              content: "",
              events: [{ type: "content", text: "Cancelled by user." }],
            },
          ];
        });
        const interruptedChatId = streamedChatId || chatId;
        if (isAnonymousMode && interruptedChatId) {
          pollForCompletedAnonymousTurn(
            interruptedChatId,
            transcriptVersionRef.current,
          );
        }
      } else {
        setRejectedTurn({ message: { ...message }, options: turnOptions });
        finalizeStreamingContent();
        const errorMessage =
          error instanceof Error && error.message
            ? error.message
            : "Sorry, something went wrong.";
        setMessages((prev) => {
          const assistantIndex = [...prev]
            .map((message, index) => ({ message, index }))
            .reverse()
            .find(({ message }) => message.role === "assistant")?.index;
          if (assistantIndex !== undefined) {
            const updated = [...prev];
            updated[assistantIndex] = {
              ...updated[assistantIndex],
              error: errorMessage,
            };
            return updated;
          }
          return [
            ...prev,
            {
              role: "assistant",
              content: "",
              error: errorMessage,
            },
          ];
        });
      }
      setIsResponseLoading(false);
      setIsLoadingCitations(false);
      return null;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };
  const retryRejectedTurn = async () => {
    const pending = rejectedTurn;
    if (!pending) return null;
    setRejectedTurn(null);
    return handleChat(pending.message, pending.options);
  };
  const handleNewChat = async (
    message: Message,
    projectId?: string,
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;
    transcriptPollGenerationRef.current += 1;
    setRejectedTurn(null);
    setMessages([message]);
    const newChatId = await saveChat(projectId);
    if (newChatId) {
      stagePendingChatMessage(newChatId, message);
      transcriptVersionRef.current = 0;
      setChatId(newChatId);
    }
    return newChatId;
  };
  return {
    messages,
    isResponseLoading,
    setIsResponseLoading,
    isLoadingCitations,
    handleChat,
    handleNewChat,
    setMessages,
    rejectedTurn,
    clearRejectedTurn,
    retryRejectedTurn,
    setTranscriptVersion: (version: number) => {
      if (Number.isSafeInteger(version) && version >= 0) {
        transcriptVersionRef.current = version;
      }
    },
    cancel,
    chatId,
  };
}
