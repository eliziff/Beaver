import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import type { Document } from "@/app/lib/api/documents";
import { TRSidePanel } from "./TRSidePanel";
import type { DocumentViewerProps } from "../shared/views/DocumentViewer";
import type { LegalSourceViewerProps } from "../legal/LegalSourceViewer";

vi.mock("../shared/views/DocumentViewer", () => ({
    DocumentViewer: (props: DocumentViewerProps) => <div data-testid="document-viewer"
        data-document={props.documentId} data-version={props.versionId} data-kind={props.kind}
        data-quotes={JSON.stringify(props.quotes)} data-cells={JSON.stringify(props.highlightCells)} />,
}));
vi.mock("../assistant/CitationQuotesHeader", () => ({
    CitationQuotesHeader: () => <div>Citation</div>,
}));
vi.mock("../legal/LegalSourceViewer", () => ({
    LegalSourceViewer: (props: LegalSourceViewerProps) => <div data-testid="source-viewer"
        data-source={props.sourceId} data-locator={props.initialLocator} />,
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
            citation={{ kind: "document", ref: 1, document_id: sourceDocument.id,
                filename: sourceDocument.filename, version_id: "pinned-version",
                quotes: [{ quote: "termination for convenience", page: 2 }] }}
        />,
    );

    expect(screen.getByText("Termination")).toBeVisible();
    expect(screen.getByText("Because the term is express.")).toBeVisible();
    expect(screen.getByTestId("document-viewer")).toBeVisible();
    expect(screen.getByTestId("document-viewer")).toHaveAttribute("data-version", "pinned-version");
    expect(screen.getByTestId("document-viewer")).toHaveAttribute("data-quotes", '[{"page":2,"quote":"termination for convenience"}]');
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

it("opens the original pinned Library version from a separately arranged row", () => {
    render(<TRSidePanel cell={cell} document={{ ...sourceDocument, id: "delivery-passage", filename: "Delivery deadline",
        reference: { provider: "library", kind: "document", id: "original-document", versionId: "pinned-original", title: "Agreement.pdf" } }}
        column={column} onClose={vi.fn()} displayDocument />);
    expect(screen.getByTestId("document-viewer")).toHaveAttribute("data-document", "original-document");
    expect(screen.getByTestId("document-viewer")).toHaveAttribute("data-version", "pinned-original");
    expect(screen.getByTestId("document-viewer")).toHaveAttribute("data-kind", "pdf");
    expect(screen.getByText("Agreement.pdf")).toBeVisible();
});

it("opens provider rows with the source reader and preserves full findings and coverage", () => {
    render(<TRSidePanel cell={{ ...cell, content: { ...cell.content!, coverage: "partial" } }}
        document={{ ...sourceDocument, id: "source://a2aj/case", filename: "Example v Example",
            resource: "source://a2aj/case", reference: { provider: "a2aj", id: "case", kind: "case", citation: "2026 SCC 1" } }}
        column={column} onClose={vi.fn()} displayDocument
        citation={{ kind: "a2aj", ref: 1, citation: "2026 SCC 1", locator: "par12",
            quotes: [{ quote: "The hearing was required." }] }} />);
    expect(screen.getByTestId("source-viewer")).toHaveAttribute("data-source", "case");
    expect(screen.getByTestId("source-viewer")).toHaveAttribute("data-locator", "par12");
    expect(screen.queryByTestId("document-viewer")).not.toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeVisible();
    expect(screen.getByText("Because the term is express.")).toBeVisible();
    expect(screen.getByText("Green")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Source coverage is incomplete.");
});
