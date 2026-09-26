import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sso = vi.hoisted(() => vi.fn());
vi.mock("../lib/authSession", () => ({
  createRequestSupabase: () => ({ auth: { signInWithSSO: sso } }),
  clearRequestAuthCookies: vi.fn(), publicAuthUser: vi.fn(),
}));
import { createAuthRouter } from "./auth";

const app = express().use(express.json()).use("/auth", createAuthRouter("https://beaver.example"));
const start = (body: object, origin = "https://beaver.example") =>
  request(app).post("/auth/oauth").set("Origin", origin).send({ provider: "sso", ...body });

beforeEach(() => {
  sso.mockReset();
  vi.stubEnv("SSO_ENABLED", "true");
  vi.stubEnv("SSO_ALLOWED_DOMAINS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("progressive SSO", () => {
  it("starts domain SSO with a trusted callback and retains the Word surface", async () => {
    sso.mockResolvedValue({ data: { url: "https://identity.example/saml" }, error: null });
    const response = await start({ email: "Ada@Firm.Example", next: "//evil.example/" })
      .set("x-beaver-surface", "word");
    expect(response.status).toBe(200);
    expect(response.body.url).toBe("https://identity.example/saml");
    expect(sso).toHaveBeenCalledWith({ domain: "firm.example", options: {
      redirectTo: "https://beaver.example/auth/callback?next=%2Fonboarding&surface=word",
      skipBrowserRedirect: true,
    } });
  });

  it("offers password login only for disabled, excluded or unconfigured domains", async () => {
    vi.stubEnv("SSO_ENABLED", "false");
    expect((await start({ email: "ada@firm.example" })).body).toEqual({ url: null });
    vi.stubEnv("SSO_ENABLED", "true");
    vi.stubEnv("SSO_ALLOWED_DOMAINS", "other.example");
    expect((await start({ email: "ada@firm.example" })).body).toEqual({ url: null });
    expect(sso).not.toHaveBeenCalled();
    vi.stubEnv("SSO_ALLOWED_DOMAINS", "firm.example");
    sso.mockResolvedValue({ data: null, error: { code: "sso_provider_not_found" } });
    expect((await start({ email: "ada@firm.example" })).body).toEqual({ url: null });
  });

  it("does not expose provider errors, unsafe redirects or fall back after an outage", async () => {
    for (const result of [
      { data: null, error: { status: 500, message: "private tenant data" } },
      { data: { url: "javascript:alert(1)" }, error: null },
    ]) {
      sso.mockResolvedValue(result);
      const response = await start({ email: "ada@firm.example" });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("sso_unavailable");
      expect(response.text).not.toContain("private tenant");
      expect(response.body).not.toHaveProperty("url");
    }
  });

  it("rejects invalid requests and untrusted origins before contacting the provider", async () => {
    expect((await start({ email: "https://firm.example" })).status).toBe(400);
    expect((await start({ email: "ada@firm.example" }, "https://evil.example")).status).toBe(403);
    expect(sso).not.toHaveBeenCalled();
  });
});
