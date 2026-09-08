import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256, sha256 } from "../hash";
import { MAX_OBJECT_SIZE_BYTES } from "../storage";
import type { WorkProduct, WorkProductBuildReceipt } from "../workProduct";
import { zipDocumentBytes } from "./support/documentBytes";

let root: string | null = null;

async function localStores() {
  const [{ createDocumentApplication }, { documentRepository }, { libraryRepository },
    { projectRepository }, objects, { createLibraryStore }, { createProjectStore },
    { createUserPreferencesRepository }, { relationalDatabase }, { createWorkflowFiles }] =
    await Promise.all([
      import("../documentApplication"), import("../relationalDocumentRepository"),
      import("../relationalLibraryRepository"), import("../relationalProjectRepository"),
      import("../filesystemObjectStorage"), import("../libraryStore"), import("../projectStore"),
      import("../relationalUserPreferencesRepository"), import("../relationalDatabase"),
      import("../workflowFiles"),
    ]);
  const objectStore = objects.filesystemDocumentObjects();
  const documents = createDocumentApplication(documentRepository, objectStore);
  const library = createLibraryStore(libraryRepository, documents);
  const preferences = createUserPreferencesRepository(await relationalDatabase());
  const projects = createProjectStore(projectRepository, documents);
  return { documents, library, preferences, objects: objectStore,
    projects,
    workflowFiles: createWorkflowFiles(documents, library, preferences, projects) };
}

const buildReceipt = (
  product: WorkProduct, filename: string, bytes: Buffer, role = "book",
): WorkProductBuildReceipt => ({
  schemaVersion: "beaver.work-product-build.v2", builtAt: "2026-08-30T00:00:00.000Z",
  workProduct: { id: product.id, kind: product.kind, revision: product.revision }, inputs: [],
  settings: { profileId: null, outputMode: "book", stateSha256: canonicalJsonSha256(product.state),
    settingsSha256: "b".repeat(64), sourceReceiptIds: [],
    audit: { effective: null, valuesJson: "{}" } },
  steps: ["Rendered"], output: { role, filename,
    mimeType: "text/plain; charset=utf-8", pageCount: null, sha256: sha256(bytes) },
});

afterEach(async () => {
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.AUTH_MODE;
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("SQLite and filesystem document adapters", () => {
  it("saves quote workbooks beside the input with their complete receipt", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-quote-workbook-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const { documents, library, projects } = await localStores();
    const { saveQuoteCheckWorkbook } = await import("../quoteCheckWorkbook");
    const scope = { userId: "quote-owner" };
    const folder = (await library.createFolder({ ...scope, kind: "file" }, "Research", null))!;
    const project = await projects.create(scope, { name: "Matter", cmNumber: null,
      practice: null, sharedWith: [] });
    const result = { mode: "mechanical", total: 0, citationUnits: [], counts: {}, quotes: [] };
    for (const placement of [{ folderId: folder.id }, { projectId: project.id }]) {
      const input = await documents.create(scope, { filename: "Draft.txt", fileType: "txt",
        bytes: Buffer.from("No quotations"), ...placement });
      const report = await saveQuoteCheckWorkbook(documents, scope, input.id, result, undefined, input.current_version_id);
      expect(report).toMatchObject({ file_type: "xlsx", project_id: input.project_id, folder_id: input.folder_id });
      expect((await documents.read(scope, report.id, null, false))?.bytes.subarray(0, 2).toString()).toBe("PK");
      const parts = await documents.readParts(scope, report.id, null, ["quote-check-receipt.json"]);
      expect(JSON.parse(parts![0].bytes.toString())).toEqual({ inputDocumentId: input.id,
        inputVersionId: input.current_version_id, result });
    }
  });

  it("pages Library search and directories without repeating or exposing documents", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-directory-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const { documents, library, projects } = await localStores();
    const scope = { userId: "directory-owner" }, libraryScope = { ...scope, kind: "file" as const };
    const folder = (await library.createFolder(libraryScope, "Evidence", null))!;
    const project = await projects.create(scope, { name: "Matter", cmNumber: null,
      practice: null, sharedWith: [] });
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) ids.push((await documents.create(scope, {
      filename: "Agreement.txt", fileType: "txt", bytes: Buffer.from(`Notice ${index}`),
      folderId: index % 2 ? folder.id : null,
    })).id);
    const hidden = await documents.create({ userId: "another-owner" }, {
      filename: "Agreement.txt", fileType: "txt", bytes: Buffer.from("private") });
    const matterFile = await documents.create(scope, { filename: "Agreement.txt",
      fileType: "txt", bytes: Buffer.from("project notice"), projectId: project.id });
    const requested = [ids[3], hidden.id, ids[0], "missing", ids[3], matterFile.id];
    expect(await documents.metadataMany(scope, requested)).toEqual(await Promise.all(
      [ids[3], ids[0], matterFile.id].map((id) => documents.metadata(scope, id))));
    for (const options of [{ q: "Agreement" }, { q: "", documentsOnly: true }]) {
      const found: string[] = [];
      let after: [number, string, string] | null = null;
      for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
        const page = await library.page(libraryScope, { ...options,
          parentFolderId: null, limit: 2, after });
        for (const item of page.items) {
          expect(item.kind).toBe("document");
          if (item.kind === "document") {
            found.push(item.document.id);
          }
        }
        after = page.nextAfter;
        if (!after) break;
      }
      expect(after).toBeNull();
      expect(found).toEqual([...ids].sort());
    }
    const directory = await library.page(libraryScope, { q: "", parentFolderId: null,
      limit: 2, after: null });
    expect(directory.items[0]).toMatchObject({ kind: "folder", folder: { id: folder.id } });
    expect((await projects.directory(scope, project.id, { q: "", parentFolderId: null,
      limit: 2, after: null })).items).toEqual([
      { kind: "document", document: await documents.metadata(scope, matterFile.id) },
    ]);
  });

  it("versions, moves, validates, and cleans named CAS parts", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const { documents, projects, objects } = await localStores(), scope = { userId: "local-user" };
    const source = Buffer.from("source one"), queries = Buffer.from("queries"),
      rootBytes = Buffer.from("# research");
    const created = await documents.create(scope, { filename: "research.md", fileType: "md",
      bytes: rootBytes, parts: [{ name: "source.one.json", bytes: source },
        { name: "queries.json", bytes: queries }] });
    const firstId = created.current_version_id;
    expect((await documents.readParts(scope, created.id, null,
      ["queries.json", "missing.json", "source.one.json"]))?.map(({ name, bytes }) =>
      [name, bytes.toString()])).toEqual([["queries.json", "queries"],
      ["source.one.json", "source one"]]);

    const { relationalDatabase, sql } = await import("../relationalDatabase"),
      database = await relationalDatabase(), get = vi.spyOn(objects, "get");
    await database.query(sql`UPDATE document_version_parts SET size_bytes=${MAX_OBJECT_SIZE_BYTES}
      WHERE document_id=${created.id}`); get.mockClear();
    await expect(documents.readParts(scope, created.id, null,
      ["queries.json", "source.one.json"])).rejects.toMatchObject({ status: 413 });
    expect(get).not.toHaveBeenCalled();
    await database.query(sql`UPDATE document_version_parts SET size_bytes=CASE name
      WHEN 'queries.json' THEN ${queries.length} ELSE ${source.length} END
      WHERE document_id=${created.id}`);

    const part = (await database.query<{ sha256: string; storage_path: string }>(sql`
      SELECT sha256,storage_path FROM document_version_parts
      WHERE document_id=${created.id} AND name='queries.json'`)).rows[0]!;
    await objects.remove(part.storage_path);
    expect(await documents.checkpointVersion(scope, created.id, firstId, 0))
      .toEqual({ status: "missing" });
    await objects.put(part.storage_path, queries, "application/octet-stream",
      { expectedSha256: part.sha256 });
    await documents.renameVersion(scope, created.id, firstId, "Reviewed research.md", 0);
    const checkpoint = await documents.checkpointVersion(scope, created.id, firstId, 1);
    expect(checkpoint.status).toBe("created");
    if (checkpoint.status !== "created") return;
    const secondId = checkpoint.version.id;

    const changed = await documents.replaceVersion(scope, created.id, secondId, 0, {
      filename: "research.md", fileType: "md", bytes: Buffer.from("# changed"),
      parts: { put: [{ name: "source.one.json", bytes: Buffer.from("source two") }],
        remove: ["queries.json"] },
    });
    expect(changed.status).toBe("replaced");
    await expect(documents.replaceVersion(scope, created.id, secondId, 0, {
      filename: "research.md", fileType: "md", bytes: Buffer.from("# stale"),
      parts: { put: [{ name: "source.one.json", bytes: Buffer.from("stale") }] },
    })).resolves.toEqual({ status: "conflict" });
    expect((await documents.read(scope, created.id, null, false))?.bytes.toString()).toBe("# changed");
    expect((await documents.readParts(scope, created.id, secondId,
      ["source.one.json", "queries.json"]))?.map(({ bytes }) => bytes.toString()))
      .toEqual(["source two"]);

    const restored = await documents.restoreVersion(scope, created.id, firstId, secondId, 1);
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") return;
    expect((await documents.readParts(scope, created.id, restored.version.id,
      ["source.one.json", "queries.json"]))?.map(({ bytes }) => bytes.toString()))
      .toEqual(["source one", "queries"]);

    const project = await projects.create(scope, {
      name: "Matter", cmNumber: null, practice: null, sharedWith: [],
    });
    await expect(projects.attachDocument(scope, project.id, created.id)).resolves
      .toMatchObject({ document: { project_id: project.id } });
    const moved = (await database.query<{ version_id: string; name: string; sha256: string;
      storage_path: string }>(sql`SELECT version_id,name,sha256,storage_path
      FROM document_version_parts WHERE document_id=${created.id}`)).rows;
    expect((await documents.readParts(scope, created.id, null,
      ["source.one.json"]))?.[0].bytes.toString()).toBe("source one");

    const currentPart = moved.find(({ version_id, name }) =>
      version_id === restored.version.id && name === "source.one.json")!;
    await database.query(sql`UPDATE document_version_parts SET sha256=${"f".repeat(64)}
      WHERE version_id=${currentPart.version_id} AND name=${currentPart.name}`);
    await expect(documents.readParts(scope, created.id, restored.version.id,
      [currentPart.name])).rejects.toThrow("integrity check");
    await database.query(sql`UPDATE document_version_parts SET sha256=${currentPart.sha256}
      WHERE version_id=${currentPart.version_id} AND name=${currentPart.name}`);
    const uniquePart = moved.find(({ version_id, name }) =>
      version_id === secondId && name === "source.one.json")!;
    await objects.remove(uniquePart.storage_path);
    await expect(documents.readParts(scope, created.id, secondId,
      [uniquePart.name])).rejects.toThrow("unavailable");
    await expect(documents.restoreVersion(scope, created.id, secondId,
      restored.version.id, restored.version.working_revision)).resolves.toEqual({ status: "missing" });
    expect((await documents.versions(scope, created.id))?.current_version_id)
      .toBe(restored.version.id);

    const retainedKey = moved.find(({ name }) => name === "queries.json")!.storage_path;
    expect(await objects.get(retainedKey)).toEqual(queries);
    expect(await documents.deleteDocument(scope, created.id)).toBe(true);
    expect(await objects.get(retainedKey)).toBeNull();
  });

  it("persist the shared lifecycle and expose library paging", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const { documents, library } = await localStores();
    const scope = { userId: "local-user" };
    const folder = await library.createFolder({ ...scope, kind: "file" }, "Authorities", null);
    const bytes = await zipDocumentBytes("docx");
    const document = await documents.create(scope, {
      filename: "Brief.docx", fileType: "docx", bytes,
      folderId: folder!.id,
    });
    expect(document.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await documents.read(scope, document.id, null, false))?.bytes)
      .toEqual(bytes);
    const page = await library.page({ ...scope, kind: "file" }, {
      q: "brief", parentFolderId: folder!.id, limit: 10, after: null,
    });
    expect(page.items[0]).toMatchObject({
      kind: "document", document: { id: document.id, filename: "Brief.docx" },
    });
    const pending = await documents.commitAssistantVersion(scope, document.id, {
      sourceVersionId: document.current_version_id, expectedWorkingRevision: 0,
      filename: document.filename, fileType: "docx", bytes, status: "pending", edits: [{
        changeId: "edit", deletedText: "old", insertedText: "new",
        contextBefore: "", contextAfter: "", diff: [],
      }],
    });
    expect(pending.status).toBe("committed");
    if (pending.status !== "committed") return;
    expect(await documents.checkpointVersion(scope, document.id, pending.version.id, 0))
      .toEqual({ status: "pending-edits" });
    const clean = await documents.addVersion(scope, document.id, {
      filename: document.filename, fileType: "docx", bytes,
    });
    expect(await documents.restoreVersion(scope, document.id, pending.version.id, clean!.id, 0))
      .toEqual({ status: "pending-edits" });
    expect(await library.deleteFolder({ ...scope, kind: "file" }, folder!.id)).toBe(true);
    expect(await documents.read(scope, document.id, null, false)).toBeNull();
  });

  it("survives a repository restart", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const first = await localStores();
    const created = await first.documents.create({ userId: "local-user" }, {
      filename: "Record.txt", fileType: "txt", bytes: Buffer.from("record"),
    });
    await (await import("../relationalDatabase")).closeRelationalDatabase();
    vi.resetModules();
    const second = await localStores();
    expect((await second.documents.read(
      { userId: "local-user" }, created.id, null, false,
    ))?.bytes.toString()).toBe("record");
  });

  it("moves all version blobs between Library and project scopes atomically", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const { documents, projects } = await localStores(), scope = { userId: "local-user" };
    const project = await projects.create(scope, {
      name: "Matter", cmNumber: null, practice: null, sharedWith: [],
    });
    const first = Buffer.from("shared"), moving = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: first,
    });
    await documents.addVersion(scope, moving.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("revised"),
    });
    const sibling = await documents.create(scope, {
      filename: "copy.md", fileType: "md", bytes: first,
    });
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    const database = await relationalDatabase();
    const paths = async (id: string) => (await database.query<{ storage_path: string }>(sql`
      SELECT storage_path FROM document_versions WHERE document_id=${id}
      ORDER BY version_number`)).rows.map(({ storage_path }) => storage_path);
    const libraryKeys = await paths(moving.id);
    expect(await paths(sibling.id)).toEqual([libraryKeys[0]]);
    await projects.attachDocument(scope, project.id, moving.id);
    const projectKeys = await paths(moving.id);
    expect(projectKeys.every((key) => key.startsWith(`projects/${project.id}/blobs/`))).toBe(true);
    const other = await projects.create(scope, {
      name: "Other matter", cmNumber: null, practice: null, sharedWith: [],
    });
    const copy = await projects.attachDocument(scope, other.id, moving.id);
    expect(copy.created).toBe(true);
    expect(copy.document).toMatchObject({ project_id: other.id, filename: "notes.md" });
    expect(copy.document.id).not.toBe(moving.id);
    expect((await documents.read(scope, copy.document.id, null, false))?.bytes.toString()).toBe("revised");
    expect((await documents.metadata(scope, moving.id))?.project_id).toBe(project.id);
    expect((await database.query<{ storage_path: string }>(sql`SELECT storage_path
      FROM object_cleanup WHERE storage_path IN(${sql.join(libraryKeys)})`)).rows
      .map(({ storage_path }) => storage_path).sort()).toEqual([...libraryKeys].sort());
    await expect(projects.detachDocument(scope, project.id, moving.id)).resolves.toBe(true);
    expect(await paths(moving.id)).toEqual(libraryKeys);
    expect((await database.query(sql`SELECT storage_path FROM object_cleanup
      WHERE storage_path IN(${sql.join(libraryKeys)})`)).rows).toEqual([]);
    expect((await database.query<{ storage_path: string }>(sql`SELECT storage_path
      FROM object_cleanup WHERE storage_path IN(${sql.join(projectKeys)}) ORDER BY storage_path`))
      .rows.map(({ storage_path }) => storage_path)).toEqual([...projectKeys].sort());
    expect((await documents.read(scope, moving.id, null, false))?.bytes.toString()).toBe("revised");
    await database.query(sql`UPDATE document_versions SET storage_path=${projectKeys[1]}
      WHERE document_id=${moving.id} AND version_number=2`);
    await expect(documents.read(scope, moving.id, null, false))
      .rejects.toThrow("different storage scope");
  });

  it("contains direct Court Records and Authorities PDFs in their durable targets", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const store = await localStores(), scope = { userId: "local-user" };
    const [{ createCourtRecordsApplication }, { createAuthoritiesWorkspaceApplication }] =
      await Promise.all([import("../courtRecordsApplication"),
        import("../authoritiesWorkspaceApplication")]);
    const courtRecords = createCourtRecordsApplication(
      store.documents, store.workflowFiles, {} as never,
    );
    const first = await courtRecords.saveFile(scope, {
      filename: "Record.pdf", fileType: "pdf", bytes: Buffer.from("%PDF-1.7\nrecord"),
    });
    const defaults = await store.preferences.get(scope.userId);
    expect(defaults.workflowFileTargets["court-records"]).toBeNull();
    await expect(store.library.folder({ ...scope, kind: "file" }, first.folder_id!))
      .resolves.toMatchObject({ name: "Court Records" });

    const project = await store.projects.create(scope, {
      name: "Matter", cmNumber: null, practice: null, sharedWith: [],
    });
    const folder = await store.projects.createFolder(scope, project.id, {
      name: "Authorities", parentFolderId: null,
    });
    await store.preferences.update(scope.userId, { workflowFileTargets: {
      ...defaults.workflowFileTargets,
      authorities: { kind: "project", projectId: project.id, folderId: folder!.id },
    } });

    const authorities = createAuthoritiesWorkspaceApplication(
      store.documents, {} as never, store.workflowFiles,
    );
    const second = await authorities.saveFile(scope, {
      filename: "Book.pdf", fileType: "pdf", bytes: Buffer.from("%PDF-1.7\nbook"),
    });
    expect(second).toMatchObject({ project_id: project.id, folder_id: folder!.id });

    const [{ enqueuePdfPreparation }, { relationalDatabase, sql }] = await Promise.all([
      import("../pdfJobs"), import("../relationalDatabase"),
    ]);
    await enqueuePdfPreparation({ userId: scope.userId,
      documentId: second.id, versionId: second.current_version_id,
      sourceSha256: second.source_sha256 });
    await expect((await relationalDatabase()).query(sql`SELECT d.id,
      COUNT(DISTINCT v.id) versions,COUNT(DISTINCT j.id) jobs,MIN(j.kind) kind
      FROM documents d JOIN document_versions v ON v.document_id=d.id
      JOIN application_jobs j ON j.document_version_id=v.id
      WHERE d.id IN(${first.id},${second.id}) GROUP BY d.id ORDER BY d.id`))
      .resolves.toMatchObject({ rows: [
        { versions: 1, jobs: 1, kind: "pdf.prepare" },
        { versions: 1, jobs: 1, kind: "pdf.prepare" },
      ] });
  });

  it.each(["court-record", "authorities"] as const)(
    "persists and rolls back exact %s output versions through the shared build operation", async (kind) => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-build-save-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const store = await localStores(), scope = { userId: "build-owner" };
    const [{ createWorkProductApplication, saveWorkProductBuild }, { workProductRepository },
      { createAuthoritiesDraft }, { relationalDatabase, sql }] = await Promise.all([
      import("../workProductApplication"), import("../relationalWorkProductRepository"),
      import("../authoritiesDomain"), import("../relationalDatabase"),
    ]);
    const workProducts = createWorkProductApplication(workProductRepository);
    const projectId = kind === "court-record" ? (await store.projects.create(scope, {
      name: "Matter", cmNumber: null, practice: null, sharedWith: [],
    })).id : null;
    const product = await workProducts.create(scope, { kind, title: "Build", projectId,
      state: kind === "authorities" ? createAuthoritiesDraft({ kind: "manual" })
        : { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} } });
    const deps = { documents: store.documents, files: store.workflowFiles, workProducts };
    const role = kind === "court-record" ? "record" : "book";
    let sourceNumber = 0;
    const artifact = async (product: WorkProduct, bytes: Buffer, outputRole = role) => {
      const filename = `${outputRole}.txt`, source = path.join(root!, `${++sourceNumber}.txt`);
      if (kind === "court-record") await writeFile(source, bytes);
      return { role: outputRole, file: { filename, fileType: "txt",
        ...(kind === "court-record" ? { path: source, sizeBytes: bytes.length } : { bytes }) },
        receipt: buildReceipt(product, filename, bytes, outputRole) };
    };
    const v1 = Buffer.from("first build"), firstArtifact = await artifact(product, v1);
    const first = await saveWorkProductBuild(deps, scope, product, [firstArtifact]);
    const v2 = Buffer.from("second build"), secondArtifact = await artifact(first, v2);
    const second = await saveWorkProductBuild(deps, scope, first, [secondArtifact]);
    const output = second.outputs[role], firstOutput = first.outputs[role];
    expect(output.documentId).toBe(firstOutput.documentId);
    expect(output.versionId).not.toBe(firstOutput.versionId);
    expect(await store.documents.metadata(scope, output.documentId)).toMatchObject({ project_id: projectId });
    expect((await store.documents.read(scope, output.documentId, firstOutput.versionId, false))?.bytes).toEqual(v1);

    await workProducts.save(scope, second.id, { revision: second.revision, title: "Changed during build" });
    await expect(saveWorkProductBuild(deps, scope, second, [
      await artifact(second, Buffer.from("stale rebuild")),
      await artifact(second, Buffer.from("new index"), "index"),
    ])).rejects.toMatchObject({ status: 409 });
    expect((await store.documents.versions(scope, output.documentId))?.versions.map(({ id }) => id))
      .toEqual([output.versionId, firstOutput.versionId]);
    expect((await workProducts.get(scope, second.id)).outputs).toEqual(second.outputs);
    expect((await (await relationalDatabase()).query<{ id: string }>(sql`
      SELECT id FROM documents WHERE user_id=${scope.userId}`)).rows).toEqual([{ id: output.documentId }]);

    await (await import("../relationalDatabase")).closeRelationalDatabase();
    vi.resetModules();
    const reopened = await localStores();
    const versions = await reopened.documents.versions(scope, output.documentId);
    expect(versions?.versions.map((version) => version.provenance)).toEqual([
      { schema_version: 1, actor: "work-product", action: "built",
        receipt: { workProduct: { kind } } },
      { schema_version: 1, actor: "work-product", action: "built",
        receipt: { workProduct: { kind } } },
    ]);
    expect((await reopened.documents.projectionSource(scope, output.documentId, null))?.provenance)
      .toMatchObject({ receipt: secondArtifact.receipt });
    expect((await reopened.documents.read(scope, output.documentId, null, false))?.bytes).toEqual(v2);
  });
});
