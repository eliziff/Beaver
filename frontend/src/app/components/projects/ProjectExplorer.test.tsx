import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Document, Folder } from "@/app/lib/api/documents";
import { ProjectExplorer } from "./ProjectExplorer";

function projectDocument(id: string, filename: string, props: Partial<Document> = {}): Document {
  return {
    id, filename, project_id: "matter-1", file_type: "pdf",
    pdf_storage_path: "brief.pdf", size_bytes: 10, page_count: 1,
    created_at: "2026-07-27T00:00:00.000Z", ...props
  };
}

function projectFolder(id: string, name: string): Folder {
  return { id, name, parent_folder_id: null };
}

function chooseDocumentAction(filename: string, label: string) {
  const row = screen.getByText(filename).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

function projectExplorer(props: Partial<React.ComponentProps<typeof ProjectExplorer>> = {}) {
  return <ProjectExplorer documents={[]} onDocClick={vi.fn()} {...props} />;
}

describe("ProjectExplorer document removal", () => {
  it("opens root PDF and DOCX rows with their current versions and tolerates an empty folder", async () => {
    const user = userEvent.setup();
    const onDocClick = vi.fn();
    const base = { user_id: "user-1", folder_id: null, pdf_storage_path: "file.pdf",
      active_version_number: 1 };
    const pdf = projectDocument("pdf-1", "Brief.pdf", { ...base, current_version_id: "pdf-version" });
    const docx = projectDocument("docx-1", "Agreement.docx", {
      ...base,
      file_type: "docx", current_version_id: "docx-version"
    });

    render(projectExplorer({
      documents: [pdf, docx],
      folders: [projectFolder("empty-folder", "Empty folder")],
      onDocClick,
    }));

    await user.click(screen.getByText("Brief.pdf"));
    await user.click(screen.getByText("Agreement.docx"));
    await user.click(screen.getByText("Empty folder"));

    expect(onDocClick).toHaveBeenNthCalledWith(1, pdf);
    expect(onDocClick).toHaveBeenNthCalledWith(2, docx);
    expect(screen.getByText("Empty folder")).toBeInTheDocument();
  });

  it("treats a folder's expanded children area as its drop target", async () => {
    const onMoveDoc = vi.fn(async () => {});
    const source = projectDocument("source", "Source.pdf", {
      folder_id: null,
      pdf_storage_path: null, size_bytes: 1
    });
    const child = { ...source, id: "child", filename: "Child.pdf", folder_id: "folder" };
    const dataTransfer = {
      types: ["application/mike-doc"],
      getData: (type: string) => (type === "application/mike-doc" ? source.id : ""),
    };

    render(projectExplorer({
      documents: [source, child],
      folders: [projectFolder("folder", "Folder")],
      onMoveDoc,
    }));

    fireEvent.click(screen.getByText("Folder"));
    const childRow = screen.getByText("Child.pdf");
    fireEvent.dragOver(childRow, { dataTransfer });
    fireEvent.drop(childRow, { dataTransfer });

    await waitFor(() => expect(onMoveDoc).toHaveBeenCalledWith(source.id, "folder"));
  });

  it("confirms a local detach and explains that Library files are kept", async () => {
    const user = userEvent.setup();
    const onDeleteDoc = vi.fn(async () => {});

    render(projectExplorer({
      documents: [projectDocument("document-1", "Brief.pdf", { active_version_number: 1 })],
      onDeleteDoc,
      documentRemovalMode: "detach",
    }));

    chooseDocumentAction("Brief.pdf", "Remove from project");

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

    render(projectExplorer({
      documents: [projectDocument("document-1", "Brief.pdf", { active_version_number: 1 })],
      onDeleteDoc,
      documentRemovalMode: "detach",
    }));

    chooseDocumentAction("Brief.pdf", "Remove from project");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "The document could not be removed from this project.",
      ),
    ).toBeInTheDocument();
  });

  it("moves a document from its row menu without drag and drop", async () => {
    const user = userEvent.setup();
    const onMoveDoc = vi.fn(async () => {});
    const document = projectDocument("document-1", "Authorities.research.md", { folder_id: null, file_type: "md" });
    render(projectExplorer({
      documents: [document],
      folders: [projectFolder("evidence", "Evidence")],
      onMoveDoc,
    }));

    const row = screen.getByText("Authorities").closest("li")!;
    expect(screen.queryByText("Authorities.research.md")).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Move/u }));
    const destination = within(screen.getByRole("dialog", { name: "Move Authorities" }))
      .getByRole("button", { name: "Evidence" });
    destination.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onMoveDoc).toHaveBeenCalledWith("document-1", "evidence"));
  });

  it("renames a folder from a standalone keyboard-editable field", async () => {
    const user = userEvent.setup();
    const onRenameFolder = vi.fn(async () => {});
    render(projectExplorer({
      folders: [projectFolder("evidence", "Evidence")],
      onRenameFolder,
    }));

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Evidence" });
    expect(input.closest("button")).toBeNull();
    await user.clear(input);
    await user.type(input, "Exhibits{Enter}");

    await waitFor(() => expect(onRenameFolder).toHaveBeenCalledWith("evidence", "Exhibits"));
  });
});
