import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Workflow } from "@/app/lib/api/workflows";
import { QuoteReviewModal } from "./QuoteReviewModal";
vi.mock("./QuoteCheckWorkflow", () => ({ default: ({ documents }: any) => <p>Mechanical review: {documents?.[0]?.filename}</p> }));
const workflow: Workflow = { id: "quote-checking", user_id: null, is_system: true, created_at: "",
    metadata: { title: "Review quotations", description: "Check wording and support.", category: "Research and verification",
        audiences: ["general"], contributors: [], language: "English", version: "1", jurisdictions: [] },
    launcher: { kind: "quote_check", variants: [{ id: "ai-review", label: "Review quotations", description: "Review source support.",
        result: "A prose critique", execution: "assistant", skill_md: null, columns_config: null }] } };

it("defaults to mechanical checking and carries the selected document into the review", () => {
    render(<QuoteReviewModal workflow={workflow} documents={[{ id: "draft", filename: "Draft.docx" }]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Mechanical review: Draft.docx")).toBeVisible();
});

it("launches the existing assistant variant when the user selects a deeper review", () => {
    const select = vi.fn(), close = vi.fn();
    render(<QuoteReviewModal workflow={workflow} onClose={close} onAssistantSelect={select} />);
    fireEvent.click(screen.getByRole("radio", { name: /Quotations and legal support/u }));
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(select).toHaveBeenCalledWith({ workflow, variant: workflow.launcher.kind === "quote_check" ? workflow.launcher.variants[0] : undefined });
    expect(close).toHaveBeenCalledOnce();
});
