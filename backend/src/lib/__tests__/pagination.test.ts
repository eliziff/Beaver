import { describe, expect, it } from "vitest";
import {
  pageRequest,
  pageResponse,
  PageCursorError,
} from "../pagination";

describe("pagination", () => {
  it("round-trips a resource-bound cursor with normalized filters", () => {
    const cursor = pageResponse(
      "projects",
      { scope: "mine", q: "lease" },
      { items: [], nextAfter: ["2026-08-12T10:00:00.000Z", "project-2"] },
    ).next_cursor;

    expect(
      pageRequest(
        { cursor },
        "projects",
        { q: "lease", scope: "mine" },
        ["string", "string"],
      ).after,
    ).toEqual(["2026-08-12T10:00:00.000Z", "project-2"]);
  });

  it.each([
    ["wrong resource", "workflows", { q: "lease", scope: "mine" }],
    ["changed filter", "projects", { q: "other", scope: "mine" }],
  ])("rejects a cursor with %s", (_label, resource, filters) => {
    const cursor = pageResponse(
      "projects",
      { q: "lease", scope: "mine" },
      { items: [], nextAfter: ["2026-08-12T10:00:00.000Z", "project-2"] },
    ).next_cursor;
    expect(() =>
      pageRequest({ cursor }, resource, filters, ["string", "string"]),
    ).toThrow(PageCursorError);
  });

  it.each([
    "not base64!",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1 })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        v: 1,
        resource: "projects",
        filters: {},
        after: ["one"],
        extra: true,
      }),
    ).toString("base64url"),
  ])("rejects malformed cursor %s", (cursor) => {
    expect(() =>
      pageRequest({ cursor }, "projects", {}, ["string", "string"]),
    ).toThrow(PageCursorError);
  });

  it("rejects a cursor with the wrong tuple shape", () => {
    const cursor = pageResponse(
      "projects", {}, { items: [], nextAfter: [1, "project-2"] },
    ).next_cursor;
    expect(() =>
      pageRequest({ cursor }, "projects", {}, ["string", "string"]),
    ).toThrow(PageCursorError);
  });

  it("parses bounded limits", () => {
    const limit = (value: unknown) => pageRequest(
      { limit: value }, "test", {}, [],
    ).limit;
    expect(limit(undefined)).toBe(50);
    expect(limit("1")).toBe(1);
    expect(limit("200")).toBe(200);
    for (const invalid of ["0", "201", "2.5", "x", ["20"]]) {
      expect(() => limit(invalid)).toThrow(PageCursorError);
    }
  });
});
