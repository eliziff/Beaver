import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    DocumentAutomation,
    documentAutomationEligible,
} from "./DocumentAutomation";
import {
    fixLibraryDocxSupras,
    inspectLibraryDocumentAutomation,
    submitLibraryDocumentToAuthorities,
} from "@/app/lib/beaverApi";

vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));
vi.mock("@/app/lib/beaverApi", () => ({
    fixLibraryDocxSupras: vi.fn(),
    inspectLibraryDocumentAutomation: vi.fn(),
    linkLibraryDocxCitations: vi.fn(),
    submitLibraryDocumentToAuthorities: vi.fn(),
}));

const docx = {
    id: "document-1",
    filename: "Lease.docx",
    file_type: "docx",
};

describe("DocumentAutomation", () => {
    beforeEach(() => vi.clearAllMocks());

    it("is available only for DOCX", () => {
        expect(documentAutomationEligible(docx)).toBe(true);
        expect(
            documentAutomationEligible({
                id: "pdf-1",
                filename: "Decision.pdf",
                file_type: "pdf",
            }),
        ).toBe(false);
        expect(
            documentAutomationEligible({
                id: "sheet-1",
                filename: "Schedule.xlsx",
                file_type: "xlsx",
            }),
        ).toBe(false);

        const { rerender } = render(
            <DocumentAutomation
                document={{
                    id: "pdf-1",
                    filename: "Decision.pdf",
                    file_type: "pdf",
                }}
            />,
        );
        expect(
            screen.queryByRole("button", { name: "Automation" }),
        ).toBeNull();
        rerender(<DocumentAutomation document={docx} />);
        expect(
            screen.getByRole("button", { name: "Automation" }),
        ).toBeVisible();
    });

    it("waits for server capabilities before opening", async () => {
        const user = userEvent.setup();
        let release!: (value: { supra_references: boolean }) => void;
        vi.mocked(inspectLibraryDocumentAutomation).mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        render(<DocumentAutomation document={docx} />);

        await user.click(screen.getByRole("button", { name: "Automation" }));
        expect(screen.queryByRole("complementary")).toBeNull();

        release({ supra_references: true });
        expect(
            await screen.findByRole("complementary", { name: "Automation" }),
        ).toBeVisible();
    });

    it("uses the compact action list and server-gates supra repair", async () => {
        const user = userEvent.setup();
        vi.mocked(inspectLibraryDocumentAutomation).mockResolvedValue({
            supra_references: false,
        });
        render(<DocumentAutomation document={docx} />);

        await user.click(screen.getByRole("button", { name: "Automation" }));
        expect(
            await screen.findByRole("button", {
                name: "Create book/table of authorities",
            }),
        ).toBeVisible();
        expect(
            screen.getByRole("button", {
                name: "Auto-add hyperlinks to citations",
            }),
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Fix supra references" }),
        ).toBeNull();
        expect(screen.queryByText(docx.filename)).toBeNull();
    });

    it("reports deterministic results and keeps Authorities explicit", async () => {
        const user = userEvent.setup();
        const onDocumentChanged = vi.fn();
        vi.mocked(inspectLibraryDocumentAutomation).mockResolvedValue({
            supra_references: true,
        });
        vi.mocked(fixLibraryDocxSupras).mockResolvedValue({
            ok: true,
            document_id: docx.id,
            version_id: "version-2",
            filename: "Lease - supras fixed.docx",
            detected: 3,
            converted: 2,
            already_linked: 1,
            review_required: 0,
        });
        vi.mocked(submitLibraryDocumentToAuthorities).mockResolvedValue({
            id: "a".repeat(32),
            state: "review",
            operation: "Review citations",
            progress: 100,
            message: "Ready for review",
            error: "",
            has_review: true,
            split_fallback: "auto",
            files: [],
            app_url: "/table-of-authorities?job=abc",
        });
        render(
            <DocumentAutomation
                document={docx}
                onDocumentChanged={onDocumentChanged}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Automation" }));
        await user.click(
            await screen.findByRole("button", {
                name: "Fix supra references",
            }),
        );
        expect(await screen.findByText("2")).toBeVisible();
        expect(onDocumentChanged).toHaveBeenCalledWith(
            expect.objectContaining({ version_id: "version-2" }),
        );

        await user.click(
            screen.getByRole("button", {
                name: "Create book/table of authorities",
            }),
        );
        const link = await screen.findByRole("link", {
            name: "Open full Authorities",
        });
        expect(link).toHaveAttribute(
            "href",
            "/table-of-authorities?job=abc",
        );
    });
});
