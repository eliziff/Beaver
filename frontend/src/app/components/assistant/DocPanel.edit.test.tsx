import { useState } from "react";
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
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
    it("leaves the redline as the only change preview", async () => {
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
        await waitFor(() => {
        expect(
            screen.getByText("Couldn't save accept — please retry."),
        ).toBeInTheDocument();
        });
        await waitFor(() =>
            expect(mocks.docxView).toHaveBeenLastCalledWith(
            expect.objectContaining({
                highlightEdit: expect.objectContaining({
                    key: "edit-1",
                    inserted_text: edit.inserted_text,
                    deleted_text: edit.deleted_text,
                }),
            }),
            ),
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

describe("assistant side panel tabs", () => {
    it("keeps tab content mounted while switching and routes close actions", async () => {
        const onActivateTab = vi.fn();
        const onCloseTab = vi.fn();
        const onCloseAll = vi.fn();
        function Panel() {
            const [activeTabId, setActiveTabId] = useState("first");
            return (
                <AssistantSidePanel
                    tabs={[
                        {
                            id: "first",
                            kind: "document",
                            documentId: "doc-1",
                            filename: "First.docx",
                            versionId: "version-1",
                            versionNumber: 1,
                        },
                        {
                            id: "second",
                            kind: "document",
                            documentId: "doc-2",
                            filename: "Second.docx",
                            versionId: "version-2",
                            versionNumber: 1,
                        },
                    ]}
                    activeTabId={activeTabId}
                    onActivateTab={(id) => {
                        onActivateTab(id);
                        setActiveTabId(id);
                    }}
                    onCloseTab={onCloseTab}
                    onCloseAll={onCloseAll}
                />
            );
        }
        const { container } = render(<Panel />);

        await waitFor(() =>
            expect(screen.getAllByTestId("docx-view")).toHaveLength(2),
        );
        expect(container.firstElementChild).toHaveClass(
            "md:w-[min(46vw,680px)]",
        );
        const views = screen.getAllByTestId("docx-view");
        const firstPane = views[0].closest("[aria-hidden]");
        const secondPane = views[1].closest("[aria-hidden]");
        expect(firstPane).toHaveAttribute("aria-hidden", "false");
        expect(secondPane).toHaveAttribute("aria-hidden", "true");

        const closeSecond = screen.getByRole("button", {
            name: "Close Second.docx",
        });
        fireEvent.click(closeSecond.parentElement!);

        expect(onActivateTab).toHaveBeenCalledWith("second");
        expect(screen.getAllByTestId("docx-view")[0]).toBe(views[0]);
        expect(firstPane).toHaveAttribute("aria-hidden", "true");
        expect(secondPane).toHaveAttribute("aria-hidden", "false");

        fireEvent.click(closeSecond);
        expect(onCloseTab).toHaveBeenCalledWith("second");
        expect(onActivateTab).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
        expect(onCloseAll).toHaveBeenCalledOnce();
    });
});
