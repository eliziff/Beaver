import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ColumnConfig, Document, TabularCell } from "../shared/types";
import { TRSidePanel } from "./TRSidePanel";

vi.mock("../shared/views/DocumentViewer", () => ({
    DocumentViewer: () => <div data-testid="document-viewer" />,
}));
vi.mock("../assistant/CitationQuotesHeader", () => ({
    CitationQuotesHeader: () => <div>Citation</div>,
}));
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

it("keeps evidence controls without a resizable navigation pad", async () => {
    const onClose = vi.fn();
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    render(
        <TRSidePanel
            cell={cell}
            document={sourceDocument}
            column={column}
            onClose={onClose}
            onRegenerate={onRegenerate}
            displayDocument
            citationQuote="termination for convenience"
            citationPage={2}
        />,
    );

    expect(screen.getByText("Termination")).toBeVisible();
    expect(screen.getByText("Because the term is express.")).toBeVisible();
    expect(screen.getByTestId("document-viewer")).toBeVisible();
    expect(
        screen.queryByRole("button", { name: "Next column" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
        screen.getByRole("button", { name: "Collapse document pane" }),
    );
    expect(screen.queryByTestId("document-viewer")).not.toBeInTheDocument();
    fireEvent.click(
        screen.getByRole("button", { name: "Expand document pane" }),
    );
    expect(screen.getByTestId("document-viewer")).toBeVisible();

    fireEvent.click(screen.getByTitle("Regenerate"));
    await waitFor(() => expect(onRegenerate).toHaveBeenCalledOnce());

    fireEvent.pointerDown(document.body);
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
                onClose={() => setOpen(false)} />}</>;
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
