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

export function isAnonymousLocalMode() {
  return (
    process.env.NODE_ENV !== "test" &&
    process.env.AUTH_MODE === "anonymous" &&
    !isServerSupabaseConfigured()
  );
}
