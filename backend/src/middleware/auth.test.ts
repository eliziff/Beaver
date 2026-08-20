import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const state = vi.hoisted(() => ({
  user: { id: "user-1", email: "USER@example.com" } as null | { id: string; email: string },
  profile: { mfa_on_login: false },
  profileError: null as null | Error,
  assurance: { currentLevel: "aal1", nextLevel: "aal1" },
  assuranceError: null as null | Error,
}));
const db = vi.hoisted(() => ({
  auth: {
    getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })),
    mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({
      data: state.assurance, error: state.assuranceError,
    })) },
  },
  from: vi.fn(() => {
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: state.profile, error: state.profileError })),
    };
    return query;
  }),
}));
vi.mock("../lib/supabase", () => ({ createServerSupabase: () => db }));
vi.mock("../lib/userLookup", () => ({ syncProfileEmail: vi.fn(async () => null) }));

import { requireAuth, requireMfaIfEnrolled } from "./auth";

function response() {
  const res = { locals: {}, statusCode: 200 } as Response & { body?: unknown };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as never;
  res.json = vi.fn((body: unknown) => { res.body = body; return res; }) as never;
  return res;
}
function request(overrides: Partial<Request> = {}) {
  return { headers: {}, method: "GET", path: "/private", ...overrides } as Request;
}

describe("auth boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_MODE = "cloud";
    state.user = { id: "user-1", email: "USER@example.com" };
    state.profile = { mfa_on_login: false };
    state.profileError = null;
    state.assurance = { currentLevel: "aal1", nextLevel: "aal1" };
    state.assuranceError = null;
  });

  it("uses the single account-free identity without opening Supabase", async () => {
    process.env.AUTH_MODE = "local";
    const res = response(), next = vi.fn() as NextFunction;
    await requireAuth(request(), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals).toMatchObject({ userId: "00000000-0000-0000-0000-000000000001" });
    expect(db.auth.getUser).not.toHaveBeenCalled();
  });

  it("rejects an enrolled cloud session until it reaches AAL2", async () => {
    state.profile = { mfa_on_login: true };
    state.assurance = { currentLevel: "aal1", nextLevel: "aal2" };
    const res = response(), next = vi.fn() as NextFunction;
    await requireAuth(request({ headers: { authorization: "Bearer token" } }), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: "mfa_verification_required", detail: "MFA verification required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("does not downgrade login MFA when the enrolled factor disappears", async () => {
    state.profile = { mfa_on_login: true };
    state.assurance = { currentLevel: "aal1", nextLevel: "aal1" };
    const res = response(), next = vi.fn() as NextFunction;
    await requireAuth(request({ headers: { authorization: "Bearer token" } }), res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps GET /profile available as the MFA bootstrap", async () => {
    state.profile = { mfa_on_login: true };
    const res = response(), next = vi.fn() as NextFunction;
    await requireAuth(request({ headers: { authorization: "Bearer token" }, path: "/profile" }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("rejects oversized or whitespace-smuggled bearer values before verification", async () => {
    for (const authorization of [`Bearer ${"a".repeat(8193)}`, "Bearer token extra"]) {
      const res = response(), next = vi.fn() as NextFunction;
      await requireAuth(request({ headers: { authorization } }), res, next);
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    }
    expect(db.auth.getUser).not.toHaveBeenCalled();
  });

  it("fails closed without returning assurance-provider details", async () => {
    state.assuranceError = new Error("service secret abcdefghi");
    const res = response(), next = vi.fn() as NextFunction;
    Object.assign(res.locals, { token: "token", userId: "user-1" });
    await requireMfaIfEnrolled(request(), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ detail: "MFA verification failed" });
    expect(JSON.stringify(res.body)).not.toContain("abcdefghi");
  });

  it("fails closed on an unexpected assurance response", async () => {
    state.assurance = { currentLevel: "aal1", nextLevel: undefined as never };
    const res = response(), next = vi.fn() as NextFunction;
    Object.assign(res.locals, { token: "token", userId: "user-1" });
    await requireMfaIfEnrolled(request(), res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
