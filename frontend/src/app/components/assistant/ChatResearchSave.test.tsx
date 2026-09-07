import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "../legal/SourcesWorkspace";
import { ChatResearchSave } from "./ChatResearchSave";
const api = vi.hoisted(() => ({ ensureSourcesWorkspace: vi.fn(), openWorkspaceTable: vi.fn(), getResearchFile: vi.fn(), previewWorkspaceTable: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
const file = { document: { id: "workspace", filename: "Research.research.md", project_id: null },
  versionId: "v1", workingRevision: 0, state: { sources: {}, labels: {} } } as ResearchFile;
const preview = { fingerprint: "a".repeat(64), design: { title: "Research", columns: [{ index: 0, name: "Finding", prompt: "Question?" }],
  cells: [{ rowId: "source", columnIndex: 0, itemIds: ["item"] }] }, rows: [{ id: "source", sourceId: "source", title: "Case A" }],
  stats: [{ index: 0, reused: 1, kinds: ["answer"], evidence: 1 }], samples: [{ rowId: "source", columnIndex: 0, text: "Grounded prior work", kinds: ["answer"] }] };
function Location() { const location = useLocation(); return <output aria-label="Location">{location.pathname}{location.search}
  {location.state?.assistantIntent?.text}</output>; }
function setup() { render(<MemoryRouter><SourcesWorkspaceProvider><ChatResearchSave chatId="chat" /><Location />
  </SourcesWorkspaceProvider></MemoryRouter>); }
function open(name: "Workspace" | "Table") {
  fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear();
  api.ensureSourcesWorkspace.mockResolvedValue(file); api.getResearchFile.mockResolvedValue(file); api.previewWorkspaceTable.mockResolvedValue(preview); });
it("opens the chat's Sources workspace directly", async () => {
  setup(); open("Workspace");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/sources?research_file=workspace"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("previews grounded Chat work and creates a table only after acceptance", async () => {
  api.openWorkspaceTable.mockResolvedValue({ id: "table" });
  setup(); open("Table");
  expect(await screen.findByText("Grounded prior work")).toBeVisible();
  expect(api.openWorkspaceTable).not.toHaveBeenCalled();
  expect(api.previewWorkspaceTable).toHaveBeenCalledWith("workspace", { rows: "sources", chatId: "chat" });
  fireEvent.click(screen.getByRole("button", { name: "Open review" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/table"));
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", { rows: "sources", chatId: "chat", messageIds: undefined,
    design: preview.design, fingerprint: preview.fingerprint });
});
