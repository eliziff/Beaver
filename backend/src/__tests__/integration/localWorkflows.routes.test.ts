import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  supabaseCalls: 0,
}));

vi.mock("../../lib/localMode", () => ({
  isAnonymousLocalMode: () => true,
}));

vi.mock("../../lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/supabase")>()),
  createServerSupabase: () => {
    mocks.supabaseCalls += 1;
    throw new Error("Supabase must not be used by local workflow routes");
  },
}));

async function loadApp() {
  vi.resetModules();
  return (await import("../../app")).app;
}

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "anonymous");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  mocks.supabaseCalls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("account-free starter workflows", () => {
  it("returns the requested bounded workflow archive without Supabase", async () => {
    const app = await loadApp();
    const files = [
      { path: "contract-review/SKILL.md", content: "---\nname: contract-review\n---\n" },
      { path: "contract-review/table-config.yaml", content: "columns_config: []\n" },
    ];
    const response = await request(app)
      .post("/workflows/archive")
      .send({ files })
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    const zip = await (await import("jszip")).default.loadAsync(response.body);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/zip/);
    expect(Object.keys(zip.files).filter((path) => !zip.files[path].dir)).toEqual(
      files.map(({ path }) => path),
    );
    await Promise.all(
      files.map(async ({ path, content }) =>
        expect(await zip.file(path)!.async("text")).toBe(content),
      ),
    );
    expect(
      (
        await request(app)
          .post("/workflows/archive")
          .send({ files: [...files, files[0]] })
      ).status,
    ).toBe(400);
    expect(mocks.supabaseCalls).toBe(0);
  });

  it("lists a small assistant and tabular set without Supabase", async () => {
    const app = await loadApp();
    const [assistant, tabular, hidden] = await Promise.all([
      request(app).get("/workflows/system?type=assistant"),
      request(app).get("/workflows/system?type=tabular"),
      request(app).get("/workflows/hidden"),
    ]);

    expect(assistant.status).toBe(200);
    expect(
      assistant.body.map((workflow: { id: string }) => workflow.id),
    ).toEqual([
      "builtin-credit-agreement-review",
      "builtin-draft-cp-checklist",
      "builtin-shareholder-agreement-review",
    ]);
    expect(
      tabular.body.map((workflow: { id: string }) => workflow.id),
    ).toEqual([
      "builtin-change-of-control-tabular-review",
      "builtin-commercial-agreement-tabular-review",
    ]);
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

  it("opens only local starters and keeps mutations unavailable", async () => {
    const app = await loadApp();
    const starter = await request(app).get(
      "/workflows/builtin-draft-cp-checklist",
    );
    const nonStarter = await request(app).get(
      "/workflows/builtin-proofread",
    );
    const created = await request(app)
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
    expect(nonStarter.status).toBe(404);
    expect(created.status).toBe(503);
    expect(created.body.detail).toBe(
      "This feature requires Supabase persistence",
    );
    expect(mocks.supabaseCalls).toBe(0);
  });
});
