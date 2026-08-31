const MAX_URL_LENGTH = 8_192;

export function safeAssistantUrl(
  value: unknown,
  { relative = true }: { relative?: boolean } = {},
): string | null {
  const raw = typeof value === "string" ? value.trim().slice(0, MAX_URL_LENGTH) : "";
  if (!raw || raw.includes("\\") ||
      Array.from(raw).some((character) => character.charCodeAt(0) <= 0x1f)) return null;
  if (relative && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
