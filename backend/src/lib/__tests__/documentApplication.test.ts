import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument } from "pdf-lib";
import { createDocumentApplication } from "../documentApplication";
import { MAX_DRAFTING_DOCX_BYTES } from "../docx/core";
import { sha256 } from "../hash";
import { documentRepository as repository } from "../relationalDocumentRepository";
import { projectRepository } from "../relationalProjectRepository";
import { closeRelationalDatabase, relationalDatabase, sql } from "../relationalDatabase";
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

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "beaver-documents-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeRelationalDatabase();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const project = (scope: DocumentScope, sharedWith: string[] = []) =>
  projectRepository.create(scope, { name: "Matter", cmNumber: null, practice: null, sharedWith });
async function projectFolders(scope: DocumentScope) {
  const { id: projectId } = await project(scope);
  const [drafts, filed] = await Promise.all(["Drafts", "Filed"].map((name) =>
    projectRepository.createFolder(scope, projectId, { name, parentFolderId: null })));
  return { projectId, folderId: drafts!.id, filedId: filed!.id };
}

async function orphanKeys() {
  const { rows } = await (await relationalDatabase()).query<{ storage_path: string }>(
    sql`SELECT storage_path FROM object_cleanup ORDER BY storage_path`);
  return rows.map(({ storage_path }) => storage_path);
}
// Age only disposable cleanup rows; do not wait for the production grace period.
async function ageOrphans() {
  await (await relationalDatabase()).query(sql`UPDATE object_cleanup
    SET created_at=${"2000-01-01T00:00:00.000Z"}`);
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
    const bulk = vi.spyOn(repository, "currentVersions");
    const documents = createDocumentApplication(repository, objects), scope = { userId: "bulk" };
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
    const objects = createFilesystemObjectStorage(root), put = vi.spyOn(objects, "put");
    const documents = createDocumentApplication(repository, objects);
    await expect(documents.create({ userId: "owner" }, {
      filename: "corrupt.docx", fileType: "docx", bytes: Buffer.from("PK\x03\x04not-a-zip"),
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("extraction limits") });
    await expect(documents.create({ userId: "owner" }, {
      filename: "bomb.docx", fileType: "docx", bytes,
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("extraction limits") });
    expect(put).not.toHaveBeenCalled();
    expect((await (await relationalDatabase()).query(sql`SELECT id FROM documents`)).rows).toEqual([]);
    expect(await orphanKeys()).toEqual([]);
  });

  it("rejects output bytes that do not match their build receipt before storing them", async () => {
    const objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(repository, objects);
    const scope = { userId: "receipt-owner" };
    const created = await documents.create(scope, {
      filename: "Record.docx", fileType: "docx", bytes: await docx("first"),
    });
    const put = vi.spyOn(objects, "put");
    await expect(documents.addVersion(scope, created.id, {
      filename: "Record.docx", fileType: "docx", bytes: await docx("second"),
      expectedSha256: "0".repeat(64),
    })).rejects.toMatchObject({ status: 409 });
    expect(put).not.toHaveBeenCalled();
    expect((await documents.read(scope, created.id, null, false))?.version.id)
      .toBe(created.current_version_id);
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(1);
    expect(await orphanKeys()).toEqual([]);
    await documents.deleteDocument(scope, created.id);
  });

  it("rejects a version whose expected parent is stale", async () => {
    const documents = createDocumentApplication(repository,
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
    const documents = createDocumentApplication(repository,
      createFilesystemObjectStorage(root)), scope = { userId: "rollback-owner" };
    const { projectId, folderId, filedId } = await projectFolders(scope);
    const created = await documents.create(scope, { filename: "notes.md", fileType: "md",
      bytes: Buffer.from("one"), projectId, folderId });
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
    expect(await documents.relocate(scope, created.id, { expectedProjectId: projectId,
      expectedFolderId: folderId, projectId, folderId: filedId, owner: true }))
      .toMatchObject({ status: "moved" });
    await expect(documents.deleteVersion(scope, created.id, version.id, {
      ...expected, workingRevision: expected.workingRevision + 1,
    })).resolves.toEqual({ status: "missing" });
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(2);
  });

  it("lets an authorized project collaborator roll back its unchanged version", async () => {
    const member = { userId: "member", userEmail: "member@example.test" };
    const documents = createDocumentApplication(repository,
      createFilesystemObjectStorage(root));
    const owner = { userId: "owner", userEmail: "owner@example.test" };
    const { id: projectId } = await project(owner, [member.userEmail]);
    const created = await documents.create(owner, { filename: "notes.md", fileType: "md",
      bytes: Buffer.from("one"), projectId });
    const version = (await documents.addVersion(member, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("two"),
    }))!;
    await expect(documents.deleteVersion(member, created.id, version.id, {
      versionId: version.id, workingRevision: version.working_revision,
      projectId, folderId: null,
    })).resolves.toEqual({ status: "deleted", currentVersionId: created.current_version_id });
    expect((await documents.read(member, created.id, null, false))?.bytes.toString()).toBe("one");
  });

  it("does not remove a created document after its head or location changes", async () => {
    const documents = createDocumentApplication(repository,
      createFilesystemObjectStorage(root)), scope = { userId: "created-rollback-owner" };
    const { projectId, folderId, filedId } = await projectFolders(scope);
    const created = await documents.create(scope, { filename: "draft.md", fileType: "md",
      bytes: Buffer.from("one"), projectId, folderId });
    const expected = { versionId: created.current_version_id,
      workingRevision: created.current_working_revision,
      projectId: created.project_id, folderId: created.folder_id };
    await documents.replaceVersion(scope, created.id, created.current_version_id,
      created.current_working_revision,
      { filename: "filed.md", fileType: "md", bytes: Buffer.from("two") });
    expect(await documents.relocate(scope, created.id, { expectedProjectId: projectId,
      expectedFolderId: folderId, projectId, folderId: filedId, owner: true }))
      .toMatchObject({ status: "moved" });
    await expect(documents.deleteDocument(scope, created.id, true, expected)).resolves.toBe(false);
    await expect(documents.read(scope, created.id, null, false)).resolves.toMatchObject({
      filename: "filed.md", bytes: Buffer.from("two"),
    });
  });

  it("coalesces one assistant turn and parents the next turn to it", async () => {
    const documents = createDocumentApplication(repository,
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
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(2);
    if (second.status !== "committed") return;
    const retried = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: second.version.id,
      expectedWorkingRevision: second.version.working_revision,
      filename: created.filename, fileType: "md", bytes: Buffer.from("four"),
      edits: [], status: "pending", turnId: "turn-1",
    });
    expect(retried.status).toBe("committed");
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(2);
    if (retried.status !== "committed") return;
    const nextTurn = await documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: retried.version.id,
      expectedWorkingRevision: retried.version.working_revision,
      filename: created.filename, fileType: "md", bytes: Buffer.from("five"),
      edits: [], status: "pending", turnId: "turn-2",
    });
    expect(nextTurn).toMatchObject({ status: "committed",
      version: { parent_version_id: retried.version.id } });
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(3);
    expect((await documents.read(scope, created.id, null, false))?.bytes.toString()).toBe("five");
    await documents.deleteDocument(scope, created.id);
  });

  it("rejects a stale same-version research autosave", async () => {
    const documents = createDocumentApplication(repository,
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
    const documents = createDocumentApplication(repository,
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
    await documents.renameVersion(scope, created.id, revised.version.id, "Revised memo.md", 0);
    const checkpoint = await documents.checkpointVersion(scope, created.id, revised.version.id, 1);
    expect(checkpoint.status).toBe("created");
    if (checkpoint.status !== "created") return;
    const checkpointProvenance = (await documents.projectionSource(scope, created.id, null))?.provenance;
    expect(checkpointProvenance).toMatchObject({ actor: "assistant", action: "revised" });
    expect(checkpointProvenance).not.toHaveProperty("turnId");
    const restored = await documents.restoreVersion(scope, created.id, created.current_version_id,
      checkpoint.version.id, 0);
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") return;
    const restoredProvenance = (await documents.projectionSource(scope, created.id, null))?.provenance;
    expect(restoredProvenance).toMatchObject({ actor: "assistant", action: "created" });
    expect(restoredProvenance).not.toHaveProperty("turnId");
    await documents.replaceVersion(scope, created.id, restored.version.id, 0,
      { filename: "memo.md", fileType: "md", bytes: Buffer.from("unrelated upload") });
    expect((await documents.projectionSource(scope, created.id, null))?.provenance).toBeUndefined();
  });

  it("restores an immutable version as a zero-copy descendant", async () => {
    const objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(repository, objects);
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
    expect(new Set((await repository.history(scope, created.id))?.versions.map(({ blobKey }) => blobKey)).size)
      .toBe(3);
    expect((await documents.read(scope, created.id, null, false))?.bytes.toString()).toBe("one");
    expect((await documents.read(scope, created.id, second!.id, false))?.bytes.toString()).toBe("two");
    await documents.deleteDocument(scope, created.id);
    await ageOrphans();
    await documents.resumeCleanup();
    expect(await orphanKeys()).toEqual([]);
  });

  it("never restores missing or corrupt historical bytes", async () => {
    const objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(repository, objects);
    const scope = { userId: "damaged-restore-owner" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    const second = await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("two"),
    });
    const source = (await repository.version(scope, created.id, created.current_version_id))!;
    const rendition = Buffer.from("pdf rendition"), pdfDigest = sha256(rendition);
    source.pdfBlobKey = documentBlobKey({ userId: scope.userId, projectId: null }, pdfDigest);
    await (await relationalDatabase()).query(sql`UPDATE document_versions
      SET pdf_storage_path=${source.pdfBlobKey} WHERE id=${source.id}`);
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
    const objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(repository, objects);
    const scope = { userId: "checkpoint-owner", userEmail: "owner@example.test" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    await expect(documents.checkpointVersion(scope, created.id, created.current_version_id, 0))
      .rejects.toMatchObject({ status: 409 });
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(1);
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
    if (checkpoint.status !== "created") throw new Error("Expected a checkpoint");
    await objects.remove((await repository.version(scope, created.id, checkpoint.version.id))!.blobKey);
    expect(await documents.checkpointVersion(scope, created.id, checkpoint.version.id, 0))
      .toEqual({ status: "missing" });
    expect(new Set((await repository.history(scope, created.id))?.versions.map(({ blobKey }) => blobKey)).size)
      .toBe(1);
  });

  it("reserves deduplicated scope-move targets in one batch", async () => {
    const objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(repository, objects);
    const scope = { userId: "move-owner" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    await documents.addVersion(scope, created.id, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    const { id: projectId } = await project(scope);
    const reserve = vi.spyOn(repository, "recordOrphans");
    const put = vi.spyOn(objects, "put");
    await expect(documents.relocate(scope, created.id, {
      expectedProjectId: null, expectedFolderId: null,
      projectId, folderId: null, owner: true,
    })).resolves.toMatchObject({ status: "moved" });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0][0]).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("does not copy a document before authorizing its destination", async () => {
    const objects = createFilesystemObjectStorage(root);
    const documents = createDocumentApplication(repository, objects);
    const scope = { userId: "move-owner" }, created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("one"),
    });
    const { id: forbidden } = await project({ userId: "another-owner" });
    const put = vi.spyOn(objects, "put");
    await expect(documents.relocate(scope, created.id, {
      expectedProjectId: null, expectedFolderId: null,
      projectId: forbidden, folderId: null, owner: true,
    })).resolves.toEqual({ status: "missing" });
    expect(put).not.toHaveBeenCalled();
  });

  it("preserves pending markers when a later same-turn write adds no edits", async () => {
    const documents = createDocumentApplication(repository,
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
    expect((await repository.get(scope, created.id))?.edits).toMatchObject([{ status: "pending" }]);
    await expect(documents.commitAssistantVersion(scope, created.id, {
      sourceVersionId: first.version.id, expectedWorkingRevision: 1,
      filename: created.filename, fileType: "docx", bytes: applied.bytes,
      edits: [], status: "pending",
    })).rejects.toThrow("Accept or reject pending tracked changes");
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(2);
  });

  it("does not checkpoint or restore pending tracked changes", async () => {
    const documents = createDocumentApplication(repository,
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
    expect((await documents.projectionSource(scope, created.id, null))?.provenance).toEqual({
      schemaVersion: 1, actor: "assistant", action: "revised", changeCount: 1,
    });
    expect((await repository.get(scope, created.id))?.edits).toHaveLength(1);
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
    const documents = createDocumentApplication(repository,
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
    const documents = createDocumentApplication(
      repository, createFilesystemObjectStorage(root));
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
    expect((await documents.versions(scope, created.id))?.versions).toHaveLength(2);
    await (await relationalDatabase()).query(sql`UPDATE document_versions
      SET size_bytes=${MAX_DRAFTING_DOCX_BYTES + 1} WHERE id=${created.current_version_id}`);
    await expect(documents.compareVersions(
      scope, created.id, created.current_version_id, second!.id,
    )).rejects.toMatchObject({ status: 413 });
  });

  it("rejects source metadata that disagrees with its content-addressed key", async () => {
    const documents = createDocumentApplication(repository,
      createFilesystemObjectStorage(root)), scope = { userId: "descriptor-owner" };
    const created = await documents.create(scope, {
      filename: "notes.md", fileType: "md", bytes: Buffer.from("trusted"),
    });
    await (await relationalDatabase()).query(sql`UPDATE document_versions
      SET source_sha256=${"0".repeat(64)} WHERE id=${created.current_version_id}`);
    await expect(documents.read(scope, created.id, null, false))
      .rejects.toThrow(/storage scope|integrity check/);
    await expect(documents.projectionSource(scope, created.id, null).then((source) => source?.readBytes()))
      .rejects.toThrow(/storage scope|integrity check/);
  });

  it.skipIf(process.env.S3_CONTRACT_TEST !== "true")(
    "runs the document lifecycle through configured S3 storage",
    async () => {
      const objects = scopeObjectStorage(createS3ObjectStorage(readS3Configuration()),
        `document-application-${randomUUID()}`);
      const documents = createDocumentApplication(repository, objects);
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
      expect(new Set((await repository.history(scope, created.id))!.versions.map(({ blobKey }) => blobKey)).size)
        .toBe(2);
      await expect(documents.restoreVersion(scope, created.id, created.current_version_id,
        changed!.id, changed!.working_revision)).resolves.toMatchObject({ status: "restored" });
      expect((await documents.read(scope, created.id, null, false))?.bytes).toEqual(bytes);
      const libraryCopy = await documents.create(scope, {
        filename: "copy.md", fileType: "md", bytes,
      });
      const { id: projectId } = await project(scope);
      const { id: otherProjectId } = await project(scope);
      const projectDocument = await documents.create(scope, {
        filename: "project.md", fileType: "md", bytes, projectId,
      });
      const projectCopy = await documents.create(scope, {
        filename: "project-copy.md", fileType: "md", bytes, projectId,
      });
      const isolated = await documents.create(scope, {
        filename: "isolated.md", fileType: "md", bytes, projectId: otherProjectId,
      });
      const ids = [created.id, libraryCopy.id, projectDocument.id, projectCopy.id, isolated.id];
      const records = await Promise.all(ids.map((id) => repository.history(scope, id)));
      const keys = records.map((value) => value!.versions[0].blobKey);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[3]).toBe(keys[2]);
      expect(new Set([keys[0], keys[2], keys[4]]).size).toBe(3);
      const allKeys = new Set(records.flatMap((value) => value!.versions.map(({ blobKey }) => blobKey)));
      expect(duplicate?.source_sha256).toBe(created.source_sha256);
      for (const id of ids)
        await documents.deleteDocument(scope, id);
      await ageOrphans();
      await documents.resumeCleanup();
      for (const key of allKeys) await expect(objects.get(key)).resolves.toBeNull();
    },
  );

  it("signs only after authorization and resumes failed compensation cleanup", async () => {
    const signedGet = vi.fn(async (): Promise<string | null> => "https://storage.test/signed-document");
    // Keep a double only for the external signing boundary; bytes and metadata are real.
    const objects: ObjectStorage = { ...createFilesystemObjectStorage(root), signedGet };
    const documents = createDocumentApplication(repository, objects);
    const created = await documents.create({ userId: "owner" }, {
      filename: "Brief.docx", fileType: "docx", bytes: await docx("private"),
    });
    expect(await documents.download({ userId: "other" }, created.id, null, { preferPdf: false, disposition: "attachment" }))
      .toBeNull();
    expect(signedGet).not.toHaveBeenCalled();
    expect(await documents.download({ userId: "owner" }, created.id, null, { preferPdf: false, disposition: "attachment" }))
      .toMatchObject({ kind: "redirect" });
    const stored = (await repository.version({ userId: "owner" }, created.id, null))!;
    expect(signedGet).toHaveBeenCalledWith(stored.blobKey, expect.objectContaining({
      expectedSha256: stored.sourceSha256, sizeBytes: stored.sizeBytes,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      disposition: "attachment",
    }));
    signedGet.mockResolvedValueOnce(null);
    expect(await documents.download({ userId: "owner" }, created.id, null, { preferPdf: false, disposition: "attachment" }))
      .toBeNull();

    vi.spyOn(objects, "put").mockRejectedValueOnce(new Error("provider object not found"));
    await expect(documents.addVersion({ userId: "owner" }, created.id, {
      filename: "Brief.docx", fileType: "docx", bytes: await docx("next"),
    })).rejects.toThrow("provider object not found");

    vi.spyOn(repository, "create").mockRejectedValueOnce(new Error("metadata unavailable"));
    await expect(documents.create({ userId: "owner" }, {
      filename: "Orphan.docx", fileType: "docx", bytes: await docx("orphan"),
    })).rejects.toThrow("metadata unavailable");
    expect(await orphanKeys()).toHaveLength(2);
    const remove = objects.remove;
    let failedKey: string | undefined;
    objects.remove = async (key) => {
      if (!failedKey && await objects.get(key)) {
        failedKey = key; throw new Error("storage unavailable");
      }
      await remove(key);
    };
    await ageOrphans();
    await documents.resumeCleanup();
    expect(await orphanKeys()).toEqual([failedKey]);
    await expect(objects.get(failedKey!)).resolves.not.toBeNull();

    objects.remove = remove;
    await ageOrphans();
    await documents.resumeCleanup();
    expect(await orphanKeys()).toEqual([]);
    await expect(objects.get(failedKey!)).resolves.toBeNull();
  });
});
