import type { Request, Response } from "express";
import {
  createServerClient,
  parseCookieHeader,
  serializeCookieHeader,
  type CookieOptions,
} from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";

const WEB_COOKIE = "beaver-session";
const WORD_COOKIE = "beaver-word-session";

function isWordRequest(req: Request) {
  return req.get("x-beaver-surface") === "word";
}

function cookieName(req: Request) {
  const secure = process.env.NODE_ENV === "production" || isWordRequest(req);
  return `${secure ? "__Host-" : ""}${isWordRequest(req) ? WORD_COOKIE : WEB_COOKIE}`;
}

function cookieOptions(req: Request): Pick<
  CookieOptions,
  "httpOnly" | "secure" | "sameSite" | "path" | "partitioned"
> {
  const word = isWordRequest(req);
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || word,
    sameSite: word ? "none" : "lax",
    path: "/",
    partitioned: word || undefined,
  };
}

function appendCookie(
  res: Response,
  name: string,
  value: string,
  options: CookieOptions,
) {
  res.append("Set-Cookie", serializeCookieHeader(name, value, options));
}

function belongsTo(name: string, base: string) {
  return name === base || name.startsWith(`${base}.`) || name.startsWith(`${base}-`);
}

export function clearRequestAuthCookies(req: Request, res: Response) {
  const base = cookieName(req);
  const options = cookieOptions(req);
  for (const { name } of parseCookieHeader(req.headers.cookie ?? "")) {
    if (!belongsTo(name, base)) continue;
    appendCookie(res, name, "", {
      ...options,
      maxAge: 0,
      expires: new Date(0),
    });
  }
  res.setHeader("Cache-Control", "private, no-store");
}

/** One isolated Supabase PKCE/session client per HTTP request. */
export function createRequestSupabase(req: Request, res: Response): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim() || "";
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || "";
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required",
    );
  }
  const options = cookieOptions(req);
  return createServerClient(url, key, {
    cookieOptions: { name: cookieName(req), ...options },
    cookies: {
      getAll: () => parseCookieHeader(req.headers.cookie ?? ""),
      setAll(cookies, responseHeaders) {
        for (const { name, value, options: supplied } of cookies) {
          appendCookie(res, name, value, { ...supplied, ...options });
        }
        for (const [name, value] of Object.entries(responseHeaders)) {
          res.setHeader(name, value);
        }
      },
    },
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });
}

export type PublicAuthUser = {
  id: string;
  email: string;
  pendingEmail: string | null;
  createdWithGoogle: boolean;
};

export function publicAuthUser(user: User): PublicAuthUser {
  return {
    id: user.id,
    email: user.email ?? "",
    pendingEmail: user.new_email ?? null,
    createdWithGoogle: user.app_metadata?.provider === "google",
  };
}
