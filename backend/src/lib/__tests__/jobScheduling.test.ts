import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let directory = "";
const workers: Array<{ stop(): Promise<void> }> = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-lanes-"));
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
};
const untilAborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
});

it("starts interactive work while preparation and bulk lanes are occupied, without exceeding limits", async () => {
  const queue = await import("../jobQueue"), { startJobLanes } = await import("../jobWorkerLanes");
  const prepared = deferred(), bulk = deferred(), chatStarted = deferred(), secondChat = deferred();
  const active = { chat: 0, pdf: 0, bulk: 0 }, maximum = { ...active };
  const handler = (lane: keyof typeof active, started: () => void) =>
    async (_job: unknown, { signal }: import("../jobQueue").JobHandlerContext) => {
      maximum[lane] = Math.max(maximum[lane], ++active[lane]);
      started(); await untilAborted(signal); active[lane] -= 1; return {};
    };
  workers.push(startJobLanes([
    { concurrency: 2, handlers: { "chat.turn": handler("chat", () => active.chat === 1
      ? chatStarted.resolve() : secondChat.resolve()) } },
    { concurrency: 1, handlers: { "pdf.prepare": handler("pdf", prepared.resolve) } },
    { concurrency: 1, handlers: { "tabular.agent": handler("bulk", bulk.resolve) } },
  ]));
  const enqueue = (kind: string, key: string) => queue.enqueueJob({ kind,
    dedupeKey: key, userId: "owner", payload: {} });
  await enqueue("pdf.prepare", "first"); await enqueue("tabular.agent", "first");
  await Promise.all([prepared.promise, bulk.promise]);
  await enqueue("chat.turn", "first"); await chatStarted.promise;
  await enqueue("chat.turn", "second"); await secondChat.promise;
  await enqueue("pdf.prepare", "second"); await enqueue("tabular.agent", "second");
  await enqueue("chat.turn", "third");
  expect(active).toEqual({ chat: 2, pdf: 1, bulk: 1 });
  expect(maximum).toEqual({ chat: 2, pdf: 1, bulk: 1 });
});

it("does not publish rolled-back enqueues and wakes only after the outer commit", async () => {
  const queue = await import("../jobQueue"), { relationalDatabase } = await import("../relationalDatabase");
  const db = await relationalDatabase(), notified = vi.fn();
  const unsubscribe = db.notifications!.subscribe(["queue:test"], notified);
  let id = "";
  await expect(db.transaction(async (tx) => {
    id = (await queue.enqueueJob({ kind: "test", dedupeKey: "rollback", userId: "owner", payload: {} }, tx)).id;
    expect(notified).not.toHaveBeenCalled();
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(notified).not.toHaveBeenCalled();
  expect(await queue.getJob(id, "owner")).toBeNull();
  await db.transaction(async (tx) => {
    await tx.transaction(async (nested) => {
      await queue.enqueueJob({ kind: "test", dedupeKey: "committed", userId: "owner", payload: {} }, nested);
    });
    expect(notified).not.toHaveBeenCalled();
  });
  expect(notified).toHaveBeenCalledOnce(); unsubscribe();
});

it("delivers persisted events without waiting for the fallback clock, and preserves ownership", async () => {
  const queue = await import("../jobQueue"), { durableChatTurns } = await import("../chatTurnQueue");
  const job = await queue.enqueueJob({ kind: "chat.turn", dedupeKey: "stream", userId: "owner", payload: {} });
  const abort = new AbortController(), received = deferred(), events: unknown[] = [];
  const observation = durableChatTurns.observe({ userId: "owner" }, job.id, abort.signal,
    (event) => { events.push(event); received.resolve(); });
  const writer = await queue.createJobEventWriter(job.id);
  writer.append({ type: "content_delta", text: "first" });
  await writer.flush(); await received.promise;
  await queue.requestJobCancellation(job.id, "owner");
  expect((await observation).status).toBe("cancelled");
  expect(events).toEqual([{ type: "content_delta", text: "first" }]);
  const replay: unknown[] = [];
  await durableChatTurns.observe({ userId: "owner" }, job.id, abort.signal, (event) => replay.push(event));
  expect(replay).toEqual(events);
  await expect(durableChatTurns.observe({ userId: "other" }, job.id, abort.signal, () => {
    throw new Error("Must not deliver another user's event");
  })).rejects.toThrow("Job unavailable");
});

it("does not claim new jobs after shutdown races with a claim", async () => {
  const queue = await import("../jobQueue"), { relationalDatabase } = await import("../relationalDatabase");
  const db = await relationalDatabase(), called = vi.fn(async () => ({}));
  const job = await queue.enqueueJob({ kind: "test", dedupeKey: "stop", userId: "owner", payload: {} });
  const original = db.transaction.bind(db), blocked = deferred(), release = deferred();
  const spy = vi.spyOn(db, "transaction").mockImplementation(async (run) => {
    const result = await original(run); blocked.resolve(); await release.promise; return result;
  });
  const worker = queue.startJobWorker({ test: called }); workers.push(worker);
  await blocked.promise;
  const stopping = worker.stop(); release.resolve(); await stopping; spy.mockRestore();
  expect(called).not.toHaveBeenCalled();
  expect(await queue.getJob(job.id, "owner")).toMatchObject({ status: "queued", attempts: 0 });
});
