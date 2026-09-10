import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type Dispatch, type SetStateAction, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import {
  DocTable,
  type DocTableFolder,
} from "./DocTable";
import { DirectoryActions, type DocumentSelectionActions } from "./UploadAction";

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "local-user" } }),
}));

vi.mock("@/app/components/shared/views/DocumentViewer", () => ({ DocumentViewer: () => null }));
vi.mock("@/app/lib/api/documents", async (original) => ({
  ...await original<typeof import("@/app/lib/api/documents")>(),
  listDocumentVersions: async () => ({ current_version_id: "version-3", versions: [{
    id: "version-3", version_number: 3, working_revision: 0, filename: "Brief.pdf",
    file_type: "pdf", created_at: "2026-07-27T00:00:00.000Z", size_bytes: 10,
  }] }),
}));

const document: Document = {
  id: "document-1",
  user_id: "local-user",
  project_id: "matter-1",
  filename: "Brief.pdf",
  file_type: "pdf",
  pdf_storage_path: "brief.pdf",
  size_bytes: 10,
  page_count: 1,
  created_at: "2026-07-27T00:00:00.000Z",
  active_version_number: 3,
};
const secondDocument: Document = {
  ...document,
  id: "document-2",
  filename: "Memo.pdf",
  pdf_storage_path: "memo.pdf",
};

const folder: DocTableFolder = {
  id: "folder-1",
  project_id: "matter-1",
  user_id: "local-user",
  name: "Research",
  parent_folder_id: null,
  created_at: "2026-07-27T00:00:00.000Z",
  updated_at: "2026-07-27T00:00:00.000Z",
};

function chooseAction(label: string) {
  fireEvent.click(screen.getAllByRole("button", { name: "More actions" })
    .find((button) => !button.hasAttribute("disabled"))!);
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

function chooseSelectedAction(label: string) {
  const header = screen.getByRole("group", { name: "Document actions" });
  fireEvent.click(within(header).getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

const DEFAULT_DOCUMENTS = [document];
const NO_FOLDERS: DocTableFolder[] = [];

function Harness({
  removeDocument,
  documentRemovalMode = "detach",
  initialDocuments = DEFAULT_DOCUMENTS,
  initialFolders = NO_FOLDERS,
  search = "",
  onOwnerOnlyAction,
}: {
  removeDocument: (documentId: string) => Promise<void>;
  documentRemovalMode?: "delete" | "detach";
  initialDocuments?: Document[];
  initialFolders?: DocTableFolder[];
  search?: string;
  onOwnerOnlyAction?: Dispatch<SetStateAction<string | null>>;
}) {
  const [selection, setSelection] = useState<DocumentSelectionActions | null>(null);
  return (
    <><DirectoryActions actions={null} onCreateFolder={null} selection={selection} />
    <DocTable
      scopeKey="matter-1"
      documents={initialDocuments}
      folders={initialFolders}
      loading={false}
      search={search}
      operations={{
        list: async ({ parent_id }) => ({
          items: initialFolders
            .filter((folder) => (folder.parent_folder_id ?? null) === (parent_id ?? null))
            .map((folder) => ({ kind: "folder" as const, folder })),
          next_cursor: null,
        }),
        removeDocument,
        uploadDocument: vi.fn(),
        uploadDocuments: vi.fn(),
        uploadDirectory: vi.fn(),
        refreshDocumentParseStates: vi.fn(),
        refreshCollection: vi.fn(),
        createFolder: vi.fn(),
        renameFolder: vi.fn(),
        deleteFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveDocument: vi.fn(),
        renameDocument: vi.fn(),
      }}
      onOwnerOnlyAction={onOwnerOnlyAction}
      onSelectionActionsChange={setSelection}
      documentRemovalMode={documentRemovalMode}
    /></>
  );
}

function selectDocument(filename: string) {
  const row = screen.getByText(filename).closest("[data-document-row]");
  fireEvent.click(within(row as HTMLElement).getByRole("checkbox"));
}

describe("DocTable document removal", () => {
  it.each(["delete", "detach"] as const)("shares the reader %s confirmation, cancellation and retry", async (mode) => {
    const removeDocument = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    render(<Harness removeDocument={removeDocument} documentRemovalMode={mode} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Brief.pdf" }));
    await screen.findByRole("button", { name: /Preview Version 3/ });
    const label = mode === "delete" ? "Delete" : "Remove";
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
    const prompt = screen.getByRole("alertdialog");
    expect(prompt).toHaveTextContent(mode === "delete" ? "has 1 version" : "Library file and its links in other projects will be kept");
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(removeDocument).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: label }));
    const warning = await screen.findByRole("alertdialog", { name: "Warning" });
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(within(warning).getByRole("button", { name: "Close" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: label }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(removeDocument).toHaveBeenCalledTimes(2);
  });

  it("shows a warning when a row detach fails", async () => {
    const removeDocument = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<Harness removeDocument={removeDocument} />);

    chooseAction("Remove from project");
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

    chooseAction("Delete");

    expect(
      screen.getByText(/This will delete the document and all of its versions/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has 3 versions/u)).not.toBeInTheDocument();
  });

  it("keeps the loaded page until its authoritative refresh after partial removal", async () => {
    const removeDocument = vi.fn(async (documentId: string) => {
      if (documentId === secondDocument.id) throw new Error("offline");
    });
    render(
      <Harness
        removeDocument={removeDocument}
        initialDocuments={[document, secondDocument]}
      />,
    );

    selectDocument(document.filename);
    selectDocument(secondDocument.filename);
    chooseSelectedAction("Remove");
    expect(removeDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await screen.findByText("1 document could not be removed from this project. Please try again.");
    expect(removeDocument.mock.calls).toEqual([["document-1"], ["document-2"]]);
    expect(screen.getByText(document.filename)).toBeInTheDocument();
    expect(screen.getByText(secondDocument.filename)).toBeInTheDocument();
  });

  it("does not remove a selected document owned by another user", async () => {
    const removeDocument = vi.fn(async () => {});
    const onOwnerOnlyAction = vi.fn();
    render(
      <Harness
        removeDocument={removeDocument}
        initialDocuments={[{ ...document, user_id: "other-user" }]}
        onOwnerOnlyAction={onOwnerOnlyAction}
      />,
    );

    selectDocument(document.filename);
    chooseSelectedAction("Remove");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(onOwnerOnlyAction).toHaveBeenCalledWith(
        "remove 1 of the selected documents — only the document creator can remove a document from this project",
      ),
    );
    expect(removeDocument).not.toHaveBeenCalled();
    expect(screen.getByText(document.filename)).toBeInTheDocument();
  });

  it("renders server-filtered Boolean results through normal document rows", () => {
    const nestedDocument: Document = {
      ...document,
      id: "document-2",
      filename: "Memo.pdf",
      folder_id: folder.id,
    };

    render(
      <Harness
        removeDocument={vi.fn(async () => {})}
        initialDocuments={[document, nestedDocument]}
        initialFolders={[folder]}
        search="memo OR brief"
      />,
    );

    expect(screen.getByText("Memo.pdf")).toBeInTheDocument();
    expect(screen.getByText("Brief.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "More actions" })
        .filter((button) => !button.hasAttribute("disabled")),
    ).toHaveLength(2);
  });

  it("keeps the folder row action for creating a focused subfolder", () => {
    Element.prototype.scrollIntoView = vi.fn();

    render(
      <Harness
        removeDocument={vi.fn(async () => {})}
        initialDocuments={[]}
        initialFolders={[folder]}
      />,
    );

    chooseAction("New subfolder inside");

    const input = screen.getByPlaceholderText("Folder name");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByPlaceholderText("Folder name"),
    ).not.toBeInTheDocument();
  });
});
