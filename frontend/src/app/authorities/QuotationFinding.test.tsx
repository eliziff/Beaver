import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { QuotationReview } from "./QuotationFinding";
import type { AuthoritiesDiscrepancy } from "./types";
import { describe, expect, it } from "vitest";
import { quotationDiff, readableLocator } from "./QuotationFinding";

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
});

const finding = (id: string): AuthoritiesDiscrepancy => ({ id, kind: "quote_mismatch",
  actions: ["ignore", "quote_exact", "quote_editorial"], occurrenceId: id, authorityId: "case",
  footnoteId: 1, citation: "2024 SCC 1", proposition: "A quoted rule.", authoredQuote: "The deadline is seven business days.",
  authoredPinpoint: { kind: "paragraph", text: "7" },
  cited: { locator: { kind: "paragraph", label: "7" }, text: "The deadline is five business days." },
  found: { locator: { kind: "paragraph", label: "7" }, text: "The deadline is five business days." } });
it("keeps one dialog through correction, recheck, next finding, completion and explicit close", () => {
  const close = vi.fn(), resolve = vi.fn((_finding, _action, done) => done());
  const props = { initialId: "one", onClose: close, onResolve: resolve };
  const { rerender } = render(<QuotationReview {...props} items={[finding("one"), finding("two")]} busy={false} />);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(screen.getByRole("radio", { name: "Use the source wording" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
  expect(close).not.toHaveBeenCalled();
  rerender(<QuotationReview {...props} items={undefined} busy />);
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(screen.getByRole("status")).toHaveTextContent("Rechecking");
  rerender(<QuotationReview {...props} items={[finding("two")]} busy={false} />);
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(screen.getByRole("button", { name: "Apply correction" })).toBeDisabled();
  rerender(<QuotationReview {...props} items={[]} busy={false} />);
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(screen.getByRole("status")).toHaveTextContent("No quotations left");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(close).toHaveBeenCalledOnce();
});
it("does not render a false red/green mismatch or offer corrections for an unlocated quotation", () => {
  const missing = { ...finding("one"), kind: "quote_unlocated" as const, found: null, actions: ["ignore" as const] };
  const { container } = render(<QuotationReview initialId="one" items={[missing]} busy={false} onResolve={vi.fn()} onClose={vi.fn()} />);
  expect(container.querySelector("del, ins")).toBeNull();
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  expect(screen.getByRole("radio", { name: "Keep as written" })).toBeVisible();
});
it("surfaces a failed save without discarding the choice or closing the review", () => {
  const props = { initialId: "one", items: [finding("one")], busy: false, onResolve: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<QuotationReview {...props} />);
  fireEvent.click(screen.getByRole("radio", { name: "Use the source wording" }));
  rerender(<QuotationReview {...props} error="The draft changed. Refresh first." />);
  expect(screen.getByRole("alert")).toHaveTextContent("Refresh first");
  expect(screen.getByRole("radio", { name: "Use the source wording" })).toBeChecked();
});
