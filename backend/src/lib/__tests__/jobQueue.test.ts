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

function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  return vi.waitFor(async () => {
    const value = await read();
    expect(accept(value)).toBe(true);
    return value;
  }, { timeout: 3_000, interval: 10 });
}

async function waitForJob(
  queue: typeof import("../jobQueue"), id: string, userId: string, status = "succeeded",
) {
  const current = await eventually(() => queue.getJob(id, userId),
    (job) => !!job && ["succeeded", "failed", "cancelled"].includes(job.status));
  expect(current).toMatchObject({ status });
  return current!;
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
      waitForJob(queue, low.id, "owner"),
      waitForJob(queue, high.id, "owner"),
      waitForJob(queue, otherUser.id, "other"),
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
    await started.promise;
    const high = await queue.enqueueJob({
      kind: "high", dedupeKey: "page", groupKey: "pdf:source", userId: "owner",
      payload: {}, priority: 100,
    });
    await queue.interruptJobs("pdf:source", 100);
    await waitForJob(queue, high.id, "owner");
    await waitForJob(queue, low.id, "owner");
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
    await started.promise;
    const high = await queue.enqueueJob({
      kind: "high", dedupeKey: "page", groupKey: "pdf:source",
      userId: "owner", payload: {}, priority: 100,
    });
    await queue.interruptJobs("pdf:source", 100);
    expect(aborted).toBe(false);
    finish.resolve();
    await Promise.all([
      waitForJob(queue, low.id, "owner"), waitForJob(queue, high.id, "owner"),
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
    const progress = { phase: "extracting", pages: [5] };
    const retry = await eventually(() => queue.getJob(queued.id, "owner"),
      (job) => job?.status === "queued" && job.attempts === 1);
    expect(retry).toMatchObject({ lastError: "Error", progress });
    const database = await relationalDatabase();
    // This fixture bypasses backoff; publish a wake hint after committing its direct SQL change.
    await database.transaction(async (tx) => {
      await tx.query(sql`UPDATE application_jobs SET run_at=${new Date(0).toISOString()}
        WHERE id=${queued.id}`);
      tx.notifications!.publish("queue:test");
    });
    await expect(waitForJob(queue, queued.id, "owner", "failed")).resolves.toMatchObject({
      attempts: 2, lastError: "Error", progress,
    });
    await worker.stop();
    const replacement = await queue.enqueueJob({
      kind: "test", dedupeKey: "retry", userId: "owner", payload: {}, maxAttempts: 1,
    });
    expect(replacement.id).not.toBe(queued.id);
    expect(attempts).toBe(2);
  });

  it("persists controlled PermanentJobError messages without retrying", async () => {
    const queue = await import("../jobQueue");
    const worker = queue.startJobWorker({
      safe: async () => { throw new queue.PermanentJobError("Selected workflow is unavailable"); },
    });
    const safe = await queue.enqueueJob({
      kind: "safe", dedupeKey: "safe", userId: "owner", payload: {}, maxAttempts: 2,
    });
    await expect(waitForJob(queue, safe.id, "owner", "failed")).resolves.toMatchObject({
      attempts: 1, lastError: "Selected workflow is unavailable",
    });
    await worker.stop();
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
    await expect(waitForJob(queue, recoverable.id, "owner")).resolves.toMatchObject({
      status: "succeeded", attempts: 2,
    });
    await expect(waitForJob(queue, exhausted.id, "owner", "failed")).resolves.toMatchObject({
      attempts: 1, lastError: "LeaseExpired",
    });
    await worker.stop();
    expect(handled).toEqual([recoverable.id]);
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
    await Promise.all(jobs.map(({ id }) => waitForJob(queue, id, "owner")));
    await Promise.all(workers.map((worker) => worker.stop()));
    expect([...counts.values()]).toEqual(Array(40).fill(1));
  });

  it("does not report cancellation until the running handler has unwound", async () => {
    const queue = await import("../jobQueue"), started = deferred(), release = deferred();
    const worker = queue.startJobWorker({ test: async (_job, { signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(),
        { once: true }));
      await release.promise;
      throw new DOMException("Aborted", "AbortError");
    } });
    const queued = await queue.enqueueJob({
      kind: "test", dedupeKey: "cancel", userId: "owner", payload: {},
    });
    await started.promise;
    await queue.requestJobCancellation(queued.id, "owner");
    await expect(queue.getJob(queued.id, "owner")).resolves.toMatchObject({
      status: "running", cancelRequested: true,
    });
    release.resolve();
    await waitForJob(queue, queued.id, "owner", "cancelled");
    await worker.stop();
  });

  it("attributes a stolen lease instead of ending the work as a cancellation", async () => {
    const queue = await import("../jobQueue");
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = deferred();
    let reason: unknown, cancelled: boolean | undefined;
    const worker = queue.startJobWorker({ test: async (job, { signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(),
        { once: true }));
      reason = signal.reason;
      cancelled = job.cancelRequested;
      throw new DOMException("Aborted", "AbortError");
    } }, { leaseMilliseconds: 5_000, heartbeatMilliseconds: 10 });
    const queued = await queue.enqueueJob({
      kind: "test", dedupeKey: "stolen", userId: "owner", payload: {}, maxAttempts: 3,
    });
    await started.promise;
    // Exactly what an expired lease leaves behind: another claim owns the row.
    await (await relationalDatabase()).query(sql`UPDATE application_jobs
      SET locked_by='successor',attempts=2 WHERE id=${queued.id}`);
    await vi.waitFor(() => expect(reason).toBeInstanceOf(queue.JobLeaseLostError));
    expect(queue.leaseWasLost(AbortSignal.abort(reason))).toBe(true);
    expect(cancelled).toBe(false);
    expect(warn.mock.calls.some(([message, detail]) => message === "[job] lease lost" &&
      (detail as { job: string }).job === queued.id)).toBe(true);
    await worker.stop();
    warn.mockRestore();
  });

  it("keeps a running handler while renewal fails and its lease is still valid", async () => {
    const queue = await import("../jobQueue");
    const database = await (await import("../relationalDatabase")).relationalDatabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const query = database.query.bind(database), started = deferred(), release = deferred();
    let aborted = false;
    const fault = vi.spyOn(database, "query").mockImplementation((statement) => {
      if (/UPDATE application_jobs SET\s+locked_until=/u.test(statement.text))
        return Promise.reject(new Error("Fixture renewal failure"));
      return query(statement);
    });
    const worker = queue.startJobWorker({ test: async (_job, { signal }) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      started.resolve();
      await release.promise;
      return { ok: true };
    } }, { leaseMilliseconds: 60_000, heartbeatMilliseconds: 10 });
    const queued = await queue.enqueueJob({
      kind: "test", dedupeKey: "renewal", userId: "owner", payload: {},
    });
    await started.promise;
    await vi.waitFor(() => expect(warn.mock.calls.some(([message]) =>
      message === "[job] lease renewal failed")).toBe(true));
    expect(aborted).toBe(false);
    fault.mockRestore();
    release.resolve();
    await waitForJob(queue, queued.id, "owner");
    await worker.stop();
    expect(warn.mock.calls.some(([message]) => message === "[job] lease lost")).toBe(false);
    warn.mockRestore();
  });

  it("records a re-attempt so a lost lease is attributable", async () => {
    const queue = await import("../jobQueue");
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queued = await queue.enqueueJob({
      kind: "test", dedupeKey: "reattempt", userId: "owner", payload: {}, maxAttempts: 3,
    });
    await (await relationalDatabase()).query(sql`UPDATE application_jobs SET status='running',
      attempts=1,locked_by='dead-worker',locked_until=${new Date(0).toISOString()}
      WHERE id=${queued.id}`);
    const worker = queue.startJobWorker({ test: async () => ({ ok: true }) });
    await waitForJob(queue, queued.id, "owner");
    await worker.stop();
    expect(warn.mock.calls.some(([message, detail]) => message === "[job] re-attempt" &&
      (detail as { attempt: number }).attempt === 2)).toBe(true);
    warn.mockRestore();
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
