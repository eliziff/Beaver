import { describe, expect, it } from "vitest";
import { buildCanliiPdfUrl } from "mike/shared/runtime/canliiPageUrls.mjs";

describe("CanLII citation handoff", () => {
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
});
