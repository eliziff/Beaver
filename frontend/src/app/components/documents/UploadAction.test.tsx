import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
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

it("keeps directory actions on one rail", () => {
    const createFolder = vi.fn();
    render(<DirectoryActions actions={null} onCreateFolder={createFolder} />);

    fireEvent.click(screen.getByRole("button", { name: "Folder" }));
    expect(createFolder).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
});
