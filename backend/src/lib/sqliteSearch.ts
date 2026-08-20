export function sqliteText(row: Record<string, unknown>, field: string) {
  const value = row[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function searchTokens(query: string) {
  return query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
}

export const boundedSize = (value: number | undefined, fallback: number, maximum: number) =>
  Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
