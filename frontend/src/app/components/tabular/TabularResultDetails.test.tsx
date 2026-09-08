import { fireEvent, render, screen } from "@testing-library/react";
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
  it("cites each supporting passage once as a pill and never repeats its bibliography or raw receipts", () => {
    const open = vi.fn(); render(<TabularResultDetails answer={answer} column={column} onCitation={open} />);
    const pills = screen.getAllByRole("link", { name: /Agreement/ });
    expect(new Set(pills.map((pill) => pill.dataset.citationRef))).toEqual(new Set(["1"]));
    expect(screen.queryByText(receipt.span_text!)).not.toBeInTheDocument();
    expect(screen.queryByText(/Background read/)).not.toBeInTheDocument();
    expect(screen.queryByText("More details")).not.toBeInTheDocument();
    expect(screen.queryByText(column.prompt)).not.toBeInTheDocument();
    expect(screen.queryByText(/query-1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/[Pp]artial coverage/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Notice is required\./u)).toHaveLength(1);
    expect(pills[0]).toHaveAttribute("target", "_blank");
    fireEvent.click(screen.getAllByRole("button", { name: "Citation actions" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in reader" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "document", document_id: "original",
      version_id: "pinned-version", quotes: [{ quote: receipt.span_text, page: "3" }] }));
  });
  it("does not repeat the answer as explanation", () => {
    render(<TabularResultDetails answer={{ ...answer, summary: "Notice is required.", claims: [{ text: "Notice is required.", evidence_ids: ["missing"] }] }} column={column} onCitation={vi.fn()} />);
    expect(screen.getAllByText("Notice is required.")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Explanation" })).not.toBeInTheDocument();
  });
  it("keeps distinct pinpointed passages from the same source independently openable", () => {
    const other = { ...receipt, evidence_id: "e2", span_text: "The exception applies to cause.", locator: { kind: "page", label: "4" } }, open = vi.fn();
    render(<TabularResultDetails answer={{ ...answer, claims: [{ text: "Notice subject to an exception.", evidence_ids: ["e1", "e2"] }], evidence: [receipt, other] }} column={column} onCitation={open} />);
    const pills = screen.getAllByRole("link", { name: /Agreement/ });
    expect(pills).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Citation actions" })[1]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in reader" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ ref: 2, locator: "4", quotes: [{ quote: other.span_text, page: "4" }] }));
  });
  it("presents research reused from a research set as itself, without model answer framing", () => {
    render(<TabularResultDetails answer={{ ...answer, origin: { items: [{ kind: "passage" }] } }} column={column} onCitation={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Answer" })).not.toBeInTheDocument();
    expect(screen.queryByText("Explanation")).not.toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeVisible();
    expect(screen.getByText(/The term is express\./u)).toBeVisible();
  });
});
