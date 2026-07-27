import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectExplorer } from "./ProjectExplorer";

describe("ProjectExplorer document removal", () => {
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
