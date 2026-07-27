import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Document,
    PdfParseState,
} from "@/app/components/shared/types";
import {
    getLibraryPdfParseState,
    retryLibraryPdfParse,
} from "@/app/lib/mikeApi";
import { DocumentActionsPanel } from "./DocumentActionsPanel";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    fixLibraryDocxSupras: vi.fn(),
    getLibraryPdfParseState: vi.fn(),
    linkLibraryDocxCitations: vi.fn(),
    retryLibraryPdfParse: vi.fn(),
    submitLibraryDocumentToAuthorities: vi.fn(),
}));

vi.mock("@/app/lib/authMode", () => ({
    isAnonymousMode: true,
}));

const selectedDocument: Document = {
    id: "document-1",
    project_id: null,
    filename: "upstream.docx",
    file_type: "docx",
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: 100,
    page_count: null,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-27T00:00:00Z",
};

const degradedParse: PdfParseState = {
    schema_version: "mike.pdf_parse.v1",
    job_id: "job-1",
    document_id: "pdf-1",
    version_id: "version-1",
    status: "degraded",
    source_path: "documents/pdf-1/source.pdf",
    source_sha256: "abc",
    parser_version: "0.1.0",
    parser_config_version: "mike-local-v1",
    parser_config: {
        mode: "local",
        ocr_provider: null,
        model: null,
        prompt_version: null,
        text_fidelity_root: null,
        text_fidelity_native: false,
    },
    cache_key: "cache-1",
    artifact_manifest: "manifest.json",
    attempts: 1,
    queued_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:01:00Z",
    completed_at: "2026-07-27T00:01:00Z",
    page_count: 12,
    diagnostic_count: 3,
    diagnostic_summary: {
        by_severity: { warning: 2, info: 1 },
        by_code: { missing_heading: 2, weak_page_boundary: 1 },
    },
    flat_text_fallback_available: true,
};

describe("DocumentActionsPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
    });

    it("stays non-modal, docks to either side, and minimizes", async () => {
        const user = userEvent.setup();
        const backgroundAction = vi.fn();

        render(
            <>
                <button type="button" onClick={backgroundAction}>
                    Library remains interactive
                </button>
                <DocumentActionsPanel
                    open
                    onClose={vi.fn()}
                    document={selectedDocument}
                    onDocumentChanged={vi.fn().mockResolvedValue(undefined)}
                />
            </>,
        );

        const panel = screen.getByLabelText("Document actions");
        expect(panel.tagName).toBe("ASIDE");
        expect(panel).toHaveClass("right-5");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(getLibraryPdfParseState).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", {
                name: "Library remains interactive",
            }),
        );
        expect(backgroundAction).toHaveBeenCalledOnce();

        await user.click(
            screen.getByRole("button", {
                name: "Dock panel on the left",
            }),
        );
        expect(screen.getByLabelText("Document actions")).toHaveClass("left-5");

        await user.click(
            screen.getByRole("button", { name: "Minimize document actions" }),
        );
        expect(
            screen.queryByLabelText("Document actions"),
        ).not.toBeInTheDocument();

        await user.click(
            screen.getByRole("button", { name: /Document actions/ }),
        );
        expect(screen.getByLabelText("Document actions")).toHaveClass("left-5");
    });

    it("shows concise PDF parse diagnostics and retries the selected version", async () => {
        const user = userEvent.setup();
        const queued = { ...degradedParse, status: "queued" as const };
        vi.mocked(getLibraryPdfParseState)
            .mockResolvedValueOnce(degradedParse)
            .mockResolvedValueOnce(queued);
        vi.mocked(retryLibraryPdfParse).mockResolvedValue(queued);
        const pdf: Document = {
            ...selectedDocument,
            id: "pdf-1",
            filename: "decision.pdf",
            file_type: "pdf",
            current_version_id: "version-1",
        };

        render(
            <DocumentActionsPanel
                open
                onClose={vi.fn()}
                document={pdf}
                onDocumentChanged={vi.fn().mockResolvedValue(undefined)}
            />,
        );

        expect(
            await screen.findByText(
                "Partial structure is available; flat-text access remains available.",
            ),
        ).toBeInTheDocument();
        expect(screen.getByLabelText("PDF parse status")).toHaveTextContent(
            "Degraded",
        );
        expect(
            screen.getByText(
                "3 diagnostics · 2 warning, 1 info · missing heading, weak page boundary",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("Attempt 1 · 12 pages")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "OCR affected pages" }),
        ).not.toBeInTheDocument();

        await user.click(
            screen.getByRole("button", {
                name: "Retry structural parse",
            }),
        );

        expect(retryLibraryPdfParse).toHaveBeenCalledWith(
            "pdf-1",
            "version-1",
            undefined,
        );
        await waitFor(() =>
            expect(screen.getByLabelText("PDF parse status")).toHaveTextContent(
                "Queued",
            ),
        );
    });

    it("offers selective OCR only for pages diagnosed as OCR required", async () => {
        const user = userEvent.setup();
        const ocrRequired: PdfParseState = {
            ...degradedParse,
            diagnostic_count: 2,
            diagnostic_summary: {
                by_severity: { warning: 2 },
                by_code: { OCR_REQUIRED: 2 },
            },
        };
        const queued: PdfParseState = {
            ...ocrRequired,
            status: "queued",
            parser_config: {
                ...ocrRequired.parser_config,
                ocr_provider: "tesseract",
                ocr_language: "eng",
                ocr_dpi: 180,
                ocr_psm: 3,
            },
        };
        vi.mocked(getLibraryPdfParseState)
            .mockResolvedValueOnce(ocrRequired)
            .mockResolvedValue(queued);
        vi.mocked(retryLibraryPdfParse).mockResolvedValue(queued);
        const pdf: Document = {
            ...selectedDocument,
            id: "pdf-1",
            filename: "scan.pdf",
            file_type: "pdf",
            current_version_id: "version-1",
        };

        render(
            <DocumentActionsPanel
                open
                onClose={vi.fn()}
                document={pdf}
                onDocumentChanged={vi.fn().mockResolvedValue(undefined)}
            />,
        );

        await user.click(
            await screen.findByRole("button", {
                name: "OCR affected pages",
            }),
        );

        expect(retryLibraryPdfParse).toHaveBeenCalledWith(
            "pdf-1",
            "version-1",
            { ocrProvider: "tesseract" },
        );
        await waitFor(() =>
            expect(screen.getByLabelText("PDF parse status")).toHaveTextContent(
                "Queued",
            ),
        );
    });

    it("offers bounded repair only for eligible diagnostics and reuses Assistant settings", async () => {
        const user = userEvent.setup();
        window.localStorage.setItem(
            "mike.selectedModel",
            "codex:gpt-5.6-luna",
        );
        window.localStorage.setItem("mike.reasoningEffort", "max");
        const repairable: PdfParseState = {
            ...degradedParse,
            structural_repair_available: true,
            diagnostic_count: 1,
            diagnostic_summary: {
                by_severity: { warning: 1 },
                by_code: { COLUMN_ORDER_UNCERTAIN: 1 },
            },
        };
        const queued: PdfParseState = {
            ...repairable,
            status: "queued",
            parser_config: {
                ...repairable.parser_config,
                mode: "codex",
                model: "gpt-5.6-luna",
                effort: "max",
                prompt_version: "legalpdf.codex.structure.r1.v2",
                response_schema_sha256: "b".repeat(64),
                context_radius: 1,
                max_attempts: 3,
            },
        };
        vi.mocked(getLibraryPdfParseState)
            .mockResolvedValueOnce(repairable)
            .mockResolvedValue(queued);
        vi.mocked(retryLibraryPdfParse).mockResolvedValue(queued);
        const pdf: Document = {
            ...selectedDocument,
            id: "pdf-1",
            filename: "columns.pdf",
            file_type: "pdf",
            current_version_id: "version-1",
        };

        render(
            <DocumentActionsPanel
                open
                onClose={vi.fn()}
                document={pdf}
                onDocumentChanged={vi.fn().mockResolvedValue(undefined)}
            />,
        );

        await user.click(
            await screen.findByRole("button", {
                name: "Repair uncertain structure",
            }),
        );

        expect(retryLibraryPdfParse).toHaveBeenCalledWith(
            "pdf-1",
            "version-1",
            {
                repair: {
                    model: "codex:gpt-5.6-luna",
                    effort: "max",
                },
            },
        );
    });

    it("does not send repair with a non-Codex Assistant selection", async () => {
        const user = userEvent.setup();
        const repairable: PdfParseState = {
            ...degradedParse,
            structural_repair_available: true,
        };
        vi.mocked(getLibraryPdfParseState).mockResolvedValue(repairable);
        const pdf: Document = {
            ...selectedDocument,
            id: "pdf-1",
            filename: "columns.pdf",
            file_type: "pdf",
            current_version_id: "version-1",
        };

        render(
            <DocumentActionsPanel
                open
                onClose={vi.fn()}
                document={pdf}
                onDocumentChanged={vi.fn().mockResolvedValue(undefined)}
            />,
        );
        await user.click(
            await screen.findByRole("button", {
                name: "Repair uncertain structure",
            }),
        );

        expect(
            screen.getByText(
                "Choose a Codex model and reasoning effort in Assistant first.",
            ),
        ).toBeInTheDocument();
        expect(retryLibraryPdfParse).not.toHaveBeenCalled();
    });

    it("bounds background checks to the active selected PDF", async () => {
        vi.useFakeTimers();
        try {
            const queued = { ...degradedParse, status: "queued" as const };
            vi.mocked(getLibraryPdfParseState).mockResolvedValue(queued);
            const pdf: Document = {
                ...selectedDocument,
                id: "pdf-1",
                filename: "decision.pdf",
                file_type: "pdf",
                current_version_id: "version-1",
            };

            render(
                <DocumentActionsPanel
                    open
                    onClose={vi.fn()}
                    document={pdf}
                    onDocumentChanged={vi.fn().mockResolvedValue(undefined)}
                />,
            );
            await act(async () => {
                await Promise.resolve();
            });
            expect(getLibraryPdfParseState).toHaveBeenCalledTimes(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(120_001);
            });
            expect(getLibraryPdfParseState).toHaveBeenCalledTimes(9);
            expect(
                screen.getByText(
                    "Automatic checks paused; refresh to check again.",
                ),
            ).toBeInTheDocument();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });
            expect(getLibraryPdfParseState).toHaveBeenCalledTimes(9);
        } finally {
            vi.useRealTimers();
        }
    });
});
