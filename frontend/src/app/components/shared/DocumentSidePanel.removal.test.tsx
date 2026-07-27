import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import type { DocumentVersion } from "@/app/lib/beaverApi";
import { DocumentSidePanel } from "./DocumentSidePanel";

vi.mock("@/app/components/shared/views/PdfView", () => ({
  PdfView: () => <div>PDF preview</div>,
}));
vi.mock("@/app/components/shared/views/DocxView", () => ({
  DocxView: () => <div>Word preview</div>,
}));
vi.mock("@/app/components/shared/views/SpreadsheetView", () => ({
  SpreadsheetView: () => <div>Spreadsheet preview</div>,
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

const version3: DocumentVersion = {
  id: "version-3",
  version_number: 3,
  source: "upload",
  created_at: "2026-07-27T00:00:00.000Z",
  filename: "Brief.pdf",
  file_type: "pdf",
  deleted_at: null,
};

function renderPanel({
  versions,
  onDelete = vi.fn(async () => {}),
  documentRemovalMode = "delete",
}: {
  versions: DocumentVersion[];
  onDelete?: (doc: Document) => Promise<void>;
  documentRemovalMode?: "delete" | "detach";
}) {
  render(
    <DocumentSidePanel
      doc={document}
      versions={versions}
      versionsLoading={false}
      onClose={vi.fn()}
      onLoadVersions={vi.fn()}
      onSelectVersion={vi.fn()}
      onDownloadDocument={vi.fn()}
      onDownloadVersion={vi.fn()}
      onRenameVersion={vi.fn()}
      onDeleteVersion={vi.fn()}
      onUploadNewVersion={vi.fn(async () => {})}
      onReplaceVersion={vi.fn()}
      onDelete={onDelete}
      documentRemovalMode={documentRemovalMode}
    />,
  );
}

describe("DocumentSidePanel document removal", () => {
  it("counts the surviving version rows instead of the version number", async () => {
    renderPanel({ versions: [version3] });

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(
      screen.getByText(
        "Brief.pdf has 1 version. Deleting this document will delete all of its versions.",
      ),
    ).toBeInTheDocument();
  });

  it("uses generic deletion copy until version rows are available", async () => {
    renderPanel({ versions: [] });

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(
      screen.getByText(
        "Delete Brief.pdf? This will delete the document and all of its versions.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has 3 versions/u)).not.toBeInTheDocument();
  });

  it("shows a warning when a side-panel detach fails", async () => {
    const onDelete = vi.fn(async () => {
      throw new Error("offline");
    });
    renderPanel({
      versions: [version3],
      onDelete,
      documentRemovalMode: "detach",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove" }).at(-1)!,
    );

    expect(
      await screen.findByText(
        "The document could not be removed from this project. Please try again.",
      ),
    ).toBeInTheDocument();
  });
});
