import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../hash";
import type { WorkProductBuildReceipt } from "../workProduct";
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
  const documents = createDocumentApplication(
    documentRepository, objects.filesystemDocumentObjects(),
  );
  const library = createLibraryStore(libraryRepository, documents);
  const preferences = createUserPreferencesRepository(await relationalDatabase());
  const projects = createProjectStore(projectRepository, documents);
  return { documents, library, preferences,
    projects,
    workflowFiles: createWorkflowFiles(documents, library, preferences, projects) };
}

const buildReceipt = (
  revision: number, filename: string, bytes: Buffer,
): WorkProductBuildReceipt => ({
  schemaVersion: "beaver.work-product-build.v2", builtAt: `2026-08-30T00:00:0${revision}.000Z`,
  workProduct: { id: "authorities-1", kind: "authorities", revision }, inputs: [],
  settings: { profileId: null, outputMode: "book", stateSha256: "a".repeat(64),
    settingsSha256: "b".repeat(64), sourceReceiptIds: [],
    audit: { effective: null, valuesJson: "{}" } },
  steps: ["Combined attached authority PDFs"], output: { role: "book", filename,
    mimeType: "text/plain", pageCount: null, sha256: sha256(bytes) },
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

  it("keeps exact work-product receipts on stable output document versions", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    process.env.AUTH_MODE = "local";
    const first = await localStores(), scope = { userId: "local-user" };
    const v1 = Buffer.from("book-v1"), receipt1 = buildReceipt(1, "Book.txt", v1);
    const created = await first.workflowFiles.create(scope, "authorities", {
      filename: "Book.txt", fileType: "txt", bytes: v1,
      provenance: { schemaVersion: 1, actor: "work-product", action: "built",
        receipt: receipt1 },
    });
    const v2 = Buffer.from("book-v2"), receipt2 = buildReceipt(2, "Book.txt", v2);
    await first.documents.addVersion(scope, created.id, {
      filename: "Book.txt", fileType: "txt", bytes: v2,
      provenance: { schemaVersion: 1, actor: "work-product", action: "built",
        receipt: receipt2 },
    });

    await (await import("../relationalDatabase")).closeRelationalDatabase();
    vi.resetModules();
    const reopened = await localStores();
    const versions = await reopened.documents.versions(scope, created.id);
    expect(versions?.versions.map((version) => version.provenance)).toEqual([
      { schema_version: 1, actor: "work-product", action: "built", receipt: receipt1 },
      { schema_version: 1, actor: "work-product", action: "built", receipt: receipt2 },
    ]);
    expect((await reopened.documents.read(scope, created.id, null, false))?.bytes).toEqual(v2);
  });
});
