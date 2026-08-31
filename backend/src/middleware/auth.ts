import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isLocalRuntime } from "../lib/localMode";
import { safeErrorLog } from "../lib/safeError";

const LOCAL_USER_ID = process.env.LOCAL_USER_ID?.trim() ||
  "00000000-0000-0000-0000-000000000001";
const loadCloudAuth = () => Promise.all([
  import("../lib/authSession"), import("../lib/supabase"), import("../lib/userLookup"),
]);
const eagerCloudAuth = process.env.AUTH_MODE?.trim() === "cloud"
  ? loadCloudAuth() : null;
const rejectMfa = (res: Response) => res.status(403).json({
  code: "mfa_verification_required", detail: "MFA verification required",
});

function bearer(req: Request) {
  return req.headers.authorization
    ?.match(/^Bearer ([A-Za-z0-9._~+/-]{1,8192}=*)$/iu)?.[1] ?? null;
}

async function satisfiesMfa(db: SupabaseClient, token: string | null, optional: boolean) {
  const { data, error } = token
    ? await db.auth.mfa.getAuthenticatorAssuranceLevel(token)
    : await db.auth.mfa.getAuthenticatorAssuranceLevel();
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
  try {
    const token = bearer(req);
    if (req.headers.authorization && !token) {
      return void res.status(401).json({ detail: "Authentication required" });
    }
    const [{ createRequestSupabase }, { createServerSupabase },
      { syncProfileIdentity }] = await (eagerCloudAuth ?? loadCloudAuth());
    const authClient = token ? createServerSupabase() : createRequestSupabase(req, res);
    const { data, error } = token
      ? await authClient.auth.getUser(token)
      : await authClient.auth.getUser();
    if (error || !data.user) {
      return void res.status(401).json({ detail: "Authentication required" });
    }
    const email = data.user.email?.trim().toLowerCase() || "";
    Object.assign(res.locals, {
      userId: data.user.id,
      userEmail: email,
      token: token ?? "",
      authClient,
      authSource: token ? "bearer" : "cookie",
    });
    const db = createServerSupabase();
    const mfaOnLogin = await syncProfileIdentity(db, data.user.id, email);
    const bootstrap = req.method === "GET" && req.path === "/profile";
    if (!bootstrap && mfaOnLogin && !(await satisfiesMfa(authClient, token, false)))
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
  const token = typeof res.locals.token === "string" && res.locals.token
    ? res.locals.token : null;
  const client = res.locals.authClient as SupabaseClient | undefined;
  if (!client) return void res.status(401).json({ detail: "Missing auth session" });
  try {
    if (!(await satisfiesMfa(client, token, true))) return void rejectMfa(res);
    next();
  } catch (error) {
    console.error("[auth] MFA verification failed", {
      userId: res.locals.userId, ...safeErrorLog(error),
    });
    res.status(401).json({ detail: "MFA verification failed" });
  }
}
