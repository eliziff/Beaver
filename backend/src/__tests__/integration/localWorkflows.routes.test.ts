import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  supabaseCalls: 0,
}));

vi.mock("../../lib/localMode", () => ({
  isLocalRuntime: () => true,
}));

vi.mock("../../lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/supabase")>()),
  createServerSupabase: () => {
    mocks.supabaseCalls += 1;
    throw new Error("Supabase must not be used by local workflow routes");
  },
}));

async function loadApi() {
  vi.resetModules();
  return (await import("../../api")).api;
}

let dataHome: string;

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-workflows-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", dataHome);
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  mocks.supabaseCalls = 0;
});

afterEach(async () => {
  await (await import("../../lib/relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("account-free workflows", () => {
  it("exports the authorized durable workflow without accepting archive files", async () => {
    const api = await loadApi();
    const created = await request(api).post("/workflows").send({
      metadata: { title: "Contract review", type: "tabular" },
      skill_md: "Review each agreement.",
      columns_config: [{ index: 0, name: "Term", prompt: "Extract the term." }],
    });
    const response = await request(api)
      .get(`/workflows/${created.body.id}/export`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    const zip = await (await import("jszip")).default.loadAsync(response.body);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/zip/);
    expect(Object.keys(zip.files).filter((path) => !zip.files[path].dir)).toEqual([
      "contract-review/SKILL.md",
      "contract-review/table-config.yaml",
    ]);
    expect(await zip.file("contract-review/SKILL.md")!.async("text"))
      .toContain("Review each agreement.");
    expect(JSON.parse(await zip.file("contract-review/table-config.yaml")!.async("text")))
      .toMatchObject({ columns_config: [{ name: "Term" }] });
    expect(mocks.supabaseCalls).toBe(0);
  });

  it("lists built-in assistant and tabular workflows without Supabase", async () => {
    const api = await loadApi();
    const [assistant, tabular, hidden] = await Promise.all([
      request(api).get("/workflows/system?type=assistant"),
      request(api).get("/workflows/system?type=tabular"),
      request(api).get("/workflows/hidden"),
    ]);

    expect(assistant.status).toBe(200);
    expect(assistant.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "builtin-draft-cp-checklist" }),
      expect.objectContaining({ id: "builtin-proofread" }),
    ]));
    expect(tabular.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "builtin-change-of-control-tabular-review" }),
      expect.objectContaining({ id: "builtin-commercial-agreement-tabular-review" }),
    ]));
    expect(
      [...assistant.body, ...tabular.body].every(
        (workflow: {
          is_system: boolean;
          allow_edit: boolean;
          metadata: {
            contributors: { name: string }[];
            version: string;
          };
        }) =>
          workflow.is_system &&
          !workflow.allow_edit &&
          workflow.metadata.version === "1.0.0" &&
          workflow.metadata.contributors[0]?.name === "Open Legal Products",
      ),
    ).toBe(true);
    expect(hidden.body).toEqual([]);
    expect(mocks.supabaseCalls).toBe(0);
  });

  it("persists custom workflows and hidden state without Supabase", async () => {
    const api = await loadApi();
    const starter = await request(api).get(
      "/workflows/builtin-draft-cp-checklist",
    );
    const created = await request(api)
      .post("/workflows")
      .send({
        metadata: { title: "Local custom workflow", type: "assistant" },
        skill_md: "Do the thing.",
      });

    expect(starter.status).toBe(200);
    expect(starter.body).toMatchObject({
      id: "builtin-draft-cp-checklist",
      is_system: true,
      allow_edit: false,
      metadata: {
        title: "Draft CP Checklist",
        contributors: [{ name: "Open Legal Products" }],
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await request(api).patch(`/workflows/${id}`).send({
      metadata: { title: "Updated local workflow" },
      skill_md: "Do the safer thing.",
    })).body).toMatchObject({ id, metadata: { title: "Updated local workflow" },
      skill_md: "Do the safer thing.", allow_edit: true, is_owner: true });
    expect((await request(api).post("/workflows/hidden")
      .send({ workflow_id: id })).status).toBe(204);
    expect((await request(api).get("/workflows/hidden")).body).toContain(id);
    expect((await request(api).get("/workflows?type=assistant")).body.items)
      .toEqual([expect.objectContaining({ id })]);
    const { runtime } = await import("../../runtime");
    const workflowPorts = await runtime.workflows();
    expect((await workflowPorts.repository({
      userId: "00000000-0000-0000-0000-000000000001",
    }).assistants()).get(id)).toEqual({
      title: "Updated local workflow", skill_md: "Do the safer thing.",
    });
    expect((await request(api).delete(`/workflows/${id}`)).status).toBe(204);
    expect((await request(api).get(`/workflows/${id}`)).status).toBe(404);
    expect((await request(api).get("/workflows/hidden")).body).not.toContain(id);
    expect(mocks.supabaseCalls).toBe(0);
  });
});
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
