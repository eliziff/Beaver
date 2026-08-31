import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    DocumentWorkflowMenu,
    documentWorkflowEligible,
} from "./DocumentWorkflowMenu";
import {
    createAuthorities,
    fixLibraryDocxSupras,
    inspectDocxWorkflowCapabilities,
} from "@/app/lib/beaverApi";
import { AssistantWorkflowActivity } from "@/app/components/assistant/WorkflowRun";

vi.mock("@/app/lib/beaverApi", () => ({
    createAuthorities: vi.fn(),
    fixLibraryDocxSupras: vi.fn(),
    inspectDocxWorkflowCapabilities: vi.fn(),
}));

const docx = { id: "document-1", filename: "Lease.docx", file_type: "docx" };
const pdf = { id: "pdf-1", filename: "Decision.pdf", file_type: "pdf" };

describe("document workflows", () => {
    beforeEach(() => vi.clearAllMocks());

    it("offers workflows only for supported source documents", () => {
        expect(documentWorkflowEligible(docx)).toBe(true);
        expect(documentWorkflowEligible(pdf)).toBe(true);
        expect(documentWorkflowEligible({
            id: "sheet-1",
            filename: "Schedule.xlsx",
            file_type: "xlsx",
        })).toBe(false);
        expect(documentWorkflowEligible({
            ...docx,
            library_kind: "template",
        })).toBe(false);

        const { rerender } = render(<DocumentWorkflowMenu document={null} />);
        expect(screen.queryByRole("button", { name: "Workflows" })).toBeNull();
        rerender(<DocumentWorkflowMenu document={docx} />);
        expect(screen.getByRole("button", { name: "Workflows" })).toBeVisible();
    });

    it("routes a PDF through the canonical Authorities workflow", async () => {
        const user = userEvent.setup();
        vi.mocked(createAuthorities).mockResolvedValue({
            id: "draft-1", kind: "authorities", title: "Authorities",
            projectId: null, revision: 1, outputs: {},
            createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z",
            state: { schemaVersion: "beaver.authorities-draft.v1",
                import: { kind: "manual" }, bindings: {}, outputMode: "both",
                insertIntoDocument: false,
                units: [], occurrences: {}, authorities: {}, authorityOrder: [] },
        });
        render(<>
            <DocumentWorkflowMenu document={pdf} />
            <AssistantWorkflowActivity />
        </>);

        const trigger = screen.getByRole("button", { name: "Workflows" });
        await user.click(trigger);
        const authorities = screen.getByRole("button", {
            name: "Create book/table of authorities",
        });
        await waitFor(() => expect(authorities).toHaveFocus());
        expect(authorities).toHaveAttribute("data-workflow-id", "authorities");
        expect(inspectDocxWorkflowCapabilities).not.toHaveBeenCalled();
        await user.click(authorities);
        await waitFor(() => expect(trigger).toHaveFocus());

        expect(createAuthorities).toHaveBeenCalledWith({
            source: { kind: "document", documentId: pdf.id, version: "latest" },
            projectId: undefined,
        });
        await user.click(await screen.findByRole("button", {
            name: "Create book/table of authorities: complete",
        }));
        expect(screen.getByRole("link", { name: "Open full Authorities" }))
            .toHaveAttribute("href", "/table-of-authorities?draft=draft-1");
    });

    it("keeps caller actions beside portal workflows without stealing focus back", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        render(<DocumentWorkflowMenu document={pdf}
            actions={[{ label: "Download", onSelect }]} />);

        const trigger = screen.getByRole("button", { name: "Workflows" });
        await user.click(trigger);
        expect(screen.getByRole("button", { name: "Create book/table of authorities" }))
            .toBeVisible();
        await user.click(screen.getByRole("button", { name: "Download" }));
        expect(onSelect).toHaveBeenCalledOnce();
        expect(screen.queryByRole("complementary", { name: "Workflows" })).toBeNull();
        expect(trigger).not.toHaveFocus();
    });

    it("ignores a capability response after the selected document changes", async () => {
        const user = userEvent.setup();
        let release!: (value: { supra_references: boolean }) => void;
        vi.mocked(inspectDocxWorkflowCapabilities).mockReturnValue(
            new Promise((resolve) => { release = resolve; }),
        );
        const { rerender } = render(<DocumentWorkflowMenu document={docx} />);

        await user.click(screen.getByRole("button", { name: "Workflows" }));
        rerender(<DocumentWorkflowMenu document={{ ...docx, id: "document-2" }} />);
        await act(() => release({ supra_references: true }));

        expect(screen.queryByRole("complementary")).toBeNull();
    });

    it("auto-opens the same eligible choices in an embedded dock", async () => {
        vi.mocked(inspectDocxWorkflowCapabilities).mockResolvedValue({
            supra_references: false,
        });
        render(<DocumentWorkflowMenu document={docx} embedded />);

        expect(await screen.findByRole("button", {
            name: "Create book/table of authorities",
        })).toBeVisible();
        expect(screen.queryByRole("button", { name: "Fix supra references" }))
            .toBeNull();
        expect(inspectDocxWorkflowCapabilities).toHaveBeenCalledWith(docx.id);
    });

    it("reports inspection failures and permits a clean retry", async () => {
        const user = userEvent.setup();
        vi.mocked(inspectDocxWorkflowCapabilities)
            .mockRejectedValueOnce(new Error("Inspection failed"))
            .mockResolvedValueOnce({ supra_references: true });
        render(<DocumentWorkflowMenu document={docx} />);

        await user.click(screen.getByRole("button", { name: "Workflows" }));
        expect(await screen.findByRole("alertdialog")).toHaveTextContent("Inspection failed");
        await user.click(screen.getByRole("button", { name: "Dismiss warning" }));
        await user.click(screen.getByRole("button", { name: "Workflows" }));
        expect(await screen.findByRole("button", { name: "Fix supra references" }))
            .toBeVisible();
    });

    it("runs the applicable drafting operation and publishes its result", async () => {
        const user = userEvent.setup();
        const onDocumentChanged = vi.fn();
        vi.mocked(inspectDocxWorkflowCapabilities).mockResolvedValue({
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
        render(<>
            <DocumentWorkflowMenu
                document={docx}
                onDocumentChanged={onDocumentChanged}
            />
            <AssistantWorkflowActivity />
        </>);

        await user.click(screen.getByRole("button", { name: "Workflows" }));
        const drafting = await screen.findByRole("button", {
            name: "Fix supra references",
        });
        expect(drafting).toHaveAttribute("data-workflow-id", "drafting");
        await user.click(drafting);

        await waitFor(() => expect(fixLibraryDocxSupras).toHaveBeenCalledWith(docx.id));
        expect(onDocumentChanged).toHaveBeenCalledWith(
            expect.objectContaining({ version_id: "version-2" }),
        );
        expect(await screen.findByRole("button", {
            name: "Fix supra references: complete",
        })).toBeVisible();
    });
});
