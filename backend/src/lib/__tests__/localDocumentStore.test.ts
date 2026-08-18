import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let root: string | null = null;

async function localStores() {
  const [{ createDocumentApplication }, { localDocumentRepository }, objects, library] =
    await Promise.all([
      import("../documentApplication"), import("../localDocumentStore"),
      import("../localObjectStorage"), import("../localLibraryStore"),
    ]);
  const documents = createDocumentApplication(
    localDocumentRepository, objects.localDocumentObjects(),
  );
  return { documents, library: library.createLocalLibraryStore(documents) };
}

afterEach(async () => {
  (await import("../localApplicationDatabase")).closeLocalApplicationDatabase();
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("SQLite and filesystem document adapters", () => {
  it("persist the shared lifecycle and expose library paging", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = root;
    const { documents, library } = await localStores();
    const scope = { userId: "local-user" };
    const folder = await library.createFolder({ ...scope, kind: "file" }, "Authorities", null);
    const document = await documents.create(scope, {
      filename: "Brief.docx", fileType: "docx", bytes: Buffer.from("docx"),
      folderId: folder!.id,
    });
    expect(document.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await documents.read(scope, document.id, null, false))?.localPath)
      .toContain(path.join("blobs", "documents"));
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
    const first = await localStores();
    const created = await first.documents.create({ userId: "local-user" }, {
      filename: "Record.pdf", fileType: "pdf", bytes: Buffer.from("%PDF-1.4"),
    });
    (await import("../localApplicationDatabase")).closeLocalApplicationDatabase();
    vi.resetModules();
    const second = await localStores();
    expect((await second.documents.read(
      { userId: "local-user" }, created.id, null, false,
    ))?.bytes.toString()).toBe("%PDF-1.4");
  });
});
