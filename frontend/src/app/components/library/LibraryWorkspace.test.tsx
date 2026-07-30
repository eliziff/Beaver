import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    LibraryCollectionPage,
    LibraryWorkspaceProvider,
} from "./LibraryWorkspace";

const mocks = vi.hoisted(() => ({
    getLibrary: vi.fn(),
    prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ prefetch: mocks.prefetch, push: vi.fn() }),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    createLibraryFolder: vi.fn(),
    deleteLibraryFolder: vi.fn(),
    getLibrary: mocks.getLibrary,
    moveLibraryDocument: vi.fn(),
    moveLibraryFolder: vi.fn(),
    renameLibraryDocument: vi.fn(),
    renameLibraryFolder: vi.fn(),
    retryLibraryPdfParse: vi.fn(),
    uploadLibraryDocument: vi.fn(),
}));
vi.mock("@/app/components/documents/DocTable", () => ({
    DocTable: ({
        documents,
        loading,
        setDocuments,
    }: {
        documents: unknown[];
        loading: boolean;
        setDocuments: (documents: unknown[]) => void;
    }) => (
        <button onClick={() => setDocuments([])}>
            {documents.length}:{String(loading)}
        </button>
    ),
}));
vi.mock("@/app/components/documents/DocumentAutomation", () => ({
    DocumentAutomation: () => null,
}));
vi.mock("@/app/components/shared/FolderSvgIcon", () => ({
    FolderSvgIcon: () => null,
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: () => null,
}));
vi.mock("@/app/components/shared/TableToolbar", () => ({
    TableToolbar: () => null,
}));
vi.mock("@/app/components/ui/tab-pill-button", () => ({
    TabPillButton: () => null,
}));

describe("LibraryWorkspaceProvider", () => {
    it("loads once and keeps local collection updates", async () => {
        mocks.getLibrary.mockResolvedValue({
            documents: [{ id: "one" }],
            folders: [],
        });
        render(
            <LibraryWorkspaceProvider>
                <LibraryCollectionPage kind="files" />
            </LibraryWorkspaceProvider>,
        );

        await waitFor(() => expect(screen.getByText("1:false")).toBeVisible());
        fireEvent.click(screen.getByRole("button"));
        expect(screen.getByText("0:false")).toBeVisible();
        expect(mocks.getLibrary).toHaveBeenCalledOnce();
    });
});
