import { describe, expect, it, vi } from "vitest";
import { assistantTools } from "./assistantTools";

const record = { id: "record-1", kind: "court-record" as const, title: "Record",
  projectId: "matter-1", revision: 7, state: {}, outputs: {},
  createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z" };

function tools(overrides: Record<string, unknown> = {}) {
  const committed = vi.fn();
  const create = vi.fn(async () => record), get = vi.fn(async () => record);
  const updateDraft = vi.fn(async () => ({ product: { ...record, revision: 8 },
    filled: ["counselEmail"], entryId: "entry-2" }));
  const bindOutput = vi.fn(async () => ({ product: { ...record, revision: 8 },
    entryId: "entry-1" }));
  const entries = assistantTools<Record<string, never>>({
    userId: "user-1", documents: {} as never,
    library: { document: vi.fn(async () => ({})) } as never,
    projects: {} as never,
    workProducts: { create, get, resolve: vi.fn() } as never,
    authorities: {} as never, courtRecords: { bindOutput, updateDraft } as never,
    courtRecordId: "record-1", courtRecordRevision: 7,
    allowedDocumentIds: new Set(["library-1"]),
    matterId: "matter-1", scope: "main", resolveArtifact: () => undefined,
    artifactFor: () => "", onMutationCommitted: committed,
    ...overrides,
  });
  return { entries, committed, create, get, updateDraft, bindOutput };
}

async function execute(tool: ReturnType<typeof tools>["entries"][number],
  input: Record<string, unknown>) {
  return tool.execute(input, {}, new AbortController().signal,
    { id: "call-1", name: tool.name, input });
}

describe("scoped work-product assistant operation", () => {
  it("creates a typed Court draft and returns a host event", async () => {
    const { entries, create, committed } = tools();
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

  it("fills empty fields and connects an authorized document through Court application", async () => {
    const { entries, updateDraft } = tools();
    const tool = entries.find(({ name }) => name === "update_work_product")!;
    await execute(tool, { action: "update", kind: "court-record",
      profile_id: "fc-motion-record-moving", cover: { counselEmail: "ada@example.test" },
      slot_id: "notice-motion",
      document_id: "document://library-1/version/version-2" });
    expect(updateDraft).toHaveBeenCalledWith({ userId: "user-1", userEmail: undefined }, {
      courtRecordId: "record-1", revision: 7, projectId: "matter-1",
      profileId: "fc-motion-record-moving", cover: { counselEmail: "ada@example.test" },
      document: { documentId: "library-1", versionId: "version-2",
        slotId: "notice-motion" },
    });
  });

  it("connects the latest named Authorities output without a second tool", async () => {
    const { entries, bindOutput } = tools();
    const tool = entries.find(({ name }) => name === "update_work_product")!;
    await execute(tool, { action: "update", kind: "court-record",
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

    await execute(tool, { action: "update", kind: "court-record",
      cover: { counselEmail: "ada@example.test" } });
    await execute(tool, { action: "update", kind: "court-record",
      cover: { counselPhone: "555-0100" } });

    expect(updateDraft.mock.calls.map(([, input]) => input.revision)).toEqual([7, 8]);
  });

  it("does not expose mutation operations to reader subagents", () => {
    const { entries } = tools({ scope: "reader" });
    expect(entries.some(({ name }) => name === "update_work_product")).toBe(false);
  });
});
