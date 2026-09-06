import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "../legal/SourcesWorkspace";
import { ChatResearchSave } from "./ChatResearchSave";
const api = vi.hoisted(() => ({ ensureSourcesWorkspace: vi.fn(), openWorkspaceTable: vi.fn(), getResearchFile: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
const file = { document: { id: "workspace", filename: "Research.research.md", project_id: null },
  versionId: "v1", workingRevision: 0, state: { sources: {}, labels: {} } } as ResearchFile;
function Location() { const location = useLocation(); return <output aria-label="Location">{location.pathname}{location.search}
  {location.state?.assistantIntent?.text}</output>; }
function setup() { render(<MemoryRouter><SourcesWorkspaceProvider><ChatResearchSave chatId="chat" /><Location />
  </SourcesWorkspaceProvider></MemoryRouter>); }
function open(name: "Workspace" | "Table") {
  fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear();
  api.ensureSourcesWorkspace.mockResolvedValue(file); api.getResearchFile.mockResolvedValue(file); });
it("opens the chat's Sources workspace directly", async () => {
  setup(); open("Workspace");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/sources?research_file=workspace"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it.each([false, true])("opens the chat's table directly whether or not it still needs arranging (%s)", async (needs_arrangement) => {
  api.openWorkspaceTable.mockResolvedValue({ id: "table", needs_arrangement });
  setup(); open("Table");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/table"));
  expect(screen.getByLabelText("Location")).not.toHaveTextContent("Arrange");
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", expect.objectContaining({ chatId: "chat" }));
});
