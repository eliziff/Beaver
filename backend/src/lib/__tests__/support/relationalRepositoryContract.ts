import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { chatRepository, documentRepository, projectRepository, tabularRepository }
  from "../../relationalRepositories";
import { relationalDatabase, sql } from "../../relationalDatabase";

const scope = (role: string) => ({ userId: randomUUID(),
  userEmail: `${role}-${randomUUID()}@example.test` });
const initialDocument = (
  owner: ReturnType<typeof scope>, documentId: string, versionId: string, projectId: string | null,
) => {
  const created = new Date().toISOString();
  return { document: {
    id: documentId, userId: owner.userId, projectId, libraryKind: "file" as const, folderId: null,
    status: "ready" as const, currentVersionId: versionId, createdAt: created, updatedAt: created,
  }, version: {
    id: versionId, documentId, versionNumber: 1, source: "upload" as const, createdAt: created,
    filename: "record.pdf", fileType: "pdf", sizeBytes: 1, pageCount: 1, cleanupKeys: [],
    sourceSha256: "a".repeat(64), blobKey: "first", pdfBlobKey: null,
  } };
};
const removeUserData = async (userId: string) => {
  const database = await relationalDatabase();
  await database.query(sql`DELETE FROM documents WHERE user_id=${userId}`);
  await database.query(sql`DELETE FROM projects WHERE user_id=${userId}`);
};

export function relationalRepositoryContract() {
  it("applies explicit project, document, review, and chat scope", async () => {
    const owner = scope("owner"), member = scope("member"), stranger = scope("stranger");
    try {
      const project = await projectRepository.create(owner, {
        name: "Matter", cmNumber: null, practice: null, sharedWith: [member.userEmail],
        metadata: {}, notes: null,
      });
      await expect(projectRepository.project(member, project.id, false)).resolves.toMatchObject(
        { id: project.id, is_owner: false });
      await expect(projectRepository.project(stranger, project.id, false)).resolves.toBeNull();

      const documentId = randomUUID(), versionId = randomUUID();
      await documentRepository.create(owner, initialDocument(owner, documentId, versionId, project.id));
      await expect(documentRepository.get(member, documentId)).resolves.toMatchObject(
        { document: { id: documentId }, isOwner: false });
      await expect(documentRepository.get(stranger, documentId)).resolves.toBeNull();

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

  it("commits only one writer at a document revision", async () => {
    const owner = scope("writer"), documentId = randomUUID(), firstId = randomUUID();
    try {
      await documentRepository.create(owner, initialDocument(owner, documentId, firstId, null));
      const version = (key: string) => ({
        id: randomUUID(), documentId, versionNumber: 2, source: "upload",
        createdAt: new Date().toISOString(), filename: "record.pdf", fileType: "pdf",
        sizeBytes: 1, pageCount: 1, sourceSha256: "b".repeat(64), blobKey: key,
        pdfBlobKey: null, cleanupKeys: [],
      });
      const results = await Promise.all(["second", "rival"].map((key) =>
        documentRepository.insertVersion(owner, documentId, {
          expectedCurrentVersionId: firstId, version: version(key),
        })));
      expect(results.sort()).toEqual(["conflict", "created"]);
      expect((await documentRepository.get(owner, documentId))?.versions).toHaveLength(2);
      const jobs = (await (await relationalDatabase()).query<{ document_version_id: string }>(sql`
        SELECT document_version_id FROM application_jobs WHERE document_id=${documentId}`)).rows;
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map(({ document_version_id }) => document_version_id)).size).toBe(2);
    } finally {
      await removeUserData(owner.userId);
    }
  });
}
