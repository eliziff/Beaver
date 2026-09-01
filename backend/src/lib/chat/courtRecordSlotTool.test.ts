import { describe, expect, it, vi } from "vitest";
import { assistantTools } from "./assistantTools";

const record = { id: "record-1", kind: "court-record" as const, title: "Record",
  projectId: "matter-1", revision: 7, state: { profileId: "fc-motion-record-moving",
    cover: {}, entries: [], bindings: {} }, outputs: {},
  createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z" };
const authoritiesRecord = { ...record, state: { ...record.state,
  profileId: "ab-kb-chambers-justice-applicant-set" } };

function tools(overrides: Record<string, unknown> = {}, current = record) {
  const committed = vi.fn();
  const create = vi.fn(async () => current), get = vi.fn(async () => current);
  const list = vi.fn(async () => [
    { ...record, id: "authorities-1", kind: "authorities" as const,
      title: "Motion authorities", outputs: { table: {}, receipt: {} } },
    { ...record, id: "other-matter-authorities", kind: "authorities" as const,
      projectId: "matter-2", outputs: { book: {} } },
    { ...record, id: "unbuilt-authorities", kind: "authorities" as const,
      title: "Not built yet", outputs: { receipt: {} } },
  ]);
  const updateDraft = vi.fn(async () => ({ product: { ...current, revision: 8 },
    filled: ["counselEmail"], entryId: "entry-2" }));
  const bindOutput = vi.fn(async () => ({ product: { ...current, revision: 8 },
    entryId: "entry-1" }));
  const entries = assistantTools<Record<string, never>>({
    userId: "user-1", documents: {} as never,
    library: { document: vi.fn(async () => ({})) } as never,
    projects: {} as never,
    workProducts: { create, get, list, resolve: vi.fn() } as never,
    authorities: {} as never, courtRecords: { bindOutput, updateDraft } as never,
    courtRecord: { id: "record-1", revision: 7 },
    courtRecordId: "record-1", courtRecordRevision: 7,
    allowedDocumentIds: new Set(["library-1"]),
    matterId: "matter-1", scope: "main", resolveArtifact: () => undefined,
    artifactFor: () => "", onMutationCommitted: committed,
    ...overrides,
  });
  return { entries, committed, create, get, list, updateDraft, bindOutput };
}

async function execute(tool: ReturnType<typeof tools>["entries"][number],
  input: Record<string, unknown>) {
  return tool.execute(input, {}, new AbortController().signal,
    { id: "call-1", name: tool.name, input });
}

describe("scoped work-product assistant operation", () => {
  it("reads the exact party and slot vocabulary rendered by the builder", async () => {
    const { entries } = tools();
    const output = await execute(entries.find(({ name }) => name === "update_work_product")!,
      { action: "read" });
    const result = JSON.parse((output.result.content[0] as { text: string }).text);
    expect(result.profile).toMatchObject({
      id: "fc-motion-record-moving",
      active_party_style_id: "application",
      party_styles: [{ id: "application", groups: [
        { id: "party-a", role: "Applicant" },
        { id: "party-b", role: "Respondent" },
        { id: "intervener", role: "Intervener", optional: true },
      ] }, { id: "action" }],
      slots: expect.arrayContaining([expect.objectContaining({ id: "notice-motion" })]),
    });
    expect(result.authorities_drafts).toEqual([{ child_draft_id: "authorities-1",
      title: "Motion authorities", revision: 7, output_roles: ["table"] }]);
  });

  it("creates a typed Court draft and returns a host event", async () => {
    const { entries, create, committed } = tools({ courtRecord: undefined,
      courtRecordId: undefined, courtRecordRevision: undefined });
    const tool = entries.find(({ name }) => name === "update_work_product")!;
    const output = await execute(tool, { action: "create", kind: "court-record",
      profile_id: "fc-motion-record-moving", title: "Motion record" });
    expect(create).toHaveBeenCalledWith({ userId: "user-1", userEmail: undefined }, {
      kind: "court-record", title: "Motion record", projectId: "matter-1",
      state: { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} },
    });
    expect(output.mutated).toBe(true);
    expect(committed).toHaveBeenCalledOnce();
    expect(output.events).toContainEqual(expect.objectContaining({
      type: "workflow_run", tool: "update_work_product",
      work_product: { id: "record-1", kind: "court-record", revision: 7 },
    }));
  });

  it("fills parties and entry fields while connecting an authorized document", async () => {
    const current = { ...record, state: { ...record.state,
      profileId: "ab-kb-affidavit-exhibits" } };
    const { entries, updateDraft } = tools({ resolveArtifact: (value: string) =>
      value === "draft-1" ? "document://library-1/version/version-2" : undefined }, current);
    const tool = entries.find(({ name }) => name === "update_work_product")!;
    const partyGroups = [{ id: "party-a", parties: [
      { id: "applicant-1", name: "Ada Applicant" },
      { id: "applicant-2", name: "Apex Ltd." },
    ] }, { id: "intervener", parties: [
      { id: "intervener-1", name: "Public Interest Group" },
    ] }];
    const output = await execute(tool, { action: "update",
      cover: { courtFileNumber: "2401-12345", partyStyleId: "application",
        partyGroups, filingPartyId: "applicant-1" },
      slot_id: "exhibit",
      document_id: "draft-1",
      description: "Notice of motion dated August 30, 2026",
      date: "August 30, 2026", exhibit_label: "A" });
    expect(updateDraft).toHaveBeenCalledWith({ userId: "user-1", userEmail: undefined }, {
      courtRecordId: "record-1", revision: 7, projectId: "matter-1",
      cover: { courtFileNumber: "2401-12345", partyStyleId: "application",
        partyGroups, filingPartyId: "applicant-1" },
      entry: { slotId: "exhibit",
        document: { documentId: "library-1", versionId: "version-2" },
        description: "Notice of motion dated August 30, 2026",
        date: "August 30, 2026", exhibitLabel: "A" },
    });
    expect(output.events).toContainEqual(expect.objectContaining({
      type: "workflow_run", tool: "update_work_product",
      work_product: { id: "record-1", kind: "court-record", revision: 8 },
    }));
    expect(output.mutated).toBe(true);
  });

  it("adds a description-only entry without inventing a file binding", async () => {
    const current = { ...record, state: { ...record.state,
      profileId: "fc-application-record-applicant" } };
    const { entries, updateDraft } = tools({}, current);
    await execute(entries.find(({ name }) => name === "update_work_product")!, {
      action: "update", slot_id: "physical-exhibit",
      description: "Original scale model tendered before the tribunal",
    });
    expect(updateDraft).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entry: { slotId: "physical-exhibit",
        description: "Original scale model tendered before the tribunal" },
    }));
  });

  it("connects the latest named Authorities output without a second tool", async () => {
    const { entries, bindOutput } = tools({}, authoritiesRecord);
    const tool = entries.find(({ name }) => name === "update_work_product")!;
    await execute(tool, { action: "update",
      slot_id: "authorities", child_draft_id: "authorities-1", output_role: "book" });
    expect(bindOutput).toHaveBeenCalledWith({ userId: "user-1", userEmail: undefined }, {
      courtRecordId: "record-1", revision: 7, kindId: "authorities",
      childWorkProductId: "authorities-1", role: "book", projectId: "matter-1",
    });
    expect(entries.some(({ name }) => ["court_record_slot", "court_record_update",
      "create_authorities"].includes(name))).toBe(false);
  });

  it("carries the committed revision through sequential updates in one turn", async () => {
    const { entries, updateDraft } = tools();
    updateDraft.mockImplementation(async (_scope, input) => ({
      product: { ...record, revision: input.revision + 1 }, filled: [], entryId: undefined,
    }));
    const tool = entries.find(({ name }) => name === "update_work_product")!;

    await execute(tool, { action: "update",
      cover: { counselEmail: "ada@example.test" } });
    await execute(tool, { action: "update",
      cover: { counselPhone: "555-0100" } });

    expect(updateDraft.mock.calls.map(([, input]) => input.revision)).toEqual([7, 8]);
  });

  it("does not expose mutation operations to reader subagents", () => {
    const { entries } = tools({ scope: "reader" });
    expect(entries.some(({ name }) => name === "update_work_product")).toBe(false);
  });
});
