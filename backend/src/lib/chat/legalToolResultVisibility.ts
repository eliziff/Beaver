function isLegalSourceTool(name: string) {
  return name === "search_sources" ||
    name === "note_up" ||
    /^(?:a2aj|courtlistener|public_legal_source|hansard)_/u.test(name);
}

function withoutUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUrls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      /(?:^|_)(?:url|uri|href)$/iu.test(key)
        ? []
        : [[key, withoutUrls(item)]],
    ),
  );
}

/** Provider URLs stay in host evidence state; models receive source identity and text only. */
export function hideLegalSourceUrls(
  toolName: string,
  value: unknown,
) {
  return isLegalSourceTool(toolName) ? withoutUrls(value) : value;
}
