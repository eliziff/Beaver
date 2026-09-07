import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate, setTimeout as deadline, clearTimeout as clearDeadline } from "node:timers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatApplication } from "../chat/chatApplication";
import type { ChatStore } from "../chatStore";

let directory = "";
const workers: Array<{ stop(): Promise<void> }> = [];
const cleanup: Array<() => void> = [];
const deferred = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};
// A test watchdog, not a production delay. Queue recovery/tool/heartbeat clocks
// stay frozen, so passing requires notification delivery and abort-aware cleanup.
async function within<T>(work: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = deadline(() => reject(new Error("Steering held turn cleanup open")), 2_000);
    })]);
  } finally { clearDeadline(timer); }
}
const drain = () => new Promise<void>(resolve => immediate(resolve));
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-cancel-steering-"));
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
});
afterEach(async () => {
  cleanup.splice(0).forEach(release => release());
  await drain();
  await Promise.all(workers.splice(0).map(worker => worker.stop()));
  vi.restoreAllMocks();
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

async function stalledTurn() {
  const queue = await import("../jobQueue"), registry = await import("../chatTurns");
  const { chatTurnJobHandler } = await import("../chatTurnWorker");
  const { durableChatTurns } = await import("../chatTurnQueue");
  await (await import("../relationalDatabase")).relationalDatabase();
  const chatId = randomUUID(), ready = deferred(), steeringStarted = deferred();
  const acknowledgement = deferred(), steeringSettled = deferred();
  const end = deferred<"complete" | "fail">(), successorEnd = deferred();
  const successorReady = deferred(), successorSteered = deferred();
  const successorControl = vi.fn(async () => { successorSteered.resolve(); });
  let runs = 0;
  // Substitute only the model application and its transcript lookup. The durable
  // jobs, commands, events, worker, observer, and active-turn registry are real.
  const application = { turn: async (_scope, _input, sink, signal, execution) => {
    const first = ++runs === 1;
    expect(sink.claim(chatId)).toBe(true);
    await execution!.onAccepted!(chatId);
    sink.emit({ type: "content", text: first ? "first turn" : "successor" });
    if (!first) {
      sink.setControl({ steer: successorControl }); successorReady.resolve();
      const abort = () => successorEnd.resolve();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      await successorEnd.promise;
      signal.removeEventListener("abort", abort);
      return { chatId, transcriptVersion: 2 };
    }
    sink.setControl({ steer: async message => {
      steeringStarted.resolve();
      try {
        await acknowledgement.promise;
        // A provider can acknowledge after its turn has ended. These late
        // callbacks must not append events or replace the next turn's control.
        sink.emit({ type: "steering", ...message });
        sink.setControl({ steer: async () => { throw new Error("Obsolete control installed"); } });
      } finally { steeringSettled.resolve(); }
    } });
    const abort = () => end.resolve("complete");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    ready.resolve();
    const outcome = await end.promise;
    signal.removeEventListener("abort", abort);
    if (outcome === "fail") throw new Error("Fixture model failure");
    return { chatId, transcriptVersion: 1 };
  } } as ChatApplication;
  cleanup.push(() => { acknowledgement.resolve(); end.resolve("complete"); successorEnd.resolve(); });
  const enqueue = () => queue.enqueueJob({ kind: "chat.turn", dedupeKey: randomUUID(),
    userId: "owner", maxAttempts: 1, payload: { input: { expected_version: 0,
      current_turn: { kind: "message", content: "fixture", turn_id: randomUUID() } } } });
  const first = await enqueue();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const worker = queue.startJobWorker({ "chat.turn": chatTurnJobHandler(application,
    { get: async () => null } as unknown as ChatStore) });
  workers.push(worker);
  await within(ready.promise);
  expect(await queue.enqueueJobCommand("owner", first.id, "steer", { id: "old-steer", text: "fixture" })).toBe(true);
  await within(steeringStarted.promise);
  const observe = (id: string) => {
    const abort = new AbortController(), events: unknown[] = [];
    cleanup.push(() => abort.abort());
    const result = durableChatTurns.observe({ userId: "owner" }, id, abort.signal, event => events.push(event));
    void result.catch(() => undefined);
    return { result, events };
  };
  return { queue, registry, first, chatId, worker, enqueue, observe, end, acknowledgement,
    steeringSettled, successorReady, successorSteered, successorControl };
}

it.each(["resolve", "reject"] as const)(
  "cancels stalled steering, reuses the slot, and ignores a late %s", async settlement => {
    const turn = await stalledTurn(), observed = turn.observe(turn.first.id);
    await turn.queue.requestJobCancellation(turn.first.id, "owner");
    expect((await within(observed.result)).status).toBe("cancelled");
    expect(observed.events).toEqual([{ type: "content", text: "first turn" }]);
    const successor = await turn.enqueue();
    await within(turn.successorReady.promise);
    // The original steering promise is still pending when the successor starts.
    if (settlement === "resolve") turn.acknowledgement.resolve();
    else turn.acknowledgement.reject(new Error("Late provider rejection"));
    await within(turn.steeringSettled.promise); await drain();
    expect((await turn.queue.pendingJobCommands(turn.first.id)).map(command => command.kind)).toEqual(["steer"]);
    expect((await turn.queue.readJobEvents("owner", turn.first.id, 0)).map(row => row.event))
      .toEqual(observed.events);
    expect(await turn.queue.enqueueJobCommand("owner", successor.id, "steer", { id: "next-steer", text: "new instructions" })).toBe(true);
    await within(turn.successorSteered.promise);
    expect(turn.successorControl).toHaveBeenCalledOnce();
    const next = turn.observe(successor.id);
    await turn.queue.requestJobCancellation(successor.id, "owner");
    expect((await within(next.result)).status).toBe("cancelled");
  },
);

it.each(["complete", "fail"] as const)(
  "finishes a %s turn without waiting for steering or writing its late events", async outcome => {
    const turn = await stalledTurn(), observed = turn.observe(turn.first.id);
    turn.end.resolve(outcome);
    expect((await within(observed.result)).status).toBe(outcome === "complete" ? "succeeded" : "failed");
    await turn.enqueue(); await within(turn.successorReady.promise);
    turn.acknowledgement.resolve(); await within(turn.steeringSettled.promise); await drain();
    expect((await turn.queue.pendingJobCommands(turn.first.id))).toHaveLength(1);
    expect((await turn.queue.readJobEvents("owner", turn.first.id, 0)).map(row => row.event))
      .toEqual([{ type: "content", text: "first turn" }]);
  },
);

it("releases the lease and chat registry on worker shutdown with stalled steering", async () => {
  const turn = await stalledTurn();
  await within(turn.worker.stop());
  expect(await turn.queue.getJob(turn.first.id, "owner")).toMatchObject({ status: "queued", attempts: 0 });
  const replacement = new AbortController();
  expect(turn.registry.beginChatTurn(turn.chatId, replacement)).toBe(true);
  turn.registry.finishChatTurn(turn.chatId, replacement);
  expect(await turn.queue.pendingJobCommands(turn.first.id)).toHaveLength(1);
});

it("releases the chat registry even when the final durable event flush fails", async () => {
  const queue = await import("../jobQueue"), registry = await import("../chatTurns");
  const { chatTurnJobHandler } = await import("../chatTurnWorker");
  const db = await (await import("../relationalDatabase")).relationalDatabase();
  const query = db.query.bind(db), chatId = randomUUID();
  const fault = vi.spyOn(db, "query").mockImplementation(statement => {
    if (/INSERT INTO\s+application_job_events/u.test(statement.text))
      return Promise.reject(new Error("Fixture event write failed"));
    return query(statement);
  });
  const application = { turn: async (_scope, _input, sink) => {
    expect(sink.claim(chatId)).toBe(true);
    sink.emit({ type: "content", text: "not durable" });
    return { chatId, transcriptVersion: 1 };
  } } as ChatApplication;
  const job = await queue.enqueueJob({ kind: "chat.turn", dedupeKey: "flush", userId: "owner", payload: {
    input: { expected_version: 0, current_turn: { kind: "message", content: "fixture", turn_id: randomUUID() } },
  } });
  const controller = new AbortController();
  await expect(chatTurnJobHandler(application, { get: async () => null } as unknown as ChatStore)(job, {
    signal: controller.signal, progress: async () => undefined, checkpoint: async () => undefined,
  })).rejects.toThrow("Fixture event write failed");
  fault.mockRestore();
  const replacement = new AbortController();
  expect(registry.beginChatTurn(chatId, replacement)).toBe(true);
  registry.finishChatTurn(chatId, replacement);
});
