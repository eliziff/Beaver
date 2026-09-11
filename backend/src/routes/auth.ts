import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { textField } from "../lib/textField";
import { clearRequestAuthCookies, createRequestSupabase,
  publicAuthUser } from "../lib/authSession";
import { safeErrorLog } from "../lib/safeError";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/trustedOrigin";

const authRouter = Router();
authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

export function createAuthRouter(expectedOrigin: string) {
  const router = Router();
  router.use(requireTrustedOrigin(expectedOrigin), authRouter);
  return router;
}

const credentials = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(4_096),
}).strict();
const signupCredentials = credentials.extend({
  displayName: z.string().trim().max(160).optional(),
  organisation: z.string().trim().max(240).optional(),
  next: z.string().max(2_048).optional(),
}).strict();
const password = z.object({
  password: z.string().min(12).max(4_096),
  signOut: z.boolean().optional(),
}).strict();
const recovery = z.object({
  email: z.string().trim().email().max(320),
  next: z.string().max(2_048).optional(),
}).strict();
const factor = z.object({ factorId: z.string().uuid() }).strict();
const verification = factor.extend({
  code: z.string().trim().regex(/^\d{6}$/u),
  challengeId: z.string().uuid().optional(),
}).strict();

function invalid(res: Response) {
  res.status(400).json({ code: "invalid_request", detail: "Invalid authentication request." });
}

function safeNext(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.startsWith("/") ||
      value.startsWith("//") || value.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(value)) return fallback;
  return value;
}

function callbackUrl(req: Request, next: unknown, fallback: string) {
  const url = new URL("/auth/callback", new URL(req.get("origin") as string).origin);
  url.searchParams.set("next", safeNext(next, fallback));
  if (req.get("x-beaver-surface") === "word") url.searchParams.set("surface", "word");
  return url.toString();
}

function authError(res: Response, error: unknown,
  fallback = "Authentication could not be completed.") {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof candidate?.status === "number" ? candidate.status : 500;
  if (status < 400 || status >= 500) {
    console.error("[auth] request failed", safeErrorLog(error));
    return void res.status(500).json({ code: null, detail: fallback });
  }
  res.status(status).json({
    code: typeof candidate.code === "string" ? candidate.code : null,
    detail: typeof candidate.message === "string" && candidate.message
      ? candidate.message : fallback,
  });
}

function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => void handler(req, res).catch((error) =>
    authError(res, error));
}

/**
 * Every MFA route has the same shape: validate the request, require the
 * browser's own session, call Supabase and return its payload unchanged.
 */
const mfaRoute = <T, D>(
  read: (req: Request) => T | null,
  call: (mfa: ReturnType<typeof createRequestSupabase>["auth"]["mfa"],
    value: T) => Promise<{ data: D; error: unknown }>,
  status = 200,
) => route(async (req, res) => {
  const value = read(req);
  if (value === null) return invalid(res);
  const client = cookieClient(res);
  if (!client) return;
  const { data, error } = await call(client.auth.mfa, value);
  if (error) return authError(res, error);
  res.status(status).json(data);
});

function cookieClient(res: Response): ReturnType<typeof createRequestSupabase> | null {
  const client = res.locals.authClient as
    ReturnType<typeof createRequestSupabase> | undefined;
  if (client && res.locals.authSource === "cookie") return client;
  res.status(401)
    .json({ code: "cookie_session_required", detail: "A browser session is required." });
  return null;
}

authRouter.post("/login", route(async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) return invalid(res);
  const { data, error } = await createRequestSupabase(req, res)
    .auth.signInWithPassword(parsed.data);
  if (error || !data.user || !data.session) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.post("/signup", route(async (req, res) => {
  const parsed = signupCredentials.safeParse(req.body);
  if (!parsed.success || parsed.data.password.length < 12) return invalid(res);
  const { email, password: selectedPassword, displayName, organisation, next } = parsed.data;
  const { data, error } = await createRequestSupabase(req, res).auth.signUp({
    email,
    password: selectedPassword,
    options: {
      emailRedirectTo: callbackUrl(req, next, "/onboarding"),
      data: { ...(displayName ? { display_name: displayName } : {}),
        ...(organisation ? { organisation } : {}) },
    },
  });
  if (error || !data.user) return authError(res, error);
  res.status(201)
    .json({ user: publicAuthUser(data.user), requiresEmailConfirmation: !data.session });
}));

authRouter.post("/oauth", route(async (req, res) => {
  if (req.body?.provider !== "google") return invalid(res);
  const { data, error } = await createRequestSupabase(req, res).auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(req, req.body?.next, "/onboarding"),
      skipBrowserRedirect: true },
  });
  if (error || !data.url) return authError(res, error);
  res.json({ url: data.url });
}));

authRouter.post("/exchange", route(async (req, res) => {
  const code = textField(4_096).safeParse(req.body?.code);
  if (!code.success) return invalid(res);
  const { data, error } = await createRequestSupabase(req, res)
    .auth.exchangeCodeForSession(code.data);
  if (error || !data.user || !data.session) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.post("/password-reset", route(async (req, res) => {
  const parsed = recovery.safeParse(req.body);
  if (parsed.success) {
    try {
      const next = safeNext(parsed.data.next, "/assistant");
      const reset = `/reset-password?next=${encodeURIComponent(next)}` +
        (req.get("x-beaver-surface") === "word" ? "&surface=word" : "");
      await createRequestSupabase(req, res).auth.resetPasswordForEmail(parsed.data.email,
        { redirectTo: callbackUrl(req, reset, "/reset-password") });
    } catch {
      // Password recovery never reveals whether an account exists.
    }
  }
  res.status(204).end();
}));

authRouter.get("/session", requireAuth, route(async (_req, res) => {
  const client = cookieClient(res);
  if (!client) return;
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw error ?? new Error("Authentication session missing");
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.post("/logout", route(async (req, res) => {
  try {
    await createRequestSupabase(req, res)
      .auth.signOut({ scope: req.body?.scope === "global" ? "global" : "local" });
  } catch (error) {
    console.error("[auth/logout] upstream sign-out failed", safeErrorLog(error));
  } finally {
    clearRequestAuthCookies(req, res);
  }
  res.status(204).end();
}));

authRouter.patch("/email", requireAuth, requireMfaIfEnrolled, route(async (req, res) => {
  const parsed = z.string().trim().email().max(320).safeParse(req.body?.email);
  if (!parsed.success) return invalid(res);
  const client = cookieClient(res);
  if (!client) return;
  const { data, error } = await client.auth.updateUser({ email: parsed.data },
    { emailRedirectTo: callbackUrl(req, req.body?.next, "/account") });
  if (error || !data.user) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.patch("/password", requireAuth, requireMfaIfEnrolled, route(async (req, res) => {
  const parsed = password.safeParse(req.body);
  if (!parsed.success) return invalid(res);
  const client = cookieClient(res);
  if (!client) return;
  const { data, error } = await client.auth.updateUser({ password: parsed.data.password });
  if (error || !data.user) return authError(res, error);
  if (parsed.data.signOut) {
    await client.auth.signOut({ scope: "global" });
    clearRequestAuthCookies(req, res);
  }
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.get("/mfa/factors", requireAuth,
  mfaRoute(() => true, (mfa) => mfa.listFactors()));

authRouter.get("/mfa/assurance", requireAuth,
  mfaRoute(() => true, (mfa) => mfa.getAuthenticatorAssuranceLevel()));

authRouter.post("/mfa/enroll", requireAuth, mfaRoute(
  (req) => textField(100).safeParse(req.body?.friendlyName).data ?? null,
  (mfa, friendlyName) => mfa.enroll({ factorType: "totp", friendlyName }), 201));

authRouter.post("/mfa/challenge", requireAuth, mfaRoute(
  (req) => factor.safeParse(req.body).data ?? null, (mfa, value) => mfa.challenge(value)));

authRouter.post("/mfa/verify", requireAuth, mfaRoute(
  (req) => {
    const parsed = verification.safeParse(req.body);
    return parsed.success && parsed.data.challengeId
      ? { factorId: parsed.data.factorId, challengeId: parsed.data.challengeId,
        code: parsed.data.code } : null;
  },
  (mfa, value) => mfa.verify(value)));

authRouter.post("/mfa/challenge-and-verify", requireAuth, mfaRoute(
  (req) => verification.safeParse(req.body).data ?? null,
  (mfa, { factorId, code }) => mfa.challengeAndVerify({ factorId, code })));

authRouter.delete("/mfa/factors/:factorId", requireAuth, mfaRoute(
  (req) => factor.safeParse({ factorId: req.params.factorId }).data ?? null,
  (mfa, value) => mfa.unenroll(value)));
