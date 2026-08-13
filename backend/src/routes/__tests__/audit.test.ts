import { describe, expect, it } from "vitest";

import { csvCell, escapeLikePattern, parseQuery } from "../audit";

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

  it("escapes title filters and spreadsheet formulas", () => {
    expect(escapeLikePattern("50%_off\\today")).toBe(
      "50\\%\\_off\\\\today",
    );
    expect(csvCell('=HYPERLINK("bad")')).toBe(
      '"\'=HYPERLINK(""bad"")"',
    );
    expect(csvCell("ordinary")).toBe("ordinary");
  });
});
