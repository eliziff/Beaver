import express from "express";
import request from "supertest";
import { createMemoryRouter } from "../../routes/memory";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalDatabase } from "../localDatabase";
import { decodeJson, sql } from "../relational";
import { createMemoryApplication, type MemoryTarget } from "../memoryApplication";
import { createOrganizationApplication } from "../organizationApplication";
import type { ApplicationJob, JobHandlerContext } from "../jobQueue";

vi.mock("../../middleware/auth", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const actor = req.headers["x-test-reader"] ? reader : owner;
    res.locals.userId = actor.userId; res.locals.userEmail = actor.userEmail; next();
  },
  requireMfaIfEnrolled: (req: express.Request, res: express.Response, next: express.NextFunction) =>
    req.headers["x-test-mfa-required"] ? res.sendStatus(403) : next(),
}));
const owner = { userId: randomUUID(), userEmail: "owner@example.test" },
  reader = { userId: randomUUID(), userEmail: "reader@example.test" };
const app: MemoryTarget = { scope: "app", ownerId: owner.userId };
let db: LocalDatabase, memory: ReturnType<typeof createMemoryApplication>, chatId: string, projectId: string;
const curator = vi.fn(async ({ content, input }: { content: string; input: string }) => [content, input].filter(Boolean).join("\n"));
const context: JobHandlerContext = { signal: new AbortController().signal, progress: async () => {}, checkpoint: async () => {} };
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  const native = new DatabaseSync(":memory:"); native.exec("PRAGMA foreign_keys=ON");
  native.exec(/-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u.exec(readFileSync("schema.sql", "utf8"))![1]);
  db = new LocalDatabase(native); memory = createMemoryApplication(db, curator);
  curator.mockClear(); curator.mockImplementation(async ({ content, input }) => [content, input].filter(Boolean).join("\n"));
  chatId = randomUUID(); projectId = randomUUID();
  await db.query(sql`INSERT INTO projects(id,user_id,name,created_at,updated_at)
    VALUES(${projectId},${owner.userId},'Matter','now','now')`);
  await db.query(sql`INSERT INTO chats(id,user_id,created_at,updated_at) VALUES(${chatId},${owner.userId},'now','now')`);
});
afterEach(async () => { vi.useRealTimers(); await db.close(); });
async function jobs() {
  return (await db.query(sql`SELECT * FROM application_jobs ORDER BY created_at,id`)).rows.map((row): ApplicationJob => ({
    id: String(row.id), kind: String(row.kind), dedupeKey: String(row.dedupe_key), groupKey: String(row.group_key),
    userId: String(row.user_id), payload: decodeJson(row.payload, null), status: "queued", attempts: 0, maxAttempts: 3,
    documentId: null, documentVersionId: null, priority: 0, progress: null, result: null, lastError: null, cancelRequested: false,
  }));
}
async function learn(text = "Use Canadian spelling.") {
  const turn = await memory.capture(owner, chatId, null);
  await memory.complete(owner, turn, { chatId, turnId: randomUUID(), version: Date.now(), text });
}
it("starts off, bounds UTF-8 bytes, and preserves drafts on revision conflicts", async () => {
  expect(await memory.get(owner, app)).toMatchObject({ enabled: false, content: "", revision: 0 });
  await learn(); expect(await jobs()).toHaveLength(0);
  await memory.update(owner, app, { revision: 0, content: "Spelling", enabled: true });
  await expect(memory.update(owner, app, { revision: 0, content: "Stale" })).rejects.toMatchObject({ status: 409 });
  await expect(memory.update(owner, app, { revision: 1, content: String.fromCodePoint(0x1F600).repeat(5000) })).rejects.toMatchObject({ status: 413 });
  await expect(memory.get(reader, app)).rejects.toMatchObject({ status: 404 });
  expect((await memory.capture(owner, chatId, null)).message?.role).toBe("user");
});
it("excludes private app memory from shared projects and new shared-review chats", async () => {
  await memory.update(owner, app, { revision: 0, content: "PRIVATE preference", enabled: true });
  const target: MemoryTarget = { scope: "project", ownerId: projectId };
  await memory.update(owner, target, { revision: 0, content: "Project convention", enabled: true });
  const organizations = createOrganizationApplication(db);
  await organizations.grant(owner, "project", projectId, reader.userEmail, "viewer");
  const captured = await memory.capture(owner, null, projectId);
  expect(captured.shared).toBe(true); expect(captured.message?.content).not.toContain("PRIVATE");
  expect(captured.message?.content).toContain("Project convention");
  expect(await memory.get(reader, target)).toMatchObject({ canEdit: false });
  await expect(memory.update(reader, target, { revision: 1, content: "Edit" })).rejects.toMatchObject({ status: 404 });
  const review = randomUUID();
  await db.query(sql`INSERT INTO tabular_reviews(id,user_id,created_at,updated_at) VALUES(${review},${owner.userId},'now','now')`);
  await organizations.grant(owner, "review", review, reader.userEmail, "viewer");
  expect((await memory.capture(owner, null, null, review)).message).toBeNull();
});
it("queues once per attributed turn and extends the five-minute quiet period", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  await memory.update(owner, app, { revision: 0, enabled: true });
  const turn = await memory.capture(owner, chatId, null), input = { chatId, turnId: randomUUID(), version: Date.now(), text: "Use Canadian spelling." };
  await memory.complete(owner, turn, input); await memory.complete(owner, turn, input);
  expect(await jobs()).toHaveLength(1);
  vi.setSystemTime(new Date("2026-09-19T12:02:00Z")); await learn("Use numbered paragraphs.");
  expect((await db.query(sql`SELECT run_at FROM application_jobs`)).rows.every((row) => row.run_at === "2026-09-19T12:07:00.000Z")).toBe(true);
  const job = (await jobs())[0];
  await expect(memory.handler(job, context)).rejects.toMatchObject({ name: "DeferredJobError" });
  vi.advanceTimersByTime(5 * 60 * 1000);
  expect(await memory.handler(job, context)).toEqual({ updated: true });
  expect(await memory.handler(job, context)).toEqual({ skipped: true });
  expect(curator).toHaveBeenCalledOnce();
});
it("deletion fences a running curator and keeps the enabled setting", async () => {
  await memory.update(owner, app, { revision: 0, content: "Old", enabled: true }); await learn();
  vi.advanceTimersByTime(5 * 60 * 1000);
  let finish!: (content: string) => void;
  curator.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const running = memory.handler((await jobs())[0], context);
  await vi.waitFor(() => expect(curator).toHaveBeenCalledOnce());
  await memory.update(owner, app, { revision: 1, clear: true }); finish("Resurrected");
  expect(await running).toEqual({ skipped: true });
  expect(await memory.get(owner, app)).toMatchObject({ content: "", enabled: true });
});
it("pause retains content and neither re-enable nor audience changes backfill old turns", async () => {
  await memory.update(owner, app, { revision: 0, content: "Keep", enabled: true });
  const captured = await memory.capture(owner, chatId, null);
  await memory.update(owner, app, { revision: 1, enabled: false });
  await memory.update(owner, app, { revision: 2, enabled: true });
  await memory.complete(owner, captured, { chatId, turnId: "stale", version: 1, text: "Old turn" });
  expect(await jobs()).toHaveLength(0); expect((await memory.get(owner, app)).content).toBe("Keep");
  const org = createOrganizationApplication(db);
  await org.grant(owner, "chat", chatId, reader.userEmail, "editor");
  const shared = await memory.capture(owner, chatId, null);
  await org.grant(owner, "chat", chatId, reader.userEmail, null);
  await memory.complete(owner, shared, { chatId, turnId: "shared", version: 1, text: "Shared turn" });
  expect(await jobs()).toHaveLength(0);
});
it("rechecks project permissions after curation and never passes app memory to the curator", async () => {
  const target: MemoryTarget = { scope: "project", ownerId: projectId };
  await memory.update(owner, app, { revision: 0, enabled: true, content: "PRIVATE" });
  await memory.update(owner, target, { revision: 0, enabled: true, content: "Project" });
  const org = createOrganizationApplication(db);
  await org.grant(owner, "project", projectId, reader.userEmail, "editor");
  await db.query(sql`UPDATE chats SET project_id=${projectId} WHERE id=${chatId}`);
  const turn = await memory.capture(reader, chatId, projectId);
  await memory.complete(reader, turn, { chatId, turnId: "reader-turn", version: 1, text: "The hearing is Monday." });
  vi.advanceTimersByTime(5 * 60 * 1000);
  let finish!: (content: string) => void;
  curator.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = memory.handler((await jobs())[0], context);
  await vi.waitFor(() => expect(curator).toHaveBeenCalledOnce());
  expect(JSON.stringify(curator.mock.calls)).not.toContain("PRIVATE");
  await org.grant(owner, "project", projectId, reader.userEmail, "viewer"); finish("New content");
  expect(await pending).toEqual({ skipped: true });
  expect((await memory.get(owner, target)).content).toBe("Project");
});
it("concurrent curators cannot overwrite each other; the loser retries against the latest revision", async () => {
  await memory.update(owner, app, { revision: 0, enabled: true }); await learn("First");
  chatId = randomUUID();
  await db.query(sql`INSERT INTO chats(id,user_id,created_at,updated_at) VALUES(${chatId},${owner.userId},'now','now')`);
  await learn("Second");
  vi.advanceTimersByTime(5 * 60 * 1000);
  const pending: { finish(value: string): void; value: string }[] = [];
  curator.mockImplementation(({ content, input }) => new Promise((finish) => pending.push({ finish, value: content + input })));
  const queued = await jobs(), first = memory.handler(queued[0], context), second = memory.handler(queued[1], context);
  const result = Promise.allSettled([first, second]);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[0].finish(pending[0].value); await first;
  pending[1].finish(pending[1].value);
  expect((await result).map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
  curator.mockImplementation(async ({ content, input }) => content + input);
  await memory.handler(queued[1], context);
  const saved = (await memory.get(owner, app)).content;
  expect(saved).toContain("First"); expect(saved).toContain("Second");
});

it("exposes scoped memory through validated, MFA-protected HTTP operations", async () => {
  vi.useRealTimers();
  const api = express(); api.use(express.json()); api.use("/memory", createMemoryRouter(memory));
  expect((await request(api).get("/memory/app")).body).toMatchObject({ enabled: false, ownerId: owner.userId });
  expect((await request(api).patch("/memory/app").send({ revision: 0, enabled: true, ownerId: reader.userId })).status).toBe(400);
  expect((await request(api).patch("/memory/app").set("x-test-mfa-required", "yes").send({ revision: 0, enabled: true })).status).toBe(403);
  expect((await request(api).patch("/memory/app").send({ revision: 0, enabled: true, content: "Private" })).status).toBe(200);
  expect((await request(api).get("/memory/app").set("x-test-reader", "yes")).body.content).toBe("");
  expect((await request(api).post("/memory/app/clear").send({ revision: 0 })).status).toBe(409);
  expect((await request(api).post("/memory/app/clear").send({ revision: 1 })).body).toMatchObject({ content: "", enabled: true });
  expect((await request(api).get(`/memory/projects/${projectId}`).set("x-test-reader", "yes")).status).toBe(404);
});

it("inherits the draft's project audience before the first chat turn and after sharing is revoked", async () => {
  const { chatAccess } = await import("../resourceAccess");
  await memory.update(owner, app, { revision: 0, enabled: true, content: "PRIVATE" });
  const org = createOrganizationApplication(db), draftId = randomUUID();
  await org.grant(owner, "project", projectId, reader.userEmail, "editor");
  await db.query(sql`INSERT INTO work_products(id,user_id,project_id,kind,title,created_at,updated_at)
    VALUES(${draftId},${reader.userId},${projectId},'authorities','Draft','now','now')`);
  expect((await memory.capture(owner, null, null, null, draftId)).message).toBeNull();
  await db.query(sql`UPDATE chats SET user_id=${reader.userId},work_product_id=${draftId} WHERE id=${chatId}`);
  expect((await org.access(reader, "chat", chatId)).inherited).toEqual({ kind: "project", id: projectId });
  await org.grant(owner, "project", projectId, reader.userEmail, null);
  expect((await db.query(sql`SELECT c.id FROM chats c WHERE c.id=${chatId} AND ${chatAccess(reader)}`)).rows).toHaveLength(0);
});
