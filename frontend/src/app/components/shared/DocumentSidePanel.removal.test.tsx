import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Document, DocumentVersion } from "@/app/lib/api/documents";

import { DocumentSidePanel } from "./DocumentSidePanel";

const api = vi.hoisted(() => ({ getResearchFile: vi.fn() }));

vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getResearchFile: api.getResearchFile
}));
vi.mock("@/app/components/shared/views/DocumentViewer", () => ({
  DocumentViewer: ({
    versionId,
    preferPdfRendition,
    refetchKey,
  }: {
    versionId?: string | null;
    preferPdfRendition?: boolean;
    refetchKey?: string | number;
  }) => (
    <div
      data-testid="word-preview"
      data-version-id={versionId ?? ""}
      data-prefer-pdf={String(!!preferPdfRendition)}
      data-revision={refetchKey ?? ""}
    >
      Word preview
    </div>
  ),
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
  current_version_id: "version-3",
};

const version3: DocumentVersion = {
  id: "version-3",
  version_number: 3,
  working_revision: 0,
  created_by: "local-user",
  source: "upload",
  created_at: "2026-07-27T00:00:00.000Z",
  filename: "Brief.pdf",
  file_type: "pdf",
  size_bytes: 100,
  page_count: 1,
  source_sha256: "a".repeat(64),
  comment: null,
  parent_version_id: "version-2",
};

type PanelProps = ComponentProps<typeof DocumentSidePanel>;
const panel = (props: Partial<PanelProps> & Pick<PanelProps, "versions">) =>
  <DocumentSidePanel doc={document} versionsLoading={false} onClose={vi.fn()}
    onLoadVersions={vi.fn()} onSelectVersion={vi.fn()} onDownloadVersion={vi.fn()}
    onRenameDocument={vi.fn()} onCheckpointVersion={vi.fn()} onRestoreVersion={vi.fn()}
    onCompareVersions={vi.fn()} onUploadNewVersion={vi.fn(async () => {})}
    onDelete={vi.fn()} {...props} />;
const renderPanel = (props: Partial<PanelProps> & Pick<PanelProps, "versions">) =>
  render(panel(props));

describe("DocumentSidePanel document removal", () => {
  it("previews a current research document and links to its Sources workspace", async () => {
    const onRenameDocument = vi.fn();
    const researchDocument: Document = { ...document, project_id: null,
      filename: "Authorities.research.md", file_type: "md",
      storage_path: "authorities.research.md", pdf_storage_path: null,
      current_version_id: "research-version" };
    const researchVersion: DocumentVersion = { ...version3, id: "research-version",
      filename: researchDocument.filename, file_type: "md" };
    api.getResearchFile.mockResolvedValue({ document: researchDocument,
      versionId: researchVersion.id, workingRevision: 0,
      state: { schemaVersion: "beaver.research.v2",
        labels: {
          fairness: { id: "fairness", name: "Fairness", parentId: null,
            color: "#991b1b", order: 0, scope: "source" },
          hearing: { id: "hearing", name: "Right to a hearing", parentId: "fairness",
            color: "#1d4ed8", order: 1, scope: "source" },
        },
        sources: { baker: { id: "baker", collected: true, reference: { provider: "canlii",
          id: "1999canlii699", kind: "case", title: "Baker v Canada",
          citation: "[1999] 2 SCR 817" }, labelIds: ["hearing"], badge: "",
          note: "Leading procedural fairness authority.",
          passages: { count: 1, sha256: "a".repeat(64), labelCounts: {}, unlabelledCount: 1 } } },
        queries: { count: 1, sha256: "b".repeat(64) },
        note: "Authorities on procedural fairness." } });

    renderPanel({ doc: researchDocument, currentVersionId: researchVersion.id,
      versions: [researchVersion], onRenameDocument });

    expect(screen.getByText("Authorities")).toBeInTheDocument();
    expect(await screen.findByText("Baker v Canada")).toBeInTheDocument();
    const labels = screen.getByRole("list", { name: "Labels" });
    expect(within(labels).getByText("Fairness")).toBeInTheDocument();
    expect(within(labels).getByText("Right to a hearing")).toBeInTheDocument();
    const nestedMarker = within(labels).getByRole("group", {
      name: "Labels: Fairness / Right to a hearing",
    });
    expect([...nestedMarker.querySelectorAll<HTMLElement>("[data-label-dot]")]
      .map((dot) => dot.style.backgroundColor)).toEqual(["rgb(29, 78, 216)"]);
    expect(screen.getByText("Authorities on procedural fairness.")).toBeInTheDocument();
    expect(screen.getByText("Leading procedural fairness authority.")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace contents")).toHaveTextContent(
      "1 source · 0 highlights · 2 labels · 1 search",
    );
    expect(screen.queryByText(/values underlying/u)).toBeNull();
    expect(screen.queryByLabelText("Research panels")).toBeNull();
    expect(screen.getByRole("link", { name: "Open in Sources" })).toHaveAttribute(
      "href", "/sources?research_file=document-1",
    );
    expect(api.getResearchFile).toHaveBeenCalledWith(researchDocument.id);
    expect(screen.queryByTestId("word-preview")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename document" }));
    const name = screen.getByRole("textbox", { name: "Document name" });
    expect(name).toHaveValue("Authorities");
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Cancelled rename" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText("Authorities")).toBeVisible();
    expect(onRenameDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rename document" }));
    const editedName = screen.getByRole("textbox", { name: "Document name" });
    expect(editedName).toHaveValue("Authorities");
    fireEvent.change(editedName, { target: { value: "Appeal authorities" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save document name" })));
    expect(onRenameDocument).toHaveBeenCalledWith(document.id, "Appeal authorities.research.md");
  });

  it("bounds a large research preview until more sources are requested", async () => {
    const researchDocument: Document = { ...document, project_id: null,
      filename: "Large.research.md", file_type: "md",
      storage_path: "large.research.md", pdf_storage_path: null,
      current_version_id: "large-version" };
    const researchVersion: DocumentVersion = { ...version3, id: "large-version",
      filename: researchDocument.filename, file_type: "md" };
    const long = "x".repeat(1_100), labels = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [
      `label-${index}`, { id: `label-${index}`, name: `Label ${index}`, parentId: index ? null : "label-20",
        color: "#991b1b", order: index === 20 ? 0 : index, scope: index > 20 ? "highlight" as const : "source" as const },
    ])), sources = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [
      `source-${index}`, { id: `source-${index}`, collected: true, reference: { provider: "canlii",
        id: `case-${index}`, kind: "case", title: `Source ${index}` },
        labelIds: index ? [] : ["label-0"], badge: "", note: index ? "" : `Source note ${long} SOURCE_NOTE_TAIL`,
        passages: index ? null : { count: 41, sha256: "c".repeat(64), labelCounts: { "label-21": 41 }, unlabelledCount: 0 } },
    ]));
    api.getResearchFile.mockResolvedValue({ document: researchDocument,
      versionId: researchVersion.id, workingRevision: 0,
      state: { schemaVersion: "beaver.research.v2", labels, sources,
        queries: null, note: `Workspace note ${long} WORKSPACE_NOTE_TAIL` } });

    const { container } = renderPanel({ doc: researchDocument, currentVersionId: researchVersion.id,
      versions: [researchVersion] });

    const sourceList = await screen.findByRole("list", { name: "Saved sources" });
    expect(within(sourceList).getByText("Source 39")).toBeInTheDocument();
    expect(within(sourceList).queryByText("Source 40")).toBeNull();
    const labelList = screen.getByRole("list", { name: "Labels" });
    expect(within(labelList).getAllByRole("listitem")).toHaveLength(41);
    expect(within(labelList).getByText("Label 40")).toBeInTheDocument();
    expect(within(labelList).getByRole("group", {
      name: "Labels: Label 20 / Label 0",
    })).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace contents")).toHaveTextContent(
      "41 sources · 41 highlights · 41 labels",
    );
    expect(container).not.toHaveTextContent(/(?:SOURCE|PASSAGE|WORKSPACE)_(?:NOTE|TEXT)_TAIL/u);
    expect(container.textContent?.match(/…/gu)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Next sources" }));

    expect(await within(sourceList).findByText("Source 40")).toBeInTheDocument();
    expect(within(sourceList).queryByText("Source 0")).toBeNull();
    expect(screen.getByRole("button", { name: "Previous sources" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next sources" })).toBeDisabled();
  });

  it("hands its document to an existing workflow dock", async () => {
    const onOpenWorkflows = vi.fn();
    const onClose = vi.fn();
    renderPanel({ versions: [version3], onOpenWorkflows, onClose });

    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));

    expect(onOpenWorkflows).toHaveBeenCalledWith([document]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Workflows" })).toBeNull();
  });

  it("opens the known current DOCX rendition before version rows load", async () => {
    const docxDocument = {
      ...document,
      filename: "Brief.docx",
      file_type: "docx",
      storage_path: "brief.docx",
      pdf_storage_path: "brief.pdf",
      current_version_id: "version-3",
      current_working_revision: 4,
      updated_at: "2026-07-28T00:00:00.000Z",
    };
    const docxVersion = {
      ...version3,
      filename: "Brief.docx",
      file_type: "docx",
      working_revision: 4,
    };

    const { rerender } = renderPanel({ doc: docxDocument, versions: [], versionsLoading: true });

    const preview = await screen.findByTestId("word-preview");
    expect(preview).toHaveAttribute("data-version-id", "version-3");
    expect(preview).toHaveAttribute("data-prefer-pdf", "true");
    expect(preview).toHaveAttribute(
      "data-revision",
      "version-3:4",
    );
    rerender(panel({ doc: docxDocument, currentVersionId: "version-3",
      versions: [docxVersion] }));

    expect(screen.getByTestId("word-preview")).toBe(preview);
  });

  it("reveals long version histories incrementally", async () => {
    const user = userEvent.setup();
    const versions = Array.from({ length: 1000 }, (_, index) => {
      const number = index + 1;
      return {
        ...version3,
        id: `version-${number}`,
        version_number: number,
        filename: `Brief revision ${number}.pdf`,
      };
    }).reverse();
    renderPanel({ versions });

    const list = await screen.findByRole("table", {
      name: "Document versions",
    });
    const previews = within(list).getAllByRole("button", {
      name: /^Preview Version/u,
    });
    expect(previews).toHaveLength(40);

    await user.click(within(list).getByRole("button", { name: "Show more" }));
    expect(within(list).getAllByRole("button", {
      name: /^Preview Version/u,
    })).toHaveLength(80);
  });

  it("keeps the document name editable while previewing history and restores or compares explicitly", async () => {
    const onRestoreVersion = vi.fn(async () => {});
    const onCompareVersions = vi.fn(async () => {});
    const onRenameDocument = vi.fn(async () => {});
    const versions = [3, 2].map((number) => ({ ...version3,
      id: `version-${number}`, version_number: number, filename: "Brief.docx",
      file_type: "docx", parent_version_id: number === 2 ? "version-1" : "version-2" }));
    renderPanel({ versions, onRestoreVersion, onCompareVersions, onRenameDocument, versionId: "version-2" });

    expect(screen.getByText("Brief.pdf")).toBeVisible();
    expect(screen.getByRole("button", { name: /Preview Version 3:.*Current/u })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Rename document" }));
    expect(screen.getByRole("textbox", { name: "Document name" })).toHaveValue("Brief.pdf");
    fireEvent.change(screen.getByRole("textbox", { name: "Document name" }), { target: { value: "Renamed.pdf" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save document name" })));
    expect(onRenameDocument).toHaveBeenCalledWith("document-1", "Renamed.pdf");

    expect(screen.queryByRole("button", { name: /Replace current/u })).toBeNull();
    await act(async () => fireEvent.click(
      screen.getByRole("button", {
        name: "Download comparison: Version 2 to current Version 3",
      }),
    ));
    expect(onCompareVersions).toHaveBeenCalledWith(
      "document-1", "version-2", "version-3",
    );
    fireEvent.click(screen.getByRole("button", {
      name: "Restore Version 2 as a new current version",
    }));
    expect(screen.getByText(/become a new current version/u)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restore" })));
    expect(onRestoreVersion).toHaveBeenCalledWith("document-1", "version-2");
    expect(screen.getByRole("button", { name: "Rename document" })).toBeVisible();
  });

  it("only offers a checkpoint after the current document has changed", () => {
    const { rerender } = renderPanel({ versions: [version3] });
    expect(screen.queryByRole("form", { name: "Save version" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download Version 3" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore Version 3 as a new current version" })).toBeDisabled();
    rerender(panel({ versions: [{ ...version3, working_revision: 1 }] }));
    expect(screen.getByRole("form", { name: "Save version" })).toBeVisible();
    rerender(panel({ versions: [version3] }));
    expect(screen.queryByRole("form", { name: "Save version" })).toBeNull();
  });

  it("creates an explicit version with an optional comment", async () => {
    const user = userEvent.setup(), onCheckpointVersion = vi.fn(async () => {});
    renderPanel({ versions: [{ ...version3, working_revision: 1 }], onCheckpointVersion });
    const form = await screen.findByRole("form", { name: "Save version" });
    await user.type(within(form).getByRole("textbox", { name: /Version comment/u }),
      "Before filing");
    await user.click(within(form).getByRole("button", { name: "Save version" }));
    expect(onCheckpointVersion).toHaveBeenCalledWith("document-1", "Before filing");
  });

  it("reports and retries a failed version-history load", async () => {
    const user = userEvent.setup(), onLoadVersions = vi.fn();
    renderPanel({ versions: [], versionsError: true, onLoadVersions });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load version history");
    onLoadVersions.mockClear();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onLoadVersions).toHaveBeenCalledWith("document-1", true);
  });

  it("does not offer a broken preview for unsupported versions", () => {
    renderPanel({ versions: [{ ...version3, filename: "Slides.pptx", file_type: "pptx" }] });
    expect(screen.queryByRole("button", { name: /Preview Version 3/u })).toBeNull();
    expect(screen.getByRole("button", { name: /Select Version 3/u })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download Version 3" })).toBeEnabled();
    expect(screen.getByText("Preview is not available for this file type.")).toBeInTheDocument();
  });

  it("reports a failed version action without closing the document", async () => {
    const user = userEvent.setup();
    renderPanel({
      versions: [version3],
      onDownloadVersion: vi.fn().mockRejectedValue(new Error("offline")),
    });

    await user.click(await screen.findByRole("button", {
      name: "Download Version 3",
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not download this version.",
    );
    expect(screen.getByRole("dialog", { name: /Brief\.pdf$/u })).toBeInTheDocument();
  });

  it("uses stored file type and concise assistant provenance", async () => {
    const versions = [
      { ...version3, id: "version-2", version_number: 2,
        filename: "Brief.pdf", file_type: "docx" },
      { ...version3, filename: "Brief.pdf", file_type: "docx",
        author_email: "lawyer@example.test", comment: "Ready for review",
        provenance: { actor: "assistant", action: "edited", change_count: 2 } },
    ];
    renderPanel({ versions });

    expect(await screen.findByRole("button", {
      name: "Download comparison: prior Version 2 to current Version 3",
    })).toBeInTheDocument();
    expect(screen.getByTitle(/Beaver edit · 2 changes/u)).toBeInTheDocument();
    expect(screen.getByText(/lawyer@example\.test/u)).toBeInTheDocument();
    expect(screen.queryByText("You")).toBeNull();
    expect(screen.queryByText(/local-user/u)).toBeNull();
    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Date" })).toBeInTheDocument();
  });

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

it("expands a Library preview in place and restores its size without reloading", () => {
  renderPanel({ versions: [version3], versionId: version3.id });
  const viewer = screen.getByTestId("word-preview");
  viewer.scrollTop = 120;
  fireEvent.click(screen.getByRole("button", { name: "Expand reader" }));
  expect(screen.getByRole("button", { name: "Restore reader size" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("word-preview")).toBe(viewer);
  viewer.scrollTop = 0;
  fireEvent.keyDown(screen.getByRole("button", { name: "Restore reader size" }), { key: "Escape" });
  expect(screen.getByRole("button", { name: "Expand reader" })).toHaveAttribute("aria-pressed", "false");
  expect(viewer.scrollTop).toBe(120);
  expect(screen.getByTestId("word-preview")).toBe(viewer);
});
