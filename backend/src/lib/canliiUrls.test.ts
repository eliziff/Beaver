import { describe, expect, it, vi } from "vitest";
import { buildCanliiCaseUrlFromCitation, buildCanliiPdfUrl } from "./canliiUrls";

describe("CanLII citation handoff", () => {
  it("uses the canonical legal-structure parser and court routes", () => {
    expect(buildCanliiCaseUrlFromCitation(["R v Grant, 2009 SCC 32"]))
      .toBe("https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html");
    expect(buildCanliiCaseUrlFromCitation(["2024 BCSC 2224"]))
      .toBe("https://www.canlii.org/en/bc/bcsc/doc/2024/2024bcsc2224/2024bcsc2224.html");
    expect(buildCanliiCaseUrlFromCitation(["2024 FC 123"]))
      .toBe("https://www.canlii.org/en/ca/fct/doc/2024/2024fc123/2024fc123.html");
    expect(buildCanliiCaseUrlFromCitation(["[1997] 1 SCR 241"])).toBeNull();
    expect(buildCanliiCaseUrlFromCitation(["2024 UNKNOWN 1"])).toBeNull();
  });

  it("derives only a same-slug PDF sibling from a canonical CanLII page", () => {
    expect(buildCanliiPdfUrl(
      "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html",
    )).toBe("https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf");
    expect(buildCanliiPdfUrl(
      "https://www.canlii.org/en/ukjcpc/doc/2024/2024ukjcpc1/2024ukjcpc1.html",
    )).toBe("https://www.canlii.org/en/ukjcpc/doc/2024/2024ukjcpc1/2024ukjcpc1.pdf");
    for (const unsafe of [
      "http://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html",
      "https://canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html",
      "https://www.canlii.org.evil.test/en/ca/scc/doc/2009/2009scc32/2009scc32.html",
      "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/other.html",
      "https://www.canlii.org/en/ca/scc/doc/2009/other/other.html",
      "https://www.canlii.org/en/ca/court/extra/doc/2009/2009scc32/2009scc32.html",
      "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html?download=1",
    ]) expect(buildCanliiPdfUrl(unsafe)).toBeNull();
  });

  it("constructs the manual handoff without making a CanLII request", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("CanLII requests are forbidden"));
    try {
      const page = buildCanliiCaseUrlFromCitation(["R v Grant, 2009 SCC 32"]);
      expect(page && buildCanliiPdfUrl(page))
        .toBe("https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf");
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
