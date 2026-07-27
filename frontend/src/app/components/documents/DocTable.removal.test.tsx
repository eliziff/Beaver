import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import {
  DocTable,
  type DocTableFolder,
  type DocTableSelectionActions,
} from "./DocTable";

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "local-user" } }),
}));

const document: Document = {
  id: "document-1",
  user_id: "local-user",
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
  active_version_number: 3,
};

function Harness({
  removeDocument,
  onActions,
  documentRemovalMode = "detach",
}: {
  removeDocument: (documentId: string) => Promise<void>;
  onActions?: (actions: DocTableSelectionActions | null) => void;
  documentRemovalMode?: "delete" | "detach";
}) {
  const [documents, setDocuments] = useState<Document[]>([document]);
  const [folders, setFolders] = useState<DocTableFolder[]>([]);
  return (
    <DocTable
      scopeKey="matter-1"
      documents={documents}
      setDocuments={setDocuments}
      folders={folders}
      setFolders={setFolders}
      loading={false}
      search=""
      operations={{
        removeDocument,
        uploadDocument: vi.fn(),
        refreshCollection: vi.fn(),
        createFolder: vi.fn(),
        renameFolder: vi.fn(),
        deleteFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveDocument: vi.fn(),
        renameDocument: vi.fn(),
      }}
      onSelectionActionsChange={onActions}
      documentRemovalMode={documentRemovalMode}
    />
  );
}

describe("DocTable document removal", () => {
  it("requires confirmation before detaching a selected document", async () => {
    const removeDocument = vi.fn(async () => {});
    let actions: DocTableSelectionActions | null = null;

    render(
      <Harness
        removeDocument={removeDocument}
        onActions={(next) => {
          actions = next;
        }}
      />,
    );
    fireEvent.click(screen.getAllByRole("checkbox").at(-1)!);
    await waitFor(() => expect(actions).not.toBeNull());

    await act(async () => {
      await actions!.onDelete();
    });
    expect(removeDocument).not.toHaveBeenCalled();
    expect(screen.getByText("Remove from project?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(removeDocument).toHaveBeenCalledWith("document-1"),
    );
  });

  it("shows a warning when a row detach fails", async () => {
    const removeDocument = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<Harness removeDocument={removeDocument} />);

    fireEvent.contextMenu(screen.getByText("Brief.pdf"));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from project" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "The document could not be removed from this project. Please try again.",
      ),
    ).toBeInTheDocument();
  });

  it("does not infer a version count before version rows are loaded", () => {
    render(
      <Harness
        removeDocument={vi.fn(async () => {})}
        documentRemovalMode="delete"
      />,
    );

    fireEvent.contextMenu(screen.getByText("Brief.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      screen.getByText(/This will delete the document and all of its versions/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has 3 versions/u)).not.toBeInTheDocument();
  });

  it("uses detach language when selected removals fail", async () => {
    const removeDocument = vi.fn(async () => {
      throw new Error("offline");
    });
    let actions: DocTableSelectionActions | null = null;
    render(
      <Harness
        removeDocument={removeDocument}
        onActions={(next) => {
          actions = next;
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole("checkbox").at(-1)!);
    await waitFor(() => expect(actions).not.toBeNull());
    await act(async () => {
      await actions!.onDelete();
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "1 document could not be removed from this project. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not be deleted/u)).not.toBeInTheDocument();
  });
});
