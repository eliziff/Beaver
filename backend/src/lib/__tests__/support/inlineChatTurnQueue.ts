import { randomUUID } from "node:crypto";
import type { ChatApplication, ChatTurnInput, EventSink } from "../../chat/chatApplication";
import type { ChatScope } from "../../chatStore";
import type { ApplicationJob } from "../../jobQueue";
import type { ChatTurnQueue } from "../../chatTurnQueue";
import { beginChatTurn, finishChatTurn, setChatTurnControl } from "../../chatTurns";

type Pending = {
  scope: ChatScope;
  input: ChatTurnInput;
  job: ApplicationJob;
  controller: AbortController;
  events: unknown[];
  listeners: Set<(event: unknown) => void>;
  done: Promise<ApplicationJob>;
  resolve(job: ApplicationJob): void;
  chatId?: string;
};

export function inlineChatTurnQueue(application: ChatApplication): ChatTurnQueue {
  const pending = new Map<string, Pending>();
  const byChat = new Map<string, Pending>();
  return {
    async enqueue(scope, input) {
      const existing = input.chat_id ? byChat.get(input.chat_id) : undefined;
      if (existing) return { created: false, job: existing.job };
      const job: ApplicationJob = {
        id: randomUUID(), kind: "chat.turn", dedupeKey: input.chat_id ?? null,
        groupKey: input.chat_id ? `chat:${input.chat_id}` : null,
        userId: scope.userId, documentId: null, documentVersionId: null,
        payload: {}, priority: 0, status: "queued", attempts: 0,
        maxAttempts: 1, progress: null, result: null, lastError: null,
        cancelRequested: false,
      };
      let resolve!: (job: ApplicationJob) => void;
      const item: Pending = {
        scope, input, job, controller: new AbortController(), events: [], listeners: new Set(),
        done: new Promise((done) => { resolve = done; }), resolve,
        ...(input.chat_id ? { chatId: input.chat_id } : {}),
      };
      pending.set(job.id, item);
      if (item.chatId) byChat.set(item.chatId, item);
      job.status = "running";
      job.attempts += 1;
      let version = input.expected_version;
      let claimedChatId: string | undefined;
      const sink: EventSink = {
        claim(chatId) {
          const active = byChat.get(chatId);
          if (active && active !== item) return false;
          item.chatId = chatId;
          if (!beginChatTurn(chatId, item.controller)) return false;
          claimedChatId = chatId;
          byChat.set(chatId, item);
          return true;
        },
        emit(event) {
          const row = event as { type?: string; chatId?: string; transcriptVersion?: number };
          if (row.type === "chat_id" && row.chatId) item.chatId = row.chatId;
          if (row.type === "transcript_version" && row.transcriptVersion !== undefined)
            version = row.transcriptVersion;
          item.events.push(event);
          item.listeners.forEach((listener) => listener(event));
        },
        setControl(control) {
          if (claimedChatId) setChatTurnControl(claimedChatId, item.controller, control);
        },
      };
      void application.turn(scope, input, sink, item.controller.signal)
        .then((result) => {
          job.status = "succeeded";
          job.result = { chat_id: result?.chatId ?? item.chatId ?? "",
            transcript_version: result?.transcriptVersion ?? version };
        }, () => { job.status = "failed"; })
        .finally(() => {
          if (claimedChatId) finishChatTurn(claimedChatId, item.controller);
          if (item.chatId) byChat.delete(item.chatId);
          item.resolve(job);
        });
      return { created: true, job };
    },
    async activeJob(_scope, chatId) { return byChat.get(chatId)?.job ?? null; },
    async job(_scope, jobId) { return pending.get(jobId)?.job ?? null; },
    async observe(_scope, jobId, signal, emit) {
      const item = pending.get(jobId);
      if (!item) throw new Error("Job unavailable");
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      item.events.forEach(emit);
      item.listeners.add(emit);
      return new Promise<ApplicationJob>((resolve, reject) => {
        const abort = () => {
          item.listeners.delete(emit);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
        void item.done.then((job) => {
          signal.removeEventListener("abort", abort);
          item.listeners.delete(emit);
          resolve(job);
        });
      });
    },
    async cancel(_scope, chatId) {
      const item = byChat.get(chatId);
      if (!item) return false;
      item.controller.abort();
      return true;
    },
    async cancelJob(_scope, jobId) {
      const item = pending.get(jobId);
      if (!item || !["queued", "running"].includes(item.job.status)) return false;
      item.controller.abort();
      return true;
    },
    async steer() { return false; },
  };
}
