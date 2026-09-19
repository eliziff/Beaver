/** Shared key resolution for every provider adapter: user override, then env. */
export function requireApiKey(
  override: string | null | undefined,
  envName: string,
  label: string,
): string {
  const key = override?.trim() || process.env[envName]?.trim();
  if (!key) {
    throw new Error(
      `${label} API key is not configured. Set ${envName} or add a user ${label} key.`,
    );
  }
  return key;
}

/** Classify provider failures without displaying their response body or key. */
export function apiKeyError(error: unknown, provider: string): unknown {
  if (!error || typeof error !== "object") return error;
  const row = error as { statusCode?: unknown; message?: unknown; responseBody?: unknown };
  const detail = [row.message, row.responseBody].filter((value): value is string => typeof value === "string")
    .map((value) => value.slice(0, 8192)).join(" ");
  if (row.statusCode !== 401 && !([400, 403].includes(Number(row.statusCode)) &&
      /api[ _-]?key[^."]*\b(?:not valid|invalid|incorrect|expired)|invalid[ _-]?(?:x-)?api[ _-]?key|api_key_invalid|incorrect api key|authentication_error/iu.test(detail))) return error;
  return new Error(`The ${provider} API key was rejected. Check your key in Settings, or contact the administrator if you use the server's key.`);
}
