import { describe, expect, it, vi } from "vitest";
import { createAuthoritiesDraft } from "./authoritiesDomain";
import type { WorkProduct, WorkProductRepository, WorkProductState } from "./workProduct";
import { createWorkProductApplication } from "./workProductApplication";

const scope = { userId: "owner" };
const now = "2026-08-30T12:00:00.000Z";
const binding = { kind: "document" as const, documentId: "document-1",
  version: "latest" as const };
const courtState = (bound = false): WorkProductState => ({
  profileId: "ab-kb-commercial-compendium",
  cover: { partyStyleId: "action", partyGroups: [{ id: "party-a", role: "Plaintiff", parties: [
    { id: "appellant-1", name: "A Corp." }, { id: "appellant-2", name: "B Corp." },
  ] }, { id: "intervener", role: "Intervener", parties: [
    { id: "intervener-1", name: "Public Interest Group" },
  ] }] },
  entries: bound ? [{ id: "entry-1", kindId: "document-extract", title: "Motion record",
    lastSeen: { name: "motion.pdf", size: 20, modified: 10 } }] : [],
  bindings: bound ? { "entry-1": binding } : {},
});

function product(state: WorkProductState = courtState()): WorkProduct {
  return { id: "draft-1", kind: "court-record", title: "Record", projectId: "matter-1",
    revision: 1, state, outputs: {}, createdAt: now, updatedAt: now };
}

function setup(current = product(), children: WorkProduct[] = []) {
  const repository = {
    list: vi.fn(async () => []),
    get: vi.fn(async (_scope, id: string) => {
      const found = [current, ...children].find((item) => item.id === id);
      return found ? { product: found, isOwner: true } : null;
    }),
    resolve: vi.fn(),
    create: vi.fn(async (_scope, input) => ({ status: "created", product: {
      ...current, kind: input.kind, title: input.title, projectId: input.projectId,
      state: input.state,
    } })),
    save: vi.fn(async (_scope, _id, input) => ({ status: "saved", product: {
      ...current, ...input, revision: current.revision + 1,
    } })),
    remove: vi.fn(async () => true),
  } as unknown as WorkProductRepository;
  return { repository, application: createWorkProductApplication(repository) };
}

describe("WorkProduct application state contract", () => {
  it("keeps full draft listings bounded but returns all lightweight metadata", async () => {
    const { application, repository } = setup();
    await application.list(scope);
    await application.list(scope, { kind: "authorities", metadata: true });
    expect(repository.list).toHaveBeenNthCalledWith(1, scope, { limit: 50 });
    expect(repository.list).toHaveBeenNthCalledWith(2, scope, {
      kind: "authorities", metadata: true, limit: undefined,
    });
  });

  it("accepts a typed Court draft with multiple parties and interveners", async () => {
    const { application, repository } = setup();
    await expect(application.create(scope, { kind: "court-record", title: "Appeal record",
      state: courtState(true) })).resolves.toMatchObject({ kind: "court-record" });
    expect(repository.create).toHaveBeenCalledOnce();
  });

  it("accepts only the configured producer profile for a nested Court output", async () => {
    const nested: WorkProductState = { profileId: "fc-motion-record-moving", cover: {},
      entries: [{ id: "evidence", kindId: "moving-evidence", title: "Affidavit package",
        lastSeen: { name: "Affidavit.pdf", size: 20, modified: 1 } }],
      bindings: { evidence: { kind: "work-product-output", workProductId: "child",
        role: "record" } } };
    const affidavit = { ...product(), id: "child",
      state: { profileId: "fc-affidavit-exhibits", cover: {}, entries: [], bindings: {} } };
    const accepted = setup(product(), [affidavit]);
    await expect(accepted.application.create(scope, { kind: "court-record", title: "Record",
      state: nested })).resolves.toMatchObject({ kind: "court-record" });
    expect(accepted.repository.create).toHaveBeenCalledOnce();

    const motion = { ...affidavit,
      state: { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} } };
    const rejected = setup(product(), [motion]);
    await expect(rejected.application.save(scope, "draft-1", { revision: 1, state: nested }))
      .rejects.toMatchObject({ status: 400 });
    expect(rejected.repository.save).not.toHaveBeenCalled();
  });

  it("rejects malformed binding discriminants and Court slots before persistence", async () => {
    const { application, repository } = setup();
    const malformed = courtState(true);
    malformed.bindings = { "entry-1": { kind: "other" } as never };
    await expect(application.create(scope, { kind: "court-record", title: "Record",
      state: malformed })).rejects.toMatchObject({ status: 400 });
    await expect(application.create(scope, { kind: "court-record", title: "Record",
      state: { ...courtState(), profileId: "unknown-profile" } }))
      .rejects.toMatchObject({ status: 400 });
    const duplicateParties = courtState();
    duplicateParties.cover = { partyStyleId: "application", partyGroups: [
      { id: "party-a", role: "Applicant", parties: [{ id: "party", name: "A" }] },
      { id: "party-a", role: "Applicant", parties: [{ id: "party", name: "B" }] },
    ] };
    await expect(application.create(scope, { kind: "court-record", title: "Record",
      state: duplicateParties })).rejects.toMatchObject({ status: 400 });
    const inventedRole = courtState();
    ((inventedRole.cover as { partyGroups: Array<{ role: string }> }).partyGroups)[0].role =
      "Applicants";
    await expect(application.create(scope, { kind: "court-record", title: "Record",
      state: inventedRole })).rejects.toMatchObject({ status: 400 });
    const wrongFiler: WorkProductState = { profileId: "fc-application-record-applicant",
      cover: { partyStyleId: "application", partyGroups: [{ id: "party-b",
        role: "Respondent", parties: [{ id: "respondent", name: "Canada" }] }],
      filingPartyIds: ["respondent"] }, entries: [], bindings: {} };
    await expect(application.create(scope, { kind: "court-record", title: "Record",
      state: wrongFiler })).rejects.toMatchObject({ status: 400 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("rejects malformed Authorities state before persistence", async () => {
    const { application, repository } = setup();
    await expect(application.create(scope, { kind: "authorities", title: "Authorities",
      state: { ...createAuthoritiesDraft({ kind: "manual" }), outputMode: "unknown" } as never }))
      .rejects.toMatchObject({ status: 400 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("accepts the Authorities domain's canonical initial state", async () => {
    const { application, repository } = setup();
    await expect(application.create(scope, { kind: "authorities", title: "Authorities",
      state: createAuthoritiesDraft({ kind: "manual" }) }))
      .resolves.toMatchObject({ kind: "authorities" });
    expect(repository.create).toHaveBeenCalledOnce();
  });

  it("derives editable citation boundaries before returning an Authorities draft", async () => {
    const draft = createAuthoritiesDraft({ kind: "manual" }), text = "R v Grant, 2009 SCC 32";
    Object.assign(draft, { units: [{ id: "body:0", kind: "body", ordinal: 0,
      footnoteId: null, footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["cite"] }],
    occurrences: { cite: { id: "cite", unitId: "body:0", start: 0, end: text.length, text,
      kind: "case", citation: "2009 SCC 32", authorityId: "grant", reference: null,
      pinpoints: [], evidenceIds: [], sourceTextSha256: "hash", localOrdinal: 0,
      reviewed: false } }, authorities: { grant: { id: "grant", key: "grant", kind: "case",
      citation: "2009 SCC 32", name: "R v Grant", displayName: null,
      evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
      source: { kind: "unresolved" } } }, authorityOrder: ["grant"] });
    const current = { ...product(), kind: "authorities" as const, state: draft };
    const { application } = setup(current);
    const opened = await application.get(scope, current.id);
    expect((opened.state.occurrences as Record<string, Record<string, unknown>>).cite)
      .toMatchObject({ authoritySpan: { start: 0, end: text.length, text },
        coreSpan: { start: text.indexOf("2009"), end: text.length, text: "2009 SCC 32" },
        pinpointSpan: null });
  });

  it("does not move bound inputs or saved outputs into a different matter", async () => {
    const bound = product(courtState(true));
    const first = setup(bound);
    await expect(first.application.save(scope, bound.id, {
      revision: bound.revision, projectId: "matter-2",
    })).rejects.toMatchObject({ status: 409 });
    expect(first.repository.save).not.toHaveBeenCalled();

    const output = product();
    output.outputs = { record: { documentId: "output-document", versionId: "version-1",
      sha256: "a".repeat(64), filename: "Record.pdf", mimeType: "application/pdf",
      pageCount: 1 } };
    const second = setup(output);
    await expect(second.application.save(scope, output.id, {
      revision: output.revision, projectId: "matter-2",
    })).rejects.toMatchObject({ status: 409 });
    expect(second.repository.save).not.toHaveBeenCalled();
  });

  it("allows an empty Draft to change matter and blocks cross-matter copies with inputs", async () => {
    const empty = product(), first = setup(empty);
    await expect(first.application.save(scope, empty.id, {
      revision: empty.revision, projectId: "matter-2",
    })).resolves.toMatchObject({ projectId: "matter-2" });

    const bound = product(courtState(true)), second = setup(bound);
    await expect(second.application.duplicate(scope, bound.id, {
      projectId: "matter-2",
    })).rejects.toMatchObject({ status: 409 });
    expect(second.repository.create).not.toHaveBeenCalled();
  });
});
