import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "./SourcesWorkspace";
import { AddResearchSources } from "./AddResearchSources";

const api = vi.hoisted(() => ({ getResearchFile: vi.fn(), actOnResearchFile: vi.fn(), listDirectory: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getResearchFile: api.getResearchFile, actOnResearchFile: api.actOnResearchFile }));
vi.mock("@/app/lib/api/documents", async (original) => ({
  ...await original<typeof import("@/app/lib/api/documents")>(),
  directoryResource: () => ({ list: api.listDirectory }) }));

const file = { document: { id: "workspace", filename: "Research.research.md", file_type: "md" }, versionId: "v1", workingRevision: 0,
  state: { labels: { topic: { id: "topic", name: "Relevance", scope: "source", parentId: null, order: 0, color: null } },
    sources: {}, note: "" } } as unknown as ResearchFile;

beforeEach(() => { vi.clearAllMocks(); localStorage.clear();
  api.getResearchFile.mockResolvedValue(file); api.actOnResearchFile.mockResolvedValue(file); });

it("adds pinned Library references to the current virtual folder as one atomic research action", async () => {
  const document = { id: "document", filename: "Decision.txt", file_type: "txt", current_version_id: "original-version" };
  api.listDirectory.mockResolvedValue({ items: [{ kind: "document", document }], next_cursor: null });
  render(<MemoryRouter><SourcesWorkspaceProvider file={file}>
    <AddResearchSources labelId="topic" onClose={vi.fn()} onAdded={vi.fn()} />
  </SourcesWorkspaceProvider></MemoryRouter>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Decision.txt" }));
  expect(api.actOnResearchFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add sources" }));
  await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("workspace", "v1", 0,
    { type: "batch", title: "Add Library sources", actions: [{ type: "source",
      reference: { provider: "library", kind: "document", id: "document", versionId: "original-version", title: "Decision.txt" },
      labelIds: ["topic"] }] }));
});
