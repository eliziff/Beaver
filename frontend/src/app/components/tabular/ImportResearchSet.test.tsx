import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { ImportResearchSet } from "./ImportResearchSet";
const api = vi.hoisted(() => ({ getResearchFile: vi.fn(), previewWorkspaceTable: vi.fn(), openWorkspaceTable: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
vi.mock("@/app/hooks/useSelectedModel", () => ({ useSelectedModel: () => ["model", vi.fn()], useSelectedReasoningEffort: () => [undefined, vi.fn()] }));
const file = { document: { id: "workspace", filename: "Research.research.md" }, state: { labels: {}, sources: {} } } as ResearchFile;
const preview = { fingerprint: "a".repeat(64), design: { title: "Research", columns: [{ index: 0, name: "Finding", prompt: "Question?" }],
  cells: [{ rowId: "source", columnIndex: 0, itemIds: ["item"] }] }, rows: [{ id: "source", sourceId: "source", title: "Case A" }],
  stats: [{ index: 0, reused: 1, kinds: ["answer"], evidence: 1 }], samples: [{ rowId: "source", columnIndex: 0, text: "Grounded prior work", kinds: ["answer"] }] };
const create = () => screen.getByRole("button", { name: "Create table" });
async function ready() { await waitFor(() => expect(create()).toBeEnabled()); return create(); }
const ask = (text: string) => { fireEvent.change(screen.getByLabelText("Change the proposal"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Propose again" })); };

beforeEach(() => { vi.clearAllMocks(); api.getResearchFile.mockResolvedValue(file); api.previewWorkspaceTable.mockResolvedValue(preview); });
it("preserves exact scope in previews and submits only the accepted reference mapping", async () => {
  const onOpen = vi.fn(), selection = { target: "passages" as const, members: [{ sourceId: "source", evidenceIds: ["e_saved"] }] };
  api.openWorkspaceTable.mockResolvedValue({ id: "review" });
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={onOpen} fileId="workspace" selection={selection} />);
  await ready(); expect(screen.getByDisplayValue("Finding")).toBeVisible();
  expect(api.openWorkspaceTable).not.toHaveBeenCalled();
  expect(api.previewWorkspaceTable).toHaveBeenCalledWith("workspace", { selection, model: "model" });
  fireEvent.click(create());
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/tabular-reviews/review"));
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", { selection,
    design: preview.design, fingerprint: preview.fingerprint });
});
it("keeps a failed suggestion from replacing the last usable preview", async () => {
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={vi.fn()} fileId="workspace" />);
  await ready(); api.previewWorkspaceTable.mockRejectedValueOnce(new Error("No model configured"));
  ask("The reasons given");
  expect(await screen.findByRole("alert")).toHaveTextContent("No model configured");
  expect(await screen.findByDisplayValue("Finding")).toBeVisible();
  expect(api.openWorkspaceTable).not.toHaveBeenCalled();
});
it("shows the proposal rejection alongside the preserved workspace columns", async () => {
  api.previewWorkspaceTable.mockResolvedValueOnce({ ...preview, fallback: "The proposal omitted the saved concept Notice" });
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={vi.fn()} fileId="workspace" />);
  await ready();
  expect(screen.getByRole("status")).toHaveTextContent("omitted the saved concept Notice");
  expect(screen.getByDisplayValue("Finding")).toBeVisible();
});
it("shows proposed columns and marks genuinely unanswered questions", async () => {
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={vi.fn()} fileId="workspace" />);
  await ready(); api.previewWorkspaceTable.mockResolvedValueOnce({ ...preview, design: { ...preview.design,
    columns: [...preview.design.columns, { index: 2, name: "Costs", prompt: "Were costs awarded?" }] },
    stats: [...preview.stats, { index: 2, reused: 0, kinds: [], evidence: 0 }] });
  ask("Costs too");
  await screen.findByDisplayValue("Costs");
  expect(api.previewWorkspaceTable).toHaveBeenLastCalledWith("workspace", { model: "model", request: "Costs too" });
  expect(await screen.findByText(/New ? Extracted for every source/)).toBeVisible();
});
it("shows a stale-preview rejection without navigating away or silently reinterpreting it", async () => {
  const onOpen = vi.fn(); api.openWorkspaceTable.mockRejectedValueOnce(new Error("Research changed; refresh the preview"));
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={onOpen} fileId="workspace" />);
  await ready(); fireEvent.click(create());
  expect(await screen.findByRole("alert")).toHaveTextContent("Research changed");
  expect(onOpen).not.toHaveBeenCalled(); expect(screen.getByDisplayValue("Finding")).toBeVisible();
});
it("ignores an older preview response after the selected research changes", async () => {
  let finish!: (value: unknown) => void;
  api.previewWorkspaceTable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const props = { open: true, onClose: vi.fn(), onOpen: vi.fn() };
  const view = render(<ImportResearchSet {...props} fileId="old" />);
  view.rerender(<ImportResearchSet {...props} fileId="new" />); await ready();
  await act(async () => finish({ ...preview, design: { ...preview.design, title: "Obsolete work" } }));
  expect(screen.queryByDisplayValue("Obsolete work")).not.toBeInTheDocument();
});
