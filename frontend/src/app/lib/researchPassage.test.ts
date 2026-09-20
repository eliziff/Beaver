import { describe, expect, it } from "vitest";
import { passageLabel } from "./researchPassage";

describe("passageLabel", () => {
  it("uses one canonical presentation for document-level fallback locators", () => {
    expect(passageLabel({ kind: "document", label: "characters 2445–3061" }))
      .toBe("line 2445–3061");
    expect(passageLabel({ kind: "document", label: "lines 5–21" })).toBe("line 5–21");
    expect(passageLabel({ kind: "paragraph", label: "characters 5–21" })).toBe("¶ characters 5–21");
  });
});
