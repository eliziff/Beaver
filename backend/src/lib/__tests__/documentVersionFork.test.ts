import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let root: string;
const scope = { userId: "version-owner" };

async function fixture(kind: "restore" | "checkpoint") {
  root = await mkdtemp(path.join(os.tmpdir(), "beaver-version-fork-"));
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", root);
  vi.stubEnv("AUTH_MODE", "local");
  const [{ createDocumentApplication }, { documentRepository: repository },
    { filesystemDocumentObjects }] = await Promise.all([
    import("../documentApplication"), import("../relationalDocumentRepository"),
    import("../filesystemObjectStorage"),
  ]);
  const objects = filesystemDocumentObjects(), documents = createDocumentApplication(repository, objects);
  const original = await documents.create({ ...scope, userEmail: "old@example.test" }, {
    filename: "original.txt", fileType: "txt", bytes: Buffer.from("original"),
    provenance: { schemaVersion: 1, actor: "assistant", action: "created", turnId: "old-turn" },
    parts: [{ name: "receipt.json", bytes: Buffer.from("original receipt") },
      { name: "old-only.json", bytes: Buffer.from("old") }],
  });
  const current = (await documents.addVersion({ ...scope, userEmail: "old@example.test" }, original.id, {
    filename: "current.txt", fileType: "txt", bytes: Buffer.from("current"),
    provenance: { schemaVersion: 1, actor: "assistant", action: "revised", turnId: "current-turn" },
    parts: { put: [{ name: "receipt.json", bytes: Buffer.from("current receipt") },
      { name: "new-only.json", bytes: Buffer.from("new") }], remove: ["old-only.json"] },
  }))!;
  await documents.renameVersion(scope, original.id, current.id, "edited.txt", 0);
  const sourceId = kind === "restore" ? original.current_version_id : current.id;
  const fork = (revision = 1, comment?: string) => kind === "restore"
    ? documents.restoreVersion(scope, original.id, sourceId, current.id, revision, comment)
    : documents.checkpointVersion(scope, original.id, current.id, revision, comment);
  return { documents, repository, objects, original, current, sourceId, fork };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});

describe.each(["restore", "checkpoint"] as const)("%s version publication", (kind) => {
  it("forks the selected bytes and parts without copying objects or retaining the old author", async () => {
    const { documents, repository, objects, original, current, sourceId, fork } = await fixture(kind);
    const historyBefore = await documents.versions(scope, original.id);
    const partsBefore = await documents.readParts(scope, original.id, sourceId,
      ["receipt.json", "old-only.json", "new-only.json"]);
    // An unavailable part belonging only to the unselected version is irrelevant.
    const unselected = kind === "restore" ? current.id : original.current_version_id;
    const extra = (await repository.parts(scope, original.id, unselected,
      [kind === "restore" ? "new-only.json" : "old-only.json"]))![0];
    await objects.remove(extra.blobKey);
    const filesBefore = (await readdir(path.join(root, "blobs"), { recursive: true })).sort();
    const result = await fork(1, "  Reviewed  ");
    expect(result.status).toBe(kind === "restore" ? "restored" : "created");
    if (!("version" in result)) throw new Error("Expected a published version");
    expect(result.version).toMatchObject({ parent_version_id: current.id, version_number: 3,
      working_revision: 0, source: kind === "restore" ? "restore" : "snapshot",
      created_by: scope.userId, author_email: undefined, comment: "Reviewed" });
    expect((await documents.read(scope, original.id, null, false))?.bytes.toString())
      .toBe(kind === "restore" ? "original" : "current");
    expect(await documents.readParts(scope, original.id, null,
      ["receipt.json", "old-only.json", "new-only.json"])).toEqual(partsBefore);
    expect((await documents.projectionSource(scope, original.id, null))?.provenance)
      .toEqual({ schemaVersion: 1, actor: "assistant",
        action: kind === "restore" ? "created" : "revised" });
    expect((await documents.versions(scope, original.id))?.versions.slice(1))
      .toEqual(historyBefore?.versions);
    expect((await readdir(path.join(root, "blobs"), { recursive: true })).sort()).toEqual(filesBefore);
  });

  it.each(["revision", "head", "folder", "deletion"] as const)(
    "does not publish after a concurrent %s change", async (change) => {
    const { documents, repository, original, current, fork } = await fixture(kind);
    const insert = repository.insertVersion.bind(repository);
    let expectedHead = current.id, movedFolder: string | null = null;
    vi.spyOn(repository, "insertVersion").mockImplementationOnce(async (...args) => {
      if (change === "revision") {
        await documents.renameVersion(scope, original.id, current.id, "concurrent.txt", 1);
      } else if (change === "head") {
        expectedHead = (await documents.addVersion(scope, original.id, {
          filename: "concurrent.txt", fileType: "txt", bytes: Buffer.from("concurrent"),
        }))!.id;
      } else if (change === "folder") {
        const [{ createLibraryStore }, { libraryRepository }] = await Promise.all([
          import("../libraryStore"), import("../relationalLibraryRepository"),
        ]);
        const library = createLibraryStore(libraryRepository, documents);
        movedFolder = (await library.createFolder({ ...scope, kind: "file" }, "Moved", null))!.id;
        expect((await documents.relocate(scope, original.id, { expectedProjectId: null,
          expectedFolderId: null, projectId: null, folderId: movedFolder, owner: true })).status)
          .toBe("moved");
      } else {
        await documents.deleteDocument(scope, original.id);
      }
      return insert(...args);
    });
    expect(await fork()).toEqual({ status: change === "deletion" ? "missing" : "conflict" });
    const history = await documents.versions(scope, original.id);
    if (change === "deletion") expect(history).toBeNull();
    else {
      expect(history?.current_version_id).toBe(expectedHead);
      expect(history?.versions).toHaveLength(change === "head" ? 3 : 2);
      expect(history?.versions[0]).toMatchObject({
        filename: change === "folder" ? "edited.txt" : "concurrent.txt",
        working_revision: change === "folder" ? 1 : change === "revision" ? 2 : 0 });
      expect((await documents.metadata(scope, original.id))?.folder_id).toBe(movedFolder);
    }
  });

  it("keeps missing-source and stale-revision failure precedence", async () => {
    const { repository, fork } = await fixture(kind);
    vi.spyOn(repository, "history").mockResolvedValue(null);
    expect(await fork(0)).toEqual({ status: kind === "restore" ? "missing" : "conflict" });
    expect(await fork(1)).toEqual({ status: "missing" });
  });

  it("refuses to publish when a selected named part has disappeared", async () => {
    const { documents, repository, objects, original, sourceId, fork } = await fixture(kind);
    const before = await documents.versions(scope, original.id);
    const part = (await repository.parts(scope, original.id, sourceId, ["receipt.json"]))![0];
    await objects.remove(part.blobKey);
    expect(await fork()).toEqual({ status: "missing" });
    expect(await documents.versions(scope, original.id)).toEqual(before);
  });
});
