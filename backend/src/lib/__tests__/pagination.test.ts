import { describe, expect, it } from "vitest";
import {
  decodePageCursor,
  encodePageCursor,
  pageLimit,
  PageCursorError,
} from "../pagination";

describe("pagination", () => {
  it("round-trips a resource-bound cursor with normalized filters", () => {
    const cursor = encodePageCursor(
      "projects",
      { scope: "mine", q: "lease" },
      ["2026-08-12T10:00:00.000Z", "project-2"],
    );

    expect(
      decodePageCursor(
        cursor,
        "projects",
        { q: "lease", scope: "mine" },
        ["string", "string"],
      ),
    ).toEqual(["2026-08-12T10:00:00.000Z", "project-2"]);
  });

  it.each([
    ["wrong resource", "workflows", { q: "lease", scope: "mine" }],
    ["changed filter", "projects", { q: "other", scope: "mine" }],
  ])("rejects a cursor with %s", (_label, resource, filters) => {
    const cursor = encodePageCursor(
      "projects",
      { q: "lease", scope: "mine" },
      ["2026-08-12T10:00:00.000Z", "project-2"],
    );
    expect(() =>
      decodePageCursor(cursor, resource, filters, ["string", "string"]),
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
      decodePageCursor(cursor, "projects", {}, ["string", "string"]),
    ).toThrow(PageCursorError);
  });

  it("rejects a cursor with the wrong tuple shape", () => {
    const cursor = encodePageCursor("projects", {}, [1, "project-2"]);
    expect(() =>
      decodePageCursor(cursor, "projects", {}, ["string", "string"]),
    ).toThrow(PageCursorError);
  });

  it("parses bounded limits", () => {
    expect(pageLimit(undefined)).toBe(50);
    expect(pageLimit("1")).toBe(1);
    expect(pageLimit("200")).toBe(200);
    for (const invalid of ["0", "201", "2.5", "x", ["20"]]) {
      expect(() => pageLimit(invalid)).toThrow(PageCursorError);
    }
  });
});
