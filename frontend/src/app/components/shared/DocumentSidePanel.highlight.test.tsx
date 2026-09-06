import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Document, DocumentVersion } from "@/app/lib/api/documents";
import { newResearchState, type ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "@/app/components/legal/SourcesWorkspace";
import { DocumentSidePanel } from "./DocumentSidePanel";

const api = vi.hoisted(() => ({ act: vi.fn(), items: vi.fn() }));

vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  actOnResearchFile: api.act,
  getResearchItems: api.items,
}));
vi.mock("@/app/components/shared/views/DocumentViewer", () => ({
  DocumentViewer: () => (
    <div data-legal-block="" data-locator-kind="page" data-locator-value="1">
      quoted words here
    </div>
  ),
}));

const document: Document = {
  id: "document-1",
  user_id: "local-user",
  project_id: null,
  filename: "Brief.pdf",
  file_type: "pdf",
  storage_path: "brief.pdf",
  pdf_storage_path: "brief.pdf",
  size_bytes: 10,
  page_count: 1,
  structure_tree: null,
  status: "ready",
  created_at: "2026-07-27T00:00:00.000Z",
  current_version_id: "version-1",
  current_working_revision: 0,
};
const version: DocumentVersion = {
  id: "version-1",
  version_number: 1,
  working_revision: 0,
  created_by: "local-user",
  source: "upload",
  created_at: "2026-07-27T00:00:00.000Z",
  filename: "Brief.pdf",
  file_type: "pdf",
  size_bytes: 10,
  page_count: 1,
  source_sha256: "a".repeat(64),
  comment: null,
  parent_version_id: null,
};
const ontologyFile = (): ResearchFile => ({ document: { id: "ontology-1",
  filename: "Labels.research.md" }, versionId: "v1", workingRevision: 1,
  state: { ...newResearchState(), labels: { "pen-1": { id: "pen-1", name: "Highlight",
    parentId: null, color: "#eab308", order: 0, scope: "highlight" } },
    sources: { "source-1": { id: "source-1", reference: { provider: "library", kind: "document",
      id: "document-1", versionId: "version-1" }, labelIds: [], badge: "", note: "",
      passages: { count: 0, sha256: "none", labelCounts: {}, unlabelledCount: 0 } } } } } as ResearchFile);

describe("DocumentSidePanel highlight", () => {
  it("saves a PDF page selection with the current pen in one request", async () => {
    api.items.mockResolvedValue({ items: [], next_cursor: null });
    api.act.mockImplementation(async (id: string, versionId: string, revision: number, action: { type: string }) =>
      ({ ...ontologyFile(), versionId, workingRevision: revision + 1, action }));
    render(<SourcesWorkspaceProvider file={ontologyFile()}>
      <DocumentSidePanel doc={document} versions={[version]} versionsLoading={false}
        onClose={vi.fn()} onLoadVersions={vi.fn(async () => {})} />
    </SourcesWorkspaceProvider>);
    const highlight = await screen.findByRole("button", { name: "Highlight" });
    expect(highlight).toHaveAttribute("aria-pressed", "false");
    const node = screen.getByText("quoted words here").firstChild!;
    const range = globalThis.document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.click(highlight);
    await waitFor(() => expect(api.act).toHaveBeenCalledTimes(1));
    expect(api.act).toHaveBeenCalledWith("ontology-1", "v1", 1, expect.objectContaining({
      type: "passage", sourceId: "source-1",
      locator: { kind: "page", value: "1" }, quote: "quoted words here", labelIds: ["pen-1"],
    }));
  });
});
