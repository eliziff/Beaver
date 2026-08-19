export function isServerSupabaseConfigured() {
  const url = process.env.SUPABASE_URL?.trim() || "";
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || "";
  return Boolean(
    url &&
      key &&
      !/your-project\.supabase\.co/i.test(url) &&
      key !== "your-supabase-service-role-key",
  );
}

export function isLocalRuntime() {
  const mode = process.env.AUTH_MODE?.trim();
  if (mode === "local") return true;
  if (mode === "cloud") return false;
  throw new Error("AUTH_MODE must be either local or cloud");
}
