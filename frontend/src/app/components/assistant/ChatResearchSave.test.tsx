import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "../legal/SourcesWorkspace";
import { ChatResearchSave } from "./ChatResearchSave";
const api = vi.hoisted(() => ({ ensureSourcesWorkspace: vi.fn(), openWorkspaceTable: vi.fn(), getResearchFile: vi.fn(), previewWorkspaceTable: vi.fn(), previewWorkspaceLabels: vi.fn(), applyWorkspaceLabels: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
vi.mock("@/app/hooks/useSelectedModel", () => ({ useSelectedModel: () => ["model", vi.fn()], useSelectedReasoningEffort: () => [undefined, vi.fn()] }));
const file = { document: { id: "workspace", filename: "Research.research.md", project_id: null },
  versionId: "v1", workingRevision: 0, state: { sources: {}, labels: {} } } as ResearchFile;
const preview = { fingerprint: "a".repeat(64), design: { title: "Research", columns: [{ index: 0, name: "Finding", prompt: "Question?" }],
  cells: [{ rowId: "source", columnIndex: 0, itemIds: ["item"] }] }, rows: [{ id: "source", sourceId: "source", title: "Case A" }],
  stats: [{ index: 0, reused: 1, kinds: ["answer"], evidence: 1 }], samples: [{ rowId: "source", columnIndex: 0, text: "Grounded prior work", kinds: ["answer"] }] };
function Location() { const location = useLocation(); return <output aria-label="Location">{location.pathname}{location.search}
  {location.state?.assistantIntent?.text}</output>; }
function setup() { render(<MemoryRouter><SourcesWorkspaceProvider><ChatResearchSave chatId="chat" /><Location />
  </SourcesWorkspaceProvider></MemoryRouter>); }
function open(name: "Workspace" | "Table" | "Open without organizing") {
  fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}
async function act(name: string) { const at = () => screen.getByRole("button", { name });
  await waitFor(() => expect(at()).toBeEnabled()); fireEvent.click(at()); }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear();
  api.ensureSourcesWorkspace.mockResolvedValue(file); api.getResearchFile.mockResolvedValue(file); api.previewWorkspaceTable.mockResolvedValue(preview); });
it("opens the chat's Sources workspace directly when organizing is declined", async () => {
  setup(); open("Open without organizing");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/sources?research_file=workspace"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("organizes the chat into a proposed label set before landing in the workspace", async () => {
  const plan = { title: "Cases stating the test", target: "sources" as const, propose: false, fingerprint: "b".repeat(64),
    design: { title: "Cases stating the test", labels: [{ key: "l1", name: "States the test" }],
      assignments: [{ labelKey: "l1", rowIds: ["source"], itemIds: ["item"] }] },
    labels: [{ key: "l1", name: "States the test", path: "States the test", parentKey: null, color: "#d6b85a",
      existing: false, rows: [{ id: "source", title: "Case A", support: ["The test is stated at para 21."] }] }],
    unassigned: [] };
  api.previewWorkspaceLabels.mockResolvedValue(plan); api.applyWorkspaceLabels.mockResolvedValue(file); setup(); open("Workspace");
  expect(await screen.findByText("States the test")).toBeVisible(); expect(api.applyWorkspaceLabels).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply labels" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/sources?research_file=workspace"));
  expect(api.applyWorkspaceLabels).toHaveBeenCalledWith("workspace", { chatId: "chat", messageIds: undefined,
    design: plan.design, fingerprint: plan.fingerprint });
});
it("previews grounded Chat work and creates a table only after acceptance", async () => {
  api.openWorkspaceTable.mockResolvedValue({ id: "table" });
  setup(); open("Table");
  expect(await screen.findByDisplayValue("Finding")).toBeVisible(); expect(api.openWorkspaceTable).not.toHaveBeenCalled();
  expect(api.previewWorkspaceTable).toHaveBeenCalledWith("workspace", expect.objectContaining({ chatId: "chat", model: "model" }));
  await act("Create table");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/table"));
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", { chatId: "chat", messageIds: undefined,
    design: preview.design, fingerprint: preview.fingerprint });
});
