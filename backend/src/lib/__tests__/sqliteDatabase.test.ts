import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory = "";
const module = () => import("../sqliteDatabase");

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-sqlite-"));
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
});
afterEach(async () => {
  (await module()).closeSqliteDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

describe("SQLite persistence", () => {
  it("owns one configured file and reopens committed state", async () => {
    let store = await module(), database = store.sqliteDatabase();
    expect(database.prepare("PRAGMA database_list").all()).toEqual([
      expect.objectContaining({ name: "main", file: path.join(directory, "application.sqlite") }),
    ]);
    database.prepare(`INSERT INTO projects
      (user_id,id,name,created_at,updated_at) VALUES ('owner','project','Matter','now','now')`).run();
    store.closeSqliteDatabase();
    vi.resetModules();
    store = await module();
    database = store.sqliteDatabase();
    expect(database.prepare("SELECT name FROM projects WHERE id='project'").get())
      .toEqual({ name: "Matter" });
    expect(await readdir(directory)).not.toEqual(expect.arrayContaining([
      "library.sqlite", "legal-knowledge.sqlite", "tabular.sqlite",
    ]));
  });

  it("rolls back failures and rejects asynchronous transaction bodies", async () => {
    const store = await module();
    expect(() => store.sqliteTransaction((database) => {
      database.prepare(`INSERT INTO projects
        (user_id,id,name,created_at,updated_at) VALUES ('owner','rollback','Matter','now','now')`).run();
      throw new Error("stop");
    })).toThrow("stop");
    expect(() => store.sqliteTransaction((async () => {}) as never))
      .toThrow(/must be synchronous/u);
    expect(store.sqliteDatabase().prepare("SELECT count(*) count FROM projects").get())
      .toEqual({ count: 0 });
  });

  it("cascades project folders, chats, and sessions without deleting Library documents", async () => {
    const { sqliteDatabase, sqliteTransaction } = await module(), database = sqliteDatabase();
    sqliteTransaction((tx) => tx.exec(`
      INSERT INTO projects (user_id,id,name,created_at,updated_at)
        VALUES ('owner','project','Matter','now','now');
      INSERT INTO project_subfolders
        (id,user_id,project_id,name,created_at,updated_at)
        VALUES ('project-folder','owner','project','Folder','now','now');
      INSERT INTO documents
        (id,user_id,kind,created_at,updated_at,filename)
        VALUES ('library-document','owner','file','now','now','file.pdf');
      INSERT INTO chats
        (id,user_id,project_id,created_at,updated_at)
        VALUES ('chat','owner','project','now','now');
      INSERT INTO provider_sessions
        (chat_id,user_id,continuation_id,compatibility_key,transcript_version,created_at,updated_at)
        VALUES ('chat','owner','continuation','key',0,'now','now');
    `));
    database.prepare("DELETE FROM projects WHERE id='project'").run();
    for (const table of ["project_subfolders", "chats", "provider_sessions"]) {
      expect(database.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(database.prepare(
      "SELECT filename FROM documents WHERE id='library-document'",
    ).get()).toEqual({ filename: "file.pdf" });
  });
});
