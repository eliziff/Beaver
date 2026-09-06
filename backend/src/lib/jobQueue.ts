import { randomUUID } from "node:crypto";
import { watchJobChanges } from "./jobNotifications";
import {
  relationalDatabase,
  sql,
  type RelationalDatabase,
} from "./relationalDatabase";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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
  cancelRequested: boolean;
};

type JobRow = Record<string, unknown>;
export type JobHandlerContext = {
  signal: AbortSignal;
  progress(value: Json): Promise<void>;
  checkpoint(value: { payload?: Json; progress?: Json; groupKey?: string }): Promise<void>;
};
export type JobHandler = (job: ApplicationJob, context: JobHandlerContext) => Promise<Json>;

export class PermanentJobError extends Error {
  name = "PermanentJobError";
}

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
const errorCategory = (error: unknown) => {
  // PermanentJobError messages are controlled rejection codes, safe to persist;
  // other error messages may embed provider detail and must stay name-only.
  if (error instanceof PermanentJobError && error.name === "PermanentJobError") {
    return error.message.trim().slice(0, 120) || "PermanentJobError";
  }
  return (error instanceof Error ? error.name : "JobError")
    .replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 120) || "JobError";
};
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
  cancelRequested: typeof row.cancel_requested_at === "string",
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
  const payload = boundedJson(input.payload, 256 * 1024, "Job payload");
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
  const queued = job(rows[0]);
  db.notifications?.publish(`queue:${kind}`);
  return queued;
}

async function claim(workerId: string, leaseMilliseconds: number, kinds: string[]) {
  const db = await relationalDatabase(), claimedAt = now(), lockedUntil = later(leaseMilliseconds);
  return db.transaction(async (tx) => {
    const expired = await tx.query<{ id: string }>(sql`UPDATE application_jobs SET status='failed',dedupe_key=NULL,
      locked_by=NULL,locked_until=NULL,interrupt_requested_at=NULL,
      last_error='LeaseExpired',completed_at=${claimedAt},updated_at=${claimedAt}
      WHERE status='running' AND locked_until<=${claimedAt} AND attempts>=max_attempts
      RETURNING id`);
    for (const { id } of expired.rows) tx.notifications?.publish(`events:${id}`);
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
    if (updated) tx.notifications?.publish(`events:${String(updated.id)}`);
    return updated ? job(updated) : null;
  });
}

async function heartbeat(id: string, workerId: string, leaseMilliseconds: number) {
  const db = await relationalDatabase(), timestamp = now();
  const row = (await db.query<JobRow>(sql`UPDATE application_jobs SET
      locked_until=${later(leaseMilliseconds)},updated_at=${timestamp}
    WHERE id=${id} AND status='running' AND locked_by=${workerId}
      AND interrupt_requested_at IS NULL AND cancel_requested_at IS NULL
      RETURNING id`)).rows[0];
  return !!row;
}

async function finish(id: string, workerId: string, result: Json) {
  const db = await relationalDatabase(), timestamp = now();
  const value = boundedJson(result, 16 * 1024, "Job result");
  await db.transaction(async (tx) => {
    const succeeded = (await tx.query<{ id: string }>(sql`UPDATE application_jobs SET
      status='succeeded',result=${value},last_error=NULL,dedupe_key=NULL,
      locked_by=NULL,locked_until=NULL,completed_at=${timestamp},updated_at=${timestamp}
      WHERE id=${id} AND status='running' AND locked_by=${workerId}
        AND cancel_requested_at IS NULL RETURNING id`)).rows[0];
    if (!succeeded) await tx.query(sql`UPDATE application_jobs SET status='cancelled',
      dedupe_key=NULL,locked_by=NULL,locked_until=NULL,completed_at=${timestamp},
      updated_at=${timestamp} WHERE id=${id} AND status='running'
        AND locked_by=${workerId} AND cancel_requested_at IS NOT NULL`);
    tx.notifications?.publish(`events:${id}`);
  });
}

async function completeCancellation(id: string, workerId: string) {
  const timestamp = now();
  const db = await relationalDatabase();
  await db.query(sql`UPDATE application_jobs SET
    status='cancelled',dedupe_key=NULL,locked_by=NULL,locked_until=NULL,
    completed_at=${timestamp},updated_at=${timestamp}
    WHERE id=${id} AND status='running' AND locked_by=${workerId}
      AND cancel_requested_at IS NOT NULL`);
  db.notifications?.publish(`events:${id}`);
}

async function release(id: string, workerId: string, kind: string) {
  const db = await relationalDatabase(), timestamp = now();
  await db.query(sql`UPDATE application_jobs SET status='queued',run_at=${timestamp},
    attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END,
    locked_by=NULL,locked_until=NULL,interrupt_requested_at=NULL,updated_at=${timestamp}
    WHERE id=${id} AND status='running' AND locked_by=${workerId}`);
  db.notifications?.publish(`queue:${kind}`);
  db.notifications?.publish(`events:${id}`);
}

async function fail(job: ApplicationJob, workerId: string, error: unknown) {
  const db = await relationalDatabase(), timestamp = now();
  const exhausted = error instanceof PermanentJobError || job.attempts >= job.maxAttempts;
  const delay = Math.min(60_000, 2_000 * (2 ** Math.max(0, job.attempts - 1)));
  const category = errorCategory(error);
  await db.query(sql`UPDATE application_jobs SET status=${exhausted ? "failed" : "queued"},
    run_at=${later(delay)},last_error=${category},locked_by=NULL,locked_until=NULL,
    interrupt_requested_at=NULL,dedupe_key=${exhausted ? null : job.dedupeKey},
    completed_at=${exhausted ? timestamp : null},updated_at=${timestamp}
    WHERE id=${job.id} AND status='running' AND locked_by=${workerId}`);
  db.notifications?.publish(`events:${job.id}`);
  if (!exhausted) db.notifications?.publish(`queue:${job.kind}`);
}

export async function interruptJobs(groupKey: string, belowPriority: number) {
  const db = await relationalDatabase(), timestamp = now();
  const rows = (await db.query<{ id: string }>(sql`UPDATE application_jobs
    SET interrupt_requested_at=${timestamp},
    updated_at=${timestamp} WHERE group_key=${bounded(groupKey, 500, "Job group")}
      AND status='running' AND priority<${belowPriority} RETURNING id`)).rows;
  for (const { id } of rows) db.notifications?.publish(`control:${id}`);
  const interrupted = new Set(rows.map(({ id }) => id));
  for (const active of activeJobs.values()) {
    if (interrupted.has(active.job.id)) active.controller.abort();
  }
}

export async function requestJobCancellation(id: string, userId: string) {
  const db = await relationalDatabase(), timestamp = now();
  const row = (await db.query<JobRow>(sql`UPDATE application_jobs SET
    status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
    cancel_requested_at=${timestamp},
    dedupe_key=CASE WHEN status='queued' THEN NULL ELSE dedupe_key END,
    completed_at=CASE WHEN status='queued' THEN ${timestamp} ELSE completed_at END,
    updated_at=${timestamp}
    WHERE id=${bounded(id, 100, "Job ID")} AND user_id=${bounded(userId, 200, "Job user")}
      AND status IN('queued','running') RETURNING *`)).rows[0];
  if (!row) return null;
  const current = job(row);
  db.notifications?.publish(`control:${current.id}`);
  db.notifications?.publish(`events:${current.id}`);
  for (const active of activeJobs.values()) {
    if (active.job.id === current.id) active.controller.abort();
  }
  return current;
}

export async function requestGroupCancellation(groupKey: string, userId: string) {
  const db = await relationalDatabase(), timestamp = now();
  const rows = (await db.query<{ id: string }>(sql`UPDATE application_jobs SET
    status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
    cancel_requested_at=${timestamp},
    dedupe_key=CASE WHEN status='queued' THEN NULL ELSE dedupe_key END,
    completed_at=CASE WHEN status='queued' THEN ${timestamp} ELSE completed_at END,
    updated_at=${timestamp}
    WHERE group_key=${bounded(groupKey, 500, "Job group")}
      AND user_id=${bounded(userId, 200, "Job user")}
      AND status IN('queued','running') RETURNING id`)).rows;
  for (const { id } of rows) {
    db.notifications?.publish(`control:${id}`);
    db.notifications?.publish(`events:${id}`);
  }
  const cancelled = new Set(rows.map(({ id }) => id));
  for (const active of activeJobs.values()) {
    if (cancelled.has(active.job.id)) active.controller.abort();
  }
  return rows.length;
}

export async function jobCancellationRequested(id: string, workerId?: string) {
  const owner = workerId ? sql`AND locked_by=${workerId}` : sql.raw("");
  const row = (await (await relationalDatabase()).query<{ id: string }>(sql`
    SELECT id FROM application_jobs WHERE id=${id} AND status='running'
      ${owner} AND cancel_requested_at IS NOT NULL`)).rows[0];
  return !!row;
}

export async function activeJobForGroup(groupKey: string, userId: string) {
  const db = await relationalDatabase();
  const row = (await db.query<JobRow>(sql`SELECT * FROM application_jobs
    WHERE group_key=${bounded(groupKey, 500, "Job group")}
      AND status IN('queued','running') AND user_id=${bounded(userId, 200, "Job user")}
    ORDER BY created_at,id LIMIT 1`)).rows[0];
  return row ? job(row) : null;
}

export async function recoverLocalJobs() {
  const db = await relationalDatabase();
  if (db.engine !== "sqlite") return 0;
  const timestamp = now();
  return db.transaction(async (tx) => {
    await tx.query(sql`UPDATE application_jobs SET status='cancelled',dedupe_key=NULL,
      locked_by=NULL,locked_until=NULL,completed_at=${timestamp},updated_at=${timestamp}
      WHERE status='running' AND cancel_requested_at IS NOT NULL`);
    return (await tx.query(sql`UPDATE application_jobs SET status='queued',
      run_at=${timestamp},locked_by=NULL,locked_until=NULL,
      interrupt_requested_at=NULL,updated_at=${timestamp}
      WHERE status='running'`)).changes;
  });
}

export async function getJob(id: string, userId: string) {
  const db = await relationalDatabase();
  const row = (await db.query<JobRow>(sql`SELECT * FROM application_jobs
    WHERE id=${bounded(id, 100, "Job ID")}
      AND user_id=${bounded(userId, 200, "Job user")}`)).rows[0];
  return row ? job(row) : null;
}

export const jsonValue = (value: unknown) =>
  JSON.parse(JSON.stringify(value ?? null)) as Json;

export async function createJobEventWriter(jobId: string) {
  const database = await relationalDatabase();
  let sequence = Number((await database.query<{ sequence: number }>(sql`
    SELECT COALESCE(MAX(sequence),0) sequence FROM application_job_events
    WHERE job_id=${jobId}`)).rows[0]?.sequence ?? 0), writes = Promise.resolve();
  return {
    append(value: unknown) {
      const event = boundedJson(jsonValue(value), 512 * 1024, "Job event");
      const current = ++sequence, created = now();
      writes = writes.then(async () => { await database.query(sql`INSERT INTO
        application_job_events(job_id,sequence,event,created_at)
        VALUES(${jobId},${current},${event},${created})`);
        database.notifications?.publish(`events:${jobId}`);
      });
      // Keep flush() rejecting, but observe the rejection even if the provider
      // does not yield control back to the handler immediately.
      void writes.catch(() => undefined);
    },
    flush: () => writes,
  };
}

export async function readJobEvents(userId: string, jobId: string, after: number) {
  const rows = (await (await relationalDatabase()).query<{
    sequence: number; event: unknown;
  }>(sql`SELECT e.sequence,e.event FROM application_job_events e
    JOIN application_jobs j ON j.id=e.job_id WHERE e.job_id=${jobId}
      AND j.user_id=${bounded(userId, 200, "Job user")} AND e.sequence>${after}
    ORDER BY e.sequence LIMIT 500`)).rows;
  return rows.map((row) => ({ sequence: Number(row.sequence), event: decode(row.event) }));
}

export async function enqueueJobCommand(
  userId: string,
  jobId: string,
  kind: string,
  payload: Json,
) {
  const database = await relationalDatabase(), created = now();
  const inserted = await database.query<{ id: string }>(sql`INSERT INTO application_job_commands(
    id,job_id,kind,payload,created_at)
    SELECT ${randomUUID()},id,${bounded(kind, 80, "Job command")},
      ${boundedJson(payload, 128 * 1024, "Job command")},${created}
    FROM application_jobs WHERE id=${jobId} AND user_id=${bounded(userId, 200, "Job user")}
      AND status='running' RETURNING id`);
  if (!inserted.rows.length) return false;
  database.notifications?.publish(`control:${jobId}`);
  return true;
}

export async function pendingJobCommands(jobId: string) {
  return (await (await relationalDatabase()).query<{
    id: string; kind: string; payload: unknown;
  }>(sql`SELECT id,kind,payload FROM application_job_commands
    WHERE job_id=${jobId} AND handled_at IS NULL ORDER BY created_at,id LIMIT 20`)).rows
    .map((row) => ({ ...row, payload: decode(row.payload) }));
}

export async function finishJobCommand(id: string) {
  await (await relationalDatabase()).query(sql`UPDATE application_job_commands
    SET handled_at=${now()} WHERE id=${id} AND handled_at IS NULL`);
}

export async function watchJob(jobId: string, kind: "events" | "control") {
  return watchJobChanges((await relationalDatabase()).notifications, [`${kind}:${jobId}`]);
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

const activeJobs = new Map<string, { job: ApplicationJob; controller: AbortController }>();

export function startJobWorker(handlers: Readonly<Record<string, JobHandler>>) {
  const workerId = randomUUID(), lease = 30_000, kinds = Object.keys(handlers);
  let stopping = false;
  const shutdown = new AbortController();
  const execute = async (next: ApplicationJob) => {
    const handler = handlers[next.kind];
    const controller = new AbortController();
    if (next.cancelRequested || stopping) controller.abort();
    activeJobs.set(workerId, { job: next, controller });
    const controls = await watchJob(next.id, "control");
    const controlStop = new AbortController();
    const controlTask = (async () => {
      while (!controlStop.signal.aborted && !controller.signal.aborted) {
        const version = controls.version;
        const owned = await (await relationalDatabase()).query<{ id: string }>(sql`
          SELECT id FROM application_jobs WHERE id=${next.id} AND locked_by=${workerId}
            AND status='running' AND cancel_requested_at IS NULL AND interrupt_requested_at IS NULL`);
        if (!owned.rows.length) { controller.abort(); return; }
        await controls.wait(version, controlStop.signal);
      }
    })().catch(() => controller.abort());
    const pulse = setInterval(() => {
      void heartbeat(next.id, workerId, lease).then((owned) => {
        if (!owned) controller.abort();
      }, () => controller.abort());
    }, 5_000);
    pulse.unref();
    const releaseOrCancel = async () => {
      if (!stopping && controller.signal.aborted &&
          await jobCancellationRequested(next.id, workerId))
        await completeCancellation(next.id, workerId);
      else await release(next.id, workerId, next.kind);
    };
    try {
      controller.signal.throwIfAborted();
      if (!handler) throw new Error("UnknownJobKind");
      const checkpoint: JobHandlerContext["checkpoint"] = async (value) => {
        const payload = Object.hasOwn(value, "payload") ? value.payload! : next.payload;
        const progress = Object.hasOwn(value, "progress") ? value.progress! : next.progress;
        const groupKey = value.groupKey === undefined ? next.groupKey
          : bounded(value.groupKey, 500, "Job group");
        const updated = await (await relationalDatabase()).query<{ id: string }>(sql`
          UPDATE application_jobs SET payload=${boundedJson(payload, 256 * 1024, "Job payload")},
            progress=${progress === null ? null : boundedJson(progress, 16 * 1024, "Job progress")},
            group_key=${groupKey},updated_at=${now()} WHERE id=${next.id}
            AND status='running' AND locked_by=${workerId} RETURNING id`);
        if (!updated.rows[0]) {
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        }
        next.payload = payload; next.progress = progress; next.groupKey = groupKey;
      };
      const result = await handler(next, {
        signal: controller.signal,
        progress: (value) => checkpoint({ progress: value }),
        checkpoint,
      });
      if (stopping || controller.signal.aborted) await releaseOrCancel();
      else await finish(next.id, workerId, result);
    } catch (error) {
      if (stopping || controller.signal.aborted) await releaseOrCancel();
      else await fail(next, workerId, error);
    } finally {
      clearInterval(pulse);
      controlStop.abort(); controls.close();
      await controlTask;
      activeJobs.delete(workerId);
    }
  };
  const active = (async () => {
    const db = await relationalDatabase();
    const changes = watchJobChanges(db.notifications, kinds.map((kind) => `queue:${kind}`));
    let nextPruneAt = 0;
    try {
      while (!stopping) {
        const version = changes.version;
        try {
          if (Date.now() >= nextPruneAt) {
            await pruneJobs();
            nextPruneAt = Date.now() + 60 * 60_000;
          }
          const next = await claim(workerId, lease, kinds);
          if (next) await execute(next);
          else await changes.wait(version, shutdown.signal);
        } catch (error) {
          if (!stopping) {
            console.error("[jobs] worker cycle failed", { error: errorCategory(error) });
            await changes.wait(changes.version, shutdown.signal);
          }
        }
      }
    } finally { changes.close(); }
  })();
  return {
    async stop() {
      stopping = true;
      shutdown.abort();
      activeJobs.get(workerId)?.controller.abort();
      await active;
    },
  };
}
