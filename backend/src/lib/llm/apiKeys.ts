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
