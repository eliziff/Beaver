import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SaveFindingHighlights } from "./SaveFindingHighlights";
import { SourcesWorkspaceProvider } from "./SourcesWorkspace";
const api = vi.hoisted(() => ({ saveFindingHighlights: vi.fn(), getResearchFile: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
const file = { document: { id: "workspace" }, versionId: "v1", workingRevision: 4,
  state: { sources: {}, labels: { rule: { id: "rule", name: "Rule", color: "#aabbcc", scope: "highlight", parentId: null, order: 0 } } } } as ResearchFile;
const reference = { kind: "answer" as const, chatId: "chat", answerId: "answer", resource: "source://case", claimIndices: [1] };
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); api.getResearchFile.mockResolvedValue(file); });
it("requires a deliberate save and sends the one chosen type with the original finding reference", async () => {
  api.saveFindingHighlights.mockResolvedValue({ file, saved: 2 });
  render(<SourcesWorkspaceProvider file={file}><SaveFindingHighlights references={[reference]} /></SourcesWorkspaceProvider>);
  expect(api.saveFindingHighlights).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Save highlight type"), { target: { value: "rule" } });
  fireEvent.click(screen.getByRole("button", { name: "Save highlights" }));
  await waitFor(() => expect(api.saveFindingHighlights).toHaveBeenCalledWith(file, [reference], "rule"));
  expect(await screen.findByRole("status")).toHaveTextContent("2 highlights saved");
});
it("keeps save failures visible instead of claiming the read was highlighted", async () => {
  api.saveFindingHighlights.mockRejectedValue(new Error("Missing supporting passage"));
  render(<SourcesWorkspaceProvider file={file}><SaveFindingHighlights references={[reference]} /></SourcesWorkspaceProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Save highlights" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Missing supporting passage");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
