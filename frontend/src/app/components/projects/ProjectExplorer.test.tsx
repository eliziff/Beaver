import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectExplorer } from "./ProjectExplorer";

describe("ProjectExplorer document removal", () => {
  it("opens root PDF and DOCX rows with their current versions and tolerates an empty folder", async () => {
    const user = userEvent.setup();
    const onDocClick = vi.fn();
    const base = {
      user_id: "user-1",
      project_id: "matter-1",
      folder_id: null,
      storage_path: "file",
      pdf_storage_path: "file.pdf",
      size_bytes: 10,
      page_count: 1,
      structure_tree: null,
      status: "ready" as const,
      created_at: "2026-07-27T00:00:00.000Z",
      active_version_number: 1,
    };
    const pdf = {
      ...base,
      id: "pdf-1",
      filename: "Brief.pdf",
      file_type: "pdf",
      current_version_id: "pdf-version",
    };
    const docx = {
      ...base,
      id: "docx-1",
      filename: "Agreement.docx",
      file_type: "docx",
      current_version_id: "docx-version",
    };

    render(
      <ProjectExplorer
        documents={[pdf, docx]}
        folders={[
          {
            id: "empty-folder",
            project_id: "matter-1",
            user_id: "user-1",
            name: "Empty folder",
            parent_folder_id: null,
            created_at: "2026-07-27T00:00:00.000Z",
            updated_at: "2026-07-27T00:00:00.000Z",
          },
        ]}
        onDocClick={onDocClick}
      />,
    );

    await user.click(screen.getByText("Brief.pdf"));
    await user.click(screen.getByText("Agreement.docx"));
    await user.click(screen.getByText("Empty folder"));

    expect(onDocClick).toHaveBeenNthCalledWith(1, pdf);
    expect(onDocClick).toHaveBeenNthCalledWith(2, docx);
    expect(screen.getByText("Empty folder")).toBeInTheDocument();
  });

  it("confirms a local detach and explains that Library files are kept", async () => {
    const user = userEvent.setup();
    const onDeleteDoc = vi.fn(async () => {});

    render(
      <ProjectExplorer
        documents={[
          {
            id: "document-1",
            project_id: "matter-1",
            filename: "Brief.pdf",
            file_type: "pdf",
            storage_path: "brief.pdf",
            pdf_storage_path: "brief.pdf",
            size_bytes: 10,
            page_count: 1,
            structure_tree: null,
            status: "ready",
            created_at: "2026-07-27T00:00:00.000Z",
            active_version_number: 1,
          },
        ]}
        onDocClick={vi.fn()}
        onDeleteDoc={onDeleteDoc}
        documentRemovalMode="detach"
      />,
    );

    fireEvent.contextMenu(screen.getByText("Brief.pdf"));
    await user.click(
      screen.getByRole("button", { name: "Remove from project" }),
    );

    expect(onDeleteDoc).not.toHaveBeenCalled();
    expect(screen.getByText("Remove from project?")).toBeInTheDocument();
    expect(
      screen.getByText(/Library file and its links in other projects/u),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onDeleteDoc).toHaveBeenCalledWith("document-1"));
  });

  it("shows a warning when removal fails", async () => {
    const user = userEvent.setup();
    const onDeleteDoc = vi.fn(async () => {
      throw new Error("offline");
    });

    render(
      <ProjectExplorer
        documents={[
          {
            id: "document-1",
            project_id: "matter-1",
            filename: "Brief.pdf",
            file_type: "pdf",
            storage_path: "brief.pdf",
            pdf_storage_path: "brief.pdf",
            size_bytes: 10,
            page_count: 1,
            structure_tree: null,
            status: "ready",
            created_at: "2026-07-27T00:00:00.000Z",
            active_version_number: 1,
          },
        ]}
        onDocClick={vi.fn()}
        onDeleteDoc={onDeleteDoc}
        documentRemovalMode="detach"
      />,
    );

    fireEvent.contextMenu(screen.getByText("Brief.pdf"));
    await user.click(
      screen.getByRole("button", { name: "Remove from project" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "The document could not be removed from this project.",
      ),
    ).toBeInTheDocument();
  });
});
