import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("./runtime", () => ({ runtime: { mode: "local" } }));

import { api } from "./api";
import { server } from "./server";

describe("public server boundary", () => {
  it("does not trust forwarded client addresses unless explicitly configured", () => {
    expect(server.get("trust proxy fn")("203.0.113.8", 0)).toBe(false);
    expect(api.get("trust proxy fn")("203.0.113.8", 0)).toBe(false);
  });

  it("serves the API under one same-origin prefix with security headers", async () => {
    const response = await request(server)
      .get("/api/health")
      .set("Host", "127.0.0.1:3000");

    expect(response.status).toBe(200);
    expect(response.body.runtime).toEqual({ mode: "local" });
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(response.headers["permissions-policy"]).toContain("camera=()");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects DNS rebinding and cross-site browser requests in local mode", async () => {
    expect((await request(server).get("/api/health").set("Host", "evil.test"))
      .status).toBe(421);
    expect((await request(server)
      .get("/api/health")
      .set("Host", "127.0.0.1:3000")
      .set("Sec-Fetch-Site", "cross-site")).status).toBe(403);
    expect((await request(server)
      .get("/api/health")
      .set("Host", "127.0.0.1:3000")
      .set("Origin", "https://evil.test")).status).toBe(403);
  });

  it("rejects oversized JSON before loading an application route", async () => {
    const response = await request(server)
      .post("/api/chat")
      .set("Host", "127.0.0.1:3000")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ content: "x".repeat(5 * 1024 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ detail: "Invalid request" });
  });

  it("does not turn missing static assets into successful application HTML", async () => {
    const response = await request(server)
      .get("/assets/missing.js")
      .set("Host", "127.0.0.1:3000")
      .set("Accept", "text/html");

    expect(response.status).toBe(404);
  });
});
