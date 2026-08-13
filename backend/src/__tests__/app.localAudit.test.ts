import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/localMode", () => ({
  isAnonymousLocalMode: () => true,
}));

import { app } from "../app";

describe("anonymous-local app", () => {
  it("does not expose the cloud audit route", async () => {
    const response = await request(app).get("/audit");
    expect(response.status).toBe(404);
  });

  it("uses the account-free user surface", async () => {
    expect((await request(app).get("/user/api-keys")).status).toBe(200);
    const response = await request(app).get("/user/mcp-connectors");
    expect(response.status).toBe(501);
    expect(response.body.detail).toContain("account-free");
  });
});
