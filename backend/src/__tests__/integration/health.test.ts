import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Reject attempts in teardown; the non-retryable response prevents SDK retry loops.
const outbound = vi.fn<typeof fetch>(async () => new Response(null, { status: 400 }));
beforeEach(() => {
  outbound.mockClear();
  vi.stubGlobal("fetch", outbound);
  vi.stubEnv("AUTH_MODE", "cloud");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MCP_CONNECTORS_ENABLED", undefined);
  vi.stubEnv("TRUST_PROXY_HOPS", undefined);
  vi.stubEnv("SUPABASE_URL", "https://supabase.test.local");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-service-key");
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules();
  expect(outbound).not.toHaveBeenCalled();
});

describe("public runtime endpoints", () => {
  it.each(["local", "cloud"] as const)("exposes only public %s configuration without authenticating", async (mode) => {
    vi.stubEnv("AUTH_MODE", mode);
    const { api } = await import("../../api");
    const health = await request(api).get("/health").expect(200);
    expect(health.body).toEqual({ ok: true, runtime: { mode } });
    const config = await request(api).get("/config").expect(200);
    expect(config.body).toEqual({ mode, capabilities: { connectors: mode === "cloud" } });
    expect(config.headers["cache-control"].split(",").map((value: string) => value.trim()))
      .toContain("no-store");
  });

  it.each([
    ["http://supabase.example", "development", 500],
    ["http://127.0.0.1:54321", "development", 200],
    ["http://127.0.0.1:54321", "production", 500],
  ] as const)("enforces the cloud transport policy for %s in %s", async (url, environment, status) => {
    vi.stubEnv("SUPABASE_URL", url);
    vi.stubEnv("NODE_ENV", environment);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { api } = await import("../../api");
    const response = await request(api).get("/config").expect(status);
    expect(response.body).toEqual(status === 200
      ? { mode: "cloud", capabilities: { connectors: true } }
      : { detail: "Internal server error" });
  });

  it("returns 404 for an unknown route", async () => {
    const { api } = await import("../../api");
    await request(api).get("/this-route-does-not-exist").expect(404);
  });
});
