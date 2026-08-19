import os from "node:os";
import path from "node:path";
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
  closeStores = async () => {
    (await import("../../lib/sqliteDatabase")).closeSqliteDatabase();
  };
  return api;
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
      .attach("file", spreadsheetBytes("fixture"), "lease.xlsx");
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
    expect(generated.status).toBe(200);
    expect(generated.text).toContain('"status":"done"');
    expect(generated.text).toContain("data: [DONE]");
    expect(generated.text.match(/data: \[DONE\]/gu)).toHaveLength(1);

    closeStores?.();
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
        reasoning: "Fixture result",
      },
    });

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
      params.callbacks?.onContentDelta?.(`${JSON.stringify({
        column_index: 0, summary: "Alberta", flag: "green",
        reasoning: "Fixture result",
      })}\n`);
      return { fullText: "" };
    });
    const cellRace = await Promise.all([
      request(api).post(`/tabular-review/${created.body.id}/regenerate-cell`)
        .send({ document_id: uploaded.body.id, column_index: 0 }),
      request(api).post(`/tabular-review/${created.body.id}/regenerate-cell`)
        .send({ document_id: uploaded.body.id, column_index: 0 }),
    ]);
    expect(cellRace.map(({ status }) => status).sort()).toEqual([200, 409]);

    await request(api).post(`/tabular-review/${created.body.id}/clear-cells`)
      .send({ document_ids: [uploaded.body.id] });
    mocks.streamChatWithTools.mockRejectedValueOnce(new Error("provider unavailable"));
    const failedStream = await request(api).post(
      `/tabular-review/${created.body.id}/generate`,
    );
    expect(failedStream.status).toBe(200);
    expect(failedStream.text).toContain('"type":"error"');
    expect(failedStream.text.match(/data: \[DONE\]/gu)).toHaveLength(1);

    expect(
      (
        await request(api).delete(
          `/single-documents/${uploaded.body.id}`,
        )
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
