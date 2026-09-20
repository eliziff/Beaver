import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "../legal/SourcesWorkspace";
import { ChatResearchFlow, type ChatResearchFlowHandle } from "./ChatResearchFlow";
const api = vi.hoisted(() => ({ ensureSourcesWorkspace: vi.fn(), openWorkspaceTable: vi.fn(), getResearchFile: vi.fn(), proposeWorkspaceTable: vi.fn(), proposeWorkspaceLabels: vi.fn(), applyWorkspaceLabels: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
vi.mock("@/app/hooks/useSelectedModel", () => ({ useSelectedModel: () => ["model", vi.fn()], useSelectedReasoningEffort: () => [undefined, vi.fn()] }));
vi.mock("@/app/lib/api/chat", async (original) => ({ ...await original<typeof import("@/app/lib/api/chat")>(),
  getChat: vi.fn().mockResolvedValue({ chat: { model: "model", reasoning_effort: null }, messages: [] }) }));
const file = { document: { id: "workspace", filename: "Research.research.md", project_id: null },
  versionId: "v1", workingRevision: 0, state: { sources: { source: { id: "source",
    reference: { provider: "a2aj", kind: "case", id: "source", title: "Case A" },
    labelIds: [], note: "", passages: null } }, labels: {} } } as ResearchFile;
const preview = { fingerprint: "a".repeat(64), design: { title: "Research", columns: [{ index: 0, name: "Finding", prompt: "Question?" }],
  cells: [{ rowId: "source", columnIndex: 0, itemIds: ["item"] }] }, rows: [{ id: "source", sourceId: "source", title: "Case A" }],
  stats: [{ index: 0, reused: 1, kinds: ["answer"], evidence: 1 }], samples: [{ rowId: "source", columnIndex: 0, text: "Grounded prior work", kinds: ["answer"] }] };
function Location() { const location = useLocation(); return <output aria-label="Location">{location.pathname}{location.search}
  {location.state?.assistantIntent?.text}</output>; }
function setup(getModelPreferences?: React.ComponentProps<typeof ChatResearchFlow>["getModelPreferences"], workspaceScope = false) {
  const ref = React.createRef<ChatResearchFlowHandle>();
  render(<MemoryRouter><SourcesWorkspaceProvider file={workspaceScope ? file : undefined}><ChatResearchFlow ref={ref} chatId="chat" workspaceScope={workspaceScope} getModelPreferences={getModelPreferences} /><Location />
  </SourcesWorkspaceProvider></MemoryRouter>);
  return ref;
}
async function open(ref: React.RefObject<ChatResearchFlowHandle | null>, name: "Workspace" | "Table") {
  await act(async () => {
    if (name === "Workspace") await ref.current?.openWorkspace();
    else await ref.current?.openTable();
  });
}
async function actOn(name: string) { const at = () => screen.getByRole("button", { name });
  await waitFor(() => expect(at()).toBeEnabled()); fireEvent.click(at()); }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear();
  api.ensureSourcesWorkspace.mockResolvedValue(file); api.getResearchFile.mockResolvedValue(file); api.proposeWorkspaceTable.mockResolvedValue(preview); });
it("organizes the whole workspace from its dock without filtering to an empty conversation", async () => {
  api.proposeWorkspaceLabels.mockResolvedValue({ title: "Draft", design: { title: "Draft", sourceLabels: [], highlightTypes: [] },
    sources: [], items: [], labels: [], unassigned: [], fingerprint: "a".repeat(64) });
  const ref = setup(undefined, true); await open(ref, "Workspace"); await actOn("Suggest labels");
  await waitFor(() => expect(api.proposeWorkspaceLabels).toHaveBeenCalledWith("workspace",
    { conversationId: "chat", model: "model", request: "Research" }, expect.any(Function), expect.any(AbortSignal)));
  expect(api.ensureSourcesWorkspace).not.toHaveBeenCalled();
});
it("organizes the chat into a proposed label set before landing in the workspace", async () => {
  const plan = { title: "Cases stating the test", target: "sources" as const, propose: false, fingerprint: "b".repeat(64),
    design: { title: "Cases stating the test", sourceLabels: [{ id: "l1", name: "States the test", members: ["source"], children: [] }], highlightTypes: [] },
    sources: [{ id: "source", title: "Case A" }], items: [],
    labels: [{ id: "l1", name: "States the test", path: "States the test",
      parentId: null, order: 0, scope: "source" as const, color: "#d6b85a",
      existing: false, rows: [{ id: "source", title: "Case A", support: ["The test is stated at para 21."] }] }],
    unassigned: [] };
  api.proposeWorkspaceLabels.mockResolvedValue(plan); api.applyWorkspaceLabels.mockResolvedValue(file);
  const ref = setup(); await open(ref, "Workspace"); await actOn("Suggest labels");
  fireEvent.click(await screen.findByText("States the test", { selector: "summary" }));
  expect(screen.getByLabelText("Move source from States the test")).toBeVisible(); expect(api.applyWorkspaceLabels).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply labels" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/sources?research_file=workspace"));
  expect(api.applyWorkspaceLabels).toHaveBeenCalledWith("workspace", { chatId: "chat",
    design: plan.design, fingerprint: plan.fingerprint });
});
it("previews grounded Chat work and creates a table only after acceptance", async () => {
  api.openWorkspaceTable.mockResolvedValue({ id: "table" });
  const ref = setup(); await open(ref, "Table"); await actOn("Suggest a table");
  expect(await screen.findByDisplayValue("Finding")).toBeVisible(); expect(api.openWorkspaceTable).not.toHaveBeenCalled();
  expect(api.proposeWorkspaceTable).toHaveBeenCalledWith("workspace", expect.objectContaining({ chatId: "chat", model: "model" }), expect.any(Function), expect.any(AbortSignal));
  await actOn("Create table");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/table"));
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", { chatId: "chat",
    design: preview.design, fingerprint: preview.fingerprint });
});
it("uses the composer's current model and effort when Open as is chosen", async () => {
  let current = { model: "old-model", reasoningEffort: "low" };
  const ref = setup(() => current);
  current = { model: "codex:gpt-5.6-sol", reasoningEffort: "high" };
  await open(ref, "Table"); await actOn("Suggest a table");
  await waitFor(() => expect(api.proposeWorkspaceTable).toHaveBeenCalledWith("workspace",
    expect.objectContaining(current), expect.any(Function), expect.any(AbortSignal)));
});
