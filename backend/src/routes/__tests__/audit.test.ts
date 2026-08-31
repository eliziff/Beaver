import { describe, expect, it } from "vitest";

import { csvCell, parseQuery } from "../audit";

describe("audit query helpers", () => {
  it("clamps pages and rejects invalid dates and sort fields", () => {
    expect(parseQuery({ page: "0" }, 50)).toMatchObject({
      ok: true,
      query: { page: 1 },
    });
    expect(parseQuery({ page: "999999999" }, 50)).toMatchObject({
      ok: true,
      query: { page: 100_000 },
    });
    expect(parseQuery({ from: "yesterday" }, 50).ok).toBe(false);
    expect(parseQuery({ sort_by: "action" }, 50).ok).toBe(false);
  });

  it("escapes spreadsheet formulas", () => {
    expect(csvCell('=HYPERLINK("bad")')).toBe(
      '"\'=HYPERLINK(""bad"")"',
    );
    expect(csvCell("  =1+1")).toBe("'  =1+1");
    expect(csvCell("ordinary")).toBe("ordinary");
  });
});
