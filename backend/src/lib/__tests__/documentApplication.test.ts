import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument } from "pdf-lib";
import { createDocumentApplication } from "../documentApplication";
import { MAX_DRAFTING_DOCX_BYTES } from "../docx/core";
import { sha256 } from "../hash";
import type {
  CreateDocumentMetadata,
  DocumentAggregate,
  DocumentRepository,
} from "../documentRepository";
import type { DocumentScope } from "../documentStore";
import { createFilesystemObjectStorage, createS3ObjectStorage, documentBlobKey, readS3Configuration,
  scopeObjectStorage, type ObjectStorage } from "../storage";
import { createResearchFileState, readResearchFile, researchFileMarkdown,
  saveResearchFile } from "../researchFile";
import { applyTextOpsToDocx } from "../docxTextOps";

const docx = (text: string) => new JSZip().file("word/document.xml", text, {
  date: new Date("2000-01-01T00:00:00Z"),
  createFolders: false,
})
  .generateAsync({ type: "nodebuffer" });
const validDocx = (text: string) => Packer.toBuffer(new Document({ sections: [{
  children: [new Paragraph({ children: [new TextRun(text)] })],
}] }));
const pdf = async (text: string) => {
  const value = await PDFDocument.create();
  value.addPage().drawText(text);
  return Buffer.from(await value.save());
};

function memoryRepository(readable: (scope: DocumentScope, value: DocumentAggregate) => boolean =
  (scope, value) => value.document.userId === scope.userId) {
  const values = new Map<string, DocumentAggregate>();
  const orphans = new Set<string>();
  const keys = (version: DocumentAggregate["versions"][number]) =>
    [version.blobKey, version.pdfBlobKey].filter((key): key is string => !!key);
  const retain = (version: DocumentAggregate["versions"][number]) =>
    keys(version).forEach((key) => orphans.delete(key));
  const repository: DocumentRepository = {
    async authorizeCreate() { return "ok"; },
    async create(_scope, input: CreateDocumentMetadata) {
      values.set(input.document.id, {
        document: input.document, versions: [input.version], edits: [],
      });
      retain(input.version);
      return true;
    },
    async get(scope, id) {
      const value = values.get(id);
      return value && readable(scope, value) ? value : null;
    },
    async head(scope, id) {
      const value = await repository.get(scope, id);
      const version = value?.versions.find(({ id }) => id === value.document.currentVersionId);
      return value && version ? { document: value.document, versions: [version] } : null;
    },
    async version(scope, id, versionId) {
      const value = values.get(id);
      return value && readable(scope, value)
        ? value.versions.find((version) => version.id ===
          (versionId ?? value.document.currentVersionId)) ?? null
        : null;
    },
    async currentVersions(scope, ids) {
      return [...values.values()].flatMap((value) => {
        const version = value.versions.find(({ id }) => id === value.document.currentVersionId);
        return version && ids.includes(value.document.id) && readable(scope, value) ? [version] : [];
      });
    },
    async parts() { return []; },
    async hasPendingEdits(scope, id, versionIds) {
      const value = await repository.get(scope, id);
      return !!value?.edits.some((edit) => versionIds.includes(edit.versionId) &&
        edit.status === "pending");
    },
    async history(scope, id) {
      const value = await repository.get(scope, id);
      return value && { currentVersionId: value.document.currentVersionId,
        versions: [...value.versions].reverse() };
    },
    async parseStates(scope, ids) {
      return ids.flatMap((id) => {
        const value = values.get(id);
        return value && readable(scope, value)
          ? [{ id, parseState: value.document.parseState ?? null }] : [];
      });
    },
    async insertVersion(scope, id, input) {
      const value = await repository.get(scope, id);
      if (!value) return "missing";
      if (value.document.currentVersionId !== input.expectedCurrentVersionId ||
          value.versions.find(({ id }) => id === value.document.currentVersionId)
            ?.workingRevision !== input.expectedCurrentWorkingRevision ||
          input.expectedProjectId !== undefined &&
            value.document.projectId !== input.expectedProjectId ||
          input.expectedFolderId !== undefined &&
            value.document.folderId !== input.expectedFolderId ||
          input.version.versionNumber !== value.versions.length + 1 ||
          input.version.parentVersionId !== input.expectedCurrentVersionId) return "conflict";
      value.versions.push(input.version);
      value.document.currentVersionId = input.version.id;
      retain(input.version);
      value.edits.push(...(input.edits ?? []).map((edit) => ({
        ...edit, versionId: input.version.id,
      })));
      return "created";
    },
    async updateVersion(scope, id, input) {
      const value = await repository.get(scope, id);
      const version = value?.versions.find(({ id: versionId }) => versionId === input.versionId);
      if (!version) return "missing";
      if (version.blobKey !== input.expectedBlobKey ||
          input.expectedPdfBlobKey !== undefined &&
          version.pdfBlobKey !== input.expectedPdfBlobKey ||
          version.workingRevision !== input.expectedWorkingRevision ||
          input.expectedCurrentVersionId &&
          value?.document.currentVersionId !== input.expectedCurrentVersionId) return "conflict";
      const oldKeys = keys(version);
      const update = input.update;
      for (const key of ["filename", "fileType", "sizeBytes", "pageCount", "sourceSha256",
        "blobKey", "pdfBlobKey", "createdAt"] as const) {
        if (update[key] !== undefined) (version as any)[key] = update[key];
      }
      if (update.provenance === null) delete version.provenance;
      else if (update.provenance !== undefined) version.provenance = update.provenance;
      if (input.bumpWorkingRevision !== false) version.workingRevision++;
      value!.edits.push(...(input.edits ?? []).map((edit) => ({ ...edit, versionId: version.id })));
      const edits = input.resolveEdits?.ids.map((id) =>
        value!.edits.find(({ id: editId }) => editId === id));
      if (edits?.some((edit) => !edit)) return "conflict";
      edits?.forEach((edit) => edit!.status = input.resolveEdits!.status);
      const retained = new Set(keys(version));
      oldKeys.filter((key) => !retained.has(key)).forEach((key) => orphans.add(key));
      retain(version);
      return "updated";
    },
    async deleteVersion(scope, id, input) {
      const value = await repository.get(scope, id);
      if (!value) return false;
      const version = value.versions.find(({ id }) => id === input.versionId);
      if (!version || value.document.currentVersionId !== input.expectedCurrentVersionId ||
          input.versionId !== input.expectedCurrentVersionId ||
          version.parentVersionId !== input.nextCurrentVersionId ||
          version.blobKey !== input.expectedBlobKey ||
          version.pdfBlobKey !== input.expectedPdfBlobKey ||
          version.workingRevision !== input.expectedWorkingRevision ||
          value.document.projectId !== input.expectedProjectId ||
          value.document.folderId !== input.expectedFolderId) return false;
      value.versions = value.versions.filter(({ id }) => id !== input.versionId);
      value.document.currentVersionId = input.nextCurrentVersionId;
      keys(version).forEach((key) => orphans.add(key));
      return true;
    },
    async deleteDocument(scope, id, _owner, expected) {
      const value = await repository.get(scope, id);
      if (!value) return false;
      const current = value.versions.find(({ id }) => id === value.document.currentVersionId);
      if (expected && (!current || current.id !== expected.versionId ||
          current.workingRevision !== expected.workingRevision ||
          value.document.projectId !== expected.projectId ||
          value.document.folderId !== expected.folderId)) return false;
      value.versions.flatMap(keys).forEach((key) => orphans.add(key));
      return values.delete(id);
    },
    async deleteDocuments(scope, projectIds, includeOwned) {
      const ids = [...values.values()].filter(({ document }) =>
        includeOwned && document.userId === scope.userId ||
        !!document.projectId && projectIds.includes(document.projectId)).map(({ document }) =>
        document.id);
      let deleted = 0;
      for (const id of ids) if (await repository.deleteDocument(scope, id, false)) deleted++;
      return deleted;
    },
    async relocate(scope, id, input) {
      const value = await repository.get(scope, id, input.owner);
      if (!value) return "missing";
      if (value.document.projectId !== input.expectedProjectId ||
          value.document.folderId !== input.expectedFolderId) return "conflict";
      const rewrites = new Map(input.versions.map((version) => [version.versionId, version]));
      if (value.document.projectId !== input.projectId &&
          (rewrites.size !== input.versions.length || value.versions.length !== rewrites.size ||
          value.versions.some((version) => {
            const rewrite = rewrites.get(version.id);
            return !rewrite || rewrite.expectedBlobKey !== version.blobKey ||
              rewrite.expectedPdfBlobKey !== version.pdfBlobKey;
          })) || value.document.projectId === input.projectId && rewrites.size) return "conflict";
      const oldKeys = value.versions.flatMap(keys);
      value.versions.forEach((version) => {
        const rewrite = rewrites.get(version.id);
        if (rewrite) Object.assign(version, { blobKey: rewrite.blobKey,
          pdfBlobKey: rewrite.pdfBlobKey });
        retain(version);
      });
      value.document.projectId = input.projectId;
      value.document.folderId = input.folderId;
      const referenced = new Set([...values.values()].flatMap((item) => item.versions.flatMap(keys)));
      oldKeys.filter((key) => !referenced.has(key)).forEach((key) => orphans.add(key));
      return { document: value.document,
        versions: [value.versions.find(({ id }) => id === value.document.currentVersionId)!] };
    },
    async recordOrphans(keys) { keys.forEach((key) => orphans.add(key)); return "staged"; },
    async removeOrphan(key, _claimId, remove) {
      if (!orphans.has(key)) return false;
      await remove(); return orphans.delete(key);
    },
    async pendingOrphans() {
      const referenced = new Set([...values.values()].flatMap((value) =>
        value.versions.flatMap(keys)));
      referenced.forEach((key) => orphans.delete(key));
      return [...orphans].map((key) => ({ key, claimId: "claim" }));
    },
  };
  return { repository, values, orphans };
}

let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "beaver-documents-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function modes() {
  const filesystem = createFilesystemObjectStorage(root);
  const signedGet = vi.fn(async (key: string,
    options: { filename: string; contentType: string }): Promise<string | null> =>
    `https://storage.test/${encodeURIComponent(key)}?filename=${encodeURIComponent(options.filename)}`);
  const cloud = { ...filesystem, kind: "s3" as const, signedGet } satisfies ObjectStorage;
  return [{ name: "local", objects: filesystem }, { name: "cloud", objects: cloud, signedGet }];
}

describe("shared document application", () => {
  it("bulk-loads unique files in caller order with four blob reads at a time", async () => {
    const base = createFilesystemObjectStorage(root);
    let active = 0, peak = 0;
    const objects: ObjectStorage = { ...base, async get(key, options) {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try { return await base.get(key, options); } finally { active--; }
    } };
    const state = memoryRepository(), bulk = vi.spyOn(state.repository, "currentVersions");
    const documents = createDocumentApplication(state.repository, objects), scope = { userId: "bulk" };
    const created = [];
    for (let index = 0; index < 6; index++) created.push(await documents.create(scope, {
      filename: `${index}.md`, fileType: "md", bytes: Buffer.from(`body ${index}`),
    }));
    const requested = [created[4].id, created[1].id, created[4].id, created[5].id,
      created[0].id, created[3].id, created[2].id];

    expect((await documents.files(scope, requested)).map(({ filename }) => filename))
      .toEqual(["4.md", "1.md", "5.md", "0.md", "3.md", "2.md"]);
    expect(bulk).toHaveBeenCalledOnce();
    expect(bulk.mock.calls[0][1]).toEqual([...new Set(requested)]);
    expect(peak).toBe(4);
  });

  it("rejects invalid and oversized Office packages before storing them", async () => {
    const archive = new JSZip();
    for (let index = 0; index <= 4_096; index += 1) archive.file(`word/${index}.xml`, "x");
    const bytes = await archive.generateAsync({ type: "nodebuffer" });
    const state = memoryRepository();
    const documents = createDocumentApplication(state.repository, createFilesystemObjectStorage(root));
    await expect(documents.create({ userId: "owner" }, {
      filename: "corrupt.docx", fileType: "docx", bytes: Buffer.from("PK\x03\x04not-a-zip"),
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("extraction limits") });
    await expect(documents.create({ userId: "owner" }, {
      filename: "bomb.docx", fileType: "docx", bytes,
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("extraction limits") });
    expect([state.values.size, state.orphans.size]).toEqual([0, 0]);
  });

  it("rejects output bytes that do not match their build receipt before storing them", async () => {
    const objects = createFilesystemObjectStorage(root);
    const state = memoryRepository();
    const documents = createDocumentApplication(state.repository, objects);
    const scope = { userId: "receipt-owner" };
    const created = await documents.create(scope, {
      filename: "Record.docx", fileType: "docx", bytes: await docx("first"),
    });
    await expect(documents.addVersion(scope, created.id, {
      filename: "Record.docx", fileType: "docx", bytes: await docx("second"),
      expectedSha256: "0".repeat(64),
    })).rejects.toMatchObject({ status: 409 });
    expect((await documents.read(scope, created.id, null, false))?.version.id)
      .toBe(created.current_version_id);
    expect([state.values.get(created.id)?.versions.length, state.orphans.size]).toEqual([1, 0]);
    await documents.deleteDocument(scope, created.id);
  });

  it("rejects a version whose expected parent is stale", async () => {
    const documents = createDocumentApplication(memoryRepository().repository,
      createFilesystemObjectStorage(root));
    const scope = { userId: "version-owner" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"), projectId: undefined,
    });
    const current = await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("two"),
      expectedCurrentVersionId: created.current_version_id,
      expectedCurrentWorkingRevision: 0,
    });
    expect(await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("stale"),
      expectedCurrentVersionId: created.current_version_id,
      expectedCurrentWorkingRevision: 0,
    })).toBeNull();
    expect(await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("wrong source"),
      expectedCurrentVersionId: current!.id,
      expectedCurrentSha256: "0".repeat(64),
    })).toBeNull();
    expect((await documents.read(scope, created.id, null, false))?.version.id).toBe(current?.id);
    await documents.deleteDocument(scope, created.id);
  });

  it("does not roll back a version changed after its creation snapshot", async () => {
    const state = memoryRepository(), documents = createDocumentApplication(state.repository,
      createFilesystemObjectStorage(root)), scope = { userId: "rollback-owner" };
    const created = await documents.create(scope, { filename: "notes.md", fileType: "md",
      bytes: Buffer.from("one"), projectId: "matter", folderId: "drafts" });
    const version = (await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("two"),
    }))!;
    const expected = { versionId: version.id, workingRevision: version.working_revision,
      projectId: version.project_id, folderId: version.folder_id };
    await documents.renameVersion(scope, created.id, version.id, "renamed.md",
      version.working_revision);
    await expect(documents.deleteVersion(scope, created.id, version.id, expected))
      .resolves.toEqual({ status: "missing" });
    expect((await documents.read(scope, created.id, null, false))?.filename).toBe("renamed.md");
    state.values.get(created.id)!.document.folderId = "filed";
    await expect(documents.deleteVersion(scope, created.id, version.id, {
      ...expected, workingRevision: expected.workingRevision + 1,
    })).resolves.toEqual({ status: "missing" });
    expect(state.values.get(created.id)?.versions).toHaveLength(2);
  });

  it("lets an authorized project collaborator roll back its unchanged version", async () => {
    const member = { userId: "member", userEmail: "member@example.test" };
    const state = memoryRepository((scope, value) => value.document.userId === scope.userId ||
      value.document.projectId === "matter" && scope.userEmail === member.userEmail);
    const documents = createDocumentApplication(state.repository,
      createFilesystemObjectStorage(root));
    const owner = { userId: "owner", userEmail: "owner@example.test" };
    const created = await documents.create(owner, { filename: "notes.md", fileType: "md",
      bytes: Buffer.from("one"), projectId: "matter" });
    const version = (await documents.addVersion(member, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("two"),
    }))!;
    await expect(documents.deleteVersion(member, created.id, version.id, {
      versionId: version.id, workingRevision: version.working_revision,
      projectId: "matter", folderId: null,
    })).resolves.toEqual({ status: "deleted", currentVersionId: created.current_version_id });
    expect((await documents.read(member, created.id, null, false))?.bytes.toString()).toBe("one");
  });

  it("does not remove a created document after its head or location changes", async () => {
    const state = memoryRepository(), documents = createDocumentApplication(state.repository,
      createFilesystemObjectStorage(root)), scope = { userId: "created-rollback-owner" };
    const created = await documents.create(scope, { filename: "draft.md", fileType: "md",
      bytes: Buffer.from("one"), projectId: "matter", folderId: "drafts" });
    const expected = { versionId: created.current_version_id,
      workingRevision: created.current_working_revision,
      projectId: created.project_id, folderId: created.folder_id };
    await documents.replaceVersion(scope, created.id, created.current_version_id,
      created.current_working_revision,
      { filename: "filed.md", fileType: "md", bytes: Buffer.from("two") });
    state.values.get(created.id)!.document.folderId = "filed";
    await expect(documents.deleteDocument(scope, created.id, true, expected)).resolves.toBe(false);
    await expect(documents.read(scope, created.id, null, false)).resolves.toMatchObject({
      filename: "filed.md", bytes: Buffer.from("two"),
    });
  });

  it("coalesces one assistant turn and parents the next turn to it", async () => {
    const state = memoryRepository(), documents = createDocumentApplication(state.repository,
      createFilesystemObjectStorage(root)), scope = { userId: "research-owner" };
    const created = await documents.create(scope, {
      filename: "Cases.research.md", fileType: "md", bytes: Buffer.from("one"),
    });
    const first = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: created.current_version_id, expectedWorkingRevision: 0,
      filename: created.filename, fileType: "md", bytes: Buffer.from("two"),
      edits: [], status: "pending", turnId: "turn-1",
    });
    expect(first.status).toBe("committed");
    if (first.status !== "committed") return;
    await expect(documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: first.version.id, turnVersionId: first.version.id,
      expectedWorkingRevision: first.version.working_revision,
      filename: created.filename, fileType: "md", bytes: Buffer.from("wrong turn"),
      edits: [], status: "pending", turnId: "turn-2",
    })).resolves.toEqual({ status: "conflict" });
    const second = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: first.version.id, turnVersionId: first.version.id,
      expectedWorkingRevision: first.version.working_revision,
      filename: created.filename,
      fileType: "md", bytes: Buffer.from("three"), edits: [], status: "pending",
      turnId: "turn-1",
    });
    expect(second.status).toBe("committed");
    expect(state.values.get(created.id)?.versions).toHaveLength(2);
    if (second.status !== "committed") return;
    const retried = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: second.version.id,
      expectedWorkingRevision: second.version.working_revision,
      filename: created.filename, fileType: "md", bytes: Buffer.from("four"),
      edits: [], status: "pending", turnId: "turn-1",
    });
    expect(retried.status).toBe("committed");
    expect(state.values.get(created.id)?.versions).toHaveLength(2);
    if (retried.status !== "committed") return;
    const nextTurn = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: retried.version.id,
      expectedWorkingRevision: retried.version.working_revision,
      filename: created.filename, fileType: "md", bytes: Buffer.from("five"),
      edits: [], status: "pending", turnId: "turn-2",
    });
    expect(nextTurn).toMatchObject({ status: "committed",
      version: { parent_version_id: retried.version.id } });
    expect(state.values.get(created.id)?.versions).toHaveLength(3);
    expect((await documents.read(scope, created.id, null, false))?.bytes.toString()).toBe("five");
    await documents.deleteDocument(scope, created.id);
  });

  it("rejects a stale same-version research autosave", async () => {
    const documents = createDocumentApplication(memoryRepository().repository,
      createFilesystemObjectStorage(root)), scope = { userId: "research-human" };
    const created = await documents.create(scope, { filename: "Cases.research.md",
      fileType: "md", bytes: Buffer.from(researchFileMarkdown(
        "Cases", createResearchFileState())) });
    const opened = await readResearchFile(documents, scope, created.id);
    expect(opened).not.toBeNull();
    expect(await saveResearchFile(documents, scope, created.id, opened!.versionId,
      opened!.workingRevision, { type: "note", markdown: "first" }))
      .toMatchObject({ versionId: opened!.versionId, workingRevision: 1 });
    expect(await saveResearchFile(documents, scope, created.id, opened!.versionId,
      opened!.workingRevision, { type: "note", markdown: "stale" })).toBeNull();
    expect((await readResearchFile(documents, scope, created.id))?.state.note).toBe("first");
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(1);
  });

  it("retains provenance through revisions, checkpoints and restores, but not uploaded replacement", async () => {
    const state = memoryRepository(), documents = createDocumentApplication(state.repository,
      createFilesystemObjectStorage(root)), scope = { userId: "provenance-owner" };
    const created = await documents.create(scope, { filename: "memo.md", fileType: "md",
      bytes: Buffer.from("one"), provenance: { schemaVersion: 1, actor: "assistant",
        action: "created", turnId: "draft" } });
    const revised = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: created.current_version_id, expectedWorkingRevision: 0,
      filename: created.filename, fileType: "md", bytes: Buffer.from("two"),
      edits: [], status: "accepted", turnId: "revise" });
    expect(revised.status).toBe("committed");
    if (revised.status !== "committed") return;
    expect((await documents.projectionSource(scope, created.id, null))?.provenance)
      .toMatchObject({ actor: "assistant", action: "revised", turnId: "revise" });
    const checkpoint = await documents.checkpointVersion(scope, created.id, revised.version.id, 0);
    expect(checkpoint.status).toBe("created");
    if (checkpoint.status !== "created") return;
    expect((await documents.projectionSource(scope, created.id, null))?.provenance)
      .toMatchObject({ actor: "assistant", action: "revised", turnId: undefined });
    const restored = await documents.restoreVersion(scope, created.id, created.current_version_id,
      checkpoint.version.id, 0);
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") return;
    expect((await documents.projectionSource(scope, created.id, null))?.provenance)
      .toMatchObject({ actor: "assistant", action: "created", turnId: undefined });
    await documents.replaceVersion(scope, created.id, restored.version.id, 0,
      { filename: "memo.md", fileType: "md", bytes: Buffer.from("unrelated upload") });
    expect((await documents.projectionSource(scope, created.id, null))?.provenance).toBeUndefined();
  });

  it("restores an immutable version as a zero-copy descendant", async () => {
    const state = memoryRepository(), objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(state.repository, objects);
    const scope = { userId: "restore-owner" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    const second = await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("two"),
    });
    const third = await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("three"),
    });
    await expect(documents.restoreVersion(
      scope, created.id, third!.id, third!.id, third!.working_revision,
    )).resolves.toEqual({ status: "conflict" });
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(3);
    await expect(documents.restoreVersion(
      scope, created.id, created.current_version_id, second!.id, 0,
    )).resolves.toEqual({ status: "conflict" });
    const restored = await documents.restoreVersion(
      scope, created.id, created.current_version_id, third!.id, third!.working_revision,
    );
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") return;
    const history = await documents.versions(scope, created.id);
    expect(history?.versions).toHaveLength(4);
    expect(history?.versions.map(({ parent_version_id }) => parent_version_id)).toEqual([
      third!.id, second!.id, created.current_version_id, null,
    ]);
    expect(restored.version.source_sha256).toBe(created.source_sha256);
    expect(new Set(state.values.get(created.id)?.versions.map(({ blobKey }) => blobKey)).size)
      .toBe(3);
    expect((await documents.read(scope, created.id, null, false))?.bytes.toString()).toBe("one");
    expect((await documents.read(scope, created.id, second!.id, false))?.bytes.toString()).toBe("two");
    await documents.deleteDocument(scope, created.id);
    await documents.resumeCleanup();
    expect(state.orphans.size).toBe(0);
  });

  it("never restores missing or corrupt historical bytes", async () => {
    const state = memoryRepository(), objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(state.repository, objects);
    const scope = { userId: "damaged-restore-owner" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    const second = await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("two"),
    });
    const source = state.values.get(created.id)!.versions
      .find(({ id }) => id === created.current_version_id)!;
    const rendition = Buffer.from("pdf rendition"), pdfDigest = sha256(rendition);
    source.pdfBlobKey = documentBlobKey({ userId: scope.userId, projectId: null }, pdfDigest);
    await objects.put(source.pdfBlobKey, rendition, "application/pdf",
      { expectedSha256: pdfDigest });
    await objects.remove(source.pdfBlobKey);
    await expect(documents.restoreVersion(
      scope, created.id, created.current_version_id, second!.id, 0,
    )).resolves.toEqual({ status: "missing" });
    await objects.put(source.pdfBlobKey, rendition, "application/pdf",
      { expectedSha256: pdfDigest });
    const key = source.blobKey;
    await objects.remove(key);
    await expect(documents.restoreVersion(
      scope, created.id, created.current_version_id, second!.id, 0,
    )).resolves.toEqual({ status: "missing" });
    await writeFile(path.join(root, ...key.split("/")), "tampered");
    await expect(documents.restoreVersion(
      scope, created.id, created.current_version_id, second!.id, 0,
    )).rejects.toThrow("integrity check");
    expect((await documents.read(scope, created.id, null, false))?.bytes.toString()).toBe("two");
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(2);
  });

  it("checkpoints a working revision without copying its blob", async () => {
    const state = memoryRepository(), objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(state.repository, objects);
    const scope = { userId: "checkpoint-owner", userEmail: "owner@example.test" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    const replaced = await documents.replaceVersion(
      scope, created.id, created.current_version_id, 0,
      { filename: "notes.md", fileType: "md", bytes: Buffer.from("two") });
    expect(replaced.status).toBe("replaced");
    const checkpoint = await documents.checkpointVersion(
      scope, created.id, created.current_version_id, 1, "Reviewed draft");
    expect(checkpoint).toMatchObject({ status: "created", version: {
      parent_version_id: created.current_version_id, working_revision: 0,
      source: "snapshot", created_by: scope.userId, author_email: scope.userEmail,
      comment: "Reviewed draft" } });
    expect(await documents.checkpointVersion(
      scope, created.id, checkpoint.status === "created" ? checkpoint.version.id : "", 1,
    )).toEqual({ status: "conflict" });
    await objects.remove(state.values.get(created.id)!.versions.at(-1)!.blobKey);
    expect(await documents.checkpointVersion(scope, created.id, checkpoint.version.id, 0))
      .toEqual({ status: "missing" });
    expect(new Set(state.values.get(created.id)?.versions.map(({ blobKey }) => blobKey)).size)
      .toBe(1);
  });

  it("reserves deduplicated scope-move targets in one batch", async () => {
    const state = memoryRepository(), objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(state.repository, objects);
    const scope = { userId: "move-owner" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    const reserve = vi.spyOn(state.repository, "recordOrphans");
    const put = vi.spyOn(objects, "put");
    await expect(documents.relocate(scope, created.id, {
      expectedProjectId: null, expectedFolderId: null,
      projectId: "matter", folderId: null, owner: true,
    })).resolves.toMatchObject({ status: "moved" });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0][0]).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("does not copy a document before authorizing its destination", async () => {
    const state = memoryRepository(), objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(state.repository, objects);
    const scope = { userId: "move-owner" }, created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    state.repository.authorizeCreate = async () => "project-missing";
    const put = vi.spyOn(objects, "put");
    await expect(documents.relocate(scope, created.id, {
      expectedProjectId: null, expectedFolderId: null,
      projectId: "forbidden", folderId: null, owner: true,
    })).resolves.toEqual({ status: "missing" });
    expect(put).not.toHaveBeenCalled();
  });

  it("preserves pending markers when a later same-turn write adds no edits", async () => {
    const state = memoryRepository(), documents = createDocumentApplication(state.repository,
      createFilesystemObjectStorage(root)), scope = { userId: "tracked-owner" };
    const original = await validDocx("one"), applied = await applyTextOpsToDocx(original,
      [{ op: "uppercase", scope: { kind: "find_text", text: "one" } }]);
    const created = await documents.create(scope, {
      filename: "Brief.docx", fileType: "docx", bytes: original,
    });
    const first = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: created.current_version_id, expectedWorkingRevision: 0,
      filename: created.filename, fileType: "docx", bytes: applied.bytes,
      edits: applied.edits, status: "pending",
    });
    expect(first.status).toBe("committed");
    if (first.status !== "committed") return;
    await expect(documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: first.version.id, turnVersionId: first.version.id,
      expectedWorkingRevision: first.version.working_revision,
      filename: created.filename, fileType: "docx", bytes: applied.bytes,
      edits: [], status: "pending",
    })).resolves.toMatchObject({ status: "committed" });
    expect(state.values.get(created.id)).toMatchObject({
      versions: [{}, {}], edits: [{ status: "pending" }],
    });
    await expect(documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: first.version.id, expectedWorkingRevision: 1,
      filename: created.filename, fileType: "docx", bytes: applied.bytes,
      edits: [], status: "pending",
    })).rejects.toThrow("Accept or reject pending tracked changes");
    expect(state.values.get(created.id)?.versions).toHaveLength(2);
  });

  it("does not checkpoint or restore pending tracked changes", async () => {
    const state = memoryRepository(), documents = createDocumentApplication(state.repository,
      createFilesystemObjectStorage(root)), scope = { userId: "pending-owner" };
    const created = await documents.create(scope, {
      filename: "Brief.docx", fileType: "docx", bytes: await docx("one"),
    });
    const pending = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: created.current_version_id, expectedWorkingRevision: 0,
      filename: created.filename, fileType: "docx",
      bytes: await docx("two"), edits: [{ changeId: "change", deletedText: "one",
        insertedText: "two", contextBefore: "", contextAfter: "", diff: [] }],
      status: "pending",
    });
    expect(pending.status).toBe("committed");
    if (pending.status !== "committed") return;
    expect(state.values.get(created.id)?.versions.at(-1)?.provenance).toEqual({
      schemaVersion: 1, actor: "assistant", action: "revised", changeCount: 1,
    });
    expect(state.values.get(created.id)?.edits).toHaveLength(1);
    expect(await documents.checkpointVersion(scope, created.id, pending.version.id, 0))
      .toEqual({ status: "pending-edits" });
    expect(await documents.restoreVersion(
      scope, created.id, created.current_version_id, pending.version.id, 0,
    )).toEqual({ status: "pending-edits" });
    const clean = await documents.addVersion(scope, created.id, {
      filename: "Brief.docx", fileType: "docx", bytes: await docx("three"),
    });
    expect(await documents.restoreVersion(
      scope, created.id, pending.version.id, clean!.id, 0,
    )).toEqual({ status: "pending-edits" });
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(3);
  });

  it("reads a historical PDF rendition instead of assuming the head", async () => {
    const documents = createDocumentApplication(memoryRepository().repository,
      createFilesystemObjectStorage(root));
    const scope = { userId: "history-owner" }, firstBytes = await pdf("first");
    const created = await documents.create(scope, {
      filename: "record.pdf", fileType: "pdf", bytes: firstBytes,
    });
    await documents.addVersion(scope, created.id, {
      filename: "record.pdf", fileType: "pdf", bytes: await pdf("second"),
    });
    await expect(documents.read(scope, created.id, created.current_version_id, true))
      .resolves.toMatchObject({ bytes: firstBytes, fileType: "pdf" });
  });

  it("compares DOCX versions without creating another version", async () => {
    const state = memoryRepository(), documents = createDocumentApplication(
      state.repository, createFilesystemObjectStorage(root));
    const scope = { userId: "compare-owner" };
    const created = await documents.create(scope, {
      filename: "brief.docx", fileType: "docx", bytes: await validDocx("First sentence."),
    });
    const second = await documents.addVersion(scope, created.id, {
      filename: "brief.docx", fileType: "docx", bytes: await validDocx("Changed sentence."),
    });
    const compared = await documents.compareVersions(
      scope, created.id, created.current_version_id, second!.id,
    );
    expect(compared).toMatchObject({ status: "compared", filename: "brief (changes).docx" });
    expect(state.values.get(created.id)?.versions).toHaveLength(2);
    state.values.get(created.id)!.versions[0]!.sizeBytes = MAX_DRAFTING_DOCX_BYTES + 1;
    await expect(documents.compareVersions(
      scope, created.id, created.current_version_id, second!.id,
    )).rejects.toMatchObject({ status: 413 });
  });

  it("rejects source metadata that disagrees with its content-addressed key", async () => {
    const state = memoryRepository(), documents = createDocumentApplication(state.repository,
      createFilesystemObjectStorage(root)), scope = { userId: "descriptor-owner" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("trusted"),
    });
    state.values.get(created.id)!.versions[0].sourceSha256 = "0".repeat(64);
    await expect(documents.read(scope, created.id, null, false))
      .rejects.toThrow("integrity check");
    await expect((await documents.projectionSource(scope, created.id, null))!.readBytes())
      .rejects.toThrow("integrity check");
  });

  it.skipIf(process.env.S3_CONTRACT_TEST !== "true")(
    "runs the document lifecycle through configured S3 storage",
    async () => {
      const state = memoryRepository();
      const objects = scopeObjectStorage(createS3ObjectStorage(readS3Configuration()),
        `document-application-${randomUUID()}`);
      const documents = createDocumentApplication(state.repository, objects);
      const scope = { userId: "s3-lifecycle-owner" }, bytes = Buffer.from("shared");
      const created = await documents.create(scope, {
        filename: "notes.md", fileType: "md", bytes,
      });
      const duplicate = await documents.addVersion(scope, created.id, {
        filename: "notes.md", fileType: "md", bytes,
      });
      const changed = await documents.addVersion(scope, created.id, {
        filename: "notes.md", fileType: "md", bytes: Buffer.from("changed"),
      });
      expect(new Set(state.values.get(created.id)!.versions.map(({ blobKey }) => blobKey)).size)
        .toBe(2);
      await expect(documents.restoreVersion(scope, created.id, created.current_version_id,
        changed!.id, changed!.working_revision)).resolves.toMatchObject({ status: "restored" });
      expect((await documents.read(scope, created.id, null, false))?.bytes).toEqual(bytes);
      const libraryCopy = await documents.create(scope, {
        filename: "copy.md", fileType: "md", bytes,
      });
      const project = await documents.create(scope, {
        filename: "project.md", fileType: "md", bytes, projectId: "matter",
      });
      const projectCopy = await documents.create(scope, {
        filename: "project-copy.md", fileType: "md", bytes, projectId: "matter",
      });
      const isolated = await documents.create(scope, {
        filename: "isolated.md", fileType: "md", bytes, projectId: "other-matter",
      });
      const key = (id: string) => state.values.get(id)!.versions[0].blobKey;
      expect(key(libraryCopy.id)).toBe(key(created.id));
      expect(key(projectCopy.id)).toBe(key(project.id));
      expect(new Set([key(created.id), key(project.id), key(isolated.id)]).size).toBe(3);
      const keys = new Set([...state.values.values()].flatMap((value) =>
        value.versions.map(({ blobKey }) => blobKey)));
      expect(duplicate?.source_sha256).toBe(created.source_sha256);
      for (const id of [created.id, libraryCopy.id, project.id, projectCopy.id, isolated.id])
        await documents.deleteDocument(scope, id);
      await documents.resumeCleanup();
      for (const key of keys) await expect(objects.get(key)).resolves.toBeNull();
    },
  );

  it("signs only after authorization and resumes failed compensation cleanup", async () => {
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
    const stored = state.values.get(created.id)!.versions[0];
    expect(mode.signedGet).toHaveBeenCalledWith(stored.blobKey, expect.objectContaining({
      expectedSha256: stored.sourceSha256, sizeBytes: stored.sizeBytes,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      disposition: "attachment",
    }));
    mode.signedGet!.mockResolvedValueOnce(null);
    expect(await documents.download({ userId: "owner" }, created.id, null, false, "attachment"))
      .toBeNull();

    const put = mode.objects.put;
    mode.objects.put = async () => { throw new Error("provider object not found"); };
    await expect(documents.addVersion({ userId: "owner" }, created.id, {
      filename: "Brief.docx", fileType: "docx", bytes: await docx("next"),
    })).rejects.toThrow("provider object not found");
    mode.objects.put = put;

    state.repository.create = async () => { throw new Error("metadata unavailable"); };
    await expect(documents.create({ userId: "owner" }, {
      filename: "Orphan.docx", fileType: "docx", bytes: await docx("orphan"),
    })).rejects.toThrow("metadata unavailable");
    expect(state.orphans.size).toBe(2);
    const remove = mode.objects.remove;
    const pending = state.repository.pendingOrphans.bind(state.repository);
    let failedKey: string | undefined, firstSweep = true;
    mode.objects.remove = async (key) => {
      if (!failedKey && await mode.objects.get(key)) {
        failedKey = key; throw new Error("storage unavailable");
      }
      await remove(key);
    };
    state.repository.pendingOrphans = (limit) => firstSweep
      ? (firstSweep = false, pending(limit)) : Promise.resolve([]);
    await documents.resumeCleanup();
    expect((await pending()).map((item) => item.key)).toEqual([failedKey]);
    await expect(mode.objects.get(failedKey!)).resolves.not.toBeNull();

    state.repository.pendingOrphans = pending;
    mode.objects.remove = remove;
    await documents.resumeCleanup();
    expect(state.orphans.size).toBe(0);
    await expect(mode.objects.get(failedKey!)).resolves.toBeNull();
  });
});
