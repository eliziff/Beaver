import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createAuthoritiesStandaloneApp } from "./authoritiesStandaloneServer";

const frontend = mkdtempSync(path.join(tmpdir(), "authorities-http-"));
writeFileSync(path.join(frontend, "authorities.html"), "<!doctype html><title>Authorities</title>");
const app = createAuthoritiesStandaloneApp({ port: 3002, buildId: "a".repeat(64), frontend });
afterAll(() => rmSync(frontend, { recursive: true, force: true }));

describe("standalone Authorities deployment", () => {
  it("serves the shared workspace and runtime without a Beaver account", async () => {
    await request(app).get("/").set("Host", "127.0.0.1:3002").expect(200, /Authorities/);
    const health = await request(app).get("/health").set("Host", "127.0.0.1:3002").expect(200);
    expect(health.body).toEqual({ status: "ok", app: "authorities", buildId: "a".repeat(64) });
    const result = await request(app).post("/api/authorities-runtime/create")
      .set("Host", "127.0.0.1:3002").set("Origin", "http://127.0.0.1:3002")
      .send({ settings: { profileId: "general" } }).expect(200);
    expect(result.body).toMatchObject({ import: { kind: "manual" }, stage: "sources" });
  });
  it("refuses hostile origins and DNS-rebinding hosts", async () => {
    await request(app).post("/api/authorities-runtime/create")
      .set("Host", "127.0.0.1:3002").set("Origin", "https://example.com").send({}).expect(403);
    await request(app).get("/health").set("Host", "example.com:3002").expect(403);
    await request(app).get("/health").set("Host", "127.0.0.1:3003").expect(403);
  });
  it("requires a concrete loopback port and immutable build identity", () => {
    expect(() => createAuthoritiesStandaloneApp({ port: 0, buildId: "a".repeat(64), frontend })).toThrow();
    expect(() => createAuthoritiesStandaloneApp({ port: 3002, buildId: "dev", frontend })).toThrow();
  });
});
