import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import type { Document } from "@/app/lib/api/documents";
import { TRSidePanel } from "./TRSidePanel";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const cell: TabularCell = {
    id: "cell-1",
    review_id: "review-1",
    document_id: "document-1",
    column_index: 0,
    content: {
        summary: "Yes",
        reasoning: "Because the term is express.",
        flag: "green",
        value: true,
        claims: [{ text: "Because the term is express.", evidence_ids: [] }],
        evidence: [], outcome: "answered", coverage: "complete",
    },
    status: "done",
    created_at: "2026-07-29T00:00:00.000Z",
};
const sourceDocument = {
    id: "document-1",
    project_id: null,
    filename: "Agreement.pdf",
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: null,
    page_count: 4,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-29T00:00:00.000Z",
} satisfies Document;
const column = {
    index: 0,
    name: "Termination",
    prompt: "Find termination rights.",
} satisfies ColumnConfig;

it("reads the result without an embedded source viewer, quote selector or highlighter", async () => {
    const onClose = vi.fn();
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    render(<TRSidePanel cell={cell} document={sourceDocument} column={column}
        onClose={onClose} onCitation={vi.fn()} onRegenerate={onRegenerate} />);

    expect(screen.getByText("Termination")).toBeVisible();
    expect(screen.getByText("Because the term is express.")).toBeVisible();
    for (const name of ["Expand document pane", "Collapse document pane", "Next column", "Save highlight"])
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.queryByText("More details")).not.toBeInTheDocument();
    expect(screen.queryByText(column.prompt)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Regenerate"));
    await waitFor(() => expect(onRegenerate).toHaveBeenCalledOnce());

    fireEvent.click(document.body);
    expect(onClose).toHaveBeenCalledOnce();
});

it("uses a modal dialog on compact screens and restores its opener", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const user = userEvent.setup();
    function Example() {
        const [open, setOpen] = useState(false);
        return <><button onClick={() => setOpen(true)}>Open result</button>{open &&
            <TRSidePanel cell={cell} document={sourceDocument} column={column}
                onCitation={vi.fn()} onClose={() => setOpen(false)} />}</>;
    }

    render(<Example />);
    const opener = screen.getByRole("button", { name: "Open result" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Termination result" });
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(opener).toHaveFocus());
});

it("keeps Regenerate visible but disabled while the review is running", () => {
    render(<TRSidePanel cell={cell} document={sourceDocument} column={column} onClose={vi.fn()} onCitation={vi.fn()}
        onRegenerate={vi.fn().mockResolvedValue(undefined)} running />);
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled();
});

it("hands a cited passage to the shared source reader rather than opening one inside the result", () => {
    const onCitation = vi.fn();
    const evidence = { evidence_id: "other", provider: "a2aj", stable_source_id: "other-case", source_reference: { id: "other-case" },
        source_sha256: "a".repeat(64), span_sha256: "b".repeat(64), block_id: "par7", span_text: "The court distinguished the rule.",
        citation: "2026 SCC 2", name: "Other case", external_url: null, dataset: "scc", language: "fr" as const, locator: { kind: "paragraph", label: "7" } };
    render(<TRSidePanel cell={{ ...cell, content: { ...cell.content!, evidence: [evidence], claims: [{ text: "Distinguished", evidence_ids: ["other"] }] } }}
        document={{ ...sourceDocument, reference: { provider: "a2aj", id: "row-case", kind: "case", citation: "2026 SCC 1" } }}
        column={column} onClose={vi.fn()} onCitation={onCitation} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Citation actions" })[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in reader" }));
    expect(onCitation).toHaveBeenCalledWith(expect.objectContaining({ kind: "a2aj", name: "Other case",
        locator: "7", quotes: [{ quote: evidence.span_text }] }));
});

it("keeps the answer readable after regeneration fails and permits retry", async () => {
    const regenerate = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    render(<TRSidePanel cell={cell} document={sourceDocument} column={column} onClose={vi.fn()} onCitation={vi.fn()} onRegenerate={regenerate} />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not regenerate");
    expect(screen.getByText("Yes")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(regenerate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
