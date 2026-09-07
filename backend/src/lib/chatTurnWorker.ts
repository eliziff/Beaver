import { randomUUID } from "node:crypto";
import { ChatApplicationError, chatTurnInputSchema,
  type ChatApplication, type EventSink } from "./chat/chatApplication";
import { beginChatTurn, finishChatTurn, setChatTurnControl, steerChatTurn } from "./chatTurns";
import type { ChatScope, ChatStore } from "./chatStore";
import { createJobEventWriter, finishJobCommand, watchJob,
  pendingJobCommands, PermanentJobError, type ApplicationJob,
  jsonValue, type JobHandler } from "./jobQueue";
import { jsonRecord } from "./value";

export const CHAT_TURN_JOB = "chat.turn";
const CLIENT_TOOL_TIMEOUT_MS = 90_000;

type ChatTurnRequest = { chatId?: string; scope: ChatScope;
  input: ReturnType<typeof chatTurnInputSchema.parse>; continuationId?: string };
function request(job: ApplicationJob): ChatTurnRequest | null {
  const payload = jsonRecord(job.payload), parsed = chatTurnInputSchema.safeParse(payload?.input);
  if (!parsed.success) return null;
  const progress = jsonRecord(job.progress), continuation = progress?.continuation_id;
  return { input: parsed.data, ...(parsed.data.chat_id ? { chatId: parsed.data.chat_id } : {}),
    scope: { userId: job.userId, ...(typeof payload?.user_email === "string"
      ? { userEmail: payload.user_email } : {}) },
    ...(typeof continuation === "string" ? { continuationId: continuation } : {}) };
}

export function chatTurnJobHandler(
  application: ChatApplication,
  chats: ChatStore,
): JobHandler {
  return async (job, context) => {
    const turn = request(job);
    if (!turn) throw new PermanentJobError("ChatTurnRequestUnavailable");
    const events = await createJobEventWriter(job.id);
    let acceptingEvents = true;
    const emit: EventSink["emit"] = (event) => {
      if (acceptingEvents) events.append(event);
    };
    const current = turn.chatId ? await chats.get(turn.scope, turn.chatId) : null;
    if (turn.chatId && !current) throw new PermanentJobError("ChatUnavailable");
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) controller.abort();
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
    let claimedChatId: string | undefined;
    const commands = await watchJob(job.id, "control");
    const commandStop = new AbortController();
    let commandTask = Promise.resolve();
    const checkCommands = async () => {
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
            if (command.kind === "steer" && id && text && claimedChatId &&
                await steerChatTurn(claimedChatId, { id, text })) {
              if (commandStop.signal.aborted || controller.signal.aborted) return;
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
        if (!acceptingEvents || controller.signal.aborted) return false;
        if (!beginChatTurn(chatId, controller)) return false;
        claimedChatId = chatId;
        commandTask = checkCommands();
        return true;
      },
      emit,
      setControl(control) {
        if (!acceptingEvents) return;
        if (claimedChatId) setChatTurnControl(claimedChatId, controller, control);
        commands.wake();
      },
    };
    try {
      const result = await application.turn(turn.scope, {
        ...turn.input,
        chat_id: turn.chatId ?? null,
        expected_version: job.attempts > 1 || turn.continuationId
          ? current?.transcript_version ?? 0 : turn.input.expected_version,
      }, sink, controller.signal, {
        continuationId: turn.continuationId,
        clientTool,
        onContinuation: (continuationId) =>
          context.checkpoint({ progress: { continuation_id: continuationId } }),
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
      throw error;
    } finally {
      acceptingEvents = false;
      commandStop.abort(); commands.close();
      // Disconnect steering before joining the command loop: provider acknowledgement
      // must not hold completion, cancellation, or worker shutdown hostage.
      if (claimedChatId) setChatTurnControl(claimedChatId, controller, null);
      for (const pending of clientTools.values()) pending.cancel();
      try {
        await commandTask;
        await events.flush();
      } finally {
        context.signal.removeEventListener("abort", abort);
        if (claimedChatId) finishChatTurn(claimedChatId, controller);
      }
    }
  };
}
