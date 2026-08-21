import { isServerSupabaseConfigured } from "./localMode";
import type { SupabaseClient } from "@supabase/supabase-js";

type CreateClient = typeof import("@supabase/supabase-js").createClient;
let createClient: CreateClient | undefined;
let serverClient: SupabaseClient<any, "public", any> | undefined;
const REQUEST_TIMEOUT_MS = 30_000;

const timedFetch: typeof fetch = (input, init) => fetch(input, {
  ...init,
  signal: AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    init?.signal,
    input instanceof Request ? input.signal : undefined,
  ].filter((signal): signal is AbortSignal => Boolean(signal))),
});

/**
 * Server-side Supabase client using the service role key.
 * Bypasses RLS — only use in API routes after verifying the user.
 */
export function createServerSupabase() {
  const url = process.env.SUPABASE_URL?.trim() || "";
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || "";
  if (!isServerSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured; set SUPABASE_URL and SUPABASE_SECRET_KEY",
    );
  }
  createClient ??=
    (require("@supabase/supabase-js") as { createClient: CreateClient })
      .createClient;
  return serverClient ??= createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { timeout: REQUEST_TIMEOUT_MS },
    global: { fetch: timedFetch },
  });
}
