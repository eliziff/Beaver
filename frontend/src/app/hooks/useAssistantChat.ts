import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  compactChat,
  generateChatTitle,
  getChat,
  steerChat,
  stopChat,
  stopChatJob,
  streamActiveChat,
  streamChat,
  streamChatJob,
  submitChatClientToolResult,
} from "@/app/lib/beaverApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { Chat, Message } from "@/app/components/shared/types";
import {
  ASSISTANT_GENERIC_ERROR,
  assistantSessionReducer,
  createAssistantSessionState,
  type AssistantTurnOptions,
  type ProtocolEvent,
} from "@/app/lib/assistantSession";
import {
  AssistantProtocolError,
  readAssistantEventStream,
} from "@/app/lib/assistantStream";
import {
  jurisdictionPreferenceForChat,
  readAssistantPreferences,
} from "@/app/components/assistant/assistantPreferences";
import { DEFAULT_MODEL_ID } from "@/app/components/assistant/ModelToggle";
import type { WorkProductFocus, WorkProductKind } from "@/app/lib/workProducts";

interface UseAssistantChatOptions {
  chatId?: string;
  projectId?: string;
  tabularReviewId?: string;
  onChatIdChange?: (chatId: string) => void;
  onTitleChange?: (chatId: string, title: string) => void;
  stayInPlace?: boolean;
  workProduct?: { kind: WorkProductKind; id: string; revision: number;
    focus?: WorkProductFocus };
  wordClient?: {
    context(): Promise<{ document_name: string }>;
    execute(call: Extract<ProtocolEvent, { type: "client_tool_call" }>): Promise<unknown>;
  };
}

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

export function useAssistantChat({
  chatId: initialChatId,
  projectId,
  tabularReviewId,
  onChatIdChange,
  onTitleChange,
  stayInPlace = false,
  workProduct,
  wordClient,
}: UseAssistantChatOptions = {}) {
  const navigate = useNavigate();
  const { profile } = useUserProfile();
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
  const activeStreamRef = useRef<AbortController | null>(null);
  const transportRef = useRef<{ runId: string; controller: AbortController } | null>(null);
  const clientToolResultsRef = useRef(new Map<string, Promise<unknown>>());

  useEffect(() => () => {
    pollGenerationRef.current += 1;
    activeStreamRef.current?.abort();
    transportRef.current?.controller.abort();
  }, []);

  const pollForCompletedTurn = useCallback((
    targetChatId: string,
    baselineVersion: number,
  ) => {
    const generation = ++pollGenerationRef.current;
    void (async () => {
      let seenVersion = baselineVersion;
      const controller = new AbortController();
      activeStreamRef.current?.abort();
      activeStreamRef.current = controller;
      try {
        const response = await streamActiveChat(targetChatId, controller.signal);
        if (response.ok && response.body && generation === pollGenerationRef.current) {
          const runId = `durable:${targetChatId}`;
          dispatch({ type: "live_replay_started", chatId: targetChatId, runId });
          const streamed = await readAssistantEventStream({
            body: response.body,
            signal: controller.signal,
            expectedChatId: targetChatId,
            onEvent: (event, eventChatId) => dispatch({
              type: "protocol", runId, chatId: eventChatId, event,
            }),
          });
          if (streamed.sawDone && streamed.sawTranscriptVersion) {
            const latest = await getChat(targetChatId);
            const version = latest.chat.transcript_version ?? seenVersion;
            dispatch({ type: "transcript_loaded", chatId: targetChatId,
              messages: latest.messages, transcriptVersion: version,
              active: latest.chat.turn_in_progress === true,
              preserveRejected: true });
            if (!latest.chat.turn_in_progress) {
              setChatTurnInProgress?.(targetChatId, false);
              if (!tabularReviewId) void loadChats();
              return;
            }
            seenVersion = version;
          }
        }
      } catch {
        // Fall back to canonical transcript polling while the service reconnects.
      } finally {
        if (activeStreamRef.current === controller) activeStreamRef.current = null;
      }
      while (generation === pollGenerationRef.current) {
        try {
          const latest = await getChat(targetChatId, seenVersion);
          if (latest) {
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
      activeStreamRef.current?.abort();
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
    activeStreamRef.current?.abort();
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
    else if (current.run?.jobId) void stopChatJob(current.run.jobId).catch(() => undefined);
    pollGenerationRef.current += 1;
    activeStreamRef.current?.abort();
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
        const result = await compactChat(
          current.chatId,
          message.model ?? profile?.lastSelectedChatModel ?? DEFAULT_MODEL_ID,
        );
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
    activeStreamRef.current?.abort();
    dispatch({ type: "run_started", runId, chatId: current.chatId, message, options: turnOptions });
    if (current.chatId) setChatTurnInProgress?.(current.chatId, true);
    const controller = new AbortController();
    transportRef.current = { runId, controller };
    let streamedChatId: string | undefined;
    let queuedJobId: string | undefined;
    let durablyQueued = false;
    let serverRejected = false;
    let replaying = false;
    const consume = async (response: Response) => {
      if (!response.body) throw new Error("missing response");
      return readAssistantEventStream({
        body: response.body,
        signal: controller.signal,
        expectedChatId: current.chatId,
        onEvent: (event, eventChatId) => {
          if (event.type === "turn_queued") queuedJobId = event.jobId;
          if (event.type === "client_tool_call" && queuedJobId && wordClient) {
            let result = clientToolResultsRef.current.get(event.callId);
            if (!result) {
              result = wordClient.execute(event).catch((error) => ({
                error: error instanceof Error
                  ? error.message.slice(0, 500) : "The Word tool failed.",
              }));
              clientToolResultsRef.current.set(event.callId, result);
            }
            void result.then((value) => submitChatClientToolResult(
              queuedJobId!, event.callId, value,
            )).catch(() => undefined);
          }
          if (event.type === "chat_id" && event.chatId !== current.chatId) {
            if (replaying) {
              replaying = false;
              dispatch({ type: "live_replay_started", chatId: event.chatId, runId });
            }
            streamedChatId = event.chatId;
            onChatIdChange?.(event.chatId);
            setChatTurnInProgress?.(event.chatId, true);
          }
          if (event.type === "error" && event.accepted === false) serverRejected = true;
          dispatch({ type: "protocol", runId, chatId: eventChatId, event });
        },
      });
    };
    const complete = async (finalChatId?: string) => {
      dispatch({ type: "run_finished", runId });
      if (finalChatId) setChatTurnInProgress?.(finalChatId, false);
      if (finalChatId && finalChatId !== current.chatId) {
        if (current.chatId) replaceChatId(current.chatId, finalChatId,
          message.content.trim().slice(0, 120) || "New Chat");
        if (!tabularReviewId && !stayInPlace) {
          const base = projectId ? `/projects/${projectId}/assistant/chat` : "/assistant/chat";
          navigate(`${base}/${finalChatId}`, { replace: true });
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
    };
    try {
      const model = message.model ?? profile?.lastSelectedChatModel ?? DEFAULT_MODEL_ID;
      const preferences = readAssistantPreferences();
      const readSubagents = preferences.readSubagents;
      const wordContext = wordClient ? await wordClient.context() : undefined;
      const response = await streamChat({
        current_turn: turnOptions?.askInputsResponse
          ? {
              kind: "ask_inputs_response" as const,
              responses: turnOptions.askInputsResponse.responses.map((response) =>
                response.kind === "documents"
                  ? { ...response, documents: response.documents.map(
                      ({ document_id }) => ({ document_id }),
                    ) }
                  : response),
            }
          : {
              kind: "message" as const,
              turn_id: turnOptions?.turnId,
              content: message.content,
              files: message.files?.map(({ document_id }) => ({ document_id })),
              workflow: message.workflow ? { id: message.workflow.id } : undefined,
            },
        expected_version: current.transcriptVersion,
        chat_id: current.chatId,
        project_id: projectId,
        tabular_review_id: tabularReviewId,
        model,
        reasoning_effort: message.reasoningEffort ??
          profile?.lastSelectedReasoningEffort ?? undefined,
        edit_mode: message.editMode ?? "manual",
        jurisdiction_preference: jurisdictionPreferenceForChat(
          profile?.jurisdictionPreference ?? { mode: "ask", jurisdictions: [] },
        ),
        subagent_mode: readSubagents.mode === "native" && !model.startsWith("codex:") ? "none" : readSubagents.mode,
        subagent_model: readSubagents.model,
        subagent_effort: readSubagents.effort,
        activity_detail: preferences.activityDetail,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        displayed_doc: turnOptions?.displayedDoc
          ? { document_id: turnOptions.displayedDoc.documentId }
          : undefined,
        word_context: wordContext,
        work_product: workProduct && { kind: workProduct.kind, id: workProduct.id,
          revision: workProduct.revision, ...(workProduct.focus && { focus: {
            item_id: workProduct.focus.itemId,
            ...(workProduct.focus.selection && { selection: workProduct.focus.selection }),
          } }) },
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
          if (inProgress) pollForCompletedTurn(current.chatId, version);
          return null;
        }
        throw new Error("request failed");
      }
      durablyQueued = true;
      const result = await consume(response);
      streamedChatId = result.chatId;
      if (!result.sawDone || !result.sawTranscriptVersion) {
        throw new Error("truncated response");
      }
      if (serverRejected) {
        const rejectedChatId = result.chatId ?? current.chatId;
        dispatch({
          type: "run_failed",
          runId,
          removeOptimistic: true,
          rejected: { message: userMessage(message), options: turnOptions },
        });
        if (rejectedChatId) {
          const latest = await getChat(rejectedChatId).catch(() => null);
          if (latest) dispatch({
            type: "transcript_loaded",
            chatId: rejectedChatId,
            messages: latest.messages,
            transcriptVersion: latest.chat.transcript_version ?? current.transcriptVersion,
            active: latest.chat.turn_in_progress === true,
            preserveRejected: true,
          });
        }
        return null;
      }
      const finalChatId = result.chatId ?? current.chatId;
      return complete(finalChatId);
    } catch (error) {
      const targetChatId = streamedChatId ?? current.chatId;
      if (controller.signal.aborted) {
        dispatch({ type: "run_interrupted", runId, status: "cancelled" });
        if (targetChatId) pollForCompletedTurn(
          targetChatId,
          stateRef.current.transcriptVersion,
        );
        return null;
      }
      if (durablyQueued && queuedJobId && !targetChatId) {
        try {
          replaying = true;
          const response = await streamChatJob(queuedJobId, controller.signal);
          if (response.ok) {
            const result = await consume(response);
            streamedChatId = result.chatId;
            if (result.sawDone && result.sawTranscriptVersion) {
              if (serverRejected) dispatch({ type: "run_failed", runId,
                removeOptimistic: true,
                rejected: { message: userMessage(message), options: turnOptions } });
              else return complete(result.chatId);
              return null;
            }
          }
        } catch {
          // The durable job remains available for an explicit retry.
        }
      }
      if (targetChatId) {
        try {
          const latest = await getChat(targetChatId);
          const version = latest.chat.transcript_version ?? stateRef.current.transcriptVersion;
          dispatch({ type: "transcript_loaded", chatId: targetChatId, messages: latest.messages, transcriptVersion: version, active: latest.chat.turn_in_progress === true });
          if (latest.chat.turn_in_progress) {
            pollForCompletedTurn(targetChatId, version);
            return null;
          }
          if (durablyQueued) return null;
        } catch {
          // Fall through to the bounded transport failure.
        }
      }
      const failure = error instanceof AssistantProtocolError ? ASSISTANT_GENERIC_ERROR
        : /^(?:failed to fetch|fetch failed|network request failed|networkerror)/iu
          .test(error instanceof Error ? error.message : "")
          ? "Unable to get a response. Check the local service or provider connection, then try again."
          : ASSISTANT_GENERIC_ERROR;
      dispatch({
        type: "run_failed",
        runId,
        message: failure,
        ...(durablyQueued ? {} : {
          removeOptimistic: true,
          rejected: { message: userMessage(message), options: turnOptions },
        }),
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
