import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("../localMode", () => ({ isLocalRuntime: () => true }));
const owner = { userId: "00000000-0000-0000-0000-000000000001" };
let directory: string, close: (() => Promise<void>) | undefined;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-table-tool-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", directory);
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", path.join(directory, "library"));
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  vi.resetModules();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await close?.(); close = undefined;
  vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function fixture() {
  const { runtime } = await import("../../runtime"), research = await import("../researchFile"),
    { readResearchResource } = await import("../researchReader"),
    { resourceReference } = await import("mike/shared/runtime/resourceReferences.mjs"),
    { createResearchTableTool, readResearchFindings } = await import("./researchTableTool"),
    { TurnToolRegistry } = await import("./toolRegistry");
  close = () => runtime.shutdown();
  const documents = await runtime.documents(), application = await runtime.tabular(), sources = await runtime.sources(),
    source = await documents.create(owner, { filename: "Agreement.txt", fileType: "txt",
      bytes: Buffer.from("Payment is due in thirty days.") }),
    reference = { provider: "library" as const, kind: "document" as const, id: source.id,
      versionId: source.current_version_id, title: source.filename },
    read = await readResearchResource(documents, owner, {
      resource: resourceReference.document(source.id, source.current_version_id) }),
    receipt = read.evidence![0];
  const createWorkspace = async (title: string) => {
    const document = await documents.create(owner, { filename: `${title}.research.md`, fileType: "md",
      bytes: Buffer.from(research.researchFileMarkdown(title, research.createResearchFileState())) });
    const file = (await research.readResearchFile(documents, owner, document.id))!;
    return (await research.commitResearchFile(documents, owner, file, {
      type: "merge", sources: [reference], evidence: [receipt],
    }))!;
  };
  const workspace = await createWorkspace("Review");
  let workspaceId = workspace.document.id, committed = 0;
  const tool = createResearchTableTool({ application, scope: owner, model: "test-model",
    getWorkspace: () => research.readResearchFile(documents, owner, workspaceId),
    onMutationCommitted() { committed++; },
  }), registry = new TurnToolRegistry([tool]);
  const run = async (input: Record<string, unknown>) => {
    const [result] = await registry.run([{ id: randomUUID(), name: "update_research_table", input }], {});
    return { ...result, value: JSON.parse(result.content) };
  };
  return { runtime, tool, application, documents, research, workspace, source, receipt, run, createWorkspace, sources,
    readFindings: (input: Parameters<typeof readResearchFindings>[1]) => readResearchFindings({ sources, scope: owner, workspaceId }, input),
    selectWorkspace(id: string) { workspaceId = id; }, committed: () => committed };
}

it("resolves the current workspace on each call and rejects unlinked or foreign tables", async () => {
  const f = await fixture(), columns = [{ index: 0, name: "Payment", prompt: "When is payment due?" }],
    created = await f.run({ action: "create", columns_config: columns }), reviewId = created.value.review_id;
  const other = await f.createWorkspace("Other");
  f.selectWorkspace(other.document.id);
  expect((await f.run({ action: "read", review_id: reviewId })).value).toMatchObject({ ok: false, status: 404 });
  expect((await f.run({ action: "update", review_id: reviewId, expected_version: created.value.expected_version,
    title: "Outside change" })).value).toMatchObject({ ok: false, status: 404 });
  const unlinked = await f.application.create(owner, { document_ids: [f.source.id], columns_config: columns });
  expect((await f.run({ action: "generate", review_id: unlinked.id })).value).toMatchObject({ ok: false, status: 404 });
  expect((await f.run({ action: "create", columns_config: columns,
    research_file_id: f.workspace.document.id })).status).toBe("error");
  expect((await f.application.detail(owner, reviewId)).review.title).not.toBe("Outside change");
  expect(f.committed()).toBe(1);
});

it("preserves the first observed passage when extraction fails before submitting an answer", async () => {
  const f = await fixture(), table = await f.application.create(owner, { document_ids: [f.source.id],
    columns_config: [{ index: 0, name: "Payment", prompt: "Explain payment" }] }), id = table.scope_config!.research_file_id!,
    { createTabularApplication } = await import("../tabular/application"),
    { tabularRepository } = await import("../relationalTabularRepository"),
    app = createTabularApplication(tabularRepository, f.documents, await f.runtime.projects(), {
      sources: async () => f.sources, settings: async () => ({ title_model: "codex:gpt-5.6", tabular_model: "codex:gpt-5.6",
        api_keys: {}, legal_research_us: false, last_selected_chat_model: null, last_selected_reasoning_effort: null }),
      runTurn: async () => { throw new Error("Model unavailable"); },
    });
  expect((await f.sources.items(owner, id, { kind: "passages", offset: 0, limit: 10 })).total).toBe(0);
  await expect(app.runAgent(owner, { reviewId: table.id, documentId: f.source.id, jobId: "failed-job" }))
    .rejects.toThrow("Model unavailable");
  const saved = await f.sources.items(owner, id, { kind: "evidence", offset: 0, limit: 10 });
  expect(saved.total).toBe(1);
  expect(saved.items[0].value).toMatchObject({ receipt: { span_text: "Payment is due in thirty days." } });
  expect((await f.sources.items(owner, id, { kind: "passages", offset: 0, limit: 10 })).total).toBe(0);
  expect((await tabularRepository.detail(owner, table.id))?.cells[0]).toMatchObject({ status: "error", content: null });
});
