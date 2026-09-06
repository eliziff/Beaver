import { randomUUID } from "node:crypto";
import type { ChatTurnInput } from "./chat/chatApplication";
import type { ChatScope } from "./chatStore";
import { parsePublicAssistantEvent, type PublicAssistantEvent } from "./chat/assistantEvents";
import { activeJobForGroup, enqueueJob, enqueueJobCommand, getJob,
  readJobEvents, requestJobCancellation, watchJob,
  jsonValue, type ApplicationJob } from "./jobQueue";

const chatGroup = (chatId: string) => `chat:${chatId}`;
const activeJob = (scope: ChatScope, chatId: string) =>
  activeJobForGroup(chatGroup(chatId), scope.userId);

export type ChatTurnQueue = {
  enqueue(scope: ChatScope, input: ChatTurnInput): Promise<{
    created: boolean; job: ApplicationJob;
  }>;
  activeJob(scope: ChatScope, chatId: string): Promise<ApplicationJob | null>;
  job(scope: ChatScope, jobId: string): Promise<ApplicationJob | null>;
  observe(scope: ChatScope, jobId: string, signal: AbortSignal,
    emit: (event: PublicAssistantEvent) => void): Promise<ApplicationJob>;
  cancel(scope: ChatScope, chatId: string): Promise<boolean>;
  cancelJob(scope: ChatScope, jobId: string): Promise<boolean>;
  clientResult(scope: ChatScope, jobId: string, callId: string,
    result: unknown): Promise<boolean>;
  steer(scope: ChatScope, chatId: string,
    message: { id: string; text: string }): Promise<boolean>;
};

export const durableChatTurns: ChatTurnQueue = {
  async enqueue(scope, input) {
    const durable = input.current_turn.kind === "message" && !input.current_turn.turn_id
      ? { ...input, current_turn: { ...input.current_turn, turn_id: randomUUID() } }
      : input;
    const requestId = durable.current_turn.kind === "message"
      ? durable.current_turn.turn_id! : randomUUID();
    const key = durable.chat_id ?? requestId;
    const job = await enqueueJob({ kind: "chat.turn", dedupeKey: key,
      groupKey: durable.chat_id ? chatGroup(durable.chat_id) : `chat-request:${requestId}`,
      userId: scope.userId, payload: jsonValue({ request_id: requestId,
        user_email: scope.userEmail, input: durable }), maxAttempts: 10 });
    return { created: (job.payload as { request_id?: unknown }).request_id === requestId, job };
  },
  activeJob,
  async job(scope, jobId) { return getJob(jobId, scope.userId); },
  async observe(scope, jobId, signal, emit) {
    const changes = await watchJob(jobId, "events");
    let after = 0;
    let terminal: ApplicationJob | null = null;
    try {
      while (!signal.aborted) {
        const version = changes.version;
        const page = await readJobEvents(scope.userId, jobId, after);
        for (const row of page) {
          signal.throwIfAborted();
          after = row.sequence; emit(parsePublicAssistantEvent(row.event));
        }
        if (terminal && !page.length) return terminal;
        // Drain replay immediately, including events committed just before the
        // terminal status. Never sleep between full event pages.
        if (page.length === 500) continue;
        if (!terminal) {
          const current = await getJob(jobId, scope.userId);
          if (!current) throw new Error("Job unavailable");
          if (!["queued", "running"].includes(current.status)) { terminal = current; continue; }
        }
        await changes.wait(version, signal);
      }
      throw new DOMException("Aborted", "AbortError");
    } finally { changes.close(); }
  },
  async cancel(scope, chatId) {
    const job = await activeJob(scope, chatId);
    return !!job && !!await requestJobCancellation(job.id, scope.userId);
  },
  async cancelJob(scope, jobId) {
    return !!await requestJobCancellation(jobId, scope.userId);
  },
  async clientResult(scope, jobId, callId, result) {
    return enqueueJobCommand(scope.userId, jobId, "client_tool_result",
      jsonValue({ callId, result }));
  },
  async steer(scope, chatId, message) {
    const job = await activeJob(scope, chatId);
    return !!job && enqueueJobCommand(scope.userId, job.id, "steer", jsonValue(message));
  },
};
