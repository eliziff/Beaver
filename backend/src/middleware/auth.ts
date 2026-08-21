import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isLocalRuntime } from "../lib/localMode";
import { createServerSupabase } from "../lib/supabase";
import { safeErrorLog } from "../lib/safeError";

const LOCAL_USER_ID = process.env.LOCAL_USER_ID?.trim() ||
  "00000000-0000-0000-0000-000000000001";
const rejectMfa = (res: Response) => res.status(403).json({
  code: "mfa_verification_required", detail: "MFA verification required",
});

function bearer(req: Request) {
  return req.headers.authorization
    ?.match(/^Bearer ([A-Za-z0-9._~+/-]{1,8192}=*)$/iu)?.[1] ?? null;
}

async function satisfiesMfa(db: SupabaseClient, token: string, optional: boolean) {
  const { data, error } = await db.auth.mfa.getAuthenticatorAssuranceLevel(token);
  if (error) throw error;
  return data.currentLevel === "aal2" ||
    (optional && (data.currentLevel === "aal1" || data.currentLevel === null) &&
      data.nextLevel === "aal1");
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isLocalRuntime()) {
    Object.assign(res.locals, { userId: LOCAL_USER_ID, userEmail: "", token: "" });
    return void next();
  }
  const token = bearer(req);
  if (!token) {
    return void res.status(401).json({ detail: "Missing or invalid Authorization header" });
  }
  try {
    const db = createServerSupabase();
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) {
      return void res.status(401).json({ detail: "Invalid or expired token" });
    }
    const email = data.user.email?.trim().toLowerCase() || "";
    Object.assign(res.locals, { userId: data.user.id, userEmail: email, token });
    const { syncProfileIdentity } = await import("../lib/userLookup");
    const mfaOnLogin = await syncProfileIdentity(db, data.user.id, email);
    const bootstrap = req.method === "GET" && req.path === "/profile";
    if (!bootstrap && mfaOnLogin && !(await satisfiesMfa(db, token, false)))
      return void rejectMfa(res);
    next();
  } catch (error) {
    console.error("[auth] verification failed", safeErrorLog(error));
    res.status(500).json({ detail: "Authentication service unavailable" });
  }
}

export async function requireMfaIfEnrolled(
  _req: Request, res: Response, next: NextFunction,
) {
  if (isLocalRuntime()) return void next();
  const token = typeof res.locals.token === "string" ? res.locals.token : "";
  if (!token) return void res.status(401).json({ detail: "Missing auth session" });
  try {
    if (!(await satisfiesMfa(createServerSupabase(), token, true))) return void rejectMfa(res);
    next();
  } catch (error) {
    console.error("[auth] MFA verification failed", {
      userId: res.locals.userId, ...safeErrorLog(error),
    });
    res.status(401).json({ detail: "MFA verification failed" });
  }
}
