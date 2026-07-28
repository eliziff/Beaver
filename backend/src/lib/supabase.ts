import { createClient } from "@supabase/supabase-js";
import { isServerSupabaseConfigured } from "./localMode";

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
  return createClient(url, key, { auth: { persistSession: false } });
}
