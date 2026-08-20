import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipDocumentBytes } from "./support/documentBytes";

let root: string | null = null;

async function localStores() {
  const [{ createDocumentApplication }, { documentRepository, libraryRepository }, objects,
    { createLibraryStore }] =
    await Promise.all([
      import("../documentApplication"), import("../relationalRepositories"),
      import("../filesystemObjectStorage"), import("../libraryStore"),
    ]);
  const documents = createDocumentApplication(
    documentRepository, objects.filesystemDocumentObjects(),
  );
  return { documents, library: createLibraryStore(libraryRepository, documents) };
}

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
});
