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
});
