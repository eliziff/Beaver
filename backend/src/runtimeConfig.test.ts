import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime", () => ({ runtime: { mode: "cloud" } }));

import { publicRuntimeConfig } from "./runtimeConfig";

describe("cloud public runtime configuration", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret-test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("never permits cleartext Supabase credentials to a remote host", () => {
    vi.stubEnv("SUPABASE_URL", "http://supabase.example");
    expect(() => publicRuntimeConfig()).toThrow(/HTTPS/u);
  });

  it("keeps loopback HTTP available for local Supabase development", () => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    expect(publicRuntimeConfig().supabaseUrl).toBe("http://127.0.0.1:54321");
  });
});
