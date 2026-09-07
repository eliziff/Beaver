import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import type { GroundedEvidence } from "@/app/lib/groundedAnswers";
import { TabularResultDetails } from "./TabularResultDetails";
const receipt: GroundedEvidence = { evidence_id: "e1", provider: "library", stable_source_id: "original",
  version: "pinned-version", source_sha256: "a".repeat(64), span_sha256: "b".repeat(64), block_id: "page:3",
  span_text: "The contract requires notice.", citation: "Agreement", name: "Agreement.pdf", external_url: null,
  locator: { kind: "page", label: "3" } };
const answer: NonNullable<TabularCell["content"]> = { value: true, summary: "Yes", reasoning: "Notice is required.",
  claims: [{ text: "Notice is required.", evidence_ids: ["e1", "e1"] }, { text: "The term is express.", evidence_ids: ["e1"] }],
  evidence: [receipt, { ...receipt, evidence_id: "read-only", span_text: "Background read, not supporting this answer." }],
  outcome: "answered", coverage: "partial", query_ids: ["query-1"] };
const column: ColumnConfig = { index: 0, name: "Notice", prompt: "Compare notice requirements." };
describe("tabular result inspection", () => {
  it("shows each supporting passage once, separate from explanation and background receipts", () => {
    const open = vi.fn(); render(<TabularResultDetails answer={answer} column={column} onCitation={open} />);
    const evidence = screen.getByRole("region", { name: "Evidence" });
    expect(within(evidence).getAllByRole("button")).toHaveLength(1);
    expect(within(evidence).getByText(receipt.span_text!)).toBeVisible();
    expect(within(evidence).queryByText(/Background read/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Notice is required.")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Partial coverage");
    fireEvent.click(within(evidence).getByRole("button"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "document", document_id: "original", version_id: "pinned-version", quotes: [{ quote: receipt.span_text, page: "3" }] }));
    expect(screen.getByText(column.prompt)).not.toBeVisible();
    fireEvent.click(screen.getByText("More details")); expect(screen.getByText(column.prompt)).toBeVisible();
    expect(screen.getByText(/"query-1"/)).toBeVisible();
  });
  it("does not repeat the answer as explanation and explicitly reports missing backing evidence", () => {
    render(<TabularResultDetails answer={{ ...answer, summary: "Notice is required.", claims: [{ text: "Notice is required.", evidence_ids: ["missing"] }] }} column={column} onCitation={vi.fn()} />);
    expect(screen.getAllByText("Notice is required.")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Explanation" })).not.toBeInTheDocument();
    expect(screen.getByText("Supporting passage 1 is unavailable.")).toBeVisible();
  });
  it("keeps distinct pinpointed passages from the same source independently openable", () => {
    const other = { ...receipt, evidence_id: "e2", span_text: "The exception applies to cause.", locator: { kind: "page", label: "4" } }, open = vi.fn();
    render(<TabularResultDetails answer={{ ...answer, claims: [{ text: "Notice subject to an exception.", evidence_ids: ["e1", "e2"] }], evidence: [receipt, other] }} column={column} onCitation={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Open passage 2: Agreement.pdf" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ ref: 2, locator: "4", quotes: [{ quote: other.span_text, page: "4" }] }));
  });
});
