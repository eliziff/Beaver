export type Page<T> = { items: T[]; next_cursor: string | null };
export type CursorScalar = string | number | boolean | null;
export type CursorFilters = Record<string, CursorScalar>;
type ScalarType = "string" | "number" | "boolean" | "null";

export class PageCursorError extends Error {}

export function pageLimit(value: unknown) {
  if (value === undefined) return 50;
  const limit = typeof value === "string" && /^\d{1,3}$/u.test(value)
    ? Number(value) : 0;
  if (limit < 1 || limit > 200) {
    throw new PageCursorError("limit must be an integer from 1 to 200");
  }
  return limit;
}

export function encodePageCursor(
  resource: string,
  filters: CursorFilters,
  after: CursorScalar[],
) {
  return Buffer.from(JSON.stringify({ v: 1, resource, filters, after }))
    .toString("base64url");
}

export function decodePageCursor(
  value: unknown,
  resource: string,
  filters: CursorFilters,
  shape: readonly ScalarType[],
): CursorScalar[] | null {
  if (value === undefined) return null;
  try {
    if (typeof value !== "string" || !value || value.length > 2_048 ||
        !/^[A-Za-z0-9_-]+$/u.test(value)) throw 0;
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const scalar = (item: unknown) => item === null ||
      ["string", "number", "boolean"].includes(typeof item);
    if (!cursor || Array.isArray(cursor) ||
        Object.keys(cursor).sort().join() !== "after,filters,resource,v" ||
        cursor.v !== 1 || cursor.resource !== resource ||
        !cursor.filters || Array.isArray(cursor.filters) ||
        Object.values(cursor.filters).some((item) => !scalar(item)) ||
        canonical(cursor.filters) !== canonical(filters) ||
        !Array.isArray(cursor.after) || cursor.after.length !== shape.length ||
        cursor.after.some((item: unknown, index: number) =>
          !scalar(item) || (shape[index] === "null" ? item !== null
            : typeof item !== shape[index]))) throw 0;
    return cursor.after as CursorScalar[];
  } catch {
    throw new PageCursorError("invalid cursor");
  }
}

export function pageRequest<T extends CursorScalar[]>(
  query: Record<string, unknown>, resource: string, filters: CursorFilters,
  shape: readonly ScalarType[],
) {
  return { limit: pageLimit(query.limit),
    after: decodePageCursor(query.cursor, resource, filters, shape) as T | null };
}

export function pageResult<T, R>(rows: T[], limit: number,
  map: (row: T) => R, cursor: (row: T) => string) {
  const items = rows.slice(0, limit).map(map);
  return { items, next_cursor: rows.length > limit
    ? cursor(rows[items.length - 1]) : null };
}

const canonical = (value: CursorFilters) => JSON.stringify(
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
);
