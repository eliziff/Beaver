import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY_PROVIDERS, type ApiKeyStatus } from "../../lib/userCredentials";
import { createUserApplication } from "../../lib/userApplication";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../lib/userPreferences";

const mfa = vi.hoisted(() => ({ allowed: true }));
vi.mock("../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, string> }, next: () => void) => {
    Object.assign(res.locals, { userId: "u1", userEmail: "ada@example.test" });
    next();
  },
  requireMfaIfEnrolled: (
    _req: unknown,
    res: { status: (status: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => mfa.allowed ? next() : res.status(403).json({
    code: "mfa_verification_required",
    detail: "MFA verification required",
  }),
}));

import { createUserRouter } from "../../routes/user";

const STATUS = Object.assign(
  Object.fromEntries(API_KEY_PROVIDERS.map((provider) => [provider, provider === "claude"])),
  { sources: Object.fromEntries(API_KEY_PROVIDERS.map((provider) => [
    provider, provider === "claude" ? "user" : null,
  ])) },
) as ApiKeyStatus;

function fixture() {
  let preferences: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    displayName: "Ada",
    organisation: "Acme",
  };
  let environmentManaged = false;
  const save = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const exported = vi.fn();
  const repository = {
    get: async () => preferences,
    update: async (_userId: string, patch: Partial<UserPreferences>) =>
      (preferences = { ...preferences, ...patch }),
  };
  const application = createUserApplication({
    preferences: async () => repository,
    credentials: {
      status: async () => STATUS,
      keys: async () => ({}),
      environmentConfigured: () => environmentManaged,
      save,
    },
    cloud: {
      profile: async () => ({
        mfaOnLogin: false,
      }),
      lookup: async () => null,
      setMfaOnLogin: async () => undefined,
      delete: remove,
      exportData: async (kind) => ({
        filename: `beaver-${kind}-export-u1.json`,
        data: { kind },
      }),
    },
    deleteAll: remove,
    recordExport: exported,
  });
  const api = express();
  api.use(express.json());
  api.use("/user", createUserRouter(application));
  return {
    api,
    save,
    remove,
    exported,
    manageEnvironmentKey(value: boolean) { environmentManaged = value; },
  };
}

describe("user routes", () => {
  beforeEach(() => { mfa.allowed = true; });

  it("reads and updates the authoritative profile without exposing key material", async () => {
    const { api } = fixture();
    const profile = await request(api).get("/user/profile");
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({
      displayName: "Ada",
      organisation: "Acme",
      features: { authorities: true },
      apiKeyStatus: STATUS,
    });
    expect(JSON.stringify(profile.body)).not.toContain("secret");

    mfa.allowed = false;
    expect((await request(api).get("/user/profile")).status).toBe(200);
    const updated = await request(api).patch("/user/profile").send({
      displayName: "Ada Lovelace",
      onboardingCompleted: true,
      features: { authorities: false },
      workflowFileTargets: {
        "court-records": { kind: "library", folderId: "court-records" },
        authorities: null,
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      displayName: "Ada Lovelace",
      onboardingCompleted: true,
      features: { authorities: false },
      workflowFileTargets: {
        "court-records": { kind: "library", folderId: "court-records" },
        authorities: null,
      },
    });
    expect((await request(api).patch("/user/profile").send({ unknown: true })).status)
      .toBe(400);
  });

  it("guards API-key writes and returns presence-only status", async () => {
    const { api, save, manageEnvironmentKey } = fixture();
    expect((await request(api).get("/user/api-keys")).body).toEqual(STATUS);

    const stored = await request(api).put("/user/api-keys/openai")
      .send({ api_key: "sk-secret-value" });
    expect(stored.status).toBe(200);
    expect(stored.body).toEqual(STATUS);

    manageEnvironmentKey(true);
    expect((await request(api).put("/user/api-keys/openai").send({ api_key: "x" })).status)
      .toBe(409);
    mfa.allowed = false;
    expect((await request(api).put("/user/api-keys/openai").send({ api_key: "x" })).status)
      .toBe(403);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("downloads exports and completes destructive operations", async () => {
    const { api, remove, exported } = fixture();
    const download = await request(api).get("/user/export");
    expect(download.status).toBe(200);
    expect(download.body).toEqual({ kind: "account" });
    expect(download.headers["content-disposition"]).toContain(
      "beaver-account-export-u1.json",
    );
    expect(exported).toHaveBeenCalledOnce();

    expect((await request(api).delete("/user/chats")).status).toBe(204);
    expect((await request(api).delete("/user/account")).status).toBe(204);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
