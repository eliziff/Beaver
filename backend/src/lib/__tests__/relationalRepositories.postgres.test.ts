import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relationalRepositoryContract } from "./support/relationalRepositoryContract";

const connection = process.env.SUPABASE_TEST_DB_URL;
const suite = connection ? describe : describe.skip;
const owner = { userId: randomUUID(), userEmail: `owner-${randomUUID()}@example.test` };

suite("PostgreSQL relational repository contract", () => {
  beforeAll(() => {
    process.env.AUTH_MODE = "cloud";
    process.env.DATABASE_URL = `${connection}${connection!.includes("?") ? "&" : "?"}sslmode=disable`;
  });
  afterAll(async () => {
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    await (await relationalDatabase()).query(
      sql`DELETE FROM application_jobs WHERE user_id=${owner.userId}`,
    );
    await (await import("../relationalDatabase")).closeRelationalDatabase();
    delete process.env.DATABASE_URL;
  });

  relationalRepositoryContract();

  it("deduplicates and atomically claims durable jobs across PostgreSQL workers", async () => {
    const queue = await import("../jobQueue"), handled = new Map<string, number>();
    const prefix = randomUUID();
    const jobs = await Promise.all(Array.from({ length: 20 }, (_, index) => queue.enqueueJob({
      kind: "test.postgres", dedupeKey: `${prefix}:${index}`, userId: owner.userId,
      payload: {}, priority: index,
    })));
    const duplicates = await Promise.all(Array.from({ length: 10 }, () => queue.enqueueJob({
      kind: "test.postgres", dedupeKey: `${prefix}:0`, userId: owner.userId, payload: {},
    })));
    const workers = Array.from({ length: 4 }, () => queue.startJobWorker({
      "test.postgres": async (job) => {
        handled.set(job.id, (handled.get(job.id) ?? 0) + 1);
        return {};
      },
    }));
    queue.wakeJobWorker();
    try {
      await Promise.all(jobs.map(({ id }) => queue.waitForJob(id, owner.userId)));
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
    expect(new Set(duplicates.map(({ id }) => id))).toEqual(new Set([jobs[0].id]));
    expect([...handled.values()]).toEqual(Array(20).fill(1));
  });
});
