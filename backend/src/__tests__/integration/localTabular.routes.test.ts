import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
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
  isAnonymousLocalMode: () => true,
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

async function loadApp() {
  vi.resetModules();
  const [{ app }, graph, tabular, documents] = await Promise.all([
    import("../../app"),
    import("../../lib/legalKnowledgeGraphStore"),
    import("../../lib/localTabularStore"),
    import("../../lib/localDocumentStore"),
  ]);
  closeStores = async () => {
    tabular.closeLocalTabularStore();
    graph.legalKnowledgeGraphStore().close();
    await documents.closeLocalDocumentStore();
  };
  return app;
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-tabular-routes-"));
  vi.stubEnv("AUTH_MODE", "anonymous");
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
  mocks.streamChatWithTools.mockImplementation(async (params) => {
    params.callbacks?.onContentDelta?.(
      `${JSON.stringify({
        column_index: 0,
        summary: "Alberta",
        flag: "green",
        reasoning: "Fixture result",
      })}\n`,
    );
    return { fullText: "" };
  });
});

afterEach(async () => {
  await closeStores?.();
  closeStores = null;
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("account-free tabular reviews", () => {
  it("persists a project review and generated cells across restart", async () => {
    let app = await loadApp();
    const project = await request(app)
      .post("/projects")
      .send({ name: "Lease review", practice: "Litigation" });
    expect(project.status).toBe(201);

    const uploaded = await request(app)
      .post("/library/files/documents")
      .attach("file", Buffer.from("fixture"), "lease.xlsx");
    expect(uploaded.status).toBe(201);
    expect(
      (
        await request(app).post(
          `/projects/${project.body.id}/documents/${uploaded.body.id}`,
        )
      ).status,
    ).toBe(200);

    const created = await request(app)
      .post("/tabular-review")
      .send({
        title: "Lease terms",
        project_id: project.body.id,
        document_ids: [uploaded.body.id, "not-owned"],
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

    const standalone = await request(app)
      .post("/tabular-review")
      .send({
        title: "Standalone",
        document_ids: [],
        columns_config: [],
      });
    expect(standalone.status).toBe(201);

    const listed = await request(app).get(
      `/tabular-review?project_id=${project.body.id}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((review: { id: string }) => review.id)).toEqual([
      created.body.id,
    ]);

    const opened = await request(app).get(
      `/tabular-review/${created.body.id}`,
    );
    expect(opened.status).toBe(200);
    expect(opened.body.documents[0].filename).toBe("lease.xlsx");
    expect(opened.body.cells).toHaveLength(1);
    expect(opened.body.cells[0].status).toBe("pending");

    const updated = await request(app)
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

    const generated = await request(app).post(
      `/tabular-review/${created.body.id}/generate`,
    );
    expect(generated.status).toBe(200);
    expect(generated.text).toContain('"status":"done"');
    expect(generated.text).toContain("data: [DONE]");

    closeStores?.();
    closeStores = null;
    app = await loadApp();

    const persisted = await request(app).get(
      `/tabular-review/${created.body.id}`,
    );
    expect(persisted.status).toBe(200);
    expect(persisted.body.review.title).toBe("Updated lease terms");
    expect(persisted.body.cells[0]).toMatchObject({
      status: "done",
      content: {
        summary: "Alberta",
        flag: "green",
        reasoning: "Fixture result",
      },
    });

    const projectAfterRestart = await request(app).get(
      `/projects/${project.body.id}`,
    );
    expect(projectAfterRestart.body).not.toHaveProperty("review_count");

    expect(
      (
        await request(app)
          .post(`/tabular-review/${created.body.id}/clear-cells`)
          .send({ document_ids: [uploaded.body.id] })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app).get(
          `/tabular-review/${created.body.id}`,
        )
      ).body.cells[0],
    ).toMatchObject({ content: null, status: "pending" });

    expect(
      (
        await request(app).delete(
          `/single-documents/${uploaded.body.id}`,
        )
      ).status,
    ).toBe(204);
    const reviewWithoutDocument = await request(app).get(
      `/tabular-review/${created.body.id}`,
    );
    expect(reviewWithoutDocument.body.review.document_ids).toEqual([]);
    expect(reviewWithoutDocument.body.cells).toEqual([]);

    expect(
      (
        await request(app).delete(
          `/legal-knowledge/projects/${project.body.id}`,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app).get(
          `/tabular-review?project_id=${project.body.id}`,
        )
      ).body,
    ).toEqual({ items: [], next_cursor: null });
    expect(
      (
        await request(app).delete(
          `/tabular-review/${standalone.body.id}`,
        )
      ).status,
    ).toBe(204);
    expect(mocks.supabaseCalls).toBe(0);
  });


});
