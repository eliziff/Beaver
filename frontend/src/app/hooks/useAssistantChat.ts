import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  compactChat,
  generateChatTitle,
  getChat,
  steerChat,
  stopChat,
  streamChat,
} from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import type {
  AssistantEvent,
  Citation,
  Message,
} from "@/app/components/shared/types";
import { readSseData } from "@/app/lib/sse";
import {
  finishAssistantStreamEvents,
  interruptAssistantStreamEvents,
  isStreamingPlaceholder,
  reduceAssistantStreamEvent,
} from "@/app/lib/assistantStreamEvents";
import {
  readSelectedModel,
  readSelectedReasoningEffort,
} from "./useSelectedModel";
import { jurisdictionPreferenceForChat } from "@/app/components/assistant/jurisdictionPreferences";
import { readReadSubagentPreference } from "@/app/components/assistant/readSubagentPreferences";
import { readActivityDetail } from "@/app/components/assistant/activityDisplayPreference";
interface UseAssistantChatOptions {
  initialMessages?: Message[];
  chatId?: string;
  projectId?: string;
  tabularReviewId?: string;
  onChatIdChange?: (chatId: string) => void;
  onTitleChange?: (chatId: string, title: string) => void;
}
type AssistantTurnOptions = {
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
  detail?: string;
  retryable?: boolean;
};
const CHAT_COMMAND_HELP = [
  "**Commands**",
  "",
  "- `/compact` — Compact this chat's context.",
  "- `/help` — Show available commands.",
].join("\n");
function interruptedTurn(messages: Message[]): RejectedAssistantTurn | null {
  const assistantIndex = messages.length - 1;
  const assistant = messages[assistantIndex];
  if (!assistant?.turnId || assistant.turnStatus !== "interrupted") return null;
  if (assistant.role === "user") {
    return { message: assistant, options: { turnId: assistant.turnId } };
  }
  const user = messages
    .slice(0, assistantIndex)
    .findLast(
      (message) => message.role === "user" && message.turnId === assistant.turnId,
    );
  return user
    ? { message: user, options: { turnId: assistant.turnId } }
    : null;
}
function readableStreamError(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "Unable to get a response. Try again.";
  }
  const message = value.trim();
  if (
    /^(?:failed to fetch|fetch failed|network request failed|networkerror(?: when attempting to fetch resource\.?)?)$/iu.test(
      message,
    )
  ) {
    return "Unable to get a response. Check the local service or provider connection, then try again.";
  }
  return message;
}
export function useAssistantChat({
  initialMessages = [],
  chatId: initialChatId,
  projectId,
  tabularReviewId,
  onChatIdChange,
  onTitleChange,
}: UseAssistantChatOptions = {}) {
  const router = useRouter();
  const {
    claimPendingChatMessage,
    peekPendingChatMessage,
    replaceChatId,
    setChatTurnInProgress,
    loadChats,
    renameChat,
    saveChat,
    stagePendingChatMessage,
  } = useChatHistoryContext();
  const pendingMessageRef = useRef<Message | null>(null);
  const [messages, setMessages] = useState<Message[]>(() => {
    const pendingMessage =
      initialMessages.length === 0 && initialChatId
        ? peekPendingChatMessage?.(initialChatId) ?? null
        : null;
    pendingMessageRef.current = pendingMessage;
    return initialMessages.length
      ? initialMessages
      : pendingMessage
        ? [pendingMessage]
        : [];
  });
  const [isResponseLoading, setIsResponseLoading] = useState(false);
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);
  const [rejectedTurn, setRejectedTurn] =
    useState<RejectedAssistantTurn | null>(null);
  const transcriptVersionRef = useRef(0);
  const transcriptPollGenerationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const clearRejectedTurn = () => setRejectedTurn(null);
  const eventsRef = useRef<AssistantEvent[]>([]);
  const pendingEventsSnapshotRef = useRef<AssistantEvent[] | null>(null);
  const pendingEventsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const updateLatestAssistantMessage = (
    updater: (message: Message) => Message,
    fallback?: Message,
  ) => {
    setMessages((prev) => {
      const assistantIndex = prev.findLastIndex(
        (message) => message.role === "assistant",
      );
      if (assistantIndex < 0) return fallback ? [...prev, fallback] : prev;
      const updated = prev.slice();
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
    pendingEventsTimerRef.current = setTimeout(flushPendingEventsSnapshot, 16);
  };
  useEffect(
    () => () => {
      transcriptPollGenerationRef.current += 1;
      if (pendingEventsTimerRef.current !== null) {
        clearTimeout(pendingEventsTimerRef.current);
      }
    },
    [],
  );
  const publishEvents = (
    events: AssistantEvent[],
    patch?: Partial<Message>,
  ) => {
    flushPendingEventsSnapshot();
    eventsRef.current = events;
    updateLatestAssistantMessage((message) => ({
      ...message,
      ...patch,
      events,
    }));
  };
  const cancel = () => {
    if (abortControllerRef.current || isResponseLoading) {
      if (chatId) void stopChat(chatId).catch(() => undefined);
      transcriptPollGenerationRef.current += 1;
      abortControllerRef.current?.abort();
      publishEvents(interruptAssistantStreamEvents(eventsRef.current, "cancelled"), {
        error: undefined,
        turnStatus: "cancelled",
      });
      setIsResponseLoading(false);
    }
  };
  const resetStreamingNarrative = () => {
    const snapshot = eventsRef.current.filter(
      (event) =>
        event.type !== "content" &&
        event.type !== "reasoning" &&
        !isStreamingPlaceholder(event),
    );
    publishEvents(snapshot, { content: "" });
  };
  const pollForCompletedTurn = (
    targetChatId: string,
    baselineVersion: number,
  ) => {
    const generation = ++transcriptPollGenerationRef.current;
    void (async () => {
      let seenVersion = baselineVersion;
      while (generation === transcriptPollGenerationRef.current) {
        if (generation !== transcriptPollGenerationRef.current) return;
        try {
          const latest = await getChat(targetChatId);
          const latestVersion =
            latest.chat.transcript_version ?? baselineVersion;
          if (latestVersion > seenVersion) {
            seenVersion = latestVersion;
            transcriptVersionRef.current = latestVersion;
            setMessages(latest.messages);
          }
          if (latest.chat.turn_in_progress === false) {
            transcriptVersionRef.current = latestVersion;
            setMessages(latest.messages);
            setRejectedTurn((current) => interruptedTurn(latest.messages) ?? current);
            setIsResponseLoading(false);
            setChatTurnInProgress?.(targetChatId, false);
            if (!tabularReviewId) void loadChats();
            return;
          }
        } catch {
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    })();
  };
  const resumeRunningTurn = (
    targetChatId: string,
    baselineVersion: number,
  ) => {
    setIsResponseLoading(true);
    setMessages((current) => {
      if (current.at(-1)?.role === "assistant") return current;
      return [
        ...current,
        {
          role: "assistant",
          content: "",
          events: [{ type: "thinking", isStreaming: true }],
        },
      ];
    });
    pollForCompletedTurn(targetChatId, baselineVersion);
  };
  const handleChat = async (
    message: Message,
    opts?: AssistantTurnOptions,
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;
    const command = message.content.trim().toLowerCase();
    if (command === "/help") {
      if (isResponseLoading) return null;
      setMessages((current) => {
        const last = current.at(-1);
        const withCommand = last?.role === "user" &&
            last.content.trim().toLowerCase() === command
          ? current
          : [...current, message];
        return [...withCommand, { role: "assistant", content: CHAT_COMMAND_HELP }];
      });
      return null;
    }
    if (command === "/compact") {
      if (!chatId || isResponseLoading) return null;
      const updateCompaction = (
        status: "running" | "completed" | "failed",
      ) => {
        setMessages((current) => {
          const index = current.findLastIndex((item) => item.role === "assistant");
          const events = index < 0 ? [] : current[index].events ?? [];
          const eventIndex = events.findLastIndex((event) => event.type === "compaction");
          const nextEvents = [...events];
          const event: AssistantEvent = { type: "compaction", status };
          if (eventIndex < 0) nextEvents.push(event);
          else nextEvents[eventIndex] = event;
          eventsRef.current = nextEvents;
          if (index < 0) {
            return [...current, { role: "assistant", content: "", events: nextEvents }];
          }
          const next = [...current];
          next[index] = { ...next[index], events: nextEvents };
          return next;
        });
      };
      updateCompaction("running");
      try {
        const result = await compactChat(
          chatId,
          message.model ?? readSelectedModel(),
        );
        if (Number.isSafeInteger(result.transcriptVersion)) {
          transcriptVersionRef.current = result.transcriptVersion!;
        }
        updateCompaction("completed");
      } catch (error) {
        updateCompaction("failed");
        updateLatestAssistantMessage((current) => ({
          ...current,
          error: readableStreamError(error instanceof Error ? error.message : error),
        }));
      }
      return null;
    }
    if (isResponseLoading) {
      if (!chatId) return null;
      const steering: AssistantEvent = {
        type: "steering",
        id: crypto.randomUUID(),
        text: message.content.trim(),
      };
      publishEvents([...finishAssistantStreamEvents(eventsRef.current), steering]);
      try {
        await steerChat(chatId, steering.id, steering.text);
      } catch (error) {
        publishEvents([
          ...eventsRef.current,
          {
            type: "error",
            message: readableStreamError(error instanceof Error ? error.message : error),
          },
        ]);
      }
      return null;
    }
    const turnOptions =
      isAnonymousMode && !opts?.askInputsResponse
        ? { ...opts, turnId: opts?.turnId ?? crypto.randomUUID() }
        : opts;
    transcriptPollGenerationRef.current += 1;
    setRejectedTurn(null);
    flushPendingEventsSnapshot();
    setIsResponseLoading(true);
    if (chatId) setChatTurnInProgress?.(chatId, true);
    const lastMessage = messages[messages.length - 1];
    const isMessageAlreadyAdded =
      lastMessage &&
      lastMessage.role === "user" &&
      lastMessage.content === message.content;
    const apiMessagesForTurn: Message[] = isMessageAlreadyAdded
      ? messages
      : [...messages, message];
    const optimisticResponseEvent = turnOptions?.askInputsResponse ?? null;
    const displayMessages: Message[] = optimisticResponseEvent
      ? (() => {
          const index = messages.findLastIndex(
            (item) => item.role === "assistant",
          );
          if (index < 0) return messages;
          const updated = messages.slice();
          const current = messages[index];
          updated[index] = {
            ...current,
            events: [
              ...(current.events ?? []),
              optimisticResponseEvent,
              { type: "thinking", isStreaming: true },
            ],
          };
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
      ? (displayMessages.findLast((item) => item.role === "assistant")?.events ??
        [])
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
      const editMode = message.editMode ?? "manual";
      const readSubagents = readReadSubagentPreference();
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
        tabular_review_id: tabularReviewId,
        model,
        reasoning_effort: reasoningEffort,
        edit_mode: editMode,
        jurisdiction_preference: jurisdictionPreferenceForChat(),
        subagent_mode:
          readSubagents.mode === "native" && !model.startsWith("codex:")
            ? "none"
            : readSubagents.mode,
        subagent_model: readSubagents.model,
        subagent_effort: readSubagents.effort,
        activity_detail: readActivityDetail(),
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
            if (!tabularReviewId) await loadChats();
            return null;
          }
          const conflictMessage =
            retryBlocked
              ? typeof conflict.detail === "string"
                ? conflict.detail
                : "The prior response changed local data before it stopped. Review that result before continuing."
              : conflict.code === "chat_turn_in_progress"
              ? "Another response is still running. Your draft has been restored and this chat will refresh when that response finishes."
              : "This conversation changed in another window. Review the latest messages; your draft has been restored.";
          setRejectedTurn({
            message: { ...message },
            options: turnOptions,
            detail: conflictMessage,
            retryable: !retryBlocked && conflict.code !== "chat_turn_in_progress",
          });
          setMessages(reloaded);
          if (conflict.code === "chat_turn_in_progress") {
            pollForCompletedTurn(chatId, currentVersion);
          }
          setIsResponseLoading(false);
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
              onChatIdChange?.(data.chatId);
              setChatTurnInProgress?.(data.chatId, true);
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
              continue;
            }
            if (data.type === "error") {
              if (controller.signal.aborted) continue;
              const streamErrorMessage = readableStreamError(data.message);
              if (streamErrorMessage === "Cancelled by user.") {
                publishEvents(
                  interruptAssistantStreamEvents(eventsRef.current, "cancelled"),
                  { error: undefined, turnStatus: "cancelled" },
                );
                setIsResponseLoading(false);
                if (streamedChatId || chatId) {
                  setChatTurnInProgress?.(streamedChatId || chatId!, false);
                }
                continue;
              }
              if (
                data.retryable !== false
              ) {
                setRejectedTurn({
                  message: { ...message },
                  options: turnOptions,
                });
              }
              publishEvents(
                [
                  ...finishAssistantStreamEvents(eventsRef.current),
                  { type: "error", message: streamErrorMessage },
                ],
                { error: streamErrorMessage },
              );
              setIsResponseLoading(false);
              if (streamedChatId || chatId) {
                setChatTurnInProgress?.(streamedChatId || chatId!, false);
              }
              continue;
            }
            if (
              data.type === "content_snapshot" ||
              data.type === "content_final"
            ) {
              const text = typeof data.text === "string" ? data.text : "";
              const isSnapshot = data.type === "content_snapshot";
              const current = eventsRef.current.filter(
                (event) => !isStreamingPlaceholder(event),
              );
              const lastSteering = isSnapshot
                ? -1
                : current.findLastIndex((event) => event.type === "steering");
              const firstContent = current.findIndex(
                (event, index) => index > lastSteering && event.type === "content",
              );
              const next: AssistantEvent[] = current.filter(
                (event, index) => index <= lastSteering || event.type !== "content",
              );
              if (text) {
                next.splice(
                  firstContent < 0
                    ? next.length
                    : Math.min(firstContent, next.length),
                  0,
                  {
                    type: "content",
                    text,
                    ...(isSnapshot && { isStreaming: true }),
                  },
                );
              }
              publishEvents(
                next,
                isSnapshot
                  ? undefined
                  : {
                      content: next
                        .filter((event) => event.type === "content")
                        .map((event) => event.text)
                        .join("\n\n"),
                    },
              );
              continue;
            }
            if (data.type === "content_reset") {
              resetStreamingNarrative();
              continue;
            }
            const reduction = reduceAssistantStreamEvent(eventsRef.current, data);
            if (reduction) {
              if (reduction.deferPaint) {
                eventsRef.current = reduction.events;
                scheduleEventsSnapshot();
              } else {
                publishEvents(reduction.events);
              }
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
              publishEvents(
                finishAssistantStreamEvents(eventsRef.current),
                {
                  citations: incoming,
                  citationStatus: incoming.length ? "final" : undefined,
                },
              );
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
      const finishedEvents = finishAssistantStreamEvents(eventsRef.current);
      if (finishedEvents === eventsRef.current) flushPendingEventsSnapshot();
      else publishEvents(finishedEvents);
      setIsResponseLoading(false);
      const finalChatId = streamedChatId || chatId || null;
      if (finalChatId) setChatTurnInProgress?.(finalChatId, false);
      if (finalChatId && finalChatId !== chatId) {
        if (chatId) {
          replaceChatId(
            chatId,
            finalChatId,
            message.content.trim().slice(0, 120) || "New Chat",
          );
        }
        if (!tabularReviewId) {
          const chatBasePath = projectId
            ? `/projects/${projectId}/assistant/chat`
            : `/assistant/chat`;
          router.replace(`${chatBasePath}/${finalChatId}`);
        }
      }
      if (!tabularReviewId) await loadChats();
      if (finalChatId && apiMessagesForTurn.length === 1) {
        const titleParts = [message.content];
        if (message.workflow)
          titleParts.push(`Workflow: ${message.workflow.title}`);
        if (message.files?.length)
          titleParts.push(
            `Files: ${message.files.map((f) => f.filename).join(", ")}`,
          );
        void generateChatTitle(finalChatId, titleParts.join("\n"))
          .then(({ title }) => {
            onTitleChange?.(finalChatId, title);
            return tabularReviewId ? undefined : renameChat(finalChatId, title);
          })
          .catch(() => undefined);
      }
      return streamedChatId || null;
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        const cancelledEvents = interruptAssistantStreamEvents(
          eventsRef.current,
          "cancelled",
        );
        flushPendingEventsSnapshot();
        eventsRef.current = cancelledEvents;
        updateLatestAssistantMessage(
          (assistantMessage) => ({
            ...assistantMessage,
            events: cancelledEvents,
            error: undefined,
            turnStatus: "cancelled",
          }),
          {
            role: "assistant",
            content: "",
            events: cancelledEvents,
            turnStatus: "cancelled",
          },
        );
        const interruptedChatId = streamedChatId || chatId;
        if (isAnonymousMode && interruptedChatId) {
          pollForCompletedTurn(
            interruptedChatId,
            transcriptVersionRef.current,
          );
        }
      } else {
        const interruptedChatId = streamedChatId || chatId;
        if (isAnonymousMode && interruptedChatId) {
          try {
            const latest = await getChat(interruptedChatId);
            const latestVersion = latest.chat.transcript_version ?? transcriptVersionRef.current;
            transcriptVersionRef.current = latestVersion;
            setMessages(latest.messages);
            eventsRef.current =
              latest.messages.findLast((candidate) => candidate.role === "assistant")?.events ?? [];
            if (latest.chat.turn_in_progress) {
              setIsResponseLoading(true);
              setChatTurnInProgress?.(interruptedChatId, true);
              pollForCompletedTurn(interruptedChatId, latestVersion);
              return null;
            }
            const lastAssistant = latest.messages.findLast(
              (candidate) => candidate.role === "assistant",
            );
            if (
              interruptedTurn(latest.messages) ||
              lastAssistant?.events?.some((event) => event.type === "error")
            ) {
              setRejectedTurn({ message: { ...message }, options: turnOptions });
            }
            setIsResponseLoading(false);
            setChatTurnInProgress?.(interruptedChatId, false);
            return null;
          } catch {
            // The canonical snapshot is unreachable, so this is a real transport failure.
          }
        }
        setRejectedTurn({ message: { ...message }, options: turnOptions });
        const errorMessage = readableStreamError(
          error instanceof Error ? error.message : error,
        );
        const events = finishAssistantStreamEvents(eventsRef.current);
        flushPendingEventsSnapshot();
        eventsRef.current = events;
        updateLatestAssistantMessage(
          (assistantMessage) => ({
            ...assistantMessage,
            events,
            error: errorMessage,
          }),
          {
            role: "assistant",
            content: "",
            error: errorMessage,
          },
        );
      }
      setIsResponseLoading(false);
      return null;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };
  const submitPendingMessage = useEffectEvent((message: Message) => {
    void handleChat(message);
  });
  useEffect(() => {
    if (!initialChatId || !pendingMessageRef.current) return;
    const message = claimPendingChatMessage?.(initialChatId);
    if (!message) return;
    pendingMessageRef.current = null;
    submitPendingMessage(message);
  }, [claimPendingChatMessage, initialChatId]);
  const retryRejectedTurn = async () => {
    const pending = rejectedTurn;
    if (!pending) return null;
    setRejectedTurn(null);
    return handleChat(pending.message, pending.options);
  };
  const restoreMessages = (next: Message[]) => {
    setMessages(next);
    setRejectedTurn(interruptedTurn(next));
  };
  const openChat = (
    nextChatId?: string,
    nextMessages: Message[] = [],
    transcriptVersion = 0,
  ) => {
    transcriptPollGenerationRef.current += 1;
    setRejectedTurn(null);
    setChatId(nextChatId);
    restoreMessages(nextMessages);
    transcriptVersionRef.current = transcriptVersion;
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
    handleChat,
    handleNewChat,
    setMessages: restoreMessages,
    rejectedTurn,
    clearRejectedTurn,
    retryRejectedTurn,
    openChat,
    setTranscriptVersion: (version: number) => {
      if (Number.isSafeInteger(version) && version >= 0) {
        transcriptVersionRef.current = version;
      }
    },
    resumeRunningTurn,
    cancel,
    chatId,
  };
}
