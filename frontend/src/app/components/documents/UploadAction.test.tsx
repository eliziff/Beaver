import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import { DirectoryActions, UploadAction } from "./UploadAction";

it("offers files and folders through one upload action", () => {
    const files = vi.fn();
    const folder = vi.fn();
    render(<UploadAction actions={{ files, folder }} />);

    expect(screen.getAllByRole("button", { name: "Upload" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Folder" }));
    expect(folder).toHaveBeenCalledOnce();
    expect(files).not.toHaveBeenCalled();
});

it("keeps one stable action rail and enables selection actions in place", () => {
    const createFolder = vi.fn();
    const openChat = vi.fn();
    const selection = {
        documents: [{ id: "brief", filename: "Brief.docx" } as Document],
        onWorkflowDocumentChanged: vi.fn(), onDownload: vi.fn(), onMove: vi.fn(),
        onRemove: vi.fn(), removeLabel: "Delete" as const,
    };
    const { rerender } = render(<MemoryRouter><DirectoryActions actions={null}
        onCreateFolder={createFolder} onOpenSelectionInChat={openChat} /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(createFolder).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open in new chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Workflows" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "More actions" })).toBeDisabled();

    rerender(<MemoryRouter><DirectoryActions actions={null} onCreateFolder={createFolder}
        selection={selection} onOpenSelectionInChat={openChat} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Open in new chat" }));
    expect(openChat).toHaveBeenCalledWith(selection.documents);
    expect(screen.getByRole("button", { name: "Workflows" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "More actions" })).toBeEnabled();
});
