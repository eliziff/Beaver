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
import { AssistantAutomationActivity } from "@/app/components/assistant/AutomationRun";

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
const pdf = {
    id: "pdf-1",
    filename: "Decision.pdf",
    file_type: "pdf",
};

describe("DocumentAutomation", () => {
    beforeEach(() => vi.clearAllMocks());

    it("is available for DOCX and PDF files", () => {
        expect(documentAutomationEligible(docx)).toBe(true);
        expect(documentAutomationEligible(pdf)).toBe(true);
        expect(
            documentAutomationEligible({
                id: "sheet-1",
                filename: "Schedule.xlsx",
                file_type: "xlsx",
            }),
        ).toBe(false);
        expect(
            documentAutomationEligible({
                ...docx,
                library_kind: "template",
            }),
        ).toBe(false);

        const { rerender } = render(
            <DocumentAutomation
                document={{
                    id: "sheet-1",
                    filename: "Schedule.xlsx",
                    file_type: "xlsx",
                }}
            />,
        );
        expect(
            screen.queryByRole("button", { name: "Automation" }),
        ).toBeNull();
        rerender(<DocumentAutomation document={docx} />);
        const trigger = screen.getByRole("button", { name: "Automation" });
        expect(trigger).toBeVisible();
        expect(
            trigger.querySelector("svg.lucide-wand-sparkles"),
        ).not.toBeNull();
    });

    it("keeps one stable trigger while document eligibility changes", () => {
        const { rerender } = render(
            <DocumentAutomation
                document={null}
                showWhenUnavailable
            />,
        );
        const trigger = screen.getByRole("button", { name: "Automation" });
        expect(trigger).toBeDisabled();
        expect(
            trigger.querySelector("svg.lucide-wand-sparkles"),
        ).not.toBeNull();

        rerender(
            <DocumentAutomation
                document={pdf}
                showWhenUnavailable
            />,
        );
        expect(screen.getByRole("button", { name: "Automation" })).toBe(
            trigger,
        );
        expect(trigger).toBeEnabled();

        rerender(
            <DocumentAutomation
                document={docx}
                showWhenUnavailable
            />,
        );
        expect(screen.getByRole("button", { name: "Automation" })).toBe(
            trigger,
        );
        expect(trigger).toBeEnabled();
    });

    it("opens PDF automation without DOCX inspection and shows only Authorities", async () => {
        const user = userEvent.setup();
        render(<DocumentAutomation document={pdf} />);

        await user.click(screen.getByRole("button", { name: "Automation" }));

        expect(
            screen.getByRole("complementary", { name: "Automation" }),
        ).toBeVisible();
        expect(inspectLibraryDocumentAutomation).not.toHaveBeenCalled();
        expect(
            screen.getByRole("button", {
                name: "Create book/table of authorities",
            }),
        ).toBeVisible();
        expect(
            screen.queryByRole("button", {
                name: "Auto-add hyperlinks to citations",
            }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Fix supra references" }),
        ).toBeNull();
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

    it("does not open an inspection result for a different document", async () => {
        const user = userEvent.setup();
        let release!: (value: { supra_references: boolean }) => void;
        vi.mocked(inspectLibraryDocumentAutomation).mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        const { rerender } = render(<DocumentAutomation document={docx} />);
        await user.click(screen.getByRole("button", { name: "Automation" }));
        rerender(
            <DocumentAutomation
                document={{ ...docx, id: "document-2" }}
            />,
        );
        release({ supra_references: true });

        expect(screen.queryByRole("complementary")).toBeNull();
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

    it("moves run status out of the direct control and into Assistant activity", async () => {
        const user = userEvent.setup();
        let release!: (
            value: Awaited<ReturnType<typeof fixLibraryDocxSupras>>,
        ) => void;
        vi.mocked(inspectLibraryDocumentAutomation).mockResolvedValue({
            supra_references: true,
        });
        vi.mocked(fixLibraryDocxSupras).mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        render(
            <>
                <DocumentAutomation document={docx} />
                <AssistantAutomationActivity />
            </>,
        );

        await user.click(screen.getByRole("button", { name: "Automation" }));
        await user.click(
            await screen.findByRole("button", {
                name: "Fix supra references",
            }),
        );

        expect(
            screen.queryByRole("complementary", { name: "Automation" }),
        ).toBeNull();
        expect(
            await screen.findByRole("button", {
                name: "Fix supra references: running",
            }),
        ).toBeVisible();

        release({
            ok: true,
            document_id: docx.id,
            version_id: "version-2",
            filename: "Lease - supras fixed.docx",
            detected: 1,
            converted: 1,
            already_linked: 0,
            review_required: 0,
        });
        expect(
            await screen.findByRole("button", {
                name: "Fix supra references: complete",
            }),
        ).toBeVisible();
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
            <>
                <DocumentAutomation
                    document={docx}
                    onDocumentChanged={onDocumentChanged}
                />
                <AssistantAutomationActivity />
            </>,
        );

        await user.click(screen.getByRole("button", { name: "Automation" }));
        await user.click(
            await screen.findByRole("button", {
                name: "Fix supra references",
            }),
        );
        expect(
            screen.queryByRole("complementary", { name: "Automation" }),
        ).toBeNull();
        await user.click(
            await screen.findByRole("button", {
                name: "Fix supra references: complete",
            }),
        );
        expect(await screen.findByText("2")).toBeVisible();
        expect(onDocumentChanged).toHaveBeenCalledWith(
            expect.objectContaining({ version_id: "version-2" }),
        );

        await user.click(screen.getByRole("button", { name: "Automation" }));
        await user.click(
            await screen.findByRole("button", {
                name: "Create book/table of authorities",
            }),
        );
        await user.click(
            await screen.findByRole("button", {
                name: "Create book/table of authorities: review",
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
