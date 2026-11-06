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

export class DeferredJobError extends Error {
  name = "DeferredJobError";
  constructor(readonly delayMilliseconds: number) { super("Job deferred"); }
}

export class PermanentJobError extends Error {
  name = "PermanentJobError";
}

// The abort reason used when a running job's lease was taken by another claim.
// Nobody cancelled the work: the attempt that observes this must not record the
// outcome as a cancellation, and the re-attempt has to resume rather than clash.
export class JobLeaseLostError extends Error {
  name = "JobLeaseLostError";
  constructor(readonly jobId: string) { super("Job lease lost"); }
}
export const leaseWasLost = (signal: AbortSignal) =>
  signal.aborted && signal.reason instanceof JobLeaseLostError;

// A single synchronous step (document rendering, a stalled SQLite write) blocks
// the renewal timer, so the lease has to outlast the longest such step by a wide
// margin, not by one renewal period.
const JOB_LEASE_MS = 120_000;
const JOB_HEARTBEAT_MS = 10_000;

const now = () => new Date().toISOString();
const later = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
const decode = (value: unknown): Json | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as Json;
  try { return JSON.parse(value) as Json; } catch { throw new Error("Invalid job JSON"); }
};
const boundedJson = (value: Json, maximum: number, label: string) => {
  const text = JSON.stringify(value);
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
  runAt?: string;
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
      ${input.documentVersionId ?? null},${payload},${priority},'queued',${input.runAt ?? created},0,
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

// A row's lifecycle. `status` is its phase and the other columns qualify it:
//   queued     a future run_at delays it.
//   running    locked_by and locked_until are the lease; cancel_requested_at and
//              interrupt_requested_at ask the holder to stop.
//   succeeded, failed, cancelled    terminal: no lease and no dedupe key.
// A row leaves `running` only through claim (lease expired), endAttempt or
// recoverLocalJobs, and a cancel request outranks every other way out of it.
type Clause = ReturnType<typeof sql>;
const claimable = (at: string) => sql`((status='queued' AND run_at<=${at}) OR
  (status='running' AND locked_until<=${at}))`;
const heldBy = (id: string, workerId: string) => sql`id=${id} AND status='running' AND locked_by=${workerId}`;
const unleased = sql.raw("locked_by=NULL,locked_until=NULL,interrupt_requested_at=NULL");
const terminal = (status: Clause, at: string) =>
  sql`status=${status},dedupe_key=NULL,${unleased},completed_at=${at},updated_at=${at}`;
const requeued = (runAt: string, at: string) =>
  sql`status='queued',run_at=${runAt},${unleased},updated_at=${at}`;
const refundAttempt = sql.raw("attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END");
const CANCELLED = sql.raw("'cancelled'");

/** Ends the rows no attempt can follow: a cancel they asked for ends them as cancelled. */
async function abandon(tx: RelationalDatabase, which: Clause, at: string) {
  const uncancelled = sql.raw("cancel_requested_at IS NULL");
  const rows = await tx.query<{ id: string }>(sql`UPDATE application_jobs SET
    ${terminal(sql`CASE WHEN ${uncancelled} THEN 'failed' ELSE 'cancelled' END`, at)},
    last_error=CASE WHEN ${uncancelled} THEN 'LeaseExpired' ELSE last_error END
    WHERE ${which} AND attempts>=max_attempts RETURNING id`);
  for (const { id } of rows.rows) tx.notifications?.publish(`events:${id}`);
}

async function claim(workerId: string, leaseMilliseconds: number, kinds: string[]) {
  const db = await relationalDatabase(), claimedAt = now(), lockedUntil = later(leaseMilliseconds);
  return db.transaction(async (tx) => {
    await abandon(tx, sql`status='running' AND locked_until<=${claimedAt}`, claimedAt);
    const locking = tx.engine === "postgres" ? sql.raw("FOR UPDATE SKIP LOCKED") : sql.raw("");
    const candidate = (await tx.query<JobRow>(sql`SELECT * FROM application_jobs
      WHERE ${claimable(claimedAt)}
        AND attempts<max_attempts AND kind IN(${sql.join(kinds)})
      ORDER BY priority DESC,run_at,created_at,id LIMIT 1 ${locking}`)).rows[0];
    if (!candidate) return null;
    const updated = (await tx.query<JobRow>(sql`UPDATE application_jobs SET
      status='running',locked_by=${workerId},locked_until=${lockedUntil},
      interrupt_requested_at=NULL,attempts=attempts+1,updated_at=${claimedAt}
      WHERE id=${String(candidate.id)} AND ${claimable(claimedAt)}
      RETURNING *`)).rows[0];
    if (updated) tx.notifications?.publish(`events:${String(updated.id)}`);
    return updated ? job(updated) : null;
  });
}

// "stopped" is a cancel/interrupt the operator asked for, "lost" means the row
// is no longer ours, and "unavailable" is a transient database failure that must
// not end work while the lease it renews is still valid.
type LeaseState = { state: "renewed"; until: number }
  | { state: "stopped" | "lost" | "unavailable" };

async function leaseHeld(id: string, workerId: string) {
  const row = (await (await relationalDatabase()).query<JobRow>(sql`
    SELECT status,locked_by,cancel_requested_at,interrupt_requested_at
    FROM application_jobs WHERE id=${id}`)).rows[0];
  if (!row || String(row.status) !== "running" || row.locked_by !== workerId) return "lost";
  return row.cancel_requested_at || row.interrupt_requested_at ? "stopped" : "held";
}

async function heartbeat(
  id: string, workerId: string, leaseMilliseconds: number,
): Promise<LeaseState> {
  try {
    const db = await relationalDatabase(), timestamp = now();
    const until = Date.now() + leaseMilliseconds;
    const row = (await db.query<JobRow>(sql`UPDATE application_jobs SET
        locked_until=${later(leaseMilliseconds)},updated_at=${timestamp}
      WHERE id=${id} AND status='running' AND locked_by=${workerId}
        AND interrupt_requested_at IS NULL AND cancel_requested_at IS NULL
        RETURNING id`)).rows[0];
    if (row) return { state: "renewed", until };
    const held = await leaseHeld(id, workerId);
    return { state: held === "held" ? "unavailable" : held };
  } catch { return { state: "unavailable" }; }
}

// How an attempt ended. A worker stopped or a lease lost is "released": the job
// is owed another attempt that this one does not pay for.
type AttemptEnd =
  | { end: "succeeded"; result: string }
  | { end: "failed"; error: string }
  | { end: "retry"; error: string; runAt: string }
  | { end: "deferred"; runAt: string }
  | { end: "released" };

function attemptFailed(job: ApplicationJob, error: unknown): AttemptEnd {
  if (error instanceof DeferredJobError) return { end: "deferred",
    runAt: later(Math.max(1000, Math.min(error.delayMilliseconds, 3_600_000))) };
  const exhausted = error instanceof PermanentJobError || job.attempts >= job.maxAttempts;
  const category = errorCategory(error);
  console.warn("[job] attempt failed", { job: job.id, kind: job.kind, attempt: job.attempts, error: category, exhausted });
  return exhausted ? { end: "failed", error: category } : { end: "retry", error: category,
    runAt: later(Math.min(60_000, 2_000 * (2 ** Math.max(0, job.attempts - 1)))) };
}

async function endAttempt(job: ApplicationJob, workerId: string, attempt: AttemptEnd) {
  const held = heldBy(job.id, workerId), at = now();
  await (await relationalDatabase()).transaction(async (tx) => {
    const lock = tx.engine === "postgres" ? sql.raw("FOR UPDATE") : sql.raw("");
    const row = (await tx.query<JobRow>(sql`SELECT cancel_requested_at FROM application_jobs
      WHERE ${held} ${lock}`)).rows[0];
    const update = (set: Clause) => tx.query(sql`UPDATE application_jobs SET ${set} WHERE ${held}`);
    if (row?.cancel_requested_at) await update(terminal(CANCELLED, at));
    else if (row) switch (attempt.end) {
      case "succeeded":
        await update(sql`${terminal(sql.raw("'succeeded'"), at)},result=${attempt.result},last_error=NULL`);
        break;
      case "failed":
        await update(sql`${terminal(sql.raw("'failed'"), at)},last_error=${attempt.error}`);
        break;
      case "retry":
        await update(sql`${requeued(attempt.runAt, at)},last_error=${attempt.error}`);
        break;
      case "deferred":
        await update(sql`${requeued(attempt.runAt, at)},${refundAttempt},last_error=NULL`);
        break;
      case "released":
        await update(sql`${requeued(at, at)},${refundAttempt}`);
    }
    tx.notifications?.publish(`events:${job.id}`);
    if (!row?.cancel_requested_at && !["succeeded", "failed"].includes(attempt.end))
      tx.notifications?.publish(`queue:${job.kind}`);
  });
}

const abortActive = (ids: ReadonlySet<string>) => {
  for (const active of activeJobs.values()) {
    if (ids.has(active.job.id)) active.controller.abort();
  }
};

export async function interruptJobs(groupKey: string, belowPriority: number) {
  const db = await relationalDatabase(), timestamp = now();
  const rows = (await db.query<{ id: string }>(sql`UPDATE application_jobs
    SET interrupt_requested_at=${timestamp},
    updated_at=${timestamp} WHERE group_key=${bounded(groupKey, 500, "Job group")}
      AND status='running' AND priority<${belowPriority} RETURNING id`)).rows;
  for (const { id } of rows) db.notifications?.publish(`control:${id}`);
  abortActive(new Set(rows.map(({ id }) => id)));
}

async function cancelMatching(match: Clause, userId: string) {
  const db = await relationalDatabase(), timestamp = now();
  const owned = sql`${match} AND user_id=${bounded(userId, 200, "Job user")}`;
  const rows = await db.transaction(async (tx) => [
    ...(await tx.query<JobRow>(sql`UPDATE application_jobs SET ${terminal(CANCELLED, timestamp)},
      cancel_requested_at=${timestamp} WHERE ${owned} AND status='queued' RETURNING *`)).rows,
    ...(await tx.query<JobRow>(sql`UPDATE application_jobs SET cancel_requested_at=${timestamp},
      updated_at=${timestamp} WHERE ${owned} AND status='running' RETURNING *`)).rows,
  ]);
  const cancelled = new Set(rows.map((row) => String(row.id)));
  for (const id of cancelled) {
    db.notifications?.publish(`control:${id}`);
    db.notifications?.publish(`events:${id}`);
  }
  abortActive(cancelled);
  return rows;
}

export async function requestJobCancellation(id: string, userId: string) {
  const [row] = await cancelMatching(sql`id=${bounded(id, 100, "Job ID")}`, userId);
  return row ? job(row) : null;
}

export async function requestGroupCancellation(groupKey: string, userId: string) {
  return (await cancelMatching(
    sql`group_key=${bounded(groupKey, 500, "Job group")}`, userId)).length;
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
    await tx.query(sql`UPDATE application_jobs SET ${terminal(CANCELLED, timestamp)}
      WHERE status='running' AND cancel_requested_at IS NOT NULL`);
    // A job on its last attempt has none to be queued for; no worker would ever claim it.
    await abandon(tx, sql.raw("status IN('queued','running')"), timestamp);
    return (await tx.query(sql`UPDATE application_jobs SET ${requeued(timestamp, timestamp)}
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
  type Batch = { rows: Array<ReturnType<typeof sql>>; bytes: number };
  let pending: Batch | undefined;
  return {
    append(value: unknown) {
      const event = boundedJson(jsonValue(value), 512 * 1024, "Job event");
      const bytes = Buffer.byteLength(event);
      // The first write starts on the same microtask boundary as before. Only
      // events already available before a write starts share an INSERT; there
      // is no batching timer and individual events/sequence IDs are unchanged.
      if (!pending || pending.rows.length >= 64 || pending.bytes + bytes > 64 * 1024) {
        const batch: Batch = { rows: [], bytes: 0 };
        pending = batch;
        writes = writes.then(async () => {
          if (pending === batch) pending = undefined;
          try {
            await database.query(sql`INSERT INTO application_job_events(job_id,sequence,event,created_at)
              VALUES ${sql.join(batch.rows)}`);
            database.notifications?.publish(`events:${jobId}`);
          } finally { batch.rows = []; }
        });
        // Keep flush() rejecting, including calls made after failure. Do not
        // continue past a failed batch, publish a false hint, or leak rejections.
        void writes.catch(() => {
          batch.rows = [];
          if (pending === batch) pending = undefined;
        });
      }
      pending.rows.push(sql`(${jobId},${++sequence},${event},${now()})`);
      pending.bytes += bytes;
    },
    flush() {
      // Seal this prefix: later appends cannot extend an outstanding flush.
      pending = undefined;
      return writes;
    },
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

export function startJobWorker(
  handlers: Readonly<Record<string, JobHandler>>,
  options: { leaseMilliseconds?: number; heartbeatMilliseconds?: number } = {},
) {
  const workerId = randomUUID(), kinds = Object.keys(handlers);
  const lease = options.leaseMilliseconds ?? JOB_LEASE_MS;
  const renewEvery = options.heartbeatMilliseconds ?? JOB_HEARTBEAT_MS;
  const shutdown = new AbortController();
  const stopping = () => shutdown.signal.aborted;
  const execute = async (next: ApplicationJob) => {
    const handler = handlers[next.kind];
    const controller = new AbortController();
    if (next.cancelRequested || stopping()) controller.abort();
    activeJobs.set(workerId, { job: next, controller });
    if (next.attempts > 1) console.warn("[job] re-attempt", {
      job: next.id, kind: next.kind, attempt: next.attempts, worker: workerId,
    });
    let leaseUntil = Date.now() + lease;
    const leaseLost = (reason: string) => {
      console.warn("[job] lease lost", {
        job: next.id, kind: next.kind, attempt: next.attempts, worker: workerId, reason,
      });
      controller.abort(new JobLeaseLostError(next.id));
    };
    const controls = await watchJob(next.id, "control");
    const controlStop = new AbortController();
    const controlTask = (async () => {
      while (!controlStop.signal.aborted && !controller.signal.aborted) {
        const version = controls.version;
        const held = await leaseHeld(next.id, workerId);
        if (held === "lost") { leaseLost("claimed by another worker or removed"); return; }
        if (held === "stopped") { controller.abort(); return; }
        await controls.wait(version, controlStop.signal);
      }
    })().catch(() => controller.abort());
    // Renewal never queues behind itself: a stalled write must not stack timers,
    // and a failed one keeps the handler running while the lease is still valid.
    let renewing = false, settled = false;
    const pulse = setInterval(() => {
      if (renewing || settled || controller.signal.aborted) return;
      renewing = true;
      void heartbeat(next.id, workerId, lease).then((result) => {
        if (settled) return;
        if (result.state === "renewed") leaseUntil = result.until;
        else if (result.state === "stopped") controller.abort();
        else if (result.state === "lost") leaseLost("claimed by another worker or removed");
        else if (Date.now() >= leaseUntil) leaseLost("renewal unavailable");
        else console.warn("[job] lease renewal failed", {
          job: next.id, kind: next.kind, msRemaining: leaseUntil - Date.now(),
        });
      }).finally(() => { renewing = false; });
    }, renewEvery);
    pulse.unref();
    const stopRenewal = () => { settled = true; clearInterval(pulse); };
    const stopped = () => stopping() || controller.signal.aborted;
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
        // A report, often not awaited: a lost, cancelled or deleted job stops through its signal instead.
        progress: (value) => checkpoint({ progress: value }).catch(() => undefined),
        checkpoint,
      });
      stopRenewal();
      await endAttempt(next, workerId, stopped() ? { end: "released" }
        : { end: "succeeded", result: boundedJson(result, 16 * 1024, "Job result") });
    } catch (error) {
      // The handler has ended: releasing the lease here is not losing it.
      stopRenewal();
      await endAttempt(next, workerId, stopped() ? { end: "released" } : attemptFailed(next, error));
    } finally {
      stopRenewal();
      controlStop.abort(); controls.close();
      await controlTask;
      activeJobs.delete(workerId);
    }
  };
  const active = (async () => {
    const db = await relationalDatabase();
    const changes = watchJobChanges(db.notifications, kinds.map((kind) => `queue:${kind}`));
    let nextPruneAt = 0, failures = 0;
    try {
      while (!stopping()) {
        const version = changes.version;
        try {
          if (Date.now() >= nextPruneAt) {
            await pruneJobs();
            nextPruneAt = Date.now() + 60 * 60_000;
          }
          const next = await claim(workerId, lease, kinds);
          if (next) await execute(next);
          else await changes.wait(version, shutdown.signal);
          failures = 0;
        } catch (error) {
          if (!stopping()) {
            failures += 1;
            console.error("[jobs] worker cycle failed", { error: errorCategory(error), failures });
            // A failure that persists waits longer each time, and queue notifications do not cut that short.
            await watchJobChanges(undefined, []).wait(0, shutdown.signal, Math.min(30_000, 500 * 2 ** failures));
          }
        }
      }
    } finally { changes.close(); }
  })();
  return {
    async stop() {
      shutdown.abort();
      activeJobs.get(workerId)?.controller.abort();
      await active;
    },
  };
}
