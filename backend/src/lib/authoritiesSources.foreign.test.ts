import { describe, expect, it, vi } from "vitest";
import { authoritySourceServices } from "./authoritiesSourceResolution";

describe("case sources outside the Canadian corpus", () => {
  it("refuses citations no provider claims without reaching the network", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network forbidden"));
    try {
      for (const citation of ["2023 SCC 14", "[1989] 1 SCR 927", "[2007] HCA 60",
        "[2001] 2 AC 127", "[1962] 3 All ER 380", "(1996), 72 OR",
        "21 November 2016", "(2011) 19 Torts LJ 1"]) {
        expect(await authoritySourceServices.resolveForeign([citation])).toBeNull();
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it("refuses a US reporter citation the local bulk index cannot match", async () => {
    expect(await authoritySourceServices.resolveForeign(["9999 U.S. 99999"])).toBeNull();
  });
});
