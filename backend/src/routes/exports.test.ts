import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { LocalDatabase } from "../lib/localDatabase";
import { sql } from "../lib/relational";
import { buildProjectExportManifest } from "../lib/userDataExport";
import { verifyExport } from "mike/shared/export-integrity.mjs";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("downloads a signed local project snapshot and publishes only the public identity", async () => {
  const owner = randomUUID(), projectId = randomUUID(), seed = 'ab'.repeat(32);
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("LOCAL_USER_ID", owner); vi.stubEnv("MANIFEST_SIGNING_KEY", seed);
  const native = new DatabaseSync(":memory:");
  native.exec(/-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u.exec(readFileSync("schema.sql", "utf8"))![1]);
  const db = new LocalDatabase(native);
  try {
    await db.query(sql`INSERT INTO projects(id,user_id,name,created_at,updated_at)
      VALUES(${projectId},${owner},'Matter','now','now')`);
    const { createExportsRouter } = await import("./exports");
    const api = express(); api.use("/exports", createExportsRouter((scope, id) => buildProjectExportManifest(db, scope, id)));
    const identity = await request(api).get("/exports/signing-key");
    expect(identity.status).toBe(200); expect(JSON.stringify(identity.body)).not.toContain(seed);
    const response = await request(api).get(`/exports/projects/${projectId}`);
    expect(response.status).toBe(200); expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.body.data.project.id).toBe(projectId);
    expect(verifyExport(response.body, identity.body.public_key)).toEqual({ signed: true, trusted: true });
    expect((await request(api).get('/exports/projects/invalid')).status).toBe(400);
    expect((await request(api).get(`/exports/projects/${randomUUID()}`)).status).toBe(404);
  } finally { await db.close(); }
});
