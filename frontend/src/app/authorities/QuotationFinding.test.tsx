import { describe, expect, it } from "vitest";
import { quotationAlignment, quotationDiff, readableLocator } from "./QuotationFinding";

describe("quotation comparison presentation", () => {
  it("preserves both original passages and marks only their changed words", () => {
    const before = "The deadline is seven business days.", after = "The deadline is five business days.";
    const result = quotationDiff(before, after);
    expect(result.authored.map(({ text }) => text).join("")).toBe(before);
    expect(result.source.map(({ text }) => text).join("")).toBe(after);
    expect(result.authored.filter(({ changed }) => changed).map(({ text }) => text)).toEqual(["seven"]);
    expect(result.source.filter(({ changed }) => changed).map(({ text }) => text)).toEqual(["five"]);
  });
  it("keeps inserted punctuation, whitespace and deletion-only changes visible", () => {
    const result = quotationDiff("The court did not agree.", "The court agreed!\n");
    expect(result.authored.map(({ text }) => text).join("")).toBe("The court did not agree.");
    expect(result.source.map(({ text }) => text).join("")).toBe("The court agreed!\n");
    expect(result.authored.some(({ text, changed }) => changed && text.includes("not"))).toBe(true);
  });
  it("renders provider paragraph IDs as readable pinpoints", () => {
    expect(readableLocator("paragraph", "par2")).toBe("para 2");
    expect(readableLocator("paragraph", "para 17")).toBe("para 17");
    expect(readableLocator("page", "page 9")).toBe("p 9");
  });
  it("accepts a recognisable passage with a substantive wording difference", () => {
    const alignment = quotationAlignment(
      "The deadline is seven business days.",
      "The deadline is five business days.",
    );
    expect(alignment.credible).toBe(true);
    expect(alignment.coverage).toBeGreaterThan(0.6);
  });
  it("does not turn an unrelated source passage into a quotation mismatch", () => {
    const alignment = quotationAlignment(
      "The deadline is seven business days.",
      "The appeal concerns whether a municipality owed a private law duty of care.",
    );
    expect(alignment.credible).toBe(false);
    expect(alignment.matchedWords).toBeLessThan(3);
  });
  it("is conservative about short quotations", () => {
    expect(quotationAlignment("good faith", "good faith").credible).toBe(true);
    expect(quotationAlignment("good faith", "bad faith").credible).toBe(false);
  });
});
