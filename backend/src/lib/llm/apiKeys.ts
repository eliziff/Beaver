/** Shared key resolution for every provider adapter: user override, then env. */
export function requireApiKey(
  override: string | null | undefined,
  envNames: string[],
  label: string,
): string {
  const key =
    override?.trim() ||
    envNames.map((name) => process.env[name]?.trim()).find(Boolean) ||
    "";
  if (!key) {
    throw new Error(
      `${label} API key is not configured. Set ${envNames[0]} or add a user ${label} key.`,
    );
  }
  return key;
}
