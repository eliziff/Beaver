import { describe, expect, it, vi } from "vitest";
import { createAuthoritiesDraft } from "./authoritiesDomain";
import type { WorkProduct, WorkProductRepository, WorkProductState } from "./workProduct";
import { createWorkProductApplication } from "./workProductApplication";

const scope = { userId: "owner" };
const now = "2026-08-30T12:00:00.000Z";
const binding = { kind: "document" as const, documentId: "document-1",
  version: "latest" as const };
const courtState = (bound = false): WorkProductState => ({
  profileId: "general-court-record",
  cover: { partyGroups: [{ id: "appellants", role: "Appellants", parties: [
    { id: "appellant-1", name: "A Corp." }, { id: "appellant-2", name: "B Corp." },
  ] }, { id: "interveners", role: "Interveners", parties: [
    { id: "intervener-1", name: "Public Interest Group" },
  ] }] },
  entries: bound ? [{ id: "entry-1", kindId: "document", title: "Motion record",
    lastSeen: { name: "motion.pdf", size: 20, modified: 10 } }] : [],
  bindings: bound ? { "entry-1": binding } : {},
});

function product(state: WorkProductState = courtState()): WorkProduct {
  return { id: "draft-1", kind: "court-record", title: "Record", projectId: "matter-1",
    revision: 1, state, outputs: {}, createdAt: now, updatedAt: now };
}

function setup(current = product()) {
  const repository = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ product: current, isOwner: true })),
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
  it("accepts a typed Court draft with multiple parties and interveners", async () => {
    const { application, repository } = setup();
    await expect(application.create(scope, { kind: "court-record", title: "Appeal record",
      state: courtState(true) })).resolves.toMatchObject({ kind: "court-record" });
    expect(repository.create).toHaveBeenCalledOnce();
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
    duplicateParties.cover = { partyGroups: [
      { id: "side", role: "Applicants", parties: [{ id: "party", name: "A" }] },
      { id: "side", role: "Respondents", parties: [{ id: "party", name: "B" }] },
    ] };
    await expect(application.create(scope, { kind: "court-record", title: "Record",
      state: duplicateParties })).rejects.toMatchObject({ status: 400 });
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
