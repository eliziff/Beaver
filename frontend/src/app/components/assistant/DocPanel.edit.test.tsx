import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditAnnotation } from "../shared/types";

const mocks = vi.hoisted(() => ({
    docxView: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../shared/views/DocxView", () => ({
    DocxView: (props: {
        warning?: string | null;
        highlightEdit?: unknown;
    }) => {
        mocks.docxView(props);
        return (
            <div data-testid="docx-view">
                {props.warning ? <span>{props.warning}</span> : null}
            </div>
        );
    },
}));

vi.mock("../shared/views/PdfView", () => ({
    PdfView: () => <div data-testid="pdf-view" />,
}));

vi.mock("../shared/views/SpreadsheetView", () => ({
    SpreadsheetView: () => <div data-testid="spreadsheet-view" />,
}));

vi.mock("./CaseLawPanel", () => ({
    CaseLawPanel: () => <div data-testid="case-view" />,
}));

vi.mock("@/app/components/legal/LegalSourceViewer", () => ({
    LegalSourceViewer: () => <div data-testid="legal-view" />,
}));

import { AssistantSidePanel } from "./AssistantSidePanel";
import { DocPanel } from "./DocPanel";

const edit: EditAnnotation = {
    edit_id: "edit-1",
    document_id: "doc-1",
    version_id: "version-1",
    version_number: 1,
    change_id: "change-1",
    deleted_text: "Deleted original",
    inserted_text: "Inserted replacement",
    reason: "This repeats what the redline already shows.",
    status: "pending",
};

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("edit document panel", () => {
    it("leaves the redline as the only change preview", () => {
        const { container } = render(
            <DocPanel
                documentId="doc-1"
                filename="Draft agreement.docx"
                versionId="version-1"
                versionNumber={1}
                mode={{ kind: "edit", edit }}
                warning="Couldn't save accept — please retry."
            />,
        );

        expect(container).not.toHaveTextContent(
            /Draft agreement\.docx|Tracked Change|This repeats what the redline already shows|Inserted replacement|Deleted original/i,
        );
        expect(
            screen.queryByRole("button", { name: /download/i }),
        ).not.toBeInTheDocument();
        screen.getByRole("button", { name: "Accept" });
        screen.getByRole("button", { name: "Reject" });
        expect(
            screen.getByText("Couldn't save accept — please retry."),
        ).toBeInTheDocument();
        expect(mocks.docxView).toHaveBeenLastCalledWith(
            expect.objectContaining({
                highlightEdit: expect.objectContaining({
                    key: "edit-1",
                    inserted_text: edit.inserted_text,
                    deleted_text: edit.deleted_text,
                }),
            }),
        );
    });

    it("keeps the ordinary document header and download action", () => {
        render(
            <DocPanel
                documentId="doc-1"
                filename="Draft agreement.docx"
                versionId="version-1"
                versionNumber={1}
                mode={{ kind: "document" }}
            />,
        );

        screen.getByText("Draft agreement.docx");
        screen.getByText("V1");
        screen.getByRole("button", { name: /download/i });
    });

    it("shows the edit filename and version once, in its tab", () => {
        const { container } = render(
            <AssistantSidePanel
                tabs={[
                    {
                        id: "edit-tab",
                        kind: "edit",
                        documentId: "doc-1",
                        filename: "Draft agreement.docx",
                        versionId: "version-1",
                        versionNumber: 1,
                        edit,
                    },
                ]}
                activeTabId="edit-tab"
                onActivateTab={vi.fn()}
                onCloseTab={vi.fn()}
                onCloseAll={vi.fn()}
            />,
        );

        expect(screen.getAllByText("Draft agreement.docx")).toHaveLength(1);
        expect(screen.getAllByText("V1")).toHaveLength(1);
        expect(container).not.toHaveTextContent(
            /Tracked Change|This repeats what the redline already shows|Inserted replacement|Deleted original/i,
        );
    });
});
