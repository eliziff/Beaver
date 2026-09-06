import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import * as XLSX from "xlsx";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  supabaseCalls: 0,
  streamChatWithTools: vi.fn(),
}));

vi.mock("../../lib/localMode", () => ({
  isLocalRuntime: () => true,
}));

vi.mock("../../lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/supabase")>()),
  createServerSupabase: () => {
    mocks.supabaseCalls += 1;
    throw new Error("Supabase must not be used by local tabular routes");
  },
}));

vi.mock("../../lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/llm")>()),
  streamChatWithTools: mocks.streamChatWithTools,
}));

let dataHome: string;
let closeStores: (() => Promise<void>) | null = null;

function spreadsheetBytes(value: string) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([[value]]),
    "Sheet1",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function loadApi() {
  vi.resetModules();
  const { api } = await import("../../api");
  const { runtime } = await import("../../runtime");
  const workers = await runtime.startWorkers();
  closeStores = async () => {
    await workers.stop();
    await (await import("../../lib/relationalDatabase")).closeRelationalDatabase();
  };
  return api;
}

async function waitForReview(
  api: Parameters<typeof request>[0],
  reviewId: string,
  predicate: (detail: { review: { is_running: boolean };
    cells: { status: string }[] }) => boolean,
) {
  const deadline = Date.now() + 5_000;
  let latest: unknown;
  while (Date.now() < deadline) {
    const response = await request(api).get(`/tabular-review/${reviewId}`);
    latest = response.body;
    if (response.status === 200 && predicate(response.body)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for tabular agents: ${JSON.stringify(latest)}`);
}

async function submitFixture(params: Parameters<typeof import("../../lib/llm").streamChatWithTools>[0]) {
  const evidenceId = /e_[A-Za-z0-9_-]{18}/u.exec(JSON.stringify(params.messages))?.[0];
  if (!evidenceId) throw new Error("Extraction did not receive original evidence");
  await params.runTools([{
    id: "result", name: "submit_extraction", input: { column_index: 0,
      value: "Alberta", flag: "green", outcome: "answered",
      claims: [{ text: "The governing law is Alberta.", evidence_ids: [evidenceId] }] },
  }]);
  return { fullText: "" };
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-tabular-routes-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", dataHome);
  vi.stubEnv(
    "MIKE_LOCAL_DATA_DIR",
    path.join(dataHome, "apps", "mike", "library"),
  );
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  mocks.supabaseCalls = 0;
  mocks.streamChatWithTools.mockReset();
  mocks.streamChatWithTools.mockImplementation(submitFixture);

});

afterEach(async () => {
  await closeStores?.();
  closeStores = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("account-free tabular reviews", () => {
  it("extracts a public research source through durable jobs and imports its grounded findings without another model run", async () => {
    const api = await loadApi(), { runtime } = await import("../../runtime"),
      { structureNative } = await import("../../lib/structureNative"),
      { legalSourceOperations } = await import("../../lib/legalSourceApplication"),
      research = await import("../../lib/researchFile"), documents = await runtime.documents(),
      app = await runtime.tabular(), scope = { userId: "00000000-0000-0000-0000-000000000001" },
      reference = { provider: "tna", id: "ewca/civ/2024/1", kind: "case" as const,
        title: "Example", citation: "[2024] EWCA Civ 1" },
      resource = research.researchSourceResource(reference),
      artifact = await structureNative().deriveDocumentStructure({ kind: "instrument", id: reference.id,
        text: "[1] The governing law is Alberta.", reconstruct_lineation: false });
    vi.spyOn(legalSourceOperations, "readWithRenditions").mockResolvedValue({ status: "found",
      values: [{ source: reference, locator: { requested: null, label: "document" }, role: "document",
        text: structureNative().documentText(artifact), documentArtifact: artifact }], pdfRenditions: [] });
    const created = await documents.create(scope, { filename: "Sources.research.md", fileType: "md",
      bytes: Buffer.from(research.researchFileMarkdown("Sources", research.createResearchFileState())) });
    let file = (await research.readResearchFile(documents, scope, created.id))!;
    file = (await research.commitResearchFile(documents, scope, file, { type: "source", reference }))!;
    const sourceId = Object.keys(file.state.sources)[0];
    const table = await request(api).post("/tabular-review").send({ research_file_id: created.id,
      research_selection: { sourceIds: [sourceId], target: "sources" },
      columns_config: [{ index: 0, name: "Law", prompt: "Find the governing law" }] });
    expect(table.status).toBe(201);
    expect(table.body.document_ids).toEqual([resource]);
    expect((await request(api).post(`/tabular-review/${table.body.id}/generate`)).status).toBe(202);
    const completed = await waitForReview(api, table.body.id, (detail) =>
      !detail.review.is_running && detail.cells[0]?.status === "done");
    expect(completed.cells[0].content).toMatchObject({ summary: "Alberta", resource,
      evidence: [expect.objectContaining({ provider: "tna", source_reference: { id: reference.id } })] });
    const extraction = completed.cells[0].content, calls = mocks.streamChatWithTools.mock.calls.length;
    const chats = await runtime.chats(),
      { createLegalEvidenceTurnState, registerLegalEvidence, legalEvidenceReceiptEvent } = await import("../../lib/chat/legalEvidence"),
      sources = await runtime.sources(), state = createLegalEvidenceTurnState(),
      chat = await chats.create(scope, { projectId: null, tabularReviewId: null, researchFileId: created.id }),
      answerMessageId = randomUUID();
    for (const receipt of extraction.evidence) registerLegalEvidence(state, receipt);
    state.answer = extraction.claims;
    await chats.commitTurn(scope, chat.id, { expectedVersion: 0,
      userMessage: { id: randomUUID(), content: "What law applies?" },
      assistantMessage: { id: answerMessageId, content: [legalEvidenceReceiptEvent(state)!] } });
    const imported = await sources.table(scope, created.id, { chatId: chat.id, messageIds: [answerMessageId] }),
      finding = (await sources.findings(scope, created.id, { chatId: chat.id, offset: 0, limit: 10 })).items[0];
    expect(imported.id).not.toBe(table.body.id);
    expect(imported.columns_config.map(({ name }) => name).slice(0, 2)).toEqual(["Labels", "Note"]);
    expect(imported.scope_config?.arrangement?.rows).toEqual([{ id: sourceId, title: "Example", sourceId }]);
    expect((await app.detail(scope, imported.id)).cells.every(({ status }) => status === "done")).toBe(true);
    expect((await sources.table(scope, created.id, { chatId: chat.id, messageIds: [answerMessageId] })).id)
      .toBe(imported.id);
    const arrangement = { rows: [{ id: "governing-law", title: "Governing law", sourceId }],
      cells: [{ rowId: "governing-law", columnIndex: 0, items: [{ kind: "answer" as const,
        chatId: chat.id, answerId: finding.question.id, resource }] }] };
    await app.update(scope, imported.id, { expected_version: imported.updated_at,
      columns_config: [{ index: 0, name: "Finding", prompt: "What law applies?" }], arrangement });
    const detail = await app.detail(scope, imported.id);
    expect(detail.cells[0].content).toMatchObject({ claims: extraction.claims, evidence: extraction.evidence,
      summary: extraction.claims.map(({ text }: { text: string }) => text).join("\n\n") });
    expect(detail.review.scope_config).toMatchObject({ arrangement,
      findings: { references: [finding.reference], sourceIds: [sourceId] } });
    const { tabularRepository } = await import("../../lib/relationalTabularRepository");
    expect((await tabularRepository.detail(scope, imported.id))?.cells[0])
      .toMatchObject({ status: "pending", content: null });
    expect(mocks.streamChatWithTools.mock.calls.length).toBe(calls);
  });

  it("filters and paginates standalone reviews without duplicates", async () => {
    const api = await loadApi();
    const created = await Promise.all(["Needle lease", "Employment", "Supply"].map(
      (title) => request(api).post("/tabular-review").send({
        title, document_ids: [], columns_config: [],
      }),
    ));
    expect(created.every(({ status }) => status === 201)).toBe(true);

    const first = await request(api).get("/tabular-review?scope=standalone&limit=2");
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await request(api).get(
      `/tabular-review?scope=standalone&limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    expect(second.body.items).toHaveLength(1);
    const all = [...first.body.items, ...second.body.items] as {
      id: string; created_at: string;
    }[];
    expect(new Set(all.map(({ id }) => id))).toEqual(
      new Set(created.map(({ body }) => body.id)),
    );
    expect(all.map(({ id }) => id)).toEqual([...all].sort((left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
      .map(({ id }) => id));

    const filtered = await request(api).get("/tabular-review?q=NEEDLE");
    expect(filtered.body.items.map(({ title }: { title: string }) => title))
      .toEqual(["Needle lease"]);
  });

  it("persists a project review and generated cells across restart", async () => {
    let api = await loadApi();
    const project = await request(api)
      .post("/projects")
      .send({ name: "Lease review", practice: "Litigation" });
    expect(project.status).toBe(201);

    const uploaded = await request(api)
      .post("/library/files/documents")
      .attach("file", spreadsheetBytes("Governing law: Alberta"), "lease.xlsx");
    expect(uploaded.status).toBe(201);
    expect(
      (
        await request(api).post(
          `/projects/${project.body.id}/documents/${uploaded.body.id}`,
        )
      ).status,
    ).toBe(200);

    const rejected = await request(api)
      .post("/tabular-review")
      .send({
        title: "Lease terms",
        project_id: project.body.id,
        document_ids: [uploaded.body.id, "not-owned"],
        columns_config: [
          { index: 0, name: "Governing law", prompt: "Find governing law" },
        ],
      });
    expect(rejected.status).toBe(404);

    const created = await request(api)
      .post("/tabular-review")
      .send({
        title: "Lease terms",
        project_id: project.body.id,
        document_ids: [uploaded.body.id],
        columns_config: [
          { index: 0, name: "Governing law", prompt: "Find governing law" },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      project_id: project.body.id,
      title: "Lease terms",
      document_ids: [uploaded.body.id],
      document_count: 1,
      is_owner: true,
    });

    const standalone = await request(api)
      .post("/tabular-review")
      .send({
        title: "Standalone",
        document_ids: [],
        columns_config: [],
      });
    expect(standalone.status).toBe(201);

    const listed = await request(api).get(
      `/tabular-review?project_id=${project.body.id}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((review: { id: string }) => review.id)).toEqual([
      created.body.id,
    ]);

    const opened = await request(api).get(
      `/tabular-review/${created.body.id}`,
    );
    expect(opened.status).toBe(200);
    expect(opened.body.documents[0].filename).toBe("lease.xlsx");
    expect(opened.body.cells).toHaveLength(1);
    expect(opened.body.cells[0].status).toBe("pending");

    const updated = await request(api)
      .patch(`/tabular-review/${created.body.id}`)
      .send({
        title: "Updated lease terms",
        document_ids: [uploaded.body.id],
        columns_config: [
          { index: 0, name: "Jurisdiction", prompt: "Find jurisdiction" },
        ],
      });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      title: "Updated lease terms",
      columns_config: [{ index: 0, name: "Jurisdiction" }],
    });

    const reviewRace = await Promise.all([
      request(api).patch(`/tabular-review/${created.body.id}`).send({
        title: "Updated lease terms", expected_version: updated.body.updated_at,
      }),
      request(api).patch(`/tabular-review/${created.body.id}`).send({
        title: "Updated lease terms", expected_version: updated.body.updated_at,
      }),
    ]);
    expect(reviewRace.map(({ status }) => status).sort()).toEqual([200, 409]);

    const generated = await request(api).post(
      `/tabular-review/${created.body.id}/generate`,
    );
    expect(generated.status).toBe(202);
    expect(generated.body).toMatchObject({ queued: 1, job_ids: [expect.any(String)] });
    await waitForReview(api, created.body.id, (detail) =>
      detail.review.is_running === false && detail.cells[0]?.status === "done");

    const workspace = await request(api).post("/source-workspaces/ensure").send({ tableId: created.body.id });
    expect(workspace.status).toBe(200);
    expect(workspace.body.document.id).toEqual(expect.any(String));
    const reopenedWorkspace = await request(api).post("/source-workspaces/ensure").send({ tableId: created.body.id });
    expect(reopenedWorkspace.body.document.id).toEqual(workspace.body.document.id);

    await closeStores?.();
    closeStores = null;
    api = await loadApi();

    const persisted = await request(api).get(
      `/tabular-review/${created.body.id}`,
    );
    expect(persisted.status).toBe(200);
    expect(persisted.body.review.title).toBe("Updated lease terms");
    expect(persisted.body.cells[0]).toMatchObject({
      status: "done",
      content: {
        summary: "Alberta",
        flag: "green",
        reasoning: "The governing law is Alberta.",
      },
    });

    expect(persisted.body.review.scope_config.research_file_id).toBe(workspace.body.document.id);
    expect(persisted.body.cells[0].content.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "library", stable_source_id: uploaded.body.id,
        version: uploaded.body.current_version_id }),
    ]));
    const { tabularRepository } = await import("../../lib/relationalTabularRepository");
    const cellScope = { userId: persisted.body.review.user_id }, original = persisted.body.cells[0];
    const writing = await tabularRepository.setCell(cellScope, { reviewId: created.body.id,
      documentId: uploaded.body.id, columnIndex: 0, expected: original, status: "generating", content: null });
    if (writing.status !== "committed") throw new Error("Cell fixture unavailable");
    const cleared = await tabularRepository.setCell(cellScope, { reviewId: created.body.id,
      documentId: uploaded.body.id, columnIndex: 0, expected: writing.value, status: "pending", content: null });
    if (cleared.status !== "committed") throw new Error("Cell fixture unavailable");
    await tabularRepository.setCell(cellScope, { reviewId: created.body.id,
      documentId: uploaded.body.id, columnIndex: 0, expected: cleared.value, status: "generating", content: null });
    const stale = await tabularRepository.setCell(cellScope, { reviewId: created.body.id,
      documentId: uploaded.body.id, columnIndex: 0, expected: writing.value, status: "done", content: original.content });
    expect(stale.status).toBe("conflict");

    const projectAfterRestart = await request(api).get(
      `/projects/${project.body.id}`,
    );
    expect(projectAfterRestart.body).not.toHaveProperty("review_count");

    expect(
      (
        await request(api)
          .post(`/tabular-review/${created.body.id}/clear-cells`)
          .send({ document_ids: [uploaded.body.id] })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(api).get(
          `/tabular-review/${created.body.id}`,
        )
      ).body.cells[0],
    ).toMatchObject({ content: null, status: "pending" });

    mocks.streamChatWithTools.mockImplementation(async (params) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return submitFixture(params);
    });
    const cellRace = await Promise.all([
      request(api).post(`/tabular-review/${created.body.id}/regenerate-cell`)
        .send({ document_id: uploaded.body.id, column_index: 0 }),
      request(api).post(`/tabular-review/${created.body.id}/regenerate-cell`)
        .send({ document_id: uploaded.body.id, column_index: 0 }),
    ]);
    expect(cellRace.map(({ status }) => status).sort()).toEqual([202, 409]);
    await waitForReview(api, created.body.id, (detail) =>
      detail.review.is_running === false && detail.cells[0]?.status === "done");

    await request(api).post(`/tabular-review/${created.body.id}/clear-cells`)
      .send({ document_ids: [uploaded.body.id] });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    mocks.streamChatWithTools.mockImplementationOnce(async (params) => {
      providerStarted();
      await new Promise<void>((_resolve, reject) => {
        const signal = params.abortSignal as AbortSignal;
        signal.addEventListener("abort", () => reject(
          signal.reason ?? new DOMException("Stopped", "AbortError"),
        ), { once: true });
      });
      return { fullText: "" };
    });
    const running = request(api).post(`/tabular-review/${created.body.id}/generate`)
      .then((response) => response);
    await started;
    expect((await request(api).get(
      `/tabular-review/${created.body.id}`,
    )).body.review.is_running).toBe(true);
    expect((await request(api).post(
      `/tabular-review/${created.body.id}/stop`,
    )).body).toEqual({ stopped: true });
    await running;
    const stopped = await waitForReview(api, created.body.id, (detail) =>
      detail.review.is_running === false);
    expect(stopped.cells[0]).toMatchObject({ status: "pending", content: null });

    expect(
      (
        await request(api).delete(
          `/single-documents/${uploaded.body.id}`,
        ).send({ expected_current_version_id: uploaded.body.current_version_id,
          expected_working_revision: uploaded.body.current_working_revision,
          expected_project_id: project.body.id, expected_folder_id: null })
      ).status,
    ).toBe(204);
    const reviewWithoutDocument = await request(api).get(
      `/tabular-review/${created.body.id}`,
    );
    expect(reviewWithoutDocument.body.review.document_ids).toEqual([]);
    expect(reviewWithoutDocument.body.cells).toEqual([]);

    expect(
      (
        await request(api).delete(
          `/projects/${project.body.id}`,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await request(api).get(
          `/tabular-review?project_id=${project.body.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(api).delete(
          `/tabular-review/${standalone.body.id}`,
        )
      ).status,
    ).toBe(204);
    expect(mocks.supabaseCalls).toBe(0);
  });


});
