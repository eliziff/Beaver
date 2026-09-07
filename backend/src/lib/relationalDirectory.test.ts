import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { RelationalDatabase, SqlStatement } from "./relational";
import { libraryRepository } from "./relationalLibraryRepository";
import { projectRepository } from "./relationalProjectRepository";

let database: RelationalDatabase, native: DatabaseSync;
vi.mock("./relationalDatabase", async () => ({
  ...await import("./relational"), relationalDatabase: async () => database,
}));
const scope = { userId: "alice", userEmail: " ALICE@example.com " };
const options = { q: "", parentFolderId: null, limit: 100, after: null };
type Options = Parameters<typeof libraryRepository.page>[1];
const library = (input: Partial<Options> = {}) =>
  libraryRepository.page({ ...scope, kind: "file" }, { ...options, ...input });
const project = (input: Partial<Options> = {}) =>
  projectRepository.directory(scope, "owned", { ...options, ...input });
const ids = (page: Awaited<ReturnType<typeof library>>) => page.items.map((item) =>
  item.kind === "folder" ? item.folder.id : item.id);

beforeEach(() => {
  native = new DatabaseSync(":memory:");
  database = { engine: "sqlite", async query<T extends Record<string, unknown>>(statement: SqlStatement) {
    const bindings = Object.fromEntries(statement.params.map((value, i) => [`$${i + 1}`, value]));
    return { rows: native.prepare(statement.text).all(bindings) as T[], changes: 0 };
  }, transaction: async (run) => run(database), close: async () => native.close() };
  native.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE project_members(project_id TEXT,email TEXT);
    CREATE TABLE library_folders(id TEXT PRIMARY KEY,user_id TEXT,library_kind TEXT,name TEXT,
      parent_folder_id TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE project_subfolders(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,
      parent_folder_id TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE documents(id TEXT PRIMARY KEY,user_id TEXT,project_id TEXT,library_kind TEXT,
      filename TEXT,library_folder_id TEXT,folder_id TEXT);
    INSERT INTO projects VALUES ('owned','alice','Owned','created','updated'),
      ('shared','bob','Shared','created','updated'),('private','bob','Private','created','updated');
    INSERT INTO project_members VALUES ('shared','alice@example.com');
  `);
  for (const prefix of ["l", "p"]) {
    for (const [id, name, parent] of [["a", "ALPHA", null], ["b", "alpha", null],
      ["z", "Zulu", null], ["child", "Child", `${prefix}-a`]]) {
      const values = [`${prefix}-${id}`, name, parent, "created", "updated"];
      if (prefix === "l") native.prepare("INSERT INTO library_folders VALUES (?, 'alice', 'file', ?, ?, ?, ?)").run(...values);
      else native.prepare("INSERT INTO project_subfolders VALUES (?, 'owned', ?, ?, ?, ?)").run(...values);
    }
    for (const [id, name, parent] of [["a", "ALPHA.pdf", null], ["b", "alpha.pdf", null],
      ["z", "Zulu.pdf", null], ["child", "needle.pdf", `${prefix}-a`],
      ["grandchild", "100%_!.pdf", `${prefix}-child`]]) {
      native.prepare("INSERT INTO documents VALUES (?, 'alice', ?, 'file', ?, ?, ?)").run(
        `${prefix}-doc-${id}`, prefix === "l" ? null : "owned", name,
        prefix === "l" ? parent : null, prefix === "p" ? parent : null);
    }
  }
  native.exec(`
    INSERT INTO library_folders VALUES ('template-folder','alice','template','Template',NULL,'created','updated'),
      ('foreign-folder','bob','file','Foreign',NULL,'created','updated');
    INSERT INTO project_subfolders VALUES ('shared-folder','shared','Shared',NULL,'created','updated'),
      ('private-folder','private','Private',NULL,'created','updated');
    INSERT INTO documents VALUES ('template-doc','alice',NULL,'template','Template.pdf',NULL,NULL),
      ('foreign-doc','bob',NULL,'file','Foreign.pdf',NULL,NULL),
      ('shared-doc','bob','shared','file','Shared.pdf',NULL,NULL),
      ('private-doc','bob','private','file','Private.pdf',NULL,NULL);
  `);
});
afterEach(async () => database.close());

for (const [prefix, read] of [["l", library], ["p", project]] as const) {
  describe(prefix === "l" ? "Library directory" : "Project directory", () => {
    const expected = ["a", "b", "z", "doc-a", "doc-b", "doc-z"].map((id) => `${prefix}-${id}`);
    it("orders folders before documents, with stable case-insensitive name ties", async () => {
      const page = await read();
      assert.deepEqual(ids(page), expected);
      assert.equal(page.nextAfter, null);
      const first = page.items[0];
      assert.equal(first.kind, "folder");
      if (first.kind === "folder") {
        assert.equal(first.folder.name, "ALPHA");
        assert.equal(first.folder.parent_folder_id, null);
        assert.equal(first.folder.created_at, "created");
        assert.equal(first.folder.updated_at, "updated");
        if (prefix === "p") assert.equal(first.folder.project_id, "owned");
      }
    });
    it("drains every page without skipping or repeating tied names or the bucket boundary", async () => {
      for (const limit of [1, 2, 3, 6, 7]) {
        let after: Options["after"] = null;
        const found: string[] = [];
        do {
          const page = await read({ limit, after });
          found.push(...ids(page)); after = page.nextAfter;
          assert.ok(found.length <= expected.length, "pagination did not terminate");
        } while (after);
        assert.deepEqual(found, expected);
      }
    });
    it("uses the last returned row, not the lookahead row, as the cursor", async () => {
      assert.deepEqual((await read({ limit: 1 })).nextAfter, [0, "alpha", `${prefix}-a`]);
      assert.deepEqual(ids(await read({ after: [0, "alpha", `${prefix}-a`] })), expected.slice(1));
      assert.deepEqual(ids(await read({ after: [1, "alpha.pdf", `${prefix}-doc-a`] })), expected.slice(4));
    });
    it("browses only immediate children, not grandchildren", async () => {
      assert.deepEqual(ids(await read({ parentFolderId: `${prefix}-a` })),
        [`${prefix}-child`, `${prefix}-doc-child`]);
    });
    it("searches documents across folders, using the existing Boolean and escaping rules", async () => {
      assert.deepEqual(ids(await read({ q: "ALPHA OR needle", parentFolderId: "missing" })),
        [`${prefix}-doc-a`, `${prefix}-doc-b`, `${prefix}-doc-child`]);
      assert.deepEqual(ids(await read({ q: '"100%_!"' })), [`${prefix}-doc-grandchild`]);
      assert.deepEqual(ids(await read({ q: "alpha NOT needle" })), [`${prefix}-doc-a`, `${prefix}-doc-b`]);
    });
    it("retains whitespace-search behavior and terminal empty pages", async () => {
      assert.equal((await read({ q: " " })).items.length, 5);
      for (const input of [{ q: "unfindable" }, { parentFolderId: "missing" },
        { after: [1, "zzzz", "zzzz"] as Options["after"] }]) {
        assert.deepEqual(await read(input), { items: [], nextAfter: null });
      }
    });
    it("continues after a deleted cursor row", async () => {
      const first = await read({ limit: 1 });
      native.prepare(`DELETE FROM ${prefix === "l" ? "library_folders" : "project_subfolders"} WHERE id=?`)
        .run(`${prefix}-a`);
      assert.deepEqual(ids(await read({ after: first.nextAfter })), expected.slice(1));
    });
    it("treats folder IDs and search strings as bound data", async () => {
      assert.deepEqual(ids(await read({ parentFolderId: "' OR 1=1 --" })), []);
      assert.deepEqual(ids(await read({ q: "' OR 1=1 --" })), []);
    });
  });
}
it("keeps file/template, user, and project membership outside the Library inventory", async () => {
  assert.deepEqual(ids(await libraryRepository.page({ ...scope, kind: "template" }, options)),
    ["template-folder", "template-doc"]);
  const all = await library({ documentsOnly: true, parentFolderId: "missing", limit: 100 });
  assert.deepEqual(ids(all), ["l-doc-grandchild", "l-doc-a", "l-doc-b", "l-doc-child", "l-doc-z"]);
  assert.deepEqual(ids(await library({ documentsOnly: true, q: "needle" })), ["l-doc-child"]);
});
it("retains project-level sharing and denies private, missing, and unauthorized projects", async () => {
  assert.deepEqual(ids(await projectRepository.directory(scope, "shared", options)), ["shared-folder", "shared-doc"]);
  for (const id of ["private", "missing"]) {
    assert.deepEqual(await projectRepository.directory(scope, id, options), { items: [], nextAfter: null });
  }
  assert.deepEqual(await projectRepository.directory({ userId: "eve" }, "owned", options),
    { items: [], nextAfter: null });
});
