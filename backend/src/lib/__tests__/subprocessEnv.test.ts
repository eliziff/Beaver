import { afterEach, describe, expect, it } from "vitest";
import { isolatedProcessEnv } from "../subprocessEnv";

describe("isolated subprocess environments", () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, original);
  });

  it("keeps system settings and explicit families but drops server secrets", () => {
    Object.assign(process.env, {
      PATH: "bin", LEGALPDF_MODEL: "model", SUPABASE_SECRET_KEY: "secret",
      OPENAI_API_KEY: "secret", NODE_OPTIONS: "--require malware.js",
    });
    const env = isolatedProcessEnv(["LEGALPDF_*"]);
    expect(env).toMatchObject({ PATH: "bin", LEGALPDF_MODEL: "model" });
    expect(env).not.toHaveProperty("SUPABASE_SECRET_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });
});
