import { StrictMode, useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { newResearchState, type ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider, useSourcesWorkspace } from "./SourcesWorkspace";

const api = vi.hoisted(() => ({ file: vi.fn(), findings: vi.fn(), passages: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getResearchFile: api.file, getWorkspaceFindings: api.findings, getResearchItems: api.passages }));
const file = (id = "workspace"): ResearchFile => ({ document: { id, filename: `${id}.research.md` }, versionId: "v1", workingRevision: 1,
  state: { ...newResearchState(), sources: { source: { id: "source", reference: { provider: "library", kind: "document", id: "document", versionId: "original" },
    labelIds: [], badge: "", note: "", passages: { count: 1, sha256: "original", labelCounts: {}, unlabelledCount: 1 } } } } } as ResearchFile);
function Results() {
  const workspace = useSourcesWorkspace(), page = workspace.findings.chains.source, passages = workspace.passages.chains.source;
  useEffect(() => { if (!page) void workspace.findings.fetchPage("source", null, false); }, [page, workspace.findings.fetchPage]);
  useEffect(() => { if (!passages) void workspace.passages.fetchPage("source", null, false); }, [passages, workspace.passages.fetchPage]);
  return <><p>{workspace.file?.document.id}</p>{page?.items.map((item, index) => <p key={index}>{item.question.title}</p>)}
    {passages?.items.map((item, index) => <p key={index}>{item.kind === "passage" && item.value.receipt.span_text}</p>)}
    <button onClick={() => void workspace.open("next")}>Open next workspace</button></>;
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  api.file.mockResolvedValue(file());
  api.findings.mockResolvedValue({ items: [{ question: { title: "Original finding" } }], next_offset: null });
  api.passages.mockResolvedValue({ items: [{ kind: "passage", value: { receipt: { span_text: "Original saved passage" } } }], next_cursor: null });
});
it("loads findings and saved passages when hosted consumers mount in StrictMode", async () => {
  render(<StrictMode><SourcesWorkspaceProvider file={file()}><Results /></SourcesWorkspaceProvider></StrictMode>);
  expect(await screen.findByText("Original finding")).toBeVisible();
  expect(await screen.findByText("Original saved passage")).toBeVisible();
});
it("refreshes linked findings on focus even when the workspace revision is unchanged", async () => {
  render(<SourcesWorkspaceProvider file={file()}><Results /></SourcesWorkspaceProvider>);
  await screen.findByText("Original finding");
  api.findings.mockResolvedValue({ items: [{ question: { title: "Completed table finding" } }], next_offset: null });
  fireEvent.focus(window);
  expect(await screen.findByText("Completed table finding")).toBeVisible();
  expect(screen.queryByText("Original finding")).not.toBeInTheDocument();
});
it("keeps the newer workspace when an older refresh finishes afterwards", async () => {
  let finish!: (value: ResearchFile) => void;
  api.file.mockImplementation((id) => id === "next" ? Promise.resolve(file("next")) : new Promise((resolve) => { finish = resolve; }));
  render(<SourcesWorkspaceProvider file={file()}><Results /></SourcesWorkspaceProvider>);
  fireEvent.focus(window);
  fireEvent.click(screen.getByRole("button", { name: "Open next workspace" }));
  await waitFor(() => expect(screen.getByText("next")).toBeVisible());
  await act(async () => finish(file()));
  expect(screen.getByText("next")).toBeVisible();
});
