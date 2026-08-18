import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory = "";

async function databaseModule() {
  return import("../localApplicationDatabase");
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-application-db-"));
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
});

afterEach(async () => {
  (await databaseModule()).closeLocalApplicationDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

describe("local application database", () => {
  it("owns one configured file and reopens committed state", async () => {
    let store = await databaseModule();
    let database = store.localApplicationDatabase();
    const files = database.prepare("PRAGMA database_list").all() as {
      name: string; file: string;
    }[];
    expect(files).toEqual([expect.objectContaining({
      name: "main",
      file: path.join(directory, "application.sqlite"),
    })]);
    database.prepare(
      `INSERT INTO legal_knowledge_projects
        (user_id,id,name,sort_order,created_at,updated_at)
       VALUES ('owner','matter','Matter',0,'now','now')`,
    ).run();
    store.closeLocalApplicationDatabase();
    vi.resetModules();

    store = await databaseModule();
    database = store.localApplicationDatabase();
    expect(database.prepare(
      "SELECT name FROM legal_knowledge_projects WHERE user_id='owner' AND id='matter'",
    ).get()).toEqual({ name: "Matter" });
    expect(await readdir(directory)).not.toEqual(expect.arrayContaining([
      "library.sqlite", "legal-knowledge.sqlite",
    ]));
  });

  it("rolls back failures and rejects asynchronous transaction bodies", async () => {
    const store = await databaseModule();
    expect(() => store.localApplicationTransaction((database) => {
      database.prepare(
        `INSERT INTO legal_knowledge_projects
          (user_id,id,name,sort_order,created_at,updated_at)
         VALUES ('owner','rolled-back','Matter',0,'now','now')`,
      ).run();
      throw new Error("stop");
    })).toThrow("stop");
    const asynchronous = async (
      database: ReturnType<typeof store.localApplicationDatabase>,
    ) => {
      await Promise.resolve();
      database.prepare(
        `INSERT INTO legal_knowledge_projects
          (user_id,id,name,sort_order,created_at,updated_at)
         VALUES ('owner','async','Matter',0,'now','now')`,
      ).run();
    };
    expect(() => store.localApplicationTransaction(asynchronous as never))
      .toThrow(/must be synchronous/u);
    await Promise.resolve();
    expect(store.localApplicationDatabase().prepare(
      "SELECT count(*) AS count FROM legal_knowledge_projects",
    ).get()).toEqual({ count: 0 });
  });

  it("cascades metadata while project deletion retains Library documents", async () => {
    const { localApplicationDatabase, localApplicationTransaction } =
      await databaseModule();
    const database = localApplicationDatabase();
    localApplicationTransaction((tx) => tx.exec(`
      INSERT INTO legal_knowledge_projects
        (user_id,id,name,sort_order,created_at,updated_at)
      VALUES ('00000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001','Matter',0,'now','now');
      INSERT INTO mike_matter_metadata(user_id,project_id)
      VALUES ('00000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001');
      INSERT INTO local_library_folders
        (id,user_id,kind,name,parent_folder_id,created_at,updated_at)
      VALUES ('folder','owner','file','Folder',NULL,'now','now');
      INSERT INTO local_library_documents
        (id,user_id,kind,folder_id,created_at,updated_at,filename,payload)
      VALUES ('document','owner','file','folder','now','now','file.pdf','{}');
      INSERT INTO mike_matter_documents
        (user_id,project_id,document_id,created_at)
      VALUES ('00000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001','document','now');
      INSERT INTO local_chats
        (id,user_id,project_id,created_at,updated_at,messages_json)
      VALUES ('20000000-0000-0000-0000-000000000001',
              '00000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001','now','now','[]');
      INSERT INTO local_codex_sessions
        (chat_id,user_id,continuation_id,compatibility_key,
         transcript_version,created_at,updated_at)
      VALUES ('20000000-0000-0000-0000-000000000001',
              '00000000-0000-0000-0000-000000000001',
              '30000000-0000-0000-0000-000000000001','key',0,'now','now');
    `));

    database.prepare("DELETE FROM local_library_folders WHERE id='folder'").run();
    expect(database.prepare(
      "SELECT count(*) AS count FROM mike_matter_documents",
    ).get()).toEqual({ count: 0 });
    database.exec(`
      INSERT INTO local_library_documents
        (id,user_id,kind,created_at,updated_at,filename,payload)
      VALUES ('retained-document','00000000-0000-0000-0000-000000000001',
              'file','now','now','retained.pdf','{}');
      INSERT INTO mike_matter_documents
        (user_id,project_id,document_id,created_at)
      VALUES ('00000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001','retained-document','now');
    `);
    database.prepare(
      "DELETE FROM legal_knowledge_projects WHERE id='10000000-0000-0000-0000-000000000001'",
    ).run();
    expect(database.prepare(
      "SELECT count(*) AS count FROM mike_matter_metadata",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM local_chats",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM local_codex_sessions",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT filename FROM local_library_documents WHERE id='retained-document'",
    ).get()).toEqual({ filename: "retained.pdf" });
  });
});
