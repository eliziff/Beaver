import { expect, it } from "vitest";
import { normalizeQuoteText, strippedToOriginal } from "./quoteText";

it("normalizes quote text while preserving source offsets", () => {
    expect(normalizeQuoteText("A-b 2")).toBe("ab2");
    expect(strippedToOriginal("A-b 2", 2)).toBe(4);
    expect(strippedToOriginal("A-b 2", 3)).toBe(5);
});
