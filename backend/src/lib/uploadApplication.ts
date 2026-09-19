import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { DocumentRepository } from "./documentRepository";
import type { DocumentStore } from "./documentStore";
import { documentFileType, contentTypeForDocumentType } from "./documentTypes";
import { validateObjectKey, MAX_OBJECT_SIZE_BYTES, normalizeDownloadFilename, type ObjectStorage } from "./storage";
import { sql, type RelationalDatabase } from "./relational";
import { enqueueJob, type JobHandler, type Json } from "./jobQueue";
import { sha256 } from "./hash";

const upload = z.object({ client_key: z.string().uuid(), filename: z.string().trim().min(1).max(200),
  size_bytes: z.number().int().min(1).max(MAX_OBJECT_SIZE_BYTES), source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  project_id: z.string().uuid().nullable().default(null), folder_id: z.string().uuid().nullable().default(null),
  library_kind: z.enum(["file", "template"]).default("file") }).strict();
type Session = z.infer<typeof upload> & { id: string; user_id: string; user_email: string | null;
  file_type: string; document_id: string; storage_path: string; status: string; job_id: string | null;
  error: string | null; expires_at: string; created_at: string; updated_at: string };
const now = () => new Date().toISOString();
const fail = (status: number, message: string): never => { throw new ApplicationError(status, message); };
const destination = (row: Session | z.infer<typeof upload>) => ({ projectId: row.project_id,
  libraryKind: row.library_kind, folderId: row.folder_id });

export function createUploadApplication(database: RelationalDatabase, objects: ObjectStorage,
  repository: DocumentRepository, documents: DocumentStore) {
  const authorize = async (actor: ApplicationScope, row: Session | z.infer<typeof upload>) => {
    if (await repository.authorizeCreate(actor, destination(row)) !== "ok") fail(404, "Upload destination not found.");
  };
  const load = async (db: RelationalDatabase, actor: ApplicationScope, id: string) =>
    (await db.query<Session>(sql`SELECT * FROM upload_sessions WHERE id=${id} AND user_id=${actor.userId}`)).rows[0]
      ?? fail(404, "Upload not found.");
  const active = (row: Session) => {
    if (row.expires_at <= now()) fail(410, "Upload expired. Select the file again.");
    if (row.status === "cancelled" || row.status === "failed") fail(409, row.error ?? "Upload was cancelled.");
  };
  const view = async (actor: ApplicationScope, row: Session) => {
    const job = row.job_id ? (await database.query(sql`SELECT status FROM application_jobs WHERE id=${row.job_id}`)).rows[0] : null;
    const document = row.status === "complete" ? await documents.metadata(actor, row.document_id) : null;
    const status = row.status === "complete" ? document ? "complete" : "removed"
      : row.expires_at <= now() ? "expired" : job?.status === "failed" ? "failed" : row.status;
    return { id: row.id, filename: row.filename, project_id: row.project_id, folder_id: row.folder_id,
      library_kind: row.library_kind, size_bytes: row.size_bytes, source_sha256: row.source_sha256,
      status, document, expires_at: row.expires_at, retryable: row.status === "queued" && job?.status === "failed",
      error: row.error ?? (status === "failed" ? "Upload processing failed. Retry the upload." : null) };
  };
  return {
    async start(actor: ApplicationScope, input: unknown) {
      const parsed = upload.parse(input), filename = normalizeDownloadFilename(parsed.filename);
      const fields = { ...parsed, filename }, type = documentFileType(filename);
      if (!type.ok) return fail(400, type.error);
      const matching = (old: Session) => {
        if (Object.entries(fields).some(([name, value]) => old[name as keyof Session] !== value))
          return fail(409, "Upload retry does not match its original file or destination.");
        return old;
      };
      await authorize(actor, fields);
      const row = await database.transaction(async (db) => {
        const old = (await db.query<Session>(sql`SELECT * FROM upload_sessions WHERE user_id=${actor.userId}
          AND client_key=${fields.client_key}`)).rows[0];
        if (old) return matching(old);
        const id = randomUUID(), created = now(), expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const key = validateObjectKey(`uploads/${actor.userId}/${id}`);
        // Reserve upload bytes through the existing blob cleanup owner.
        if (!(await db.query(sql`INSERT INTO object_cleanup(storage_path,created_at) VALUES(${key},${created})
          ON CONFLICT(storage_path) DO UPDATE SET created_at=excluded.created_at WHERE object_cleanup.claim_id IS NULL`)).changes)
          return fail(409, "Upload storage is busy. Retry shortly.");
        const inserted = await db.query(sql`INSERT INTO upload_sessions(id,user_id,user_email,client_key,project_id,library_kind,folder_id,
          document_id,filename,file_type,size_bytes,source_sha256,storage_path,created_at,updated_at,expires_at)
          VALUES(${id},${actor.userId},${actor.userEmail ?? null},${fields.client_key},${fields.project_id},${fields.library_kind},
          ${fields.folder_id},${randomUUID()},${filename},${type.fileType},${fields.size_bytes},${fields.source_sha256},${key},${created},${created},${expires})
          ON CONFLICT(user_id,client_key) DO NOTHING`);
        if (!inserted.changes) return matching((await db.query<Session>(sql`SELECT * FROM upload_sessions
          WHERE user_id=${actor.userId} AND client_key=${fields.client_key}`)).rows[0]);
        await enqueueJob({ kind: "upload-cleanup", dedupeKey: id, userId: actor.userId, payload: {}, runAt: expires }, db);
        return load(db, actor, id);
      });
      return view(actor, row);
    },
    async get(actor: ApplicationScope, id: string) {
      const row = await load(database, actor, id); await authorize(actor, row); return view(actor, row);
    },
    async list(actor: ApplicationScope) {
      // ponytail: recovery shows 100 recent sessions, unfinished first; use the shared cursor API if larger queues need browsing.
      const rows = (await database.query<Session>(sql`SELECT * FROM upload_sessions WHERE user_id=${actor.userId}
        AND expires_at>${now()} ORDER BY CASE WHEN status IN('pending','queued') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 100`)).rows;
      const visible = [];
      for (const row of rows) {
        try { await authorize(actor, row); visible.push(await view(actor, row)); }
        catch (error) { if (!(error instanceof ApplicationError) || error.status !== 404) throw error; }
      }
      return visible;
    },
    async transfer(actor: ApplicationScope, id: string) {
      const row = await load(database, actor, id); await authorize(actor, row); active(row);
      if (row.status !== "pending") return fail(409, "Upload is already processing.");
      if (Date.parse(row.expires_at) - Date.now() < 5 * 60 * 1000) return fail(410, "Upload expired. Select the file again.");
      return objects.signedPut ? { kind: "direct" as const, ...await objects.signedPut(row.storage_path, {
        expectedSha256: row.source_sha256, sizeBytes: row.size_bytes, contentType: contentTypeForDocumentType(row.file_type),
      }) } : { kind: "proxy" as const };
    },
    async receive(actor: ApplicationScope, id: string, file: { path: string; sizeBytes: number }) {
      const row = await load(database, actor, id); await authorize(actor, row); active(row);
      if (row.status !== "pending") return fail(409, "Upload is already processing.");
      if (file.sizeBytes !== row.size_bytes) return fail(400, "Uploaded file size does not match the session.");
      if (await repository.recordOrphans([row.storage_path]) !== "staged") return fail(409, "Upload storage is busy. Retry shortly.");
      await objects.put(row.storage_path, file, contentTypeForDocumentType(row.file_type), { expectedSha256: row.source_sha256, timeoutMs: 120_000 });
    },
    async complete(actor: ApplicationScope, id: string) {
      const row = await load(database, actor, id); await authorize(actor, row);
      if (row.status === "complete") return view(actor, row);
      active(row);
      await database.transaction(async (db) => {
        const changed = await db.query(sql`UPDATE upload_sessions SET status='queued',updated_at=${now()}
          WHERE id=${id} AND user_id=${actor.userId} AND status IN('pending','queued') AND expires_at>${now()}`);
        if (!changed.changes) {
          if ((await load(db, actor, id)).status === "complete") return;
          return fail(409, "Upload is no longer active.");
        }
        const job = await enqueueJob({ kind: "upload-document", dedupeKey: id, groupKey: `upload:${id}`,
          userId: actor.userId, payload: { sessionId: id } }, db);
        await db.query(sql`UPDATE upload_sessions SET job_id=${job.id} WHERE id=${id}`);
      });
      return view(actor, await load(database, actor, id));
    },
    async cancel(actor: ApplicationScope, id: string) {
      await load(database, actor, id);
      await database.query(sql`UPDATE upload_sessions SET status='cancelled',updated_at=${now()}
        WHERE id=${id} AND user_id=${actor.userId} AND status IN('pending','queued')`);
    },
    handlers: {
      "upload-cleanup": (async () => { await documents.resumeCleanup(); return { cleaned: true }; }) satisfies JobHandler,
      "upload-document": (async (job, context): Promise<Json> => {
        const id = (job.payload as { sessionId: string }).sessionId;
        const row = await load(database, { userId: job.userId }, id), actor = { userId: row.user_id, userEmail: row.user_email ?? undefined };
        if (row.status !== "queued") return { skipped: true };
        try {
          active(row); await authorize(actor, row);
          const bytes = await objects.get(row.storage_path, { maxBytes: row.size_bytes, signal: context.signal, timeoutMs: 120_000 });
          if (!bytes || bytes.byteLength !== row.size_bytes || sha256(bytes) !== row.source_sha256)
            return fail(400, "Uploaded file failed its integrity check. Select the file again.");
          context.signal.throwIfAborted();
          const document = await documents.create(actor, { ...destination(row), filename: row.filename,
            fileType: row.file_type, bytes, expectedSha256: row.source_sha256, upload: { sessionId: id, documentId: row.document_id } });
          return { documentId: document.id };
        } catch (error) {
          if (!(error instanceof ApplicationError)) throw error;
          await database.query(sql`UPDATE upload_sessions SET status='failed',error=${error.message},updated_at=${now()}
            WHERE id=${id} AND status='queued'`);
          return { failed: true };
        }
      }) satisfies JobHandler,
    },
  };
}
