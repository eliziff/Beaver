import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  compactChat,
  generateChatTitle,
  getChat,
  steerChat,
  stopChat,
  streamChat,
} from "@/app/lib/beaverApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import type { Chat, Message } from "@/app/components/shared/types";
import {
  ASSISTANT_GENERIC_ERROR,
  assistantSessionReducer,
  createAssistantSessionState,
  type AssistantTurnOptions,
  type RejectedAssistantTurn,
} from "@/app/lib/assistantSession";
import {
  AssistantProtocolError,
  readAssistantEventStream,
} from "@/app/lib/assistantStream";
import {
  readSelectedModel,
  readSelectedReasoningEffort,
} from "./useSelectedModel";
import { jurisdictionPreferenceForChat } from "@/app/components/assistant/jurisdictionPreferences";
import { readReadSubagentPreference } from "@/app/components/assistant/readSubagentPreferences";
import { readActivityDetail } from "@/app/components/assistant/activityDisplayPreference";

interface UseAssistantChatOptions {
  chatId?: string;
  projectId?: string;
  tabularReviewId?: string;
  onChatIdChange?: (chatId: string) => void;
  onTitleChange?: (chatId: string, title: string) => void;
}

export type { AssistantTurnOptions, RejectedAssistantTurn };
export type AssistantChatLoad =
  | { status: "loading"; chatId: string }
  | { status: "loaded"; chatId?: string; chat: Chat | null }
  | { status: "error"; chatId: string; error: unknown };

const CHAT_COMMAND_HELP = [
  "**Commands**",
  "",
  "- `/compact` — Compact this chat's context.",
  "- `/help` — Show available commands.",
].join("\n");

function userMessage(message: Message): Message {
  return {
    role: "user",
    content: message.content,
    files: message.files,
    workflow: message.workflow,
    model: message.model,
    reasoningEffort: message.reasoningEffort,
    editMode: message.editMode,
    turnId: message.turnId,
  };
}

function networkError(value: unknown) {
  const message = value instanceof Error ? value.message : "";
  return /^(?:failed to fetch|fetch failed|network request failed|networkerror)/iu.test(message)
    ? "Unable to get a response. Check the local service or provider connection, then try again."
    : ASSISTANT_GENERIC_ERROR;
}

export function useAssistantChat({
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
  } = useChatHistoryContext();
  const pendingMessageRef = useRef<Message | null>(null);
  const [state, dispatch] = useReducer(
    assistantSessionReducer,
    undefined,
    () => {
      const pending = initialChatId
        ? peekPendingChatMessage?.(initialChatId) ?? null
        : null;
      pendingMessageRef.current = pending;
      const initial = createAssistantSessionState({ chatId: initialChatId });
      return pending
        ? assistantSessionReducer(initial, { type: "new_chat", chatId: initialChatId, message: pending })
        : initial;
    },
  );
  const [chatLoad, setChatLoad] = useState<AssistantChatLoad>(() =>
    initialChatId && !pendingMessageRef.current
      ? { status: "loading", chatId: initialChatId }
      : { status: "loaded", chatId: initialChatId, chat: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadGenerationRef = useRef(0);
  const pollGenerationRef = useRef(0);
  const transportRef = useRef<{ runId: string; controller: AbortController } | null>(null);

  useEffect(() => () => {
    pollGenerationRef.current += 1;
    transportRef.current?.controller.abort();
  }, []);

  const pollForCompletedTurn = useCallback((
    targetChatId: string,
    baselineVersion: number,
    runId = crypto.randomUUID(),
  ) => {
    const generation = ++pollGenerationRef.current;
    dispatch({ type: "run_resumed", runId, chatId: targetChatId });
    void (async () => {
      let seenVersion = baselineVersion;
      while (generation === pollGenerationRef.current) {
        try {
          const latest = await getChat(targetChatId);
          const version = latest.chat.transcript_version ?? seenVersion;
          if (version > seenVersion || latest.chat.turn_in_progress === false) {
            seenVersion = version;
            dispatch({
              type: "transcript_loaded",
              chatId: targetChatId,
              messages: latest.messages,
              transcriptVersion: version,
              active: latest.chat.turn_in_progress === true,
              preserveRejected: true,
            });
          }
          if (latest.chat.turn_in_progress === false) {
            setChatTurnInProgress?.(targetChatId, false);
            if (!tabularReviewId) void loadChats();
            return;
          }
        } catch {
          // Keep the last usable transcript while the local service reconnects.
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    })();
  }, [loadChats, setChatTurnInProgress, tabularReviewId]);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    const current = stateRef.current;
    if (!initialChatId) {
      pollGenerationRef.current += 1;
      transportRef.current?.controller.abort();
      if (current.chatId || current.messages.length) dispatch({ type: "new_chat" });
      setChatLoad({ status: "loaded", chat: null });
      return;
    }
    if (pendingMessageRef.current || current.run || (current.chatId === initialChatId && current.messages.length)) {
      setChatLoad({ status: "loaded", chatId: initialChatId, chat: null });
      return;
    }
    pollGenerationRef.current += 1;
    transportRef.current?.controller.abort();
    setChatLoad({ status: "loading", chatId: initialChatId });
    void getChat(initialChatId).then((latest) => {
      if (generation !== loadGenerationRef.current) return;
      const version = latest.chat.transcript_version ?? 0;
      dispatch({ type: "transcript_loaded", chatId: initialChatId, messages: latest.messages, transcriptVersion: version, active: latest.chat.turn_in_progress === true });
      setChatLoad({ status: "loaded", chatId: initialChatId, chat: latest.chat });
      if (latest.chat.turn_in_progress) pollForCompletedTurn(initialChatId, version);
    }).catch((error) => {
      if (generation === loadGenerationRef.current) setChatLoad({ status: "error", chatId: initialChatId, error });
    });
    return () => { if (loadGenerationRef.current === generation) loadGenerationRef.current += 1; };
  }, [initialChatId, pollForCompletedTurn]);

  const cancel = () => {
    const current = stateRef.current;
    const runId = current.run?.id;
    if (!runId) return;
    if (current.chatId) void stopChat(current.chatId).catch(() => undefined);
    pollGenerationRef.current += 1;
    if (transportRef.current?.runId === runId) {
      transportRef.current.controller.abort();
    }
    dispatch({ type: "run_interrupted", runId, status: "cancelled" });
    if (current.chatId) setChatTurnInProgress?.(current.chatId, false);
  };

  const handleChat = async (
    message: Message,
    options?: AssistantTurnOptions,
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;
    const current = stateRef.current;
    const command = message.content.trim().toLowerCase();
    if (command === "/help") {
      if (!current.run) dispatch({ type: "local_exchange", user: message, assistantText: CHAT_COMMAND_HELP });
      return null;
    }
    if (command === "/compact") {
      if (!current.chatId || current.run) return null;
      dispatch({ type: "compaction_changed", status: "running" });
      try {
        const result = await compactChat(current.chatId, message.model ?? readSelectedModel());
        if (Number.isSafeInteger(result.transcriptVersion)) {
          dispatch({ type: "transcript_version_changed", transcriptVersion: result.transcriptVersion! });
        }
        dispatch({ type: "compaction_changed", status: "completed" });
      } catch {
        dispatch({ type: "compaction_changed", status: "failed", error: ASSISTANT_GENERIC_ERROR });
      }
      return null;
    }
    if (current.run && !options?.askInputsResponse) {
      if (!current.chatId) return null;
      const id = crypto.randomUUID();
      const text = message.content.trim();
      dispatch({ type: "steering_queued", runId: current.run.id, id, text });
      try {
        await steerChat(current.chatId, id, text);
      } catch {
        dispatch({ type: "protocol", runId: current.run.id, chatId: current.chatId, event: { type: "error", message: ASSISTANT_GENERIC_ERROR, retryable: false } });
      }
      return null;
    }

    const turnOptions = !options?.askInputsResponse
      ? { ...options, turnId: options?.turnId ?? crypto.randomUUID() }
      : options;
    const shouldGenerateTitle = !options?.askInputsResponse && current.messages.length === 0;
    const runId = crypto.randomUUID();
    pollGenerationRef.current += 1;
    dispatch({ type: "run_started", runId, chatId: current.chatId, message, options: turnOptions });
    if (current.chatId) setChatTurnInProgress?.(current.chatId, true);
    const controller = new AbortController();
    transportRef.current = { runId, controller };
    let streamedChatId: string | undefined;
    let retryableProviderFailure = false;
    try {
      const model = message.model ?? readSelectedModel();
      const readSubagents = readReadSubagentPreference();
      const attachedDocs = (message.files ?? []).flatMap((file) =>
        file.document_id ? [{ filename: file.filename, document_id: file.document_id }] : [],
      );
      const response = await streamChat({
        current_turn: turnOptions?.askInputsResponse
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
            },
        expected_version: current.transcriptVersion,
        chat_id: current.chatId,
        project_id: projectId,
        tabular_review_id: tabularReviewId,
        model,
        reasoning_effort: message.reasoningEffort ?? readSelectedReasoningEffort(),
        edit_mode: message.editMode ?? "manual",
        jurisdiction_preference: jurisdictionPreferenceForChat(),
        subagent_mode: readSubagents.mode === "native" && !model.startsWith("codex:") ? "none" : readSubagents.mode,
        subagent_model: readSubagents.model,
        subagent_effort: readSubagents.effort,
        activity_detail: readActivityDetail(),
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        displayed_doc: turnOptions?.displayedDoc
          ? { filename: turnOptions.displayedDoc.filename, document_id: turnOptions.displayedDoc.documentId }
          : undefined,
        attached_documents: attachedDocs.length ? attachedDocs : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 409 && current.chatId) {
          const conflict = await response.json().catch(() => null) as Record<string, unknown> | null;
          const latest = await getChat(current.chatId);
          const version = typeof conflict?.current_version === "number" && Number.isSafeInteger(conflict.current_version)
            ? conflict.current_version
            : latest.chat.transcript_version ?? current.transcriptVersion;
          dispatch({ type: "transcript_loaded", chatId: current.chatId, messages: latest.messages, transcriptVersion: latest.chat.transcript_version ?? version, active: latest.chat.turn_in_progress === true });
          if (conflict?.code === "chat_turn_already_completed") return null;
          const retryBlocked = conflict?.code === "chat_retry_blocked_after_mutation";
          const inProgress = conflict?.code === "chat_turn_in_progress";
          dispatch({
            type: "turn_rejected",
            rejected: {
              message: userMessage(message),
              options: turnOptions,
              retryable: !retryBlocked && !inProgress,
              detail: retryBlocked
                ? "The prior continuation changed local data before it stopped. Review that result before sending a new instruction."
                : inProgress
                  ? "Another response is still running. Your draft has been restored and this chat will refresh when that response finishes."
                  : "This conversation changed in another window. Review the latest messages; your draft has been restored.",
            },
          });
          if (inProgress) pollForCompletedTurn(current.chatId, version, runId);
          return null;
        }
        throw new Error("request failed");
      }
      if (!response.body) throw new Error("missing response");
      const result = await readAssistantEventStream({
        body: response.body,
        signal: controller.signal,
        expectedChatId: current.chatId,
        onEvent: (event, eventChatId) => {
          if (event.type === "chat_id" && event.chatId !== current.chatId) {
            streamedChatId = event.chatId;
            onChatIdChange?.(event.chatId);
            setChatTurnInProgress?.(event.chatId, true);
          }
          if (event.type === "error" && event.retryable) retryableProviderFailure = true;
          dispatch({ type: "protocol", runId, chatId: eventChatId, event });
        },
      });
      streamedChatId = result.chatId;
      if (!result.sawDone || !result.sawTranscriptVersion) {
        throw new Error("truncated response");
      }
      dispatch({ type: "run_finished", runId });
      if (retryableProviderFailure) {
        dispatch({ type: "turn_rejected", rejected: { message: userMessage(message), options: turnOptions } });
      }
      const finalChatId = result.chatId ?? current.chatId;
      if (finalChatId) setChatTurnInProgress?.(finalChatId, false);
      if (finalChatId && finalChatId !== current.chatId) {
        if (current.chatId) replaceChatId(current.chatId, finalChatId, message.content.trim().slice(0, 120) || "New Chat");
        if (!tabularReviewId) {
          const base = projectId ? `/projects/${projectId}/assistant/chat` : "/assistant/chat";
          router.replace(`${base}/${finalChatId}`);
        }
      }
      if (!tabularReviewId) await loadChats();
      if (finalChatId && shouldGenerateTitle) {
        const titleParts = [message.content];
        if (message.workflow) titleParts.push(`Workflow: ${message.workflow.title}`);
        if (message.files?.length) titleParts.push(`Files: ${message.files.map((file) => file.filename).join(", ")}`);
        void generateChatTitle(finalChatId, titleParts.join("\n"))
          .then(({ title }) => {
            onTitleChange?.(finalChatId, title);
            return tabularReviewId ? undefined : renameChat(finalChatId, title);
          })
          .catch(() => undefined);
      }
      return streamedChatId ?? null;
    } catch (error) {
      const targetChatId = streamedChatId ?? current.chatId;
      if (controller.signal.aborted) {
        dispatch({ type: "run_interrupted", runId, status: "cancelled" });
        if (targetChatId) {
          pollForCompletedTurn(targetChatId, stateRef.current.transcriptVersion);
        }
        return null;
      }
      if (targetChatId) {
        try {
          const latest = await getChat(targetChatId);
          const version = latest.chat.transcript_version ?? stateRef.current.transcriptVersion;
          dispatch({ type: "transcript_loaded", chatId: targetChatId, messages: latest.messages, transcriptVersion: version, active: latest.chat.turn_in_progress === true });
          if (latest.chat.turn_in_progress) {
            pollForCompletedTurn(targetChatId, version, runId);
            return null;
          }
          return null;
        } catch {
          // Fall through to the bounded transport failure.
        }
      }
      dispatch({
        type: "run_failed",
        runId,
        message: error instanceof AssistantProtocolError ? ASSISTANT_GENERIC_ERROR : networkError(error),
        rejected: { message: userMessage(message), options: turnOptions },
      });
      if (targetChatId) setChatTurnInProgress?.(targetChatId, false);
      return null;
    } finally {
      if (transportRef.current?.runId === runId) transportRef.current = null;
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

  return {
    state,
    chatLoad,
    actions: {
      handleChat,
      clearRejectedTurn: () => dispatch({ type: "turn_rejected", rejected: null }),
      retryRejectedTurn: async () => {
        const pending = stateRef.current.rejectedTurn;
        if (!pending) return null;
        dispatch({ type: "turn_rejected", rejected: null });
        return handleChat(pending.message, pending.options);
      },
      cancel,
    },
  };
}
