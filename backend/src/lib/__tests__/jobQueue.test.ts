import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-jobs-"));
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
  vi.stubEnv("AUTH_MODE", "local");
});

afterEach(async () => {
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached");
}

describe("application job queue", () => {
  it("deduplicates active work and claims higher priority first", async () => {
    const queue = await import("../jobQueue");
    const low = await queue.enqueueJob({
      kind: "test", dedupeKey: "low", userId: "owner", payload: {}, priority: 10,
    });
    const duplicate = await queue.enqueueJob({
      kind: "test", dedupeKey: "low", userId: "owner", payload: {}, priority: 0,
    });
    const high = await queue.enqueueJob({
      kind: "test", dedupeKey: "high", userId: "owner", payload: {}, priority: 100,
    });
    const otherUser = await queue.enqueueJob({
      kind: "test", dedupeKey: "low", userId: "other", payload: {}, priority: -10,
    });
    expect(duplicate.id).toBe(low.id);
    expect(otherUser.id).not.toBe(low.id);

    const order: string[] = [];
    const worker = queue.startJobWorker({ test: async (job) => {
      order.push(job.id);
      return { ok: true };
    } });
    await Promise.all([
      queue.waitForJob(low.id, "owner"),
      queue.waitForJob(high.id, "owner"),
      queue.waitForJob(otherUser.id, "other"),
    ]);
    await worker.stop();
    expect(order).toEqual([high.id, low.id, otherUser.id]);
  });

  it("preempts lower priority work and resumes it after foreground work", async () => {
    const queue = await import("../jobQueue");
    const started = deferred();
    let lowAttempts = 0;
    const worker = queue.startJobWorker({
      low: async (_job, { signal }) => {
        lowAttempts += 1;
        if (lowAttempts === 1) {
          started.resolve();
          await new Promise<void>((_resolve, reject) => signal.addEventListener(
            "abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true },
          ));
        }
        return { resumed: true };
      },
      high: async () => ({ page: 5 }),
    });
    const low = await queue.enqueueJob({
      kind: "low", dedupeKey: "full", groupKey: "pdf:source", userId: "owner",
      payload: {}, priority: 0,
    });
    queue.wakeJobWorker();
    await started.promise;
    const high = await queue.enqueueJob({
      kind: "high", dedupeKey: "page", groupKey: "pdf:source", userId: "owner",
      payload: {}, priority: 100,
    });
    await queue.interruptJobs("pdf:source", 100);
    queue.wakeJobWorker();
    await queue.waitForJob(high.id, "owner");
    await queue.waitForJob(low.id, "owner");
    await worker.stop();
    expect(lowAttempts).toBe(2);
  });

  it("never interrupts lower-priority work from another group", async () => {
    const queue = await import("../jobQueue"), started = deferred(), finish = deferred();
    let aborted = false;
    const worker = queue.startJobWorker({
      low: async (_job, { signal }) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        started.resolve();
        await finish.promise;
        return {};
      },
      high: async () => ({}),
    });
    const low = await queue.enqueueJob({
      kind: "low", dedupeKey: "other-full", groupKey: "pdf:other",
      userId: "owner", payload: {}, priority: 0,
    });
    queue.wakeJobWorker();
    await started.promise;
    const high = await queue.enqueueJob({
      kind: "high", dedupeKey: "page", groupKey: "pdf:source",
      userId: "owner", payload: {}, priority: 100,
    });
    await queue.interruptJobs("pdf:source", 100);
    expect(aborted).toBe(false);
    finish.resolve();
    await Promise.all([
      queue.waitForJob(low.id, "owner"), queue.waitForJob(high.id, "owner"),
    ]);
    await worker.stop();
  });

  it("persists progress, bounds retries, and releases a failed dedupe key", async () => {
    const queue = await import("../jobQueue");
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    let attempts = 0;
    const worker = queue.startJobWorker({ test: async (_job, context) => {
      attempts += 1;
      await context.progress({ phase: "extracting", pages: [5] });
      throw new Error("provider detail must not be persisted");
    } });
    const queued = await queue.enqueueJob({
      kind: "test", dedupeKey: "retry", userId: "owner", payload: {}, maxAttempts: 2,
    });
    queue.wakeJobWorker();
    const progress: unknown[] = [];
    await eventually(() => queue.getJob(queued.id, "owner"),
      (value) => value?.status === "queued" && value.attempts === 1);
    expect(progress).toEqual([]);
    const waiting = queue.waitForJob(queued.id, "owner", {
      progress: (value) => progress.push(value),
    });
    await (await relationalDatabase()).query(sql`UPDATE application_jobs
      SET run_at=${new Date(0).toISOString()} WHERE id=${queued.id}`);
    queue.wakeJobWorker();
    await expect(waiting).rejects.toThrow("Background job failed");
    const failed = await queue.getJob(queued.id, "owner");
    expect(failed).toMatchObject({ status: "failed", attempts: 2, lastError: "Error" });
    expect(progress).toContainEqual({ phase: "extracting", pages: [5] });
    await worker.stop();
    const replacement = await queue.enqueueJob({
      kind: "test", dedupeKey: "retry", userId: "owner", payload: {}, maxAttempts: 1,
    });
    expect(replacement.id).not.toBe(queued.id);
    expect(attempts).toBe(2);
  });

  it("reclaims an expired lease and terminally fails an exhausted lease", async () => {
    const queue = await import("../jobQueue");
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    const recoverable = await queue.enqueueJob({
      kind: "test", dedupeKey: "recover", userId: "owner", payload: {}, maxAttempts: 2,
    });
    const exhausted = await queue.enqueueJob({
      kind: "test", dedupeKey: "exhausted", userId: "owner", payload: {}, maxAttempts: 1,
    });
    const database = await relationalDatabase(), expired = new Date(0).toISOString();
    await database.query(sql`UPDATE application_jobs SET status='running',attempts=1,
      locked_by='dead-worker',locked_until=${expired} WHERE id IN(${recoverable.id},${exhausted.id})`);
    const handled: string[] = [];
    const worker = queue.startJobWorker({ test: async (job) => {
      handled.push(job.id);
      return { recovered: true };
    } });
    queue.wakeJobWorker();
    await expect(queue.waitForJob(recoverable.id, "owner")).resolves.toMatchObject({
      status: "succeeded", attempts: 2,
    });
    await expect(queue.waitForJob(exhausted.id, "owner"))
      .rejects.toThrow("Background job failed");
    await worker.stop();
    expect(handled).toEqual([recoverable.id]);
    await expect(queue.getJob(exhausted.id, "owner")).resolves.toMatchObject({
      status: "failed", attempts: 1, lastError: "LeaseExpired",
    });
  });

  it("atomically claims each job once across concurrent workers", async () => {
    const queue = await import("../jobQueue"), counts = new Map<string, number>();
    const handler = async (job: { id: string }) => {
      counts.set(job.id, (counts.get(job.id) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return {};
    };
    const workers = Array.from({ length: 4 }, () => queue.startJobWorker({ test: handler }));
    const jobs = await Promise.all(Array.from({ length: 40 }, (_, index) => queue.enqueueJob({
      kind: "test", dedupeKey: `stress-${index}`, userId: "owner", payload: {},
    })));
    queue.wakeJobWorker();
    await Promise.all(jobs.map(({ id }) => queue.waitForJob(id, "owner")));
    await Promise.all(workers.map((worker) => worker.stop()));
    expect([...counts.values()]).toEqual(Array(40).fill(1));
  });

  it("prunes only expired terminal jobs", async () => {
    const queue = await import("../jobQueue");
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    const expired = await queue.enqueueJob({
      kind: "test", dedupeKey: "expired", userId: "owner", payload: {},
    });
    const recent = await queue.enqueueJob({
      kind: "test", dedupeKey: "recent", userId: "owner", payload: {},
    });
    const database = await relationalDatabase();
    await database.query(sql`UPDATE application_jobs SET status='succeeded',
      dedupe_key=NULL,completed_at=${new Date(0).toISOString()} WHERE id=${expired.id}`);
    await database.query(sql`UPDATE application_jobs SET status='failed',
      dedupe_key=NULL,completed_at=${new Date().toISOString()} WHERE id=${recent.id}`);

    await expect(queue.pruneJobs(24 * 60 * 60_000)).resolves.toBe(1);
    await expect(queue.getJob(expired.id, "owner")).resolves.toBeNull();
    await expect(queue.getJob(recent.id, "owner"))
      .resolves.toMatchObject({ status: "failed" });
  });
});
