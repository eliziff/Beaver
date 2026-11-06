import { readerSettings } from "mike/shared/runtime/assistantWire.mjs";
import { promptSubmissionSchema } from "mike/shared/runtime/promptSubmission.mjs";
import { randomUUID } from "node:crypto";
import { ChatApplicationError, chatTurnInputSchema,
  type ChatApplication, type EventSink } from "./chat/chatApplication";
import { beginChatTurn, finishChatTurn, setChatTurnControl, steerChatTurn } from "./chatTurns";
import type { ChatScope, ChatStore } from "./chatStore";
import { createJobEventWriter, finishJobCommand, watchJob,
  pendingJobCommands, PermanentJobError, type ApplicationJob,
  jsonValue, type JobHandler } from "./jobQueue";
import { providerErrorCode, safeErrorLog } from "./safeError";
import { jsonRecord } from "./value";

export const CHAT_TURN_JOB = "chat.turn";
const CLIENT_TOOL_TIMEOUT_MS = 90_000;

type ChatTurnRequest = { chatId?: string; scope: ChatScope;
  input: ReturnType<typeof chatTurnInputSchema.parse>; continuationId?: string; memoryContextKey?: string | null };
const jobScope = (job: ApplicationJob): ChatScope => {
  const email = jsonRecord(job.payload)?.user_email;
  return { userId: job.userId, ...(typeof email === "string" ? { userEmail: email } : {}) };
};
function request(job: ApplicationJob): ChatTurnRequest | null {
  const payload = jsonRecord(job.payload), parsed = chatTurnInputSchema.safeParse(payload?.input);
  if (!parsed.success) return null;
  const progress = jsonRecord(job.progress), continuation = progress?.continuation_id;
  return { input: parsed.data, memoryContextKey: typeof progress?.memory_context_key === "string" ? progress.memory_context_key : null, ...(parsed.data.chat_id ? { chatId: parsed.data.chat_id } : {}),
    scope: jobScope(job),
    ...(typeof continuation === "string" ? { continuationId: continuation } : {}) };
}

// A job's hold on its turn. The job slot closes before cleanup, so nothing late
// from a provider reaches the job or the next turn on this chat.
type TurnSlot =
  | { phase: "preparing" }
  | { phase: "claimed"; chatId: string; commands: Promise<void> }
  | { phase: "closed" };

/** Compaction runs in the chat's job slot, whose dedupe key keeps turns out of it. */
async function compactionJob(application: ChatApplication, job: ApplicationJob,
  input: { chatId: string; model?: string }, signal: AbortSignal) {
  const events = await createJobEventWriter(job.id);
  try {
    const { compacted: _compacted, transcriptVersion, ...details } =
      await application.compact(jobScope(job), input, signal);
    events.append({ type: "compaction", status: "completed", ...details });
    await events.flush();
    return { transcript_version: transcriptVersion };
  } catch (error) {
    if (!(error instanceof ChatApplicationError)) throw error;
    return jsonValue({ refused: { status: error.status, message: error.message,
      code: error.code, current_version: error.currentVersion } });
  }
}

export function chatTurnJobHandler(
  application: ChatApplication,
  chats: ChatStore,
): JobHandler {
  return async (job, context) => {
    const compaction = jsonRecord(jsonRecord(job.payload)?.compaction);
    if (typeof compaction?.chat_id === "string") return compactionJob(application, job, {
      chatId: compaction.chat_id,
      ...(typeof compaction.model === "string" && { model: compaction.model }),
    }, context.signal);
    const turn = request(job);
    if (!turn) throw new PermanentJobError("ChatTurnRequestUnavailable");
    const events = await createJobEventWriter(job.id);
    let slot = { phase: "preparing" } as TurnSlot;
    const emit: EventSink["emit"] = (event) => {
      // An oversized live event is dropped, not the turn: the saved transcript still carries it.
      try { if (slot.phase !== "closed") events.append(event); }
      catch (error) { console.warn("[chat] live event not sent", { type: event.type, ...safeErrorLog(error) }); }
    };
    const current = turn.chatId ? await chats.get(turn.scope, turn.chatId) : null;
    if (turn.chatId && !current) throw new PermanentJobError("ChatUnavailable");
    const controller = new AbortController();
    // Carry the reason across: the turn has to tell a cancellation apart from a
    // lease it lost while it was still working.
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    const clientTools = new Map<string, {
      settle(value: unknown): void;
      cancel(): void;
    }>();
    const clientTool = async (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      const callId = randomUUID();
      let timer!: NodeJS.Timeout;
      let onAbort!: () => void;
      const waiting = new Promise<unknown>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          clientTools.delete(callId);
        };
        onAbort = () => {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
        };
        timer = setTimeout(() => {
          cleanup();
          resolve({ error: "The Word task pane did not return a result in time." });
        }, CLIENT_TOOL_TIMEOUT_MS);
        timer.unref();
        clientTools.set(callId, {
          settle(value) { cleanup(); resolve(value); },
          cancel: onAbort,
        });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      emit({ type: "client_tool_call", callId, name, input });
      try {
        await events.flush();
        return await waiting;
      } catch (error) {
        clientTools.get(callId)?.cancel();
        await waiting.catch(() => undefined);
        throw error;
      }
    };
    const commands = await watchJob(job.id, "control");
    const commandStop = new AbortController();
    const checkCommands = async (chatId: string) => {
      while (!commandStop.signal.aborted && !controller.signal.aborted) {
        const version = commands.version;
        try {
          const page = await pendingJobCommands(job.id);
          let handled = 0;
          for (const command of page) {
            if (commandStop.signal.aborted || controller.signal.aborted) return;
            const payload = jsonRecord(command.payload);
            const id = typeof payload?.id === "string" ? payload.id : "";
            const text = typeof payload?.text === "string" ? payload.text : "";
            const readers = readerSettings.safeParse(payload?.readers);
            const submission = promptSubmissionSchema.safeParse(payload?.submission ?? { origin: "unknown" });
            if (command.kind === "steer" && id && (text || readers.success) &&
                submission.success &&
                await steerChatTurn(chatId, { id, text,
                  submission: submission.data,
                  ...(readers.success && { readers: readers.data }) })) {
              if (commandStop.signal.aborted || controller.signal.aborted) return;
              if (readers.success) {
                turn.input = { ...turn.input, subagents: readers.data.enabled,
                  subagent_model: readers.data.model, subagent_effort: readers.data.effort };
                await context.checkpoint({ payload: jsonValue({ ...jsonRecord(job.payload), input: turn.input }) });
              }
              await finishJobCommand(command.id); handled += 1;
            } else if (command.kind === "client_tool_result") {
              const callId = typeof payload?.callId === "string" ? payload.callId : "";
              if (callId) clientTools.get(callId)?.settle(payload?.result);
              await finishJobCommand(command.id); handled += 1;
            }
          }
          if (page.length === 20 && handled > 0) continue;
        } catch {
          // Preserve the durable command for a subsequent read on transient errors.
          // Cancellation is independently enforced by the job worker/lease.
        }
        await commands.wait(version, commandStop.signal);
      }
    };
    const sink: EventSink = {
      claim(chatId) {
        if (slot.phase !== "preparing" || controller.signal.aborted) return false;
        if (!beginChatTurn(chatId, controller)) return false;
        slot = { phase: "claimed", chatId, commands: checkCommands(chatId) };
        return true;
      },
      emit,
      setControl(control) {
        if (slot.phase === "closed") return;
        if (slot.phase === "claimed") setChatTurnControl(slot.chatId, controller, control);
        commands.wake();
      },
    };
    // A re-attempt replaces an attempt that may still be writing, so no version
    // read here survives preparation. The commit resolves the version instead.
    const resume = job.attempts > 1 || Boolean(turn.continuationId);
    try {
      const result = await application.turn(turn.scope, {
        ...turn.input,
        chat_id: turn.chatId ?? null,
        expected_version: resume
          ? current?.transcript_version ?? 0 : turn.input.expected_version,
      }, sink, controller.signal, {
        resume,
        continuationId: turn.continuationId,
        memoryContextKey: turn.memoryContextKey,
        clientTool,
        onContinuation: (continuationId, memoryContextKey) =>
          context.checkpoint({ progress: { continuation_id: continuationId, memory_context_key: memoryContextKey } }),
        onAccepted: async (chatId) => {
          turn.chatId = chatId;
          turn.input = { ...turn.input, chat_id: chatId };
          const payload = { ...jsonRecord(job.payload), input: turn.input };
          await context.checkpoint({ payload: jsonValue(payload), groupKey: `chat:${chatId}` });
        },
      });
      return { chat_id: result.chatId, transcript_version: result.transcriptVersion };
    } catch (error) {
      if (error instanceof ChatApplicationError) {
        if (error.code === "chat_turn_already_completed") {
          if (!turn.chatId) throw new PermanentJobError("ChatUnavailable");
          const chat = await chats.get(turn.scope, turn.chatId);
          return { chat_id: turn.chatId,
            transcript_version: chat?.transcript_version ?? current?.transcript_version ?? 0 };
        }
        throw new PermanentJobError(error.code ?? error.message);
      }
      // Rejected credentials, configuration or requests fail the same way on every attempt.
      const code = providerErrorCode(error);
      if (code && !["provider_limit", "provider_unavailable"].includes(code)) throw new PermanentJobError(code);
      throw error;
    } finally {
      const held = slot.phase === "claimed" ? slot : null;
      slot = { phase: "closed" };
      commandStop.abort(); commands.close();
      // Disconnect steering before joining the command loop: provider acknowledgement
      // must not hold completion, cancellation, or worker shutdown hostage.
      if (held) setChatTurnControl(held.chatId, controller, null);
      for (const pending of clientTools.values()) pending.cancel();
      try {
        await held?.commands;
        await events.flush();
      } finally {
        context.signal.removeEventListener("abort", abort);
        if (held) finishChatTurn(held.chatId, controller);
      }
    }
  };
}
