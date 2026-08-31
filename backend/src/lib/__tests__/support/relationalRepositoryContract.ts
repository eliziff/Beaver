import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createAuthoritiesDraft } from "../../authoritiesDomain";
import { canonicalJsonSha256 } from "../../hash";
import { createWorkProductApplication } from "../../workProductApplication";
import { createResearchSetState, decodeResearchSetState } from "../../researchSet";
import type { ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductInput, WorkProductKind, WorkProductState } from "../../workProduct";

const scope = (role: string) => ({ userId: randomUUID(),
  userEmail: `${role}-${randomUUID()}@example.test` });
const initialDocument = (
  owner: ReturnType<typeof scope>, documentId: string, versionId: string, projectId: string | null,
  options: { filename?: string; sha256?: string;
    provenance?: import("../../documentStore").DocumentProvenance } = {},
) => {
  const created = new Date().toISOString();
  return { document: {
    id: documentId, userId: owner.userId, projectId, libraryKind: "file" as const, folderId: null,
    status: "ready" as const, currentVersionId: versionId, createdAt: created, updatedAt: created,
  }, version: {
    id: versionId, documentId, versionNumber: 1, source: "upload" as const, createdAt: created,
    filename: options.filename ?? "record.pdf", fileType: "pdf", sizeBytes: 1, pageCount: 1,
    cleanupKeys: [], sourceSha256: options.sha256 ?? "a".repeat(64), blobKey: "first",
    pdfBlobKey: null, ...(options.provenance ? { provenance: options.provenance } : {}),
  } };
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
  profileId: "general-court-record", cover: {}, bindings,
  entries: Object.keys(bindings).map((id) => ({ id, kindId: "document", title: id,
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

export function relationalRepositoryContract() {
  it("applies explicit project, document, review, and chat scope", async () => {
    const [{ chatRepository }, { documentRepository }, { projectRepository },
      { tabularRepository }] = await Promise.all([
      import("../../relationalChatRepository"), import("../../relationalDocumentRepository"),
      import("../../relationalProjectRepository"), import("../../relationalTabularRepository"),
    ]);
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
    const { documentRepository } = await import("../../relationalDocumentRepository");
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
      const { relationalDatabase, sql } = await import("../../relationalDatabase");
      const jobs = (await (await relationalDatabase()).query<{ document_version_id: string }>(sql`
        SELECT document_version_id FROM application_jobs WHERE document_id=${documentId}`)).rows;
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map(({ document_version_id }) => document_version_id)).size).toBe(2);
      const current = await documentRepository.get(owner, documentId), active = current?.versions
        .find(({ id }) => id === current.document.currentVersionId)!;
      await expect(documentRepository.updateVersion(owner, documentId, {
        versionId: active.id, expectedBlobKey: active.blobKey,
        update: { blobKey: "replacement", sourceSha256: "c".repeat(64) },
      })).resolves.toBe("updated");
      await expect((await relationalDatabase()).query<{ count: number }>(sql`SELECT COUNT(*) count
        FROM application_jobs WHERE document_id=${documentId}`)).resolves.toMatchObject({
        rows: [{ count: 3 }],
      });
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
    try {
      const project = await projectRepository.create(owner, {
        name: "Matter", cmNumber: null, practice: null, sharedWith: [member.userEmail],
        metadata: {}, notes: null,
      });
      await documentRepository.create(owner, initialDocument(owner, documentId, versionId,
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
      await documentRepository.create(owner, initialDocument(owner, otherDocumentId,
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
      await documentRepository.create(owner, initialDocument(
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

      const researchSet = await workProducts.create(owner, { kind: "research-set",
        title: "Saved research", projectId: project.id,
        state: createResearchSetState({ kind: "human", id: owner.userId }, "Saved research") });
      expect(await workProducts.get(member, researchSet.id)).toMatchObject({
        id: researchSet.id, kind: "research-set", revision: 1,
      });
      await expect(workProducts.save(owner, researchSet.id, { revision: 1,
        state: { schemaVersion: "forged" } })).rejects.toMatchObject({ status: 400 });
      const labelled = await workProducts.applyResearchSetAction(owner, researchSet.id, {
        revision: 1, action: { type: "label", name: "Good faith" },
      });
      const researchCopy = await workProducts.duplicate(owner, researchSet.id);
      const labelledState = decodeResearchSetState(labelled.state)!;
      const copiedState = decodeResearchSetState(researchCopy.state)!;
      expect(researchCopy).toMatchObject({ kind: "research-set", revision: 1,
        title: "Saved research copy", outputs: {} });
      expect(copiedState.audit).toHaveLength(labelledState.audit.length + 1);
      expect(copiedState.audit.at(-1)).toMatchObject({ action: "duplicate",
        targets: [researchSet.id] });
      const summaries = await workProducts.list(owner, { kind: "research-set", metadata: true });
      expect(summaries).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: researchSet.id, kind: "research-set" }),
      ]));
      expect(summaries.every((item) => !("state" in item) && !("outputs" in item))).toBe(true);
      expect(await workProducts.list(owner, { kind: "research-set" }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ state: labelled.state })]));
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
    const sourceId = randomUUID(), sourceV1 = randomUUID(), outputId = randomUUID(),
      outputV1 = randomUUID();
    const source = (versionId: string, digest: string): ResolvedWorkProductInput => ({
      kind: "document", documentId: sourceId, versionId, filename: "record.pdf", sha256: digest,
    });
    try {
      await documentRepository.create(owner, initialDocument(owner, sourceId, sourceV1, null));
      const childState = authoritiesState({
        kind: "document", documentId: sourceId, version: "latest",
      });
      const child = await workProducts.create(owner, { kind: "authorities", title: "Book",
        state: childState });

      const arbitraryId = randomUUID(), arbitraryVersion = randomUUID();
      await documentRepository.create(owner,
        initialDocument(owner, arbitraryId, arbitraryVersion, null));
      await expect(workProducts.save(owner, child.id, { revision: 1,
        outputs: { book: { documentId: arbitraryId, versionId: arbitraryVersion } } }))
        .rejects.toMatchObject({ status: 409, details: { output_role: "book" } });

      const jsonbOrderedState = reverseObjectKeys(childState);
      const firstReceipt = buildReceipt({ id: child.id, kind: child.kind, revision: 1 },
        jsonbOrderedState,
        [{ role: "source", resolved: source(sourceV1, "a".repeat(64)) }], "book");
      const wrongStateId = randomUUID(), wrongStateVersion = randomUUID();
      await documentRepository.create(owner, initialDocument(owner, wrongStateId,
        wrongStateVersion, null, { sha256: "c".repeat(64), provenance: {
          schemaVersion: 1, actor: "work-product", action: "built",
          receipt: { ...firstReceipt, settings: { ...firstReceipt.settings,
            stateSha256: "0".repeat(64) } },
        } }));
      await expect(workProducts.save(owner, child.id, { revision: 1,
        outputs: { book: { documentId: wrongStateId, versionId: wrongStateVersion } } }))
        .rejects.toMatchObject({ status: 409, details: { output_role: "book" } });
      await documentRepository.create(owner, initialDocument(owner, outputId, outputV1, null, {
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
        owner, sourceId, sourceV2, null, { sha256: "b".repeat(64) },
      ).version;
      nextSource.versionNumber = 2; nextSource.blobKey = "source-v2";
      await expect(documentRepository.insertVersion(owner, sourceId, {
        expectedCurrentVersionId: sourceV1, version: nextSource,
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
        sha256: "f".repeat(64), provenance: { schemaVersion: 1, actor: "work-product",
          action: "built", receipt: secondReceipt },
      }).version;
      nextOutput.versionNumber = 2; nextOutput.blobKey = "output-v2";
      await expect(documentRepository.insertVersion(owner, outputId, {
        expectedCurrentVersionId: outputV1, version: nextOutput,
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
      await documentRepository.create(owner, initialDocument(
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
      await documentRepository.create(owner, initialDocument(
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
