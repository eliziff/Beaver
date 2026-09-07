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
    expect(screen.getByText("Supported")).not.toBeVisible();
    fireEvent.click(screen.getByText("More details", { selector: "summary" }));
    expect(screen.getByText("Supported")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Partial coverage");
});

it("keeps Regenerate visible but disabled while the review is running", () => {
    render(<TRSidePanel cell={cell} document={sourceDocument} column={column} onClose={vi.fn()}
        onRegenerate={vi.fn().mockResolvedValue(undefined)} running />);
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    expect(screen.getByText("Find termination rights.")).not.toBeVisible();
    fireEvent.click(screen.getByText("More details", { selector: "summary" }));
    expect(screen.getByText("Find termination rights.")).toBeVisible();
});

const support = {
    evidence_id: "e_support", provider: "library", stable_source_id: "supporting-document",
    version: "supporting-version", source_sha256: "a".repeat(64), span_sha256: "b".repeat(64),
    block_id: "paragraph:7", span_text: "The supporting passage is in a different document.",
    name: "Supporting.docx", citation: "Supporting.docx", external_url: null,
    locator: { kind: "paragraph", label: "para 7" },
};
const supportedCell: TabularCell = { ...cell, content: { ...cell.content!,
    claims: [{ text: "Because the term is express.", evidence_ids: [support.evidence_id] }],
    evidence: [support, { ...support, evidence_id: "e_read", span_text: "An unrelated read, not cited support." }],
} };

it("shows cited support once and keeps unrelated reads behind receipt details", () => {
    render(<TRSidePanel cell={supportedCell} document={sourceDocument} column={column} onClose={vi.fn()} />);
    expect(screen.getAllByText(support.span_text)).toHaveLength(1);
    expect(screen.queryByText("An unrelated read, not cited support.")).not.toBeInTheDocument();
    expect(screen.queryByText("Cited", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[1] Supporting.docx · para 7" })).toBeVisible();
    expect(screen.getAllByText("Because the term is express.")).toHaveLength(1);
    fireEvent.click(screen.getByText("More details", { selector: "summary" }));
    expect(screen.getAllByText(/Receipt · Supporting.docx/)).toHaveLength(2);
});

it("opens a cited document's exact version rather than the row's document", () => {
    render(<TRSidePanel cell={supportedCell} document={{ ...sourceDocument,
        reference: { provider: "library", kind: "document", id: "row-document", versionId: "row-version" } }}
        column={column} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "[1] Supporting.docx · para 7" }));
    expect(screen.getByTestId("document-viewer")).toHaveAttribute("data-document", "supporting-document");
    expect(screen.getByTestId("document-viewer")).toHaveAttribute("data-version", "supporting-version");
    expect(screen.getByTestId("document-viewer")).toHaveAttribute("data-kind", "docx");
});

it("honours a cross-source citation opened directly from a table cell", async () => {
    const { evidenceCitation } = await import("@/app/lib/groundedAnswers");
    const receipt = { ...support, provider: "a2aj", source_reference: { id: "supporting-case" },
        citation: "2099 EXAMPLE 2", name: "Other case", version: null };
    render(<TRSidePanel cell={{ ...supportedCell, content: { ...supportedCell.content!, evidence: [receipt] } }}
        document={{ ...sourceDocument, reference: { provider: "a2aj", kind: "case", id: "row-case", citation: "2099 EXAMPLE 1" } }}
        citation={evidenceCitation(receipt, 1)!} displayDocument column={column} onClose={vi.fn()} />);
    expect(screen.getByTestId("source-viewer")).toHaveAttribute("data-source", "supporting-case");
    expect(screen.getByTestId("source-viewer")).toHaveAttribute("data-locator", "para 7");
});

it("renders claims as the answer when there is no summary or scalar value", () => {
    render(<TRSidePanel cell={{ ...supportedCell, content: { ...supportedCell.content!, summary: "", value: null } }}
        document={sourceDocument} column={column} onClose={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Answer" })).toHaveTextContent("Because the term is express.");
    expect(screen.queryByRole("region", { name: "Explanation" })).not.toBeInTheDocument();
});

it("shows unavailable support explicitly and recovers after a regeneration error", async () => {
    const regenerate = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    render(<TRSidePanel cell={{ ...supportedCell, content: { ...supportedCell.content!, evidence: [] } }}
        document={sourceDocument} column={column} onClose={vi.fn()} onRegenerate={regenerate} />);
    expect(screen.getByRole("status")).toHaveTextContent("Supporting passage unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not regenerate"));
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
