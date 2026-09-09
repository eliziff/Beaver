import { ASSISTANT_GENERIC_ERROR } from "@/app/lib/assistantProtocol";
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
  type Chat,
  type ChatDetail,
  type Message,
} from "@/app/lib/api/chat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

import {
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

type TurnTransport = {
  runId: string;
  controller: AbortController;
  chatId?: string;
  jobId?: string;
  rejected: boolean;
};

const CHAT_COMMAND_HELP = [
  "**Commands**",
  "",
  "- `/compact` — Compact this chat's context.",
  "- `/help` — Show available commands.",
].join("\n");

// A rejected turn is restored as a draft, so it must not carry the transcript id
// of the message the server refused.
const userMessage = ({ id: _id, ...message }: Message): Message => message;

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
    takePreparedChat,
  } = useChatHistoryContext();
  const [preparedChat] = useState(() => initialChatId ? takePreparedChat?.(initialChatId) : null);
  const preparedChatRef = useRef(preparedChat);
  const [loadAttempt, retryLoad] = useReducer((attempt: number) => attempt + 1, 0);
  const takePreparedChatRef = useRef(takePreparedChat);
  takePreparedChatRef.current = takePreparedChat;
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
        : preparedChat?.detail ? assistantSessionReducer(initial, {
            type: "transcript_loaded", chatId: initialChatId!,
            messages: preparedChat.detail.messages,
            transcriptVersion: preparedChat.detail.chat.transcript_version ?? 0,
            active: preparedChat.detail.chat.turn_in_progress === true,
          }) : initial;
    },
  );
  const [chatLoad, setChatLoad] = useState<AssistantChatLoad>(() =>
    preparedChat?.detail
      ? { status: "loaded", chatId: initialChatId, chat: preparedChat.detail.chat }
      : initialChatId && !pendingMessageRef.current
      ? { status: "loading", chatId: initialChatId }
      : { status: "loaded", chatId: initialChatId, chat: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadGenerationRef = useRef(0);
  const transportRef = useRef<TurnTransport | null>(null);
  const clientToolResultsRef = useRef(new Map<string, Promise<unknown>>());
  const streamCallbacks = useRef({ wordClient, onChatIdChange, setChatTurnInProgress });
  streamCallbacks.current = { wordClient, onChatIdChange, setChatTurnInProgress };

  useEffect(() => () => {
    transportRef.current?.controller.abort();
  }, []);

  const startTransport = useCallback((runId: string, chatId?: string) => {
    transportRef.current?.controller.abort();
    const transport: TurnTransport = { runId, chatId, controller: new AbortController(), rejected: false };
    transportRef.current = transport;
    return transport;
  }, []);

  const loadTranscript = useCallback((chatId: string, latest: ChatDetail, preserveRejected = false,
    fallbackVersion = stateRef.current.transcriptVersion) => {
    const version = latest.chat.transcript_version ?? fallbackVersion;
    setChatLoad({ status: "loaded", chatId, chat: latest.chat });
    dispatch({ type: "transcript_loaded", chatId, messages: latest.messages,
      transcriptVersion: version, active: latest.chat.turn_in_progress === true, preserveRejected });
    return version;
  }, []);

  const consume = useCallback(async (response: Response, transport: TurnTransport, replay = false) => {
    const { controller: { signal }, runId } = transport;
    signal.throwIfAborted();
    if (!response.ok || !response.body) throw new Error("missing response");
    const resetReplay = (chatId: string) => {
      if (!replay) return;
      dispatch({ type: "live_replay_started", chatId, runId });
      replay = false;
    };
    if (transport.chatId) resetReplay(transport.chatId);
    const result = await readAssistantEventStream({
      body: response.body, signal, expectedChatId: transport.chatId,
      onEvent: (event, eventChatId) => {
        signal.throwIfAborted();
        const { wordClient, onChatIdChange, setChatTurnInProgress } = streamCallbacks.current;
        if (event.type === "turn_queued") transport.jobId = event.jobId;
        if (event.type === "client_tool_call" && transport.jobId && wordClient) {
          let result = clientToolResultsRef.current.get(event.callId);
          if (!result) {
            result = wordClient.execute(event).catch((error) => ({ error: error instanceof Error
              ? error.message.slice(0, 500) : "The Word tool failed." }));
            clientToolResultsRef.current.set(event.callId, result);
          }
          const jobId = transport.jobId;
          void result.then((value) => submitChatClientToolResult(jobId, event.callId, value))
            .catch(() => undefined);
        }
        if (event.type === "chat_id") {
          resetReplay(event.chatId);
          if (event.chatId !== transport.chatId) {
            transport.chatId = event.chatId;
            onChatIdChange?.(event.chatId);
            setChatTurnInProgress?.(event.chatId, true);
          }
        }
        if (event.type === "error" && event.accepted === false) transport.rejected = true;
        dispatch({ type: "protocol", runId, chatId: eventChatId, event });
      },
    });
    signal.throwIfAborted();
    return result;
  }, []);

  const observeTurn = useCallback((
    targetChatId: string,
    baselineVersion: number,
    after?: Promise<unknown>,
  ) => {
    const transport = startTransport(`durable:${targetChatId}`, targetChatId);
    const { signal } = transport.controller;
    void (async () => {
      let seenVersion = baselineVersion;
      let refreshAll = false;
      try {
        await after;
        signal.throwIfAborted();
        const response = await streamActiveChat(targetChatId, signal);
        const streamed = await consume(response, transport, true);
        refreshAll = streamed.sawDone && streamed.sawTranscriptVersion;
      } catch {
        // Fall back to canonical transcript polling while the service reconnects.
      }
      while (!signal.aborted) {
        try {
          const latest = refreshAll ? await getChat(targetChatId) : await getChat(targetChatId, seenVersion);
          signal.throwIfAborted();
          if (latest) {
            const version = latest.chat.transcript_version ?? seenVersion;
            if (refreshAll || version > seenVersion || latest.chat.turn_in_progress === false)
              seenVersion = loadTranscript(targetChatId, latest, true);
            if (!latest.chat.turn_in_progress) {
              setChatTurnInProgress?.(targetChatId, false);
              if (!tabularReviewId) void loadChats();
              return;
            }
          }
        } catch {
          // Keep the last usable transcript while the local service reconnects.
        }
        refreshAll = false;
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    })().finally(() => { if (transportRef.current === transport) transportRef.current = null; });
  }, [consume, loadChats, loadTranscript, setChatTurnInProgress, startTransport, tabularReviewId]);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    const current = stateRef.current;
    const preparation = preparedChatRef.current;
    preparedChatRef.current = null;
    if (!initialChatId) {
      transportRef.current?.controller.abort();
      if (current.chatId || current.messages.length) dispatch({ type: "new_chat" });
      setChatLoad({ status: "loaded", chat: null });
      return;
    }
    if (preparation?.id === initialChatId && preparation.detail) {
      if (preparation.detail.chat.turn_in_progress) observeTurn(initialChatId,
        preparation.detail.chat.transcript_version ?? 0);
      return;
    }
    if (pendingMessageRef.current || (current.chatId === initialChatId && (current.run || current.messages.length))) {
      setChatLoad((previous) => previous.status === "loaded" && previous.chatId === initialChatId
        ? previous : { status: "loaded", chatId: initialChatId, chat: null });
      return;
    }
    transportRef.current?.controller.abort();
    setChatLoad({ status: "loading", chatId: initialChatId });
    void ((preparation?.id === initialChatId ? preparation : takePreparedChatRef.current?.(initialChatId))?.result ?? getChat(initialChatId)).then((latest) => {
      if (generation !== loadGenerationRef.current) return;
      const version = loadTranscript(initialChatId, latest, false, 0);
      if (latest.chat.turn_in_progress) observeTurn(initialChatId, version);
    }).catch((error) => {
      if (generation === loadGenerationRef.current) setChatLoad({ status: "error", chatId: initialChatId, error });
    });
    return () => { if (loadGenerationRef.current === generation) loadGenerationRef.current += 1; };
  }, [initialChatId, observeTurn, loadAttempt, loadTranscript]);

  const cancel = () => {
    const current = stateRef.current;
    const runId = current.run?.id;
    if (!runId) return;
    const stopping = current.chatId ? stopChat(current.chatId) : current.run?.jobId
      ? stopChatJob(current.run.jobId) : Promise.resolve();
    if (transportRef.current?.runId === runId) {
      transportRef.current.controller.abort();
    }
    dispatch({ type: "run_interrupted", runId, status: "cancelled" });
    if (current.chatId) setChatTurnInProgress?.(current.chatId, false);
    if (current.chatId) observeTurn(current.chatId, current.transcriptVersion, stopping.catch(() => undefined));
    else void stopping.catch(() => undefined);
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
    const transport = startTransport(runId, current.chatId);
    const { controller } = transport;
    dispatch({ type: "run_started", runId, chatId: current.chatId, message, options: turnOptions });
    if (current.chatId) setChatTurnInProgress?.(current.chatId, true);
    let durablyQueued = false;
    const complete = async (finalChatId = transport.chatId) => {
      controller.signal.throwIfAborted();
      dispatch({ type: "run_finished", runId });
      if (finalChatId) {
        try { const latest = await getChat(finalChatId); controller.signal.throwIfAborted();
          if (!latest.chat.turn_in_progress && latest.messages.some((message) => message.role === "assistant" &&
            message.turn_id === turnOptions?.turnId && message.turn_complete)) loadTranscript(finalChatId, latest);
          else setChatLoad({ status: "loaded", chatId: finalChatId, chat: latest.chat });
        } catch { /* Keep usable chat metadata while a completed response reconnects. */ }
        controller.signal.throwIfAborted();
      }
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
      return finalChatId ?? null;
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
              workflow: message.workflow ? {
                id: message.workflow.id,
                ...(message.workflow.variant_id ? { variant_id: message.workflow.variant_id } : {}),
              } : undefined,
            },
        expected_version: current.transcriptVersion,
        chat_id: current.chatId,
        project_id: projectId,
        tabular_review_id: tabularReviewId,
        research_file_id: message.research_file_id,
        research_selection: message.research_selection,
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
      controller.signal.throwIfAborted();
      if (!response.ok) {
        if (response.status === 409 && current.chatId) {
          const conflict = await response.json().catch(() => null) as Record<string, unknown> | null;
          const latest = await getChat(current.chatId);
          controller.signal.throwIfAborted();
          const version = typeof conflict?.current_version === "number" && Number.isSafeInteger(conflict.current_version)
            ? conflict.current_version
            : latest.chat.transcript_version ?? current.transcriptVersion;
          loadTranscript(current.chatId, latest, false, version);
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
          if (inProgress) observeTurn(current.chatId, version);
          return null;
        }
        throw new Error("request failed");
      }
      durablyQueued = true;
      const result = await consume(response, transport);
      if (!result.sawDone || !result.sawTranscriptVersion) {
        throw new Error("truncated response");
      }
      if (transport.rejected) {
        const rejectedChatId = result.chatId ?? current.chatId;
        dispatch({
          type: "run_failed",
          runId,
          removeOptimistic: true,
          rejected: { message: userMessage(message), options: turnOptions },
        });
        if (rejectedChatId) {
          const latest = await getChat(rejectedChatId).catch(() => null);
          controller.signal.throwIfAborted();
          if (latest) loadTranscript(rejectedChatId, latest, true);
        }
        return null;
      }
      return complete();
    } catch (error) {
      let targetChatId = transport.chatId;
      if (controller.signal.aborted) return null;
      if (durablyQueued && transport.jobId && !targetChatId) {
        try {
          const response = await streamChatJob(transport.jobId, controller.signal);
          if (response.ok) {
            const result = await consume(response, transport, true);
            if (result.sawDone && result.sawTranscriptVersion) {
              if (transport.rejected) dispatch({ type: "run_failed", runId,
                removeOptimistic: true,
                rejected: { message: userMessage(message), options: turnOptions } });
              else return complete();
              return null;
            }
          }
        } catch {
          // The durable job remains available for an explicit retry.
        }
        targetChatId = transport.chatId;
      }
      if (targetChatId) {
        try {
          const latest = await getChat(targetChatId);
          controller.signal.throwIfAborted();
          const version = loadTranscript(targetChatId, latest);
          if (latest.chat.turn_in_progress) {
            observeTurn(targetChatId, version);
            return null;
          }
          if (durablyQueued) return null;
        } catch {
          // Fall through to the bounded transport failure.
        }
      }
      if (controller.signal.aborted) return null;
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
      if (transportRef.current === transport) transportRef.current = null;
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
      retryLoad,
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
