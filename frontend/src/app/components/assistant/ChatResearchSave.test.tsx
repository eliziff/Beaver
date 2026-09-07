import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "../legal/SourcesWorkspace";
import { ChatResearchSave } from "./ChatResearchSave";
const api = vi.hoisted(() => ({ ensureSourcesWorkspace: vi.fn(), openWorkspaceTable: vi.fn(), getResearchFile: vi.fn(), previewResearchTable: vi.fn(), queryWorkspaceFindings: vi.fn(), saveFindingHighlights: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
const file = { document: { id: "workspace", filename: "Research.research.md", project_id: null },
  versionId: "v1", workingRevision: 0, state: { sources: {}, labels: {} } } as ResearchFile;
function Location() { const location = useLocation(); return <output aria-label="Location">{location.pathname}{location.search}
  {location.state?.assistantIntent?.text}</output>; }
function setup() { render(<MemoryRouter><SourcesWorkspaceProvider><ChatResearchSave chatId="chat" latestMessageId="latest" /><Location />
  </SourcesWorkspaceProvider></MemoryRouter>); }
function open(name: "Workspace" | "Table") {
  fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear();
  api.ensureSourcesWorkspace.mockResolvedValue(file); api.getResearchFile.mockResolvedValue(file); });
const finding = { reference: { kind: "answer", chatId: "chat", answerId: "answer", resource: "resource" }, sourceId: "source",
  answer: { claims: [{ text: "Existing finding", evidence_ids: ["e_1"] }] }, evidence: [{ evidence_id: "e_1", name: "Case", locator: { label: "4" }, span_text: "Original passage" }] };
it("previews grounded chat research and opens it without silently saving highlights", async () => {
  api.queryWorkspaceFindings.mockResolvedValue({ items: [finding], total: 1, next_offset: null });
  setup(); open("Workspace");
  expect(await screen.findByRole("dialog", { name: "Collect chat research" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "Open research" })).toBeEnabled());
  expect(api.saveFindingHighlights).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open research" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/sources?research_file=workspace"));
  expect(api.saveFindingHighlights).not.toHaveBeenCalled();
});
it("converts a selected answer only after a populated table preview is accepted", async () => {
  api.previewResearchTable.mockResolvedValue({ title: "Research", basis: "basis", columns: [{ index: 0, name: "Reason", prompt: "Why?", fieldIds: ["claim"] }],
    fields: [], reuse: [{ index: 0, reused: 1, unrun: 0 }], preview: [{ title: "Case", values: ["Existing finding"] }], arrangement: { rows: [{ id: "source" }] } });
  api.openWorkspaceTable.mockResolvedValue({ id: "table" });
  setup(); open("Table");
  await screen.findByText("Existing finding");
  expect(api.openWorkspaceTable).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Chat conversion scope"), { target: { value: "latest" } });
  await waitFor(() => expect(api.previewResearchTable).toHaveBeenLastCalledWith("workspace", expect.objectContaining({ chatId: "chat", messageIds: ["latest"] }), expect.any(AbortSignal)));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create review" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Create review" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/table"));
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", expect.objectContaining({ chatId: "chat", messageIds: ["latest"], basis: "basis" }));
});
