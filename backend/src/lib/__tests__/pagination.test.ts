import { describe, expect, it } from "vitest";
import { pageRequest, pageResponse, PageCursorError, type CursorFilters } from "../pagination";

const filters = { scope: "mine", q: "lease" };
const after = Object.freeze(["2026-08-12T10:00:00.000Z", "project-2"]);
const cursor = pageResponse("projects", filters, { items: [], nextAfter: after }).next_cursor;
const read = (value: unknown, resource = "projects", scope: CursorFilters = filters) =>
  pageRequest({ cursor: value }, resource, scope, ["string", "string"]);

describe("pagination", () => {
  it("round-trips a resource-bound cursor with normalized filters", () => {
    expect(read(cursor, "projects", { q: "lease", scope: "mine" })).toEqual({ limit: 50, after });
    expect(pageResponse("projects", filters, { items: [{ id: "project-2" }], nextAfter: null }))
      .toEqual({ items: [{ id: "project-2" }], next_cursor: null });
  });

  it.each([
    ["wrong resource", "workflows", { q: "lease", scope: "mine" }],
    ["changed filter", "projects", { q: "other", scope: "mine" }],
  ])("rejects a cursor with %s", (_label, resource, scope) => {
    expect(() => read(cursor, resource, scope)).toThrow(PageCursorError);
  });

  it.each([
    "not base64!",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1 })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, resource: "projects", filters: {}, after: ["one"], extra: true }))
      .toString("base64url"),
  ])("rejects malformed cursor %s", (value) => {
    expect(() => read(value, "projects", {})).toThrow(PageCursorError);
  });

  it("rejects a cursor with the wrong tuple shape", () => {
    const wrong = pageResponse("projects", filters, { items: [], nextAfter: [1, "project-2"] }).next_cursor;
    expect(() => read(wrong)).toThrow(PageCursorError);
  });

  it("parses bounded limits", () => {
    const request = (limit: unknown) => pageRequest({ limit }, "test", {}, []);
    expect(request(undefined)).toEqual({ limit: 50, after: null });
    expect(request("1")).toEqual({ limit: 1, after: null });
    expect(request("200")).toEqual({ limit: 200, after: null });
    for (const invalid of ["0", "201", "2.5", "x", ["20"]]) {
      expect(() => request(invalid)).toThrow(PageCursorError);
    }
  });
});
