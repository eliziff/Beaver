import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type Dispatch, type SetStateAction, useState } from "react";
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
const secondDocument: Document = {
  ...document,
  id: "document-2",
  filename: "Memo.pdf",
  storage_path: "memo.pdf",
  pdf_storage_path: "memo.pdf",
};

function chooseAction(label: string) {
  const select = screen.getByRole("combobox", { name: "More actions" });
  const option = within(select).getByRole("option", {
    name: label,
  }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
}

function Harness({
  removeDocument,
  onActions,
  documentRemovalMode = "detach",
  initialDocuments = [document],
  initialFolders = [],
  search = "",
  onOwnerOnlyAction,
}: {
  removeDocument: (documentId: string) => Promise<void>;
  onActions?: (actions: DocTableSelectionActions | null) => void;
  documentRemovalMode?: "delete" | "detach";
  initialDocuments?: Document[];
  initialFolders?: DocTableFolder[];
  search?: string;
  onOwnerOnlyAction?: Dispatch<SetStateAction<string | null>>;
}) {
  const [documents, setDocuments] = useState<Document[]>(initialDocuments);
  const [folders, setFolders] =
    useState<DocTableFolder[]>(initialFolders);
  return (
    <DocTable
      scopeKey="matter-1"
      documents={documents}
      setDocuments={setDocuments}
      folders={folders}
      setFolders={setFolders}
      loading={false}
      search={search}
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
      onOwnerOnlyAction={onOwnerOnlyAction}
      documentRemovalMode={documentRemovalMode}
    />
  );
}

function selectDocument(filename: string) {
  const row = screen.getByText(filename).closest("[data-document-row]");
  fireEvent.click(within(row as HTMLElement).getByRole("checkbox"));
}

describe("DocTable document removal", () => {
  it("uses a folder icon for an empty document collection", () => {
    const { container } = render(
      <Harness
        removeDocument={vi.fn(async () => {})}
        initialDocuments={[]}
      />,
    );

    expect(container.querySelector("svg.lucide-folder")).not.toBeNull();
  });

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

  it("keeps the loaded page until its authoritative refresh after partial removal", async () => {
    const removeDocument = vi.fn(async (documentId: string) => {
      if (documentId === secondDocument.id) throw new Error("offline");
    });
    let actions: DocTableSelectionActions | null = null;
    render(
      <Harness
        removeDocument={removeDocument}
        initialDocuments={[document, secondDocument]}
        onActions={(next) => {
          actions = next;
        }}
      />,
    );

    selectDocument(document.filename);
    selectDocument(secondDocument.filename);
    await waitFor(() => expect(actions?.selectedCount).toBe(2));
    await act(async () => {
      await actions!.onDelete();
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(removeDocument).toHaveBeenCalledTimes(2));
    expect(screen.getByText(document.filename)).toBeInTheDocument();
    expect(screen.getByText(secondDocument.filename)).toBeInTheDocument();
  });

  it("does not remove a selected document owned by another user", async () => {
    const removeDocument = vi.fn(async () => {});
    const onOwnerOnlyAction = vi.fn();
    let actions: DocTableSelectionActions | null = null;
    render(
      <Harness
        removeDocument={removeDocument}
        initialDocuments={[{ ...document, user_id: "other-user" }]}
        onActions={(next) => {
          actions = next;
        }}
        onOwnerOnlyAction={onOwnerOnlyAction}
      />,
    );

    selectDocument(document.filename);
    await waitFor(() => expect(actions).not.toBeNull());
    await act(async () => {
      await actions!.onDelete();
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(onOwnerOnlyAction).toHaveBeenCalledWith(
        "remove 1 of the selected documents — only the document creator can remove a document from this project",
      ),
    );
    expect(removeDocument).not.toHaveBeenCalled();
    expect(screen.getByText(document.filename)).toBeInTheDocument();
  });

  it("renders nested search results through the normal document row", () => {
    const folder: DocTableFolder = {
      id: "folder-1",
      project_id: "matter-1",
      user_id: "local-user",
      name: "Research",
      parent_folder_id: null,
      created_at: "2026-07-27T00:00:00.000Z",
      updated_at: "2026-07-27T00:00:00.000Z",
    };
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
        search="memo"
      />,
    );

    expect(screen.getByText("Memo.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Brief.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("combobox", { name: "More actions" }),
    ).toHaveLength(1);
  });

  it("keeps the folder row action for creating a focused subfolder", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const folder: DocTableFolder = {
      id: "folder-1",
      project_id: "matter-1",
      user_id: "local-user",
      name: "Research",
      parent_folder_id: null,
      created_at: "2026-07-27T00:00:00.000Z",
      updated_at: "2026-07-27T00:00:00.000Z",
    };

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
