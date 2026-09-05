import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createAuthoritiesDraft } from "../../authoritiesDomain";
import type { CreateDocumentMetadata, DocumentRepository } from "../../documentRepository";
import { canonicalJsonSha256 } from "../../hash";
import { documentBlobKey } from "../../storage";
import { createWorkProductApplication } from "../../workProductApplication";
import type { ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductInput, WorkProductKind, WorkProductState } from "../../workProduct";

const scope = (role: string) => ({ userId: randomUUID(),
  userEmail: `${role}-${randomUUID()}@example.test` });
type TestScope = ReturnType<typeof scope>;
const initialDocument = (
  owner: ReturnType<typeof scope>, documentId: string, versionId: string, projectId: string | null,
  options: { filename?: string; sha256?: string; parentVersionId?: string | null;
    authorEmail?: string; provenance?: import("../../documentStore").DocumentProvenance } = {},
) => {
  const created = new Date().toISOString(), digest = options.sha256 ?? "a".repeat(64);
  return { document: {
    id: documentId, userId: owner.userId, projectId, libraryKind: "file" as const, folderId: null,
    status: "ready" as const, currentVersionId: versionId, createdAt: created, updatedAt: created,
  }, version: {
    id: versionId, documentId, parentVersionId: options.parentVersionId ?? null,
    versionNumber: 1, workingRevision: 0,
    source: "upload" as const, createdBy: owner.userId, comment: null, createdAt: created,
    ...(options.authorEmail ? { authorEmail: options.authorEmail } : {}),
    filename: options.filename ?? "record.pdf", fileType: "pdf", sizeBytes: 1, pageCount: 1,
    sourceSha256: digest, blobKey: documentBlobKey({ userId: owner.userId, projectId }, digest),
    pdfBlobKey: null, ...(options.provenance ? { provenance: options.provenance } : {}),
  } };
};

const stage = (repository: DocumentRepository, owner: TestScope,
  ...keys: Array<string | null>) => repository.recordOrphans(
  keys.filter((key): key is string => !!key));
const createDocument = async (repository: DocumentRepository, owner: TestScope,
  input: CreateDocumentMetadata) => {
  await stage(repository, owner, input.version.blobKey, input.version.pdfBlobKey);
  return repository.create(owner, input);
};

const buildReceipt = (product: { id: string; kind: WorkProductKind; revision: number },
  state: unknown, inputs: Array<{ role: string; resolved: ResolvedWorkProductInput }>, role: string,
  filename = "record.pdf", digest = "c".repeat(64)): WorkProductBuildReceipt => ({
  schemaVersion: "beaver.work-product-build.v2", builtAt: new Date().toISOString(),
  workProduct: product, inputs,
  settings: { profileId: product.kind === "court-record" ? "profile" : null,
    outputMode: "single", stateSha256: canonicalJsonSha256(state),
    settingsSha256: "e".repeat(64),
    sourceReceiptIds: [], audit: { effective: null, valuesJson: "{}" } },
  steps: ["Built"], output: { role, filename, mimeType: "application/pdf",
    pageCount: 1, sha256: digest },
});
const reverseObjectKeys = (value: unknown): unknown => Array.isArray(value)
  ? value.map(reverseObjectKeys)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]))
    : value;
const courtState = (bindings: Record<string, WorkProductInput> = {}): WorkProductState => ({
  profileId: "ab-kb-chambers-justice-applicant-set", cover: {}, bindings,
  entries: Object.keys(bindings).map((id) => ({ id, kindId: "authorities", title: id,
    lastSeen: { name: `${id}.pdf`, size: 1, modified: 1 } })),
});
const authoritiesState = (source?: WorkProductInput): WorkProductState => source
  ? createAuthoritiesDraft({ kind: "document", bindingRole: "source", filename: "record.pdf",
    fileType: "pdf", snapshot: null }, { source })
  : createAuthoritiesDraft({ kind: "manual" });
const removeUserData = async (userId: string) => {
  const { relationalDatabase, sql } = await import("../../relationalDatabase");
  const database = await relationalDatabase();
  await database.query(sql`DELETE FROM work_products WHERE user_id=${userId}`);
  await database.query(sql`DELETE FROM documents WHERE user_id=${userId}`);
  await database.query(sql`DELETE FROM projects WHERE user_id=${userId}`);
};

export function relationalRepositoryContract(
  prepareScopes: (scopes: TestScope[]) => Promise<void> = async () => undefined,
) {
  it("keeps the version author email as an immutable snapshot", async () => {
    const { documentRepository } = await import("../../relationalDocumentRepository");
    const owner = scope("version-author"), documentId = randomUUID(), versionId = randomUUID();
    await prepareScopes([owner]);
    try {
      await createDocument(documentRepository, owner, initialDocument(
        owner, documentId, versionId, null, { authorEmail: "snapshot@example.test" }));
      await expect(documentRepository.head(owner, documentId)).resolves.toMatchObject({
        versions: [{ authorEmail: "snapshot@example.test" }],
      });
      await expect(documentRepository.history(owner, documentId)).resolves.toMatchObject({
        versions: [{ authorEmail: "snapshot@example.test" }],
      });
    } finally {
      await removeUserData(owner.userId);
    }
  });

  it("applies explicit project, document, review, and chat scope", async () => {
    const [{ chatRepository }, { documentRepository }, { projectRepository },
      { tabularRepository }] = await Promise.all([
      import("../../relationalChatRepository"), import("../../relationalDocumentRepository"),
      import("../../relationalProjectRepository"), import("../../relationalTabularRepository"),
    ]);
    const owner = scope("owner"), member = scope("member"), stranger = scope("stranger");
    await prepareScopes([owner, member, stranger]);
    try {
      const project = await projectRepository.create(owner, {
        name: "Matter", cmNumber: null, practice: null, sharedWith: [member.userEmail],
        metadata: {}, notes: null,
      });
      await expect(projectRepository.project(member, project.id, false)).resolves.toMatchObject(
        { id: project.id, is_owner: false });
      await expect(projectRepository.project(stranger, project.id, false)).resolves.toBeNull();

      const documentId = randomUUID(), versionId = randomUUID();
      const initial = initialDocument(owner, documentId, versionId, project.id);
      await createDocument(documentRepository, owner, initial);
      await expect(documentRepository.get(member, documentId)).resolves.toMatchObject(
        { document: { id: documentId } });
      await expect(documentRepository.get(stranger, documentId)).resolves.toBeNull();
      await expect(documentRepository.currentVersions(member, [documentId, documentId]))
        .resolves.toMatchObject([{ id: versionId, documentId }]);
      await expect(documentRepository.currentVersions(stranger, [documentId])).resolves.toEqual([]);

      const restored = { ...initial.version, id: randomUUID(), parentVersionId: versionId,
        versionNumber: 2, source: "restore", createdBy: member.userId,
        createdAt: new Date().toISOString() };
      await expect(documentRepository.insertVersion(member, documentId, {
        expectedCurrentVersionId: versionId, expectedCurrentWorkingRevision: 0,
        expectedProjectId: project.id, expectedFolderId: null, version: restored,
      })).resolves.toBe("created");
      const rollback = { versionId: restored.id, expectedCurrentVersionId: restored.id,
        nextCurrentVersionId: versionId, expectedBlobKey: restored.blobKey,
        expectedPdfBlobKey: restored.pdfBlobKey, expectedWorkingRevision: 0,
        expectedProjectId: project.id, expectedFolderId: null };
      await expect(documentRepository.version(stranger, documentId, restored.id))
        .resolves.toBeNull();
      await expect(documentRepository.insertVersion(stranger, documentId, {
        expectedCurrentVersionId: restored.id, expectedCurrentWorkingRevision: 0,
        version: { ...restored, id: randomUUID(), parentVersionId: restored.id, versionNumber: 3 },
      })).resolves.toBe("missing");
      await expect(documentRepository.deleteVersion(stranger, documentId, rollback))
        .resolves.toBe(false);
      await expect(documentRepository.deleteVersion(member, documentId, rollback))
        .resolves.toBe(true);
      await expect(documentRepository.history(owner, documentId)).resolves.toMatchObject({
        currentVersionId: versionId, versions: [{ id: versionId }],
      });

      const review = await tabularRepository.create(owner, {
        projectId: project.id, title: "Review", columns: [], documentIds: [documentId],
        workflowId: null, sharedWith: [member.userEmail],
      });
      expect(review.status).toBe("committed");
      const reviewId = review.status === "committed" ? review.value.id : "";
      await expect(tabularRepository.detail(member, reviewId)).resolves.toMatchObject(
        { review: { id: reviewId, is_owner: false } });
      await expect(tabularRepository.detail(stranger, reviewId)).resolves.toBeNull();

      const chats = chatRepository(owner);
      const chat = await chats.create({ projectId: project.id, tabularReviewId: null });
      await chats.commit(chat.id, { kind: "turn", turn: { expectedVersion: 0,
        userMessage: { id: randomUUID(), content: "Question" } } });
      await expect(chatRepository(member).list({ projectId: project.id })).resolves.toEqual(
        [expect.objectContaining({ id: chat.id })]);
      await expect(chatRepository(stranger).read(chat.id)).resolves.toBeNull();
    } finally {
      await removeUserData(owner.userId);
    }
  });

  it("keeps tabular document references transactional", async () => {
    const [{ documentRepository }, { projectRepository }, { tabularRepository }] = await Promise.all([
      import("../../relationalDocumentRepository"), import("../../relationalProjectRepository"),
      import("../../relationalTabularRepository"),
    ]);
    const owner = scope("review-owner"), member = scope("document-owner");
    await prepareScopes([owner, member]);
    try {
      const project = await projectRepository.create(owner, { name: "Matter", cmNumber: null,
        practice: null, sharedWith: [member.userEmail], metadata: {}, notes: null });
      const documentId = randomUUID(), versionId = randomUUID();
      const initial = initialDocument(member, documentId, versionId, project.id);
      initial.version.fileType = "md";
      await createDocument(documentRepository, member, initial);
      await expect(tabularRepository.create(owner, { projectId: project.id, title: "Missing",
        columns: [], documentIds: [randomUUID()], workflowId: null, sharedWith: [],
      })).resolves.toEqual({ status: "missing" });
      const created = await tabularRepository.create(owner, { projectId: project.id,
        title: "Review", columns: [{ index: 0, name: "Issue", prompt: "Find it" }],
        documentIds: [documentId], workflowId: null, sharedWith: [] });
      expect(created.status).toBe("committed");
      const review = created.status === "committed" ? created.value : null;
      await expect(tabularRepository.update(owner, review!.id, review!.updated_at, {
        documentIds: [randomUUID()],
      })).resolves.toEqual({ status: "missing" });
      await expect(documentRepository.deleteDocument(member, documentId)).resolves.toBe(true);
      await expect(tabularRepository.detail(owner, review!.id)).resolves.toMatchObject({
        review: { document_ids: [] }, cells: [],
      });
    } finally {
      await removeUserData(member.userId);
      await removeUserData(owner.userId);
    }
  });

  it("keeps concurrent Library folder creation inside a deleted tree", async () => {
    const { libraryRepository } = await import("../../relationalLibraryRepository");
    const owner = scope("library-owner");
    await prepareScopes([owner]);
    const library = { ...owner, kind: "file" as const };
    const root = await libraryRepository.createFolder(library, "Root", null);
    expect(root).not.toBeNull();
    const [deleted, ...created] = await Promise.all([
      libraryRepository.deleteFolder(library, root!.id),
      ...Array.from({ length: 8 }, (_, index) =>
        libraryRepository.createFolder(library, `Child ${index}`, root!.id)),
    ]);
    expect(deleted).toBe(true);
    await expect(libraryRepository.folder(library, root!.id)).resolves.toBeNull();
    await Promise.all(created.flatMap((folder) => folder
      ? [expect(libraryRepository.folder(library, folder.id)).resolves.toBeNull()] : []));
  });

  it("publishes one staged blob to concurrent documents", async () => {
    const { documentRepository } = await import("../../relationalDocumentRepository");
    const { relationalDatabase, sql } = await import("../../relationalDatabase");
    const owner = scope("shared-blob");
    await prepareScopes([owner]);
    const documents = Array.from({ length: 2 }, () => {
      const value = initialDocument(owner, randomUUID(), randomUUID(), null);
      value.version.fileType = "md";
      return value;
    });
    const key = documents[0].version.blobKey;
    try {
      await stage(documentRepository, owner, key);
      await expect(Promise.all(documents.map((value) =>
        documentRepository.create(owner, value)))).resolves.toEqual([true, true]);
    } finally {
      await removeUserData(owner.userId);
      await (await relationalDatabase()).query(sql`DELETE FROM object_cleanup
        WHERE storage_path=${key}`);
    }
  });

  it("commits one writer per document revision, even at the same digest", async () => {
    const { documentRepository } = await import("../../relationalDocumentRepository");
    const owner = scope("writer"), documentId = randomUUID(), firstId = randomUUID();
    await prepareScopes([owner]);
    try {
      await createDocument(documentRepository, owner,
        initialDocument(owner, documentId, firstId, null));
      const nextKey = documentBlobKey({ userId: owner.userId, projectId: null }, "b".repeat(64));
      const version = () => ({
        id: randomUUID(), documentId, parentVersionId: firstId,
        versionNumber: 2, workingRevision: 0, source: "upload",
        createdBy: owner.userId, comment: null,
        createdAt: new Date().toISOString(), filename: "record.pdf", fileType: "pdf",
        sizeBytes: 1, pageCount: 1, sourceSha256: "b".repeat(64), blobKey: nextKey,
        pdfBlobKey: null,
      });
      await stage(documentRepository, owner, nextKey);
      const results = await Promise.all([1, 2].map(() =>
        documentRepository.insertVersion(owner, documentId, {
          expectedCurrentVersionId: firstId, expectedCurrentWorkingRevision: 0,
          version: version(),
        })));
      expect(results.sort()).toEqual(["conflict", "created"]);
      expect((await documentRepository.history(owner, documentId))?.versions).toHaveLength(2);
      const current = await documentRepository.get(owner, documentId), active = current?.versions
        .find(({ id }) => id === current.document.currentVersionId)!;
      const replacement = documentBlobKey({ userId: owner.userId, projectId: null }, "c".repeat(64));
      await stage(documentRepository, owner, replacement);
      await expect(documentRepository.updateVersion(owner, documentId, {
        versionId: active.id, expectedBlobKey: active.blobKey,
        expectedWorkingRevision: active.workingRevision,
        expectedCurrentVersionId: active.id,
        update: { blobKey: replacement, sourceSha256: "c".repeat(64) },
      })).resolves.toBe("updated");
      const revised = (await documentRepository.get(owner, documentId))!.versions
        .find(({ id }) => id === active.id)!;
      const sameDigest = await Promise.all(["First name.pdf", "Second name.pdf"].map((filename) =>
        documentRepository.updateVersion(owner, documentId, {
          versionId: revised.id, expectedBlobKey: revised.blobKey,
          expectedWorkingRevision: revised.workingRevision,
          expectedCurrentVersionId: revised.id, update: { filename },
        })));
      expect(sameDigest.sort()).toEqual(["conflict", "updated"]);
      const committed = (await documentRepository.get(owner, documentId))!.versions
        .find(({ id }) => id === active.id)!;
      expect(committed).toMatchObject({ blobKey: revised.blobKey,
        workingRevision: revised.workingRevision + 1 });
      expect(["First name.pdf", "Second name.pdf"]).toContain(committed.filename);
    } finally {
      await removeUserData(owner.userId);
    }
  });

  it("commits one first DOCX rendition and leaves the loser collectible", async () => {
    const [{ documentRepository }, { relationalDatabase, sql }] = await Promise.all([
      import("../../relationalDocumentRepository"), import("../../relationalDatabase"),
    ]);
    const owner = scope("rendition-owner"), documentId = randomUUID(), versionId = randomUUID(),
      keys = ["b", "c"].map((value) => documentBlobKey(
        { userId: owner.userId, projectId: null }, value.repeat(64))),
      database = await relationalDatabase();
    await prepareScopes([owner]);
    try {
      const initial = initialDocument(owner, documentId, versionId, null);
      initial.version.fileType = "docx"; initial.version.filename = "record.docx";
      await createDocument(documentRepository, owner, initial);
      await documentRepository.recordOrphans(keys);
      const outcomes = await Promise.all(keys.map((key) =>
        documentRepository.updateVersion(owner, documentId, {
          versionId, expectedBlobKey: initial.version.blobKey, expectedPdfBlobKey: null,
          expectedWorkingRevision: 0, bumpWorkingRevision: false,
          update: { pdfBlobKey: key },
        })));
      expect(outcomes.sort()).toEqual(["conflict", "updated"]);
      const committed = (await documentRepository.head(owner, documentId))!.versions[0];
      expect(keys).toContain(committed.pdfBlobKey);
      const queued = (await database.query<{ storage_path: string }>(sql`SELECT storage_path
        FROM object_cleanup WHERE storage_path IN(${sql.join(keys)}) ORDER BY storage_path`)).rows;
      expect(queued.map(({ storage_path }) => storage_path))
        .toEqual(keys.filter((key) => key !== committed.pdfBlobKey).sort());
    } finally {
      await database.query(sql`DELETE FROM object_cleanup WHERE storage_path IN(${sql.join(keys)})`);
      await removeUserData(owner.userId);
    }
  });

  it("rejects a stale folder move inside the same project", async () => {
    const [{ documentRepository }, { projectRepository }] = await Promise.all([
      import("../../relationalDocumentRepository"), import("../../relationalProjectRepository"),
    ]);
    const owner = scope("folder-move-owner"), documentId = randomUUID(), versionId = randomUUID();
    await prepareScopes([owner]);
    try {
      const project = await projectRepository.create(owner, { name: "Matter", cmNumber: null,
        practice: null, sharedWith: [], metadata: {}, notes: null });
      const folder = await projectRepository.createFolder(owner, project.id, {
        name: "Filed", parentFolderId: null,
      });
      const initial = initialDocument(owner, documentId, versionId, project.id);
      await createDocument(documentRepository, owner, initial);
      await expect(documentRepository.relocate(owner, documentId, {
        expectedProjectId: project.id, expectedFolderId: null,
        projectId: project.id, folderId: folder!.id, owner: true, versions: [], parts: [],
      })).resolves.toMatchObject({ document: { folderId: folder!.id } });
      await expect(documentRepository.relocate(owner, documentId, {
        expectedProjectId: project.id, expectedFolderId: null,
        projectId: project.id, folderId: null, owner: true, versions: [], parts: [],
      })).resolves.toBe("conflict");
      await expect(documentRepository.head(owner, documentId)).resolves.toMatchObject({
        document: { folderId: folder!.id },
      });
      const wrong = documentBlobKey({ userId: owner.userId, projectId: null }, "b".repeat(64));
      await stage(documentRepository, owner, wrong);
      await expect(documentRepository.relocate(owner, documentId, {
        expectedProjectId: project.id, expectedFolderId: folder!.id,
        projectId: null, folderId: null, owner: true, parts: [], versions: [{
          versionId, expectedBlobKey: initial.version.blobKey, blobKey: wrong,
          expectedPdfBlobKey: null, pdfBlobKey: null,
        }],
      })).resolves.toBe("conflict");
    } finally {
      await removeUserData(owner.userId);
    }
  });

  it("accepts only the current version of the same document as parent", async () => {
    const { documentRepository } = await import("../../relationalDocumentRepository");
    const owner = scope("parent-owner"), documentId = randomUUID(), firstId = randomUUID(),
      otherId = randomUUID(), otherVersionId = randomUUID();
    await prepareScopes([owner]);
    try {
      const initial = initialDocument(owner, documentId, firstId, null);
      initial.version.fileType = "md";
      const other = initialDocument(owner, otherId, otherVersionId, null);
      other.version.fileType = "md";
      await createDocument(documentRepository, owner, initial);
      await createDocument(documentRepository, owner, other);
      await expect(documentRepository.create(owner, {
        ...initialDocument(owner, randomUUID(), randomUUID(), null),
        version: { ...initial.version, id: randomUUID(), documentId: otherId },
      })).rejects.toThrow("different document");
      const childDigest = "b".repeat(64), child = { ...initial.version, id: randomUUID(),
        parentVersionId: otherVersionId, versionNumber: 2, sourceSha256: childDigest,
        blobKey: documentBlobKey({ userId: owner.userId, projectId: null }, childDigest),
        createdAt: new Date().toISOString() };
      await stage(documentRepository, owner, child.blobKey);
      await expect(documentRepository.insertVersion(owner, documentId, {
        expectedCurrentVersionId: firstId, expectedCurrentWorkingRevision: 0, version: child,
      })).resolves.toBe("conflict");
      child.parentVersionId = firstId;
      await expect(documentRepository.insertVersion(owner, documentId, {
        expectedCurrentVersionId: firstId, expectedCurrentWorkingRevision: 0, version: child,
      })).resolves.toBe("created");
      await expect(documentRepository.insertVersion(owner, documentId, {
        expectedCurrentVersionId: child.id, expectedCurrentWorkingRevision: 0,
        version: { ...child, id: randomUUID(),
          versionNumber: 3 },
      })).resolves.toBe("conflict");
      await expect(documentRepository.history(owner, documentId)).resolves.toMatchObject({
        currentVersionId: child.id, versions: [{ id: child.id }, { id: firstId }],
      });
    } finally {
      await removeUserData(owner.userId);
    }
  });

  it("rejects a version staged for another storage scope", async () => {
    const [{ documentRepository }, { projectRepository }] = await Promise.all([
      import("../../relationalDocumentRepository"), import("../../relationalProjectRepository"),
    ]);
    const owner = scope("version-scope-owner"), documentId = randomUUID(), firstId = randomUUID();
    await prepareScopes([owner]);
    try {
      const project = await projectRepository.create(owner, { name: "Matter", cmNumber: null,
        practice: null, sharedWith: [], metadata: {}, notes: null });
      const initial = initialDocument(owner, documentId, firstId, project.id), digest = "b".repeat(64);
      await createDocument(documentRepository, owner, initial);
      const stale = { ...initial.version, id: randomUUID(), parentVersionId: firstId,
        versionNumber: 2, sourceSha256: digest,
        blobKey: documentBlobKey({ userId: owner.userId, projectId: null }, digest) };
      await stage(documentRepository, owner, stale.blobKey);
      await expect(documentRepository.insertVersion(owner, documentId, {
        expectedCurrentVersionId: firstId, expectedCurrentWorkingRevision: 0,
        expectedProjectId: project.id, expectedFolderId: null, version: stale,
      })).resolves.toBe("conflict");
      await expect(documentRepository.history(owner, documentId)).resolves.toMatchObject({
        currentVersionId: firstId, versions: [{ id: firstId }],
      });
    } finally { await removeUserData(owner.userId); }
  });

  it("serializes a checkpoint against a working save", async () => {
    const { documentRepository } = await import("../../relationalDocumentRepository");
    const owner = scope("head-writer"), documentId = randomUUID(), firstId = randomUUID();
    await prepareScopes([owner]);
    try {
      const initial = initialDocument(owner, documentId, firstId, null);
      initial.version.fileType = "md"; initial.version.filename = "notes.md";
      await createDocument(documentRepository, owner, initial);
      const checkpoint = { ...initial.version, id: randomUUID(), parentVersionId: firstId,
        versionNumber: 2 };
      const outcomes = await Promise.all([
        documentRepository.updateVersion(owner, documentId, {
          versionId: firstId, expectedBlobKey: initial.version.blobKey,
          expectedWorkingRevision: 0, expectedCurrentVersionId: firstId,
          update: { filename: "saved.md" },
        }),
        documentRepository.insertVersion(owner, documentId, {
          expectedCurrentVersionId: firstId, expectedCurrentWorkingRevision: 0,
          version: checkpoint,
        }),
      ]);
      expect(outcomes.filter((value) => value === "conflict")).toHaveLength(1);
      const current = await documentRepository.get(owner, documentId);
      expect(current?.versions).toHaveLength(outcomes.includes("created") ? 2 : 1);
    } finally {
      await removeUserData(owner.userId);
    }
  });

  it("leases each orphan to one cleaner and releases abandoned claims", async () => {
    const { documentRepository } = await import("../../relationalDocumentRepository");
    const { relationalDatabase, sql } = await import("../../relationalDatabase");
    const owner = scope("cleanup-owner"), key = `orphan-${randomUUID()}`;
    await prepareScopes([owner]);
    const database = await relationalDatabase();
    try {
      await expect(documentRepository.recordOrphans([key]))
        .resolves.toBe("staged");
      await database.query(sql`UPDATE object_cleanup SET
        created_at=${"1900-01-01T00:00:00.000Z"} WHERE storage_path=${key}`);
      const claims = (await Promise.all([
        documentRepository.pendingOrphans(1),
        documentRepository.pendingOrphans(1),
      ])).flat().filter((claim) => claim.key === key);
      expect(claims).toHaveLength(1);
      await expect(documentRepository.recordOrphans([key]))
        .resolves.toBe("busy");
      await expect(documentRepository.removeOrphan(key, claims[0]!.claimId, async () => {
        throw new Error("storage unavailable");
      })).rejects.toThrow("storage unavailable");
      await expect(documentRepository.recordOrphans([key]))
        .resolves.toBe("staged");
      await database.query(sql`UPDATE object_cleanup SET created_at=${"1900-01-01T00:00:00.000Z"},
        claim_id=${randomUUID()},claimed_at=${"1900-01-01T00:00:00.000Z"}
        WHERE storage_path=${key}`);
      const [retry] = await documentRepository.pendingOrphans(1);
      await expect(documentRepository.removeOrphan(
        key, retry!.claimId, async () => undefined)).resolves.toBe(true);
      await expect(documentRepository.pendingOrphans(1)).resolves.toEqual([]);
    } finally {
      await database.query(sql`DELETE FROM object_cleanup WHERE storage_path=${key}`);
      await removeUserData(owner.userId);
    }
  });

  it("serializes an expired cleaner against republishing the same blob", async () => {
    const { documentRepository } = await import("../../relationalDocumentRepository");
    const { relationalDatabase, sql } = await import("../../relationalDatabase");
    const owner = scope("cleanup-fence"), documentId = randomUUID(), versionId = randomUUID(),
      key = documentBlobKey({ userId: owner.userId, projectId: null }, "a".repeat(64));
    await prepareScopes([owner]);
    const database = await relationalDatabase();
    try {
      await documentRepository.recordOrphans([key]);
      await database.query(sql`UPDATE object_cleanup SET
        created_at=${"1900-01-01T00:00:00.000Z"} WHERE storage_path=${key}`);
      const [claim] = await documentRepository.pendingOrphans(1);
      await database.query(sql`UPDATE object_cleanup SET
        claimed_at=${"1900-01-01T00:00:00.000Z"} WHERE storage_path=${key}`);
      let begin!: () => void, resume!: () => void; const order: string[] = [];
      const begun = new Promise<void>((resolve) => { begin = resolve; });
      const proceed = new Promise<void>((resolve) => { resume = resolve; });
      const deleting = documentRepository.removeOrphan(key, claim!.claimId, async () => {
        order.push("remove"); begin(); await proceed;
      });
      await begun;
      const restaging = documentRepository.recordOrphans([key]).then((result) => {
        order.push("stage"); return result;
      });
      resume();
      await expect(deleting).resolves.toBe(true);
      await expect(restaging).resolves.toBe("staged");
      expect(order).toEqual(["remove", "stage"]);
      const candidate = initialDocument(owner, documentId, versionId, null);
      candidate.version.fileType = "md";
      await expect(documentRepository.create(owner, candidate)).resolves.toBe(true);
      await expect(documentRepository.head(owner, documentId)).resolves.toMatchObject({
        document: { id: documentId },
      });
    } finally {
      await database.query(sql`DELETE FROM object_cleanup WHERE storage_path=${key}`);
      await removeUserData(owner.userId);
    }
  });

  it("queues every blob removed with a project", async () => {
    const [{ documentRepository }, { projectRepository }, { relationalDatabase, sql }] =
      await Promise.all([import("../../relationalDocumentRepository"),
        import("../../relationalProjectRepository"), import("../../relationalDatabase")]);
    const owner = scope("project-owner"), member = scope("project-member");
    await prepareScopes([owner, member]);
    const ownerId = randomUUID(), ownerVersion = randomUUID(), memberId = randomUUID(),
      memberVersion = randomUUID(), database = await relationalDatabase();
    try {
      const project = await projectRepository.create(owner, { name: "Matter", cmNumber: null,
        practice: null, sharedWith: [member.userEmail], metadata: {}, notes: null });
      const key = (value: string) => documentBlobKey({ userId: owner.userId,
        projectId: project.id }, value.repeat(64));
      const [ownerOld, ownerCurrent, memberKey, lateKey] = ["a", "b", "c", "d"].map(key);
      const keys = [ownerOld, ownerCurrent, memberKey, lateKey];
      const owned = initialDocument(owner, ownerId, ownerVersion, project.id);
      owned.version.fileType = "md";
      const contributed = initialDocument(member, memberId, memberVersion, project.id,
        { sha256: "c".repeat(64) });
      contributed.version.fileType = "md";
      await createDocument(documentRepository, owner, owned);
      await createDocument(documentRepository, member, contributed);
      await documentRepository.recordOrphans([ownerCurrent]);
      await expect(documentRepository.updateVersion(member, ownerId, {
        versionId: ownerVersion, expectedBlobKey: ownerOld, expectedWorkingRevision: 0,
        expectedCurrentVersionId: ownerVersion,
        update: { blobKey: ownerCurrent, sourceSha256: "b".repeat(64) },
      })).resolves.toBe("updated");
      await expect(documentRepository.deleteDocuments(owner, [project.id], false))
        .resolves.toBe(2);
      const late = initialDocument(member, randomUUID(), randomUUID(), project.id,
        { sha256: "d".repeat(64) });
      late.version.fileType = "md";
      await createDocument(documentRepository, member, late);
      await expect(projectRepository.remove(owner, project.id)).resolves.toEqual([]);
      const queued = (await database.query<{ storage_path: string }>(sql`
        SELECT storage_path FROM object_cleanup
        WHERE storage_path IN(${sql.join(keys)})`)).rows;
      expect(queued).toHaveLength(4);
      expect(queued.map(({ storage_path }) => storage_path).sort()).toEqual(keys.sort());
    } finally {
      await removeUserData(member.userId);
      await removeUserData(owner.userId);
    }
  });

  it("keeps shared blobs reachable and rejects stale working revisions", async () => {
    const { documentRepository } = await import("../../relationalDocumentRepository");
    const { relationalDatabase, sql } = await import("../../relationalDatabase");
    const owner = scope("blob-owner"), documentId = randomUUID(), firstId = randomUUID(),
      database = await relationalDatabase();
    await prepareScopes([owner]);
    try {
      const initial = initialDocument(owner, documentId, firstId, null);
      initial.version.fileType = "md";
      initial.version.filename = "notes.md";
      await createDocument(documentRepository, owner, initial);
      const second = { ...initial.version, id: randomUUID(), parentVersionId: firstId,
        versionNumber: 2, filename: "revised.md", createdAt: new Date().toISOString() };
      await documentRepository.recordOrphans([second.blobKey]);
      await database.query(sql`UPDATE object_cleanup SET claim_id=${randomUUID()},
        claimed_at=${new Date().toISOString()} WHERE storage_path=${second.blobKey}`);
      await expect(documentRepository.insertVersion(owner, documentId, {
        expectedCurrentVersionId: firstId, expectedCurrentWorkingRevision: 0, version: second,
      })).resolves.toBe("conflict");
      await database.query(sql`DELETE FROM object_cleanup WHERE storage_path=${second.blobKey}`);
      await expect(documentRepository.insertVersion(owner, documentId, {
        expectedCurrentVersionId: firstId, expectedCurrentWorkingRevision: 0, version: second,
      })).resolves.toBe("created");
      await expect(documentRepository.updateVersion(owner, documentId, {
        versionId: firstId, expectedBlobKey: initial.version.blobKey,
        expectedWorkingRevision: initial.version.workingRevision,
        expectedCurrentVersionId: firstId, update: { filename: "stale.md" },
      })).resolves.toBe("conflict");
      await expect(documentRepository.deleteVersion(owner, documentId, {
        versionId: second.id, expectedCurrentVersionId: second.id,
        nextCurrentVersionId: firstId, expectedBlobKey: second.blobKey,
        expectedPdfBlobKey: second.pdfBlobKey,
        expectedWorkingRevision: second.workingRevision,
        expectedProjectId: null, expectedFolderId: null,
      })).resolves.toBe(true);
      await expect(database.query(sql`SELECT current_version_id,filename FROM documents
        WHERE id=${documentId}`)).resolves.toMatchObject({ rows: [{
          current_version_id: firstId, filename: "notes.md",
        }] });
      await expect(documentRepository.pendingOrphans()).resolves.toEqual([]);
      await expect(database.query<{ count: number }>(sql`
        SELECT COUNT(*) count FROM object_cleanup WHERE storage_path=${initial.version.blobKey}`))
        .resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(documentRepository.deleteDocument(owner, documentId)).resolves.toBe(true);
      await database.query(sql`UPDATE object_cleanup
        SET created_at=${"2000-01-01T00:00:00.000Z"} WHERE storage_path=${initial.version.blobKey}`);
      const [orphan] = await documentRepository.pendingOrphans();
      expect(orphan?.key).toBe(initial.version.blobKey);
      await expect(documentRepository.removeOrphan(
        orphan!.key, orphan!.claimId, async () => undefined)).resolves.toBe(true);
    } finally {
      await removeUserData(owner.userId);
    }
  });

  it("keeps legal drafts scoped, exact, revisioned, and safely duplicable", async () => {
    const [{ documentRepository }, { projectRepository }, { workProductRepository }] =
      await Promise.all([import("../../relationalDocumentRepository"),
        import("../../relationalProjectRepository"),
        import("../../relationalWorkProductRepository")]);
    const owner = scope("draft-owner"), member = scope("draft-member"),
      stranger = scope("draft-stranger"), workProducts = createWorkProductApplication(
        workProductRepository), documentId = randomUUID(), versionId = randomUUID();
    await prepareScopes([owner, member, stranger]);
    try {
      const project = await projectRepository.create(owner, {
        name: "Matter", cmNumber: null, practice: null, sharedWith: [member.userEmail],
        metadata: {}, notes: null,
      });
      await createDocument(documentRepository, owner, initialDocument(owner, documentId, versionId,
        project.id));
      const draft = await workProducts.create(owner, { kind: "authorities", title: "Book",
        projectId: project.id, state: authoritiesState() });
      await expect(workProducts.get(member, draft.id)).resolves.toMatchObject({ id: draft.id });
      await expect(workProducts.get(stranger, draft.id)).rejects.toMatchObject({ status: 404 });
      await expect(workProducts.save(member, draft.id, { revision: 1, projectId: null }))
        .rejects.toMatchObject({ status: 404 });

      const otherProject = await projectRepository.create(owner, {
        name: "Other matter", cmNumber: null, practice: null, sharedWith: [],
        metadata: {}, notes: null,
      });
      const otherDocumentId = randomUUID(), otherVersionId = randomUUID();
      await createDocument(documentRepository, owner, initialDocument(owner, otherDocumentId,
        otherVersionId, otherProject.id));
      await expect(workProducts.create(owner, { kind: "authorities", title: "Wrong matter",
        projectId: project.id, state: authoritiesState({ kind: "document",
          documentId: otherDocumentId, version: "latest",
        }) })).rejects.toMatchObject({ status: 404,
          details: { resource_id: otherDocumentId } });
      const otherDraft = await workProducts.create(owner, { kind: "authorities",
        title: "Other book", projectId: otherProject.id, state: authoritiesState() });
      await expect(workProducts.save(owner, draft.id, { revision: 1,
        state: authoritiesState({ kind: "work-product-output",
          workProductId: otherDraft.id, role: "book",
        }) })).rejects.toMatchObject({ status: 404,
          details: { resource_id: otherDraft.id } });

      const state = authoritiesState({
        kind: "document", documentId,
        version: { versionId, sha256: "a".repeat(64) },
      });
      const outputId = randomUUID(), outputVersionId = randomUUID();
      const receipt = buildReceipt({ id: draft.id, kind: draft.kind, revision: 1 }, state, [{
        role: "source", resolved: { kind: "document", documentId, versionId,
          filename: "record.pdf", sha256: "a".repeat(64) },
      }], "book");
      await createDocument(documentRepository, owner, initialDocument(
        owner, outputId, outputVersionId, project.id, { sha256: "c".repeat(64),
          provenance: { schemaVersion: 1, actor: "work-product", action: "built", receipt } },
      ));
      const saved = await workProducts.save(member, draft.id, { revision: 1, state,
        outputs: { book: { documentId: outputId, versionId: outputVersionId } } });
      expect(saved).toMatchObject({ revision: 2, outputs: { book: {
        documentId: outputId, versionId: outputVersionId, sha256: "c".repeat(64), filename: "record.pdf",
        mimeType: "application/pdf", pageCount: 1,
      } } });
      const copy = await workProducts.duplicate(member, draft.id);
      expect(copy).toMatchObject({ kind: "authorities", revision: 1,
        title: "Book copy", state: saved.state, outputs: {} });

      await expect(workProducts.remove(member, draft.id)).rejects.toMatchObject({ status: 404 });
      await expect(workProducts.remove(owner, draft.id)).resolves.toBeUndefined();
    } finally {
      await removeUserData(member.userId);
      await removeUserData(owner.userId);
    }
  });

  it("resolves latest, pinned, and nested inputs and computes freshness from exact builds", async () => {
    const [{ documentRepository }, { workProductRepository }] = await Promise.all([
      import("../../relationalDocumentRepository"),
      import("../../relationalWorkProductRepository"),
    ]);
    const owner = scope("resolution-owner"), workProducts =
      createWorkProductApplication(workProductRepository);
    await prepareScopes([owner]);
    const sourceId = randomUUID(), sourceV1 = randomUUID(), outputId = randomUUID(),
      outputV1 = randomUUID();
    const source = (versionId: string, digest: string): ResolvedWorkProductInput => ({
      kind: "document", documentId: sourceId, versionId, filename: "record.pdf", sha256: digest,
    });
    try {
      await createDocument(documentRepository, owner,
        initialDocument(owner, sourceId, sourceV1, null));
      const childState = authoritiesState({
        kind: "document", documentId: sourceId, version: "latest",
      });
      const child = await workProducts.create(owner, { kind: "authorities", title: "Book",
        state: childState });

      const arbitraryId = randomUUID(), arbitraryVersion = randomUUID();
      await createDocument(documentRepository, owner,
        initialDocument(owner, arbitraryId, arbitraryVersion, null));
      await expect(workProducts.save(owner, child.id, { revision: 1,
        outputs: { book: { documentId: arbitraryId, versionId: arbitraryVersion } } }))
        .rejects.toMatchObject({ status: 409, details: { output_role: "book" } });

      const jsonbOrderedState = reverseObjectKeys(childState);
      const firstReceipt = buildReceipt({ id: child.id, kind: child.kind, revision: 1 },
        jsonbOrderedState,
        [{ role: "source", resolved: source(sourceV1, "a".repeat(64)) }], "book");
      const wrongStateId = randomUUID(), wrongStateVersion = randomUUID();
      await createDocument(documentRepository, owner, initialDocument(owner, wrongStateId,
        wrongStateVersion, null, { sha256: "c".repeat(64), provenance: {
          schemaVersion: 1, actor: "work-product", action: "built",
          receipt: { ...firstReceipt, settings: { ...firstReceipt.settings,
            stateSha256: "0".repeat(64) } },
        } }));
      await expect(workProducts.save(owner, child.id, { revision: 1,
        outputs: { book: { documentId: wrongStateId, versionId: wrongStateVersion } } }))
        .rejects.toMatchObject({ status: 409, details: { output_role: "book" } });
      await createDocument(documentRepository, owner, initialDocument(owner, outputId, outputV1, null, {
        sha256: "c".repeat(64), provenance: { schemaVersion: 1, actor: "work-product",
          action: "built", receipt: firstReceipt },
      }));
      const builtChild = await workProducts.save(owner, child.id, { revision: 1,
        outputs: { book: { documentId: outputId, versionId: outputV1 } } });
      await expect(workProducts.resolve(owner, child.id)).resolves.toMatchObject({
        freshness: "current", inputs: { source: { status: "ready",
          resolved: { versionId: sourceV1, sha256: "a".repeat(64) } } },
      });

      const sourceV2 = randomUUID(), nextSource = initialDocument(
        owner, sourceId, sourceV2, null, { sha256: "b".repeat(64),
          parentVersionId: sourceV1 },
      ).version;
      nextSource.versionNumber = 2;
      await stage(documentRepository, owner, nextSource.blobKey);
      await expect(documentRepository.insertVersion(owner, sourceId, {
        expectedCurrentVersionId: sourceV1, expectedCurrentWorkingRevision: 0,
        version: nextSource,
      })).resolves.toBe("created");
      await expect(workProducts.resolve(owner, child.id)).resolves.toMatchObject({
        freshness: "stale", inputs: { source: { status: "changed",
          previous: { versionId: sourceV1 }, current: { versionId: sourceV2 } } },
      });

      const pinned = await workProducts.create(owner, { kind: "authorities", title: "Pinned",
        state: authoritiesState({ kind: "document",
          documentId: sourceId,
          version: { versionId: sourceV1, sha256: "a".repeat(64) },
        }) });
      await expect(workProducts.resolve(owner, pinned.id)).resolves.toMatchObject({
        freshness: "unbuilt", inputs: { source: { status: "ready",
          resolved: { versionId: sourceV1 } } },
      });

      const parentState = courtState({ authorities: { kind: "work-product-output",
        workProductId: child.id, role: "book" } });
      const parent = await workProducts.create(owner, { kind: "court-record", title: "Record",
        state: parentState });
      await expect(workProducts.resolve(owner, parent.id)).resolves.toMatchObject({
        dependencies: [child.id], inputs: { authorities: { status: "review",
          reason: "nested-draft-stale", resolved: { versionId: outputV1 } } },
      });

      const outputV2 = randomUUID(), secondReceipt = buildReceipt({
        id: child.id, kind: child.kind, revision: builtChild.revision,
      }, childState, [{ role: "source", resolved: source(sourceV2, "b".repeat(64)) }],
      "book", "record.pdf", "f".repeat(64));
      const nextOutput = initialDocument(owner, outputId, outputV2, null, {
        sha256: "f".repeat(64), parentVersionId: outputV1,
        provenance: { schemaVersion: 1, actor: "work-product",
          action: "built", receipt: secondReceipt },
      }).version;
      nextOutput.versionNumber = 2;
      await stage(documentRepository, owner, nextOutput.blobKey);
      await expect(documentRepository.insertVersion(owner, outputId, {
        expectedCurrentVersionId: outputV1, expectedCurrentWorkingRevision: 0,
        version: nextOutput,
      })).resolves.toBe("created");
      const refreshedChild = await workProducts.save(owner, child.id, {
        revision: builtChild.revision,
        outputs: { book: { documentId: outputId, versionId: outputV2 } },
      });
      await expect(workProducts.resolve(owner, child.id)).resolves.toMatchObject({
        freshness: "current", inputs: { source: { status: "ready",
          resolved: { versionId: sourceV2 } } },
      });
      await expect(workProducts.resolve(owner, parent.id)).resolves.toMatchObject({
        inputs: { authorities: { status: "ready", resolved: { versionId: outputV2 } } },
      });

      const parentOutputId = randomUUID(), parentOutputVersion = randomUUID();
      const nested: ResolvedWorkProductInput = { kind: "work-product-output",
        workProductId: child.id, role: "book", documentId: outputId, versionId: outputV2,
        filename: "record.pdf", sha256: "f".repeat(64) };
      const parentReceipt = buildReceipt({ id: parent.id, kind: parent.kind, revision: 1 },
        parentState, [{ role: "authorities", resolved: nested }], "record");
      await createDocument(documentRepository, owner, initialDocument(
        owner, parentOutputId, parentOutputVersion, null, { sha256: "c".repeat(64),
          provenance: { schemaVersion: 1, actor: "work-product", action: "built",
            receipt: parentReceipt } },
      ));
      await workProducts.save(owner, parent.id, { revision: 1,
        outputs: { record: { documentId: parentOutputId, versionId: parentOutputVersion } } });
      await expect(workProducts.resolve(owner, parent.id)).resolves.toMatchObject({
        freshness: "current", inputs: { authorities: { status: "ready" } },
      });

      const replacementId = randomUUID(), replacementVersion = randomUUID();
      const replacementReceipt = buildReceipt({ id: child.id, kind: child.kind,
        revision: refreshedChild.revision }, childState, [{ role: "source",
        resolved: source(sourceV2, "b".repeat(64)) }], "book");
      await createDocument(documentRepository, owner, initialDocument(
        owner, replacementId, replacementVersion, null, { sha256: "c".repeat(64),
          provenance: { schemaVersion: 1, actor: "work-product", action: "built",
            receipt: replacementReceipt } },
      ));
      await expect(workProducts.save(owner, child.id, { revision: refreshedChild.revision,
        outputs: { book: { documentId: replacementId, versionId: replacementVersion } } }))
        .rejects.toMatchObject({ status: 409, details: { output_role: "book" } });
      await expect(documentRepository.deleteDocument(owner, outputId)).resolves.toBe(true);
      const recoveredChild = await workProducts.save(owner, child.id, {
        revision: refreshedChild.revision,
        outputs: { book: { documentId: replacementId, versionId: replacementVersion } },
      });
      expect(recoveredChild.outputs.book).toMatchObject({ documentId: replacementId,
        versionId: replacementVersion });
      await expect(workProducts.resolve(owner, child.id)).resolves.toMatchObject({
        freshness: "current",
      });
      await workProducts.save(owner, child.id, { revision: recoveredChild.revision,
        title: "Changed book" });
      await expect(workProducts.resolve(owner, parent.id)).resolves.toMatchObject({
        freshness: "stale", inputs: { authorities: { status: "review",
          reason: "nested-draft-stale" } },
      });
    } finally {
      await removeUserData(owner.userId);
    }
  });

  it("rejects stale saves, backend local handles, and nested draft cycles", async () => {
    const { workProductRepository } = await import("../../relationalWorkProductRepository");
    const owner = scope("draft-writer"), workProducts = createWorkProductApplication(
      workProductRepository);
    await prepareScopes([owner]);
    try {
      const first = await workProducts.create(owner, { kind: "court-record", title: "Record",
        state: courtState() });
      const second = await workProducts.create(owner, { kind: "authorities", title: "Book",
        state: authoritiesState() });
      const linked = await workProducts.save(owner, first.id, { revision: 1,
        state: courtState({ authorities: { kind: "work-product-output",
          workProductId: second.id, role: "book" } }) });
      await expect(workProducts.save(owner, first.id, { revision: 1, title: "Stale" }))
        .rejects.toMatchObject({ status: 409, details: { current_revision: "2" } });
      await expect(workProducts.save(owner, second.id, { revision: 1,
        state: authoritiesState({
          kind: "work-product-output", workProductId: first.id, role: "record",
        }) })).rejects.toMatchObject({ status: 409,
        details: { draft_ids: `${second.id},${first.id},${second.id}` } });
      await expect(workProducts.save(owner, first.id, { revision: linked.revision,
        state: courtState({ device: { kind: "local-file", handleId: "handle", lastSeen: {
          name: "brief.pdf", size: 1, modified: 1,
        } } }) })).rejects.toMatchObject({ status: 400 });
    } finally {
      await removeUserData(owner.userId);
    }
  });
}
