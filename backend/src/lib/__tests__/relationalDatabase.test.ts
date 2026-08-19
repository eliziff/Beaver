import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory = "";
const store = () => import("../relationalDatabase");

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-database-"));
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
  vi.stubEnv("AUTH_MODE", "local");
});
afterEach(async () => {
  await (await store()).closeRelationalDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

describe("local relational database", () => {
  it("uses one configured file and reopens committed state", async () => {
    let module = await store(), database = module.localDatabaseSync();
    expect(database.prepare("PRAGMA database_list").all()).toEqual([
      expect.objectContaining({ name: "main", file: path.join(directory, "application.sqlite") }),
    ]);
    database.prepare(`INSERT INTO projects
      (user_id,id,name,created_at,updated_at) VALUES ('owner','project','Matter','now','now')`).run();
    await module.closeRelationalDatabase();
    vi.resetModules();
    module = await store(); database = module.localDatabaseSync();
    expect(database.prepare("SELECT name FROM projects WHERE id='project'").get())
      .toEqual({ name: "Matter" });
    expect(await readdir(directory)).not.toEqual(expect.arrayContaining([
      "library.sqlite", "legal-knowledge.sqlite", "tabular.sqlite",
    ]));
  });

  it("rolls back failed transactions and cascades project state", async () => {
    const module = await store(), database = module.localDatabaseSync();
    expect(() => module.localTransaction((tx) => {
      tx.prepare(`INSERT INTO projects
        (user_id,id,name,created_at,updated_at) VALUES ('owner','rollback','Matter','now','now')`).run();
      throw new Error("stop");
    })).toThrow("stop");
    expect(database.prepare("SELECT count(*) count FROM projects").get()).toEqual({ count: 0 });
    module.localTransaction((tx) => tx.exec(`
      INSERT INTO projects(user_id,id,name,created_at,updated_at)
        VALUES('owner','project','Matter','now','now');
      INSERT INTO chats(id,user_id,project_id,created_at,updated_at)
        VALUES('chat','owner','project','now','now');
      INSERT INTO provider_sessions(chat_id,user_id,continuation_id,compatibility_key,
        transcript_version,created_at,updated_at)
        VALUES('chat','owner','continuation','key',0,'now','now');
    `));
    database.prepare("DELETE FROM projects WHERE id='project'").run();
    expect(database.prepare("SELECT count(*) count FROM chats").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) count FROM provider_sessions").get()).toEqual({ count: 0 });
  });
});
