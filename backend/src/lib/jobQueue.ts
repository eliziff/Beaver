import { randomUUID } from "node:crypto";
import {
  relationalDatabase,
  sql,
  type RelationalDatabase,
} from "./relationalDatabase";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ApplicationJob = {
  id: string;
  kind: string;
  dedupeKey: string | null;
  groupKey: string | null;
  userId: string;
  documentId: string | null;
  documentVersionId: string | null;
  payload: Json;
  priority: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  maxAttempts: number;
  progress: Json | null;
  result: Json | null;
  lastError: string | null;
};

type JobRow = Record<string, unknown>;
type HandlerContext = {
  signal: AbortSignal;
  progress(value: Json): Promise<void>;
};
export type JobHandler = (job: ApplicationJob, context: HandlerContext) => Promise<Json>;

const now = () => new Date().toISOString();
const later = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
const encode = (value: Json) => JSON.stringify(value);
const decode = (value: unknown): Json | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as Json;
  try { return JSON.parse(value) as Json; } catch { throw new Error("Invalid job JSON"); }
};
const boundedJson = (value: Json, maximum: number, label: string) => {
  const text = encode(value);
  if (Buffer.byteLength(text) > maximum) throw new Error(`${label} is too large`);
  return text;
};
const bounded = (value: string, maximum: number, label: string) => {
  const result = value.trim();
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new Error(`${label} is invalid`);
  }
  return result;
};
const errorCategory = (error: unknown) =>
  (error instanceof Error ? error.name : "JobError")
    .replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 120) || "JobError";
const job = (row: JobRow): ApplicationJob => ({
  id: String(row.id), kind: String(row.kind),
  dedupeKey: typeof row.dedupe_key === "string" ? row.dedupe_key : null,
  groupKey: typeof row.group_key === "string" ? row.group_key : null,
  userId: String(row.user_id),
  documentId: typeof row.document_id === "string" ? row.document_id : null,
  documentVersionId: typeof row.document_version_id === "string"
    ? row.document_version_id : null,
  payload: decode(row.payload) ?? {}, priority: Number(row.priority),
  status: String(row.status) as ApplicationJob["status"],
  attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
  progress: decode(row.progress), result: decode(row.result),
  lastError: typeof row.last_error === "string" ? row.last_error : null,
});

export async function enqueueJob(input: {
  kind: string;
  dedupeKey: string;
  groupKey?: string | null;
  userId: string;
  documentId?: string | null;
  documentVersionId?: string | null;
  payload: Json;
  priority?: number;
  maxAttempts?: number;
}, database?: RelationalDatabase) {
  const db = database ?? await relationalDatabase();
  const created = now(), id = randomUUID();
  const kind = bounded(input.kind, 80, "Job kind");
  const dedupeKey = bounded(input.dedupeKey, 500, "Job key");
  const groupKey = input.groupKey ? bounded(input.groupKey, 500, "Job group") : null;
  const userId = bounded(input.userId, 200, "Job user");
  const priority = Math.max(-100, Math.min(100, Math.trunc(input.priority ?? 0)));
  const maxAttempts = Math.max(1, Math.min(10, Math.trunc(input.maxAttempts ?? 3)));
  const payload = boundedJson(input.payload, 32 * 1024, "Job payload");
  const rows = (await db.query<JobRow>(sql`INSERT INTO application_jobs(
      id,kind,dedupe_key,group_key,user_id,document_id,document_version_id,payload,
      priority,status,run_at,attempts,max_attempts,created_at,updated_at)
    VALUES(${id},${kind},${dedupeKey},${groupKey},${userId},${input.documentId ?? null},
      ${input.documentVersionId ?? null},${payload},${priority},'queued',${created},0,
      ${maxAttempts},${created},${created})
    ON CONFLICT(kind,user_id,dedupe_key) DO UPDATE SET
      priority=CASE WHEN application_jobs.priority>excluded.priority
        THEN application_jobs.priority ELSE excluded.priority END,
      updated_at=excluded.updated_at
    RETURNING *`)).rows;
  return job(rows[0]);
}

async function claim(workerId: string, leaseMilliseconds: number, kinds: string[]) {
  const db = await relationalDatabase(), claimedAt = now(), lockedUntil = later(leaseMilliseconds);
  return db.transaction(async (tx) => {
    await tx.query(sql`UPDATE application_jobs SET status='failed',dedupe_key=NULL,
      locked_by=NULL,locked_until=NULL,interrupt_requested_at=NULL,
      last_error='LeaseExpired',completed_at=${claimedAt},updated_at=${claimedAt}
      WHERE status='running' AND locked_until<=${claimedAt} AND attempts>=max_attempts`);
    const locking = tx.engine === "postgres" ? sql.raw("FOR UPDATE SKIP LOCKED") : sql.raw("");
    const candidate = (await tx.query<JobRow>(sql`SELECT * FROM application_jobs
      WHERE ((status='queued' AND run_at<=${claimedAt}) OR
        (status='running' AND locked_until<=${claimedAt}))
        AND attempts<max_attempts AND kind IN(${sql.join(kinds)})
      ORDER BY priority DESC,run_at,created_at,id LIMIT 1 ${locking}`)).rows[0];
    if (!candidate) return null;
    const updated = (await tx.query<JobRow>(sql`UPDATE application_jobs SET
      status='running',locked_by=${workerId},locked_until=${lockedUntil},
      interrupt_requested_at=NULL,attempts=attempts+1,updated_at=${claimedAt}
      WHERE id=${String(candidate.id)} AND
        ((status='queued' AND run_at<=${claimedAt}) OR
          (status='running' AND locked_until<=${claimedAt}))
      RETURNING *`)).rows[0];
    return updated ? job(updated) : null;
  });
}

async function heartbeat(id: string, workerId: string, leaseMilliseconds: number) {
  const db = await relationalDatabase(), timestamp = now();
  const row = (await db.query<JobRow>(sql`UPDATE application_jobs SET
      locked_until=${later(leaseMilliseconds)},updated_at=${timestamp}
    WHERE id=${id} AND status='running' AND locked_by=${workerId}
      AND interrupt_requested_at IS NULL RETURNING id`)).rows[0];
  return !!row;
}

async function finish(id: string, workerId: string, result: Json) {
  const db = await relationalDatabase(), timestamp = now();
  const value = boundedJson(result, 16 * 1024, "Job result");
  await db.query(sql`UPDATE application_jobs SET status='succeeded',result=${value},
    last_error=NULL,dedupe_key=NULL,locked_by=NULL,locked_until=NULL,
    completed_at=${timestamp},updated_at=${timestamp}
    WHERE id=${id} AND status='running' AND locked_by=${workerId}`);
}

async function release(id: string, workerId: string) {
  const db = await relationalDatabase(), timestamp = now();
  await db.query(sql`UPDATE application_jobs SET status='queued',run_at=${timestamp},
    attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END,
    locked_by=NULL,locked_until=NULL,interrupt_requested_at=NULL,updated_at=${timestamp}
    WHERE id=${id} AND status='running' AND locked_by=${workerId}`);
}

async function fail(job: ApplicationJob, workerId: string, error: unknown) {
  const db = await relationalDatabase(), timestamp = now();
  const exhausted = job.attempts >= job.maxAttempts;
  const delay = Math.min(60_000, 2_000 * (2 ** Math.max(0, job.attempts - 1)));
  const category = errorCategory(error);
  await db.query(sql`UPDATE application_jobs SET status=${exhausted ? "failed" : "queued"},
    run_at=${later(delay)},last_error=${category},locked_by=NULL,locked_until=NULL,
    interrupt_requested_at=NULL,dedupe_key=${exhausted ? null : job.dedupeKey},
    completed_at=${exhausted ? timestamp : null},updated_at=${timestamp}
    WHERE id=${job.id} AND status='running' AND locked_by=${workerId}`);
}

export async function interruptJobs(groupKey: string, belowPriority: number) {
  const db = await relationalDatabase(), timestamp = now();
  const rows = (await db.query<{ id: string }>(sql`UPDATE application_jobs
    SET interrupt_requested_at=${timestamp},
    updated_at=${timestamp} WHERE group_key=${bounded(groupKey, 500, "Job group")}
      AND status='running' AND priority<${belowPriority} RETURNING id`)).rows;
  const interrupted = new Set(rows.map(({ id }) => id));
  for (const active of activeJobs.values()) {
    if (interrupted.has(active.job.id)) active.controller.abort();
  }
}

export async function getJob(id: string, userId: string) {
  const db = await relationalDatabase();
  const row = (await db.query<JobRow>(sql`SELECT * FROM application_jobs
    WHERE id=${bounded(id, 100, "Job ID")}
      AND user_id=${bounded(userId, 200, "Job user")}`)).rows[0];
  return row ? job(row) : null;
}

export async function pruneJobs(
  retentionMilliseconds = 7 * 24 * 60 * 60_000,
) {
  const db = await relationalDatabase();
  const cutoff = new Date(
    Date.now() - Math.max(60_000, Math.min(retentionMilliseconds, 365 * 24 * 60 * 60_000)),
  ).toISOString();
  const rows = (await db.query<{ id: string }>(sql`DELETE FROM application_jobs
    WHERE id IN(SELECT id FROM application_jobs
      WHERE status IN('succeeded','failed','cancelled')
        AND completed_at IS NOT NULL AND completed_at<${cutoff}
      ORDER BY completed_at,id LIMIT 500)
    RETURNING id`)).rows;
  return rows.length;
}

export async function waitForJob(
  id: string,
  userId: string,
  options: {
    signal?: AbortSignal;
    timeoutMilliseconds?: number;
    progress?(value: Json | null): void;
  } = {},
) {
  const deadline = Date.now() + Math.max(1_000,
    Math.min(options.timeoutMilliseconds ?? 10 * 60_000, 30 * 60_000));
  let previous = "";
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const current = await getJob(id, userId);
    if (!current) throw new Error("Job unavailable");
    const progress = encode(current.progress);
    if (progress !== previous) {
      previous = progress;
      options.progress?.(current.progress);
    }
    if (current.status === "succeeded") return current;
    if (current.status === "failed") throw new Error("Background job failed");
    if (current.status === "cancelled") throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        options.signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, 250);
      const abort = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      timer.unref();
    });
  }
  throw new Error("Background job timed out");
}

const activeJobs = new Map<string, { job: ApplicationJob; controller: AbortController }>();
const wakeWorkers = new Set<() => void>();

export const wakeJobWorker = () => wakeWorkers.forEach((wake) => wake());

export function startJobWorker(handlers: Readonly<Record<string, JobHandler>>) {
  const workerId = randomUUID(), lease = 30_000, kinds = Object.keys(handlers);
  let stopping = false, resume: (() => void) | undefined;
  const wake = () => resume?.();
  const idle = () => new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout;
    resume = () => {
      clearTimeout(timer);
      resume = undefined;
      resolve();
    };
    timer = setTimeout(resume, 5_000);
    timer.unref();
  });
  const execute = async (next: ApplicationJob) => {
    const handler = handlers[next.kind];
    const controller = new AbortController();
    activeJobs.set(workerId, { job: next, controller });
    const pulse = setInterval(() => {
      void heartbeat(next.id, workerId, lease).then((owned) => {
        if (!owned) controller.abort();
      }, () => controller.abort());
    }, 5_000);
    pulse.unref();
    try {
      if (!handler) throw new Error("UnknownJobKind");
      const result = await handler(next, {
        signal: controller.signal,
        progress: async (value) => {
          const data = boundedJson(value, 8 * 1024, "Job progress");
          const updated = await (await relationalDatabase()).query<{ id: string }>(
            sql`UPDATE application_jobs
            SET progress=${data},updated_at=${now()} WHERE id=${next.id}
              AND status='running' AND locked_by=${workerId} RETURNING id`);
          if (!updated.rows[0]) {
            controller.abort();
            throw new DOMException("Aborted", "AbortError");
          }
        },
      });
      if (controller.signal.aborted) await release(next.id, workerId);
      else await finish(next.id, workerId, result);
    } catch (error) {
      if (controller.signal.aborted || stopping) await release(next.id, workerId);
      else await fail(next, workerId, error);
    } finally {
      clearInterval(pulse);
      activeJobs.delete(workerId);
    }
  };
  const active = (async () => {
    let nextPruneAt = 0;
    while (!stopping) {
      try {
        if (Date.now() >= nextPruneAt) {
          await pruneJobs();
          nextPruneAt = Date.now() + 60 * 60_000;
        }
        const next = await claim(workerId, lease, kinds);
        if (next) await execute(next);
        else await idle();
      } catch (error) {
        if (!stopping) {
          console.error("[jobs] worker cycle failed", { error: errorCategory(error) });
          await idle();
        }
      }
    }
  })();
  wakeWorkers.add(wake);
  return {
    wake,
    async stop() {
      stopping = true;
      wake();
      activeJobs.get(workerId)?.controller.abort();
      await active;
      wakeWorkers.delete(wake);
    },
  };
}
