"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getChat,
  streamChat,
  streamProjectChat,
} from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useGenerateChatTitle } from "./useGenerateChatTitle";
import type {
  AssistantEvent,
  Citation,
  Message,
} from "@/app/components/shared/types";
import {
  parseCourtlistenerCaseSearches,
  parseCourtlistenerEventCases,
} from "@/app/lib/assistantEvents";

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

export function useAssistantChat({
  initialMessages = [],
  chatId: initialChatId,
  projectId,
}: UseAssistantChatOptions = {}) {
  const router = useRouter();
  const {
    replaceChatId,
    loadChats,
    setCurrentChatId,
    saveChat,
    setNewChatMessages,
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

  // Streaming deltas can arrive faster than the browser can paint. Keep the
  // event ref authoritative, but publish at most once per short frame so the
  // whole chat tree is not reconciled for every token-sized SSE chunk.
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

  /**
   * Finalize any in-flight streaming content event so the next
   * content_delta starts a fresh block. Called
   * before any non-content event is appended, so interleaved content /
   * reasoning / tool events stay in chronological order — without the
   * later content block inheriting the earlier block's accumulated text.
   */
  const finalizeStreamingContent = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last?.type === "content" && last.isStreaming) {
      flushPendingEventsSnapshot();
      eventsRef.current = [
        ...events.slice(0, -1),
        { type: "content", text: last.text },
      ];
      const snapshot = [...eventsRef.current];
      updateLatestAssistantMessage((message) => ({
        ...message,
        events: snapshot,
      }));
    }
  };

  // If the model transitions from reasoning into content/tool without a
  // reasoning_block_end (or the events arrive out of order), the prior
  // reasoning event would otherwise stay flagged isStreaming forever.
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

  // Transient placeholder events (tool_call_start, thinking) fill the
  // latency gap between real SSE events so the wrapper doesn't look stuck.
  // Anytime a real event arrives, drop any streaming placeholder first.
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
      abortControllerRef.current.abort();
      flushPendingEventsSnapshot();
      const snapshot = cancelStreamingEvents(eventsRef.current);
      eventsRef.current = snapshot;
      updateLatestAssistantMessage((message) => ({
        ...message,
        events: cancelStreamingEvents(message.events ?? snapshot),
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
    // Don't stack placeholders back-to-back; one "Thinking…" line is plenty.
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
    finalizeStreamingContent();
    finalizeStreamingReasoning();
    // A real event, or a more specific placeholder such as
    // tool_call_start, should replace any generic "Thinking..." line.
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
          // The next bounded poll may recover a transient local read.
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

      const model = message.model;

      const displayedDoc = turnOptions?.displayedDoc ?? null;

      // Pull the user's attachments from the just-submitted message.
      // These are the files dragged into / picked from the chat input
      // for this turn (separate from the running history of past
      // attachments). Sent as a request-level field so the backend
      // can call them out specifically in the system prompt.
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

      const response = await (projectId
        ? streamProjectChat({
            projectId,
            ...(isAnonymousMode
              ? {
                  current_turn: currentTurn,
                  expected_version: transcriptVersionRef.current,
                }
              : { messages: apiMessages }),
            chat_id: chatId,
            model,
            reasoning_effort: message.reasoningEffort,
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
          })
        : streamChat({
            ...(isAnonymousMode
              ? {
                  current_turn: currentTurn,
                  expected_version: transcriptVersionRef.current,
                }
              : { messages: apiMessages }),
            chat_id: chatId,
            model,
            reasoning_effort: message.reasoningEffort,
            ask_inputs_response: isAnonymousMode
              ? undefined
              : turnOptions?.askInputsResponse,
            signal: controller.signal,
          }));

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

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      let sawFinalTranscriptVersion = !isAnonymousMode;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any bytes still held by TextDecoder. A response is allowed
          // to close without a final newline, so the remaining buffer must be
          // parsed as the last SSE record instead of being discarded.
          buffer += decoder.decode();
        } else {
          buffer += decoder.decode(value, { stream: true });
        }
        const lines = buffer.split("\n");
        buffer = done ? "" : lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") {
            sawDone = true;
            continue;
          }

          try {
            const data = JSON.parse(dataStr);

            if (data.type === "chat_id") {
              streamedChatId = data.chatId;
              setChatId(data.chatId);
              setCurrentChatId(data.chatId);
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

            if (data.type === "content_delta") {
              const text = data.text as string;

              // Real content is streaming — retire any
              // "Thinking…" / "Running…" placeholders, and
              // finalize any in-flight reasoning block so it
              // doesn't get stuck rendering as streaming.
              clearStreamingPlaceholders();
              finalizeStreamingReasoning();

              // Ensure a streaming content event exists. If
              // the last event isn't already a streaming
              // content block, start a fresh one so interleaved
              // tool/reasoning events split content naturally.
              const events = eventsRef.current;
              const lastEvent = events[events.length - 1];
              if (lastEvent?.type !== "content" || !lastEvent.isStreaming) {
                eventsRef.current = [
                  ...events,
                  {
                    type: "content" as const,
                    text,
                    isStreaming: true,
                  },
                ];
                scheduleEventsSnapshot();
              } else {
                const nextEvents = [...events];
                nextEvents[nextEvents.length - 1] = {
                  type: "content" as const,
                  text: `${lastEvent.text}${text}`,
                  isStreaming: true,
                };
                eventsRef.current = nextEvents;
                scheduleEventsSnapshot();
              }
              continue;
            }

            if (data.type === "content_reset") {
              resetStreamingNarrative();
              continue;
            }

            if (data.type === "reasoning_delta") {
              const text = data.text as string;
              let events = eventsRef.current;
              const last = events[events.length - 1];
              if (last?.type === "reasoning" && last.isStreaming) {
                eventsRef.current = [
                  ...events.slice(0, -1),
                  {
                    type: "reasoning" as const,
                    text: last.text + text,
                    isStreaming: true,
                  },
                ];
              } else {
                // New reasoning block — finalize any in-flight
                // content event first so the next content_delta
                // starts a fresh block at the correct position.
                finalizeStreamingContent();
                clearStreamingPlaceholders();
                events = eventsRef.current;
                eventsRef.current = [
                  ...events,
                  {
                    type: "reasoning" as const,
                    text,
                    isStreaming: true,
                  },
                ];
              }
              scheduleEventsSnapshot();
              continue;
            }

            if (data.type === "reasoning_block_end") {
              const events = eventsRef.current;
              const last = events[events.length - 1];
              if (last?.type === "reasoning" && last.isStreaming) {
                eventsRef.current = [
                  ...events.slice(0, -1),
                  {
                    type: "reasoning" as const,
                    text: last.text,
                  },
                ];
              }
              flushPendingEventsSnapshot();
              const snapshot = [...eventsRef.current];
              updateLatestAssistantMessage((message) => ({
                ...message,
                events: snapshot,
              }));
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "tool_call_start") {
              // Transient placeholder so the client immediately
              // shows activity after Claude ends a turn with
              // tool_use. Replaced by the real tool event
              // (doc_edited_start, doc_read_start, …) if one
              // arrives; otherwise it lingers as a "Working…"
              // indicator until the next iteration streams.
              pushEvent({
                type: "tool_call_start",
                name: (data.name as string) ?? "",
                isStreaming: true,
              });
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

            if (data.type === "case_citation") {
              pushEvent({
                type: "case_citation",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                case_name:
                  typeof data.case_name === "string"
                    ? (data.case_name as string)
                    : null,
                citation:
                  typeof data.citation === "string"
                    ? (data.citation as string)
                    : null,
                url: data.url as string,
                pdfUrl:
                  typeof data.pdfUrl === "string" ? (data.pdfUrl as string) : null,
                dateFiled:
                  typeof data.dateFiled === "string"
                    ? (data.dateFiled as string)
                    : null,
              });
              continue;
            }

            if (data.type === "case_opinions") {
              pushEvent({
                type: "case_opinions",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : 0,
                case: data.case as Extract<
                  AssistantEvent,
                  { type: "case_opinions" }
                >["case"],
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

            if (data.type === "courtlistener_search_case_law_start") {
              pushEvent({
                type: "courtlistener_search_case_law",
                query: (data.query as string) ?? "",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_search_case_law") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_search_case_law" &&
                  e.query === (data.query as string) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_search_case_law",
                  query: (data.query as string) ?? "",
                  result_count:
                    typeof data.result_count === "number"
                      ? (data.result_count as number)
                      : 0,
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

            if (data.type === "courtlistener_get_cases_start") {
              pushEvent({
                type: "courtlistener_get_cases",
                cluster_ids: Array.isArray(data.cluster_ids)
                  ? (data.cluster_ids as unknown[]).filter(
                      (value: unknown): value is number =>
                        typeof value === "number",
                    )
                  : [],
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_get_cases") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_get_cases" &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_get_cases",
                  cluster_ids: Array.isArray(data.cluster_ids)
                    ? (data.cluster_ids as unknown[]).filter(
                        (value: unknown): value is number =>
                          typeof value === "number",
                      )
                    : [],
                  case_count:
                    typeof data.case_count === "number"
                      ? (data.case_count as number)
                      : 0,
                  opinion_count:
                    typeof data.opinion_count === "number"
                      ? (data.opinion_count as number)
                      : 0,
                  cases: parseCourtlistenerEventCases(data.cases),
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

            if (data.type === "courtlistener_find_in_case_start") {
              const searches = parseCourtlistenerCaseSearches(data.searches);
              pushEvent({
                type: "courtlistener_find_in_case",
                cluster_id: searches?.length
                  ? null
                  : typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                query: searches?.length ? "" : ((data.query as string) ?? ""),
                searches,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_find_in_case") {
              const searches = parseCourtlistenerCaseSearches(data.searches);
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_find_in_case" &&
                  (searches?.length
                    ? Array.isArray(e.searches)
                    : e.cluster_id ===
                        (typeof data.cluster_id === "number"
                          ? (data.cluster_id as number)
                          : null) && e.query === (data.query as string)) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_find_in_case",
                  cluster_id: searches?.length
                    ? null
                    : typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null,
                  query: searches?.length ? "" : ((data.query as string) ?? ""),
                  total_matches:
                    typeof data.total_matches === "number"
                      ? (data.total_matches as number)
                      : 0,
                  searches,
                  case_name:
                    typeof data.case_name === "string"
                      ? (data.case_name as string)
                      : null,
                  citation:
                    typeof data.citation === "string"
                      ? (data.citation as string)
                      : null,
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

            if (data.type === "courtlistener_read_case_start") {
              pushEvent({
                type: "courtlistener_read_case",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_read_case") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_read_case" &&
                  e.cluster_id ===
                    (typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_read_case",
                  cluster_id:
                    typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null,
                  case_name:
                    typeof data.case_name === "string"
                      ? (data.case_name as string)
                      : null,
                  citation:
                    typeof data.citation === "string"
                      ? (data.citation as string)
                      : null,
                  opinion_count:
                    typeof data.opinion_count === "number"
                      ? (data.opinion_count as number)
                      : 0,
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

            if (data.type === "courtlistener_verify_citations_start") {
              pushEvent({
                type: "courtlistener_verify_citations",
                citation_count:
                  typeof data.citation_count === "number"
                    ? (data.citation_count as number)
                    : 0,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_verify_citations") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_verify_citations" &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_verify_citations",
                  citation_count:
                    typeof data.citation_count === "number"
                      ? (data.citation_count as number)
                      : 0,
                  match_count:
                    typeof data.match_count === "number"
                      ? (data.match_count as number)
                      : 0,
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

            if (data.type === "doc_read_start") {
              pushEvent({
                type: "doc_read",
                filename: data.filename as string,
                isStreaming: true,
              });
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

            if (data.type === "doc_read") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_read" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                (e) => ({ ...e, isStreaming: false }),
              );
              pushThinkingPlaceholder();
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
              // End-of-stream signal — scrub any lingering
              // placeholders so they don't persist into the
              // finalised message. First finalize content so adding
              // citations cannot re-render the markdown/citation view
              // against a streaming block.
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
              "[useAssistantChat] failed to parse SSE line:",
              trimmed,
              e,
            );
          }
        }

        if (done) break;
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
        setCurrentChatId(finalChatId);
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
        eventsRef.current = appendCancellationEvent(eventsRef.current);
        setMessages((prev) => {
          const assistantIndex = [...prev]
            .map((message, index) => ({ message, index }))
            .reverse()
            .find(({ message }) => message.role === "assistant")?.index;
          if (assistantIndex !== undefined) {
            const assistantMessage = prev[assistantIndex];
            const events = appendCancellationEvent(
              assistantMessage.events ?? eventsRef.current,
            );
            eventsRef.current = events;
            const updated = [...prev];
            updated[assistantIndex] = {
              ...assistantMessage,
              events,
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
    setNewChatMessages([message]);

    const newChatId = await saveChat(projectId);
    if (newChatId) {
      transcriptVersionRef.current = 0;
      setChatId(newChatId);
      setCurrentChatId(newChatId);
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
