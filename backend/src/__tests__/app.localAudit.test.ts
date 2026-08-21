import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/localMode", () => ({
  isLocalRuntime: () => true,
}));

import { api } from "../api";

let dataHome = "";
beforeAll(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-local-audit-"));
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", dataHome);
});
afterAll(async () => {
  await (await import("../lib/relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs();
  await rm(dataHome, { recursive: true, force: true });
});

describe("local app", () => {
  it("does not rate-limit its single local user", async () => {
    const response = await request(api).get("/audit");
    expect(response.headers).not.toHaveProperty("ratelimit-limit");
  });

  it("exposes account-free local history", async () => {
    const response = await request(api).get("/audit");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ events: [], total: 0, page: 1, pageSize: 50 });
  });

  it("uses the account-free user surface", async () => {
    expect((await request(api).get("/user/api-keys")).status).toBe(200);
    const profile = await request(api).get("/user/profile");
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ mfaOnLogin: false, tier: "Free" });
    expect(profile.body).toHaveProperty("draftingStyle");
    expect((await request(api).patch("/user/profile")
      .send({ displayName: "Not an account" })).status).toBe(501);
    const response = await request(api).get("/user/mcp-connectors");
    expect(response.status).toBe(404);
  });
});
