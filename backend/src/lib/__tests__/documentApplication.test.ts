import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { createDocumentApplication } from "../documentApplication";
import type {
  CreateDocumentMetadata,
  DocumentAggregate,
  DocumentRepository,
} from "../documentRepository";
import { createFilesystemObjectStorage, type ObjectStorage } from "../storage";

const docx = (text: string) => new JSZip().file("word/document.xml", text, {
  date: new Date("2000-01-01T00:00:00Z"),
})
  .generateAsync({ type: "nodebuffer" });

function memoryRepository() {
  const values = new Map<string, DocumentAggregate>();
  const orphans = new Set<string>();
  const repository: DocumentRepository = {
    async authorizeCreate() { return "ok"; },
    async create(_scope, input: CreateDocumentMetadata) {
      values.set(input.document.id, {
        document: input.document, versions: [input.version], edits: [], isOwner: true,
      });
    },
    async get(scope, id) {
      const value = values.get(id);
      return value?.document.userId === scope.userId ? value : null;
    },
    async getMany(scope, ids) {
      return ids.flatMap((id) => {
        const value = values.get(id);
        return value?.document.userId === scope.userId ? [value] : [];
      });
    },
    async parseStates(scope, ids) {
      return ids.flatMap((id) => {
        const value = values.get(id);
        return value?.document.userId === scope.userId
          ? [{ id, parseState: value.document.parseState ?? null }] : [];
      });
    },
    async insertVersion(scope, id, input) {
      const value = await repository.get(scope, id);
      if (!value) return "missing";
      if (value.document.currentVersionId !== input.expectedCurrentVersionId) return "conflict";
      value.versions.push(input.version);
      value.document.currentVersionId = input.version.id;
      value.edits.push(...(input.edits ?? []).map((edit) => ({
        ...edit, versionId: input.version.id,
      })));
      return "created";
    },
    async updateVersion(scope, id, input) {
      const value = await repository.get(scope, id);
      const version = value?.versions.find(({ id: versionId }) => versionId === input.versionId);
      if (!version) return "missing";
      if (version.blobKey !== input.expectedBlobKey) return "conflict";
      const update = input.update;
      for (const key of ["filename", "fileType", "sizeBytes", "pageCount", "sourceSha256",
        "blobKey", "pdfBlobKey", "cleanupKeys", "createdAt"] as const) {
        if (update[key] !== undefined) (version as any)[key] = update[key];
      }
      if (update.provenance === null) delete version.provenance;
      else if (update.provenance !== undefined) version.provenance = update.provenance;
      value!.edits.push(...(input.edits ?? []).map((edit) => ({ ...edit, versionId: version.id })));
      const edit = input.resolveEdit && value!.edits.find(({ id: editId }) =>
        editId === input.resolveEdit!.id);
      if (input.resolveEdit && !edit) return "conflict";
      if (edit) edit.status = input.resolveEdit!.status;
      return "updated";
    },
    async renameVersion(scope, id, versionId, filename) {
      const version = (await repository.get(scope, id))?.versions.find(({ id }) => id === versionId);
      if (!version) return false;
      version.filename = filename;
      return true;
    },
    async deleteVersion(scope, id, input) {
      const value = await repository.get(scope, id);
      if (!value) return false;
      value.versions = value.versions.filter(({ id }) => id !== input.versionId);
      value.document.currentVersionId = input.nextCurrentVersionId;
      return true;
    },
    async deleteDocument(scope, id) {
      return !!await repository.get(scope, id) && values.delete(id);
    },
    async clearCleanup(scope, id, versionId, keys) {
      const version = (await repository.get(scope, id))?.versions.find(({ id }) => id === versionId);
      if (version) version.cleanupKeys = version.cleanupKeys.filter((key) => !keys.includes(key));
    },
    async recordOrphan(_scope, key) { orphans.add(key); },
    async clearOrphan(_maintenance, key) { orphans.delete(key); },
    async pendingOrphans() { return [...orphans]; },
    async pendingCleanup() {
      return [...values.values()].flatMap((value) => value.versions.flatMap((version) =>
        version.cleanupKeys.length ? [{
          scope: { userId: value.document.userId }, documentId: value.document.id,
          versionId: version.id, keys: version.cleanupKeys,
        }] : []));
    },
  };
  return { repository, values, orphans };
}

let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "beaver-documents-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function modes() {
  const filesystem = createFilesystemObjectStorage(root);
  const signedGet = vi.fn(async (key: string, options: { filename: string }) =>
    `https://storage.test/${encodeURIComponent(key)}?filename=${encodeURIComponent(options.filename)}`);
  const cloud = { ...filesystem, kind: "s3" as const, signedGet } satisfies ObjectStorage;
  return [{ name: "local", objects: filesystem }, { name: "cloud", objects: cloud, signedGet }];
}

describe("shared document application", () => {
  it("rejects oversized Office packages before storing them", async () => {
    const archive = new JSZip();
    for (let index = 0; index <= 4_096; index += 1) archive.file(`word/${index}.xml`, "x");
    const bytes = await archive.generateAsync({ type: "nodebuffer" });
    const objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(memoryRepository().repository, objects);
    await expect(documents.create({ userId: "owner" }, {
      filename: "bomb.docx", fileType: "docx", bytes,
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("extraction limits") });
    expect((await objects.list()).keys).toEqual([]);
  });

  it("keeps local and cloud lifecycle outcomes identical", async () => {
    const outcomes = [];
    for (const mode of modes()) {
      const { repository } = memoryRepository();
      const documents = createDocumentApplication(repository, mode.objects);
      const scope = { userId: `user-${mode.name}` };
      const created = await documents.create(scope, {
        filename: "../Brief.docx", fileType: "docx", bytes: await docx("docx-v1"),
      });
      const tracked = await documents.commitAssistantVersion(scope, created.id, {
        sourceVersionId: created.current_version_id,
        parentVersionId: created.current_version_id,
        filename: "Brief.docx",
        bytes: await docx("docx-tracked"),
        status: "pending",
        edits: [{
          changeId: "change-1", deletedText: "old", insertedText: "new",
          contextBefore: "", contextAfter: "", diff: [],
        }],
      });
      expect(tracked.status).toBe("committed");
      const added = await documents.addVersion(scope, created.id, {
        filename: "Brief revised.docx", fileType: "docx", bytes: await docx("docx-v2"),
      });
      const renamed = await documents.renameVersion(
        scope, created.id, added!.id, "Brief final.docx",
      );
      const replaced = await documents.replaceVersion(scope, created.id, added!.id, {
        filename: "Brief final.docx", fileType: "docx", bytes: await docx("docx-v3"),
      });
      const read = await documents.read(scope, created.id, null, false);
      expect(await documents.read({ userId: "intruder" }, created.id, null, false)).toBeNull();
      const deleted = await documents.deleteVersion(scope, created.id, added!.id);
      const restored = await documents.read(scope, created.id, null, false);
      outcomes.push({
        created: [created.filename, created.file_type, created.source_sha256],
        tracked: tracked.status,
        added: [added!.version_number, renamed!.filename],
        replaced: [replaced.status, read?.bytes.toString(), read?.version.source_sha256],
        restored: [deleted.status, restored?.bytes.toString()],
      });
      expect(await documents.deleteDocument(scope, created.id)).toBe(true);
      expect((await mode.objects.list()).keys).toEqual([]);
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it("signs only after authorization and keeps compensation durable", async () => {
    const mode = modes()[1];
    const state = memoryRepository();
    const documents = createDocumentApplication(state.repository, mode.objects);
    const created = await documents.create({ userId: "owner" }, {
      filename: "Brief.docx", fileType: "docx", bytes: await docx("private"),
    });
    expect(await documents.download({ userId: "other" }, created.id, null, false, "attachment"))
      .toBeNull();
    expect(mode.signedGet).not.toHaveBeenCalled();
    expect(await documents.download({ userId: "owner" }, created.id, null, false, "attachment"))
      .toMatchObject({ kind: "redirect" });
    expect(mode.signedGet).toHaveBeenCalledOnce();

    const put = mode.objects.put;
    mode.objects.put = async () => { throw new Error("provider object not found"); };
    await expect(documents.addVersion({ userId: "owner" }, created.id, {
      filename: "Brief.docx", fileType: "docx", bytes: await docx("next"),
    })).rejects.toThrow("provider object not found");
    mode.objects.put = put;

    state.repository.create = async () => { throw new Error("metadata unavailable"); };
    const remove = mode.objects.remove;
    mode.objects.remove = async () => { throw new Error("storage unavailable"); };
    await expect(documents.create({ userId: "owner" }, {
      filename: "Orphan.docx", fileType: "docx", bytes: await docx("orphan"),
    })).rejects.toThrow(/cleanup/u);
    expect(state.orphans.size).toBe(1);
    mode.objects.remove = remove;
    await documents.resumeCleanup();
    expect(state.orphans.size).toBe(0);
  });
});
