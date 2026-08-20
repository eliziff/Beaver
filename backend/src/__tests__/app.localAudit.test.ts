import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/localMode", () => ({
  isLocalRuntime: () => true,
}));

import { api } from "../api";

describe("local app", () => {
  it("does not rate-limit its single local user", async () => {
    const response = await request(api).get("/audit");
    expect(response.headers).not.toHaveProperty("ratelimit-limit");
  });

  it("does not expose the cloud audit route", async () => {
    const response = await request(api).get("/audit");
    expect(response.status).toBe(404);
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
