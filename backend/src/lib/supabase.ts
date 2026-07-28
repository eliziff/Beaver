import { isServerSupabaseConfigured } from "./localMode";

type CreateClient = typeof import("@supabase/supabase-js").createClient;
let createClient: CreateClient | undefined;

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
  return createClient(url, key, { auth: { persistSession: false } });
}
