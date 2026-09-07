import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { ImportResearchSet } from "./ImportResearchSet";
const api = vi.hoisted(() => ({ getResearchFile: vi.fn(), previewWorkspaceTable: vi.fn(), openWorkspaceTable: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
vi.mock("@/app/hooks/useSelectedModel", () => ({ useSelectedModel: () => ["model", vi.fn()] }));
const file = { document: { id: "workspace", filename: "Research.research.md" }, state: { labels: {}, sources: {} } } as ResearchFile;
const preview = { fingerprint: "a".repeat(64), design: { title: "Research", columns: [{ index: 0, name: "Finding", prompt: "Question?" }],
  cells: [{ rowId: "source", columnIndex: 0, itemIds: ["item"] }] }, rows: [{ id: "source", sourceId: "source", title: "Case A" }],
  stats: [{ index: 0, reused: 1, kinds: ["answer"], evidence: 1 }], samples: [{ rowId: "source", columnIndex: 0, text: "Grounded prior work", kinds: ["answer"] }] };
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
async function toShape() { await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled()); next();
  return screen.findByLabelText("What would you like to compare?"); }
async function toReview() { await toShape(); next(); return screen.findByRole("button", { name: "Create review" }); }

beforeEach(() => { vi.clearAllMocks(); api.getResearchFile.mockResolvedValue(file); api.previewWorkspaceTable.mockResolvedValue(preview); });
it("preserves exact scope in previews and submits only the accepted reference mapping", async () => {
  const onOpen = vi.fn(), selection = { target: "passages" as const, members: [{ sourceId: "source", evidenceIds: ["e_saved"] }] };
  api.openWorkspaceTable.mockResolvedValue({ id: "review" });
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={onOpen} fileId="workspace" selection={selection} />);
  await toReview(); expect(screen.getByText("Grounded prior work")).toBeVisible();
  expect(api.openWorkspaceTable).not.toHaveBeenCalled();
  expect(api.previewWorkspaceTable).toHaveBeenCalledWith("workspace", { rows: "sources", selection });
  fireEvent.click(screen.getByRole("button", { name: "Create review" }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/tabular-reviews/review"));
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", { rows: "sources", selection,
    design: preview.design, fingerprint: preview.fingerprint });
});
it("keeps a failed suggestion from replacing the last usable preview", async () => {
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={vi.fn()} fileId="workspace" />);
  await toShape(); api.previewWorkspaceTable.mockRejectedValueOnce(new Error("No model configured"));
  fireEvent.change(screen.getByLabelText("What would you like to compare?"), { target: { value: "Compare reasons" } });
  fireEvent.click(screen.getByRole("button", { name: "Suggest layout" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("No model configured"); next();
  expect(await screen.findByText("Grounded prior work")).toBeVisible();
  expect(api.openWorkspaceTable).not.toHaveBeenCalled();
});
it("requires acceptance after assisted layout and shows genuinely unanswered questions", async () => {
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={vi.fn()} fileId="workspace" />);
  await toShape(); api.previewWorkspaceTable.mockResolvedValueOnce({ ...preview, design: { ...preview.design,
    columns: [...preview.design.columns, { index: 2, name: "Costs", prompt: "Were costs awarded?" }] },
    stats: [...preview.stats, { index: 2, reused: 0, kinds: [], evidence: 0 }] });
  fireEvent.change(screen.getByLabelText("What would you like to compare?"), { target: { value: "Compare costs too" } });
  fireEvent.click(screen.getByRole("button", { name: "Suggest layout" }));
  await screen.findByDisplayValue("Costs"); next();
  expect(await screen.findByText("will be extracted")).toBeVisible();
});
it("shows a stale-preview rejection without navigating away or silently reinterpreting it", async () => {
  const onOpen = vi.fn(); api.openWorkspaceTable.mockRejectedValueOnce(new Error("Research changed; refresh the preview"));
  render(<ImportResearchSet open onClose={vi.fn()} onOpen={onOpen} fileId="workspace" />);
  await toReview(); fireEvent.click(screen.getByRole("button", { name: "Create review" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Research changed");
  expect(onOpen).not.toHaveBeenCalled(); expect(screen.getByText("Grounded prior work")).toBeVisible();
});
it("ignores an older preview response after the selected research changes", async () => {
  let finish!: (value: unknown) => void;
  api.previewWorkspaceTable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const props = { open: true, onClose: vi.fn(), onOpen: vi.fn() };
  const view = render(<ImportResearchSet {...props} fileId="old" />);
  view.rerender(<ImportResearchSet {...props} fileId="new" />); await toReview();
  await act(async () => finish({ ...preview, samples: [{ ...preview.samples[0], text: "Obsolete work" }] }));
  expect(screen.queryByText("Obsolete work")).not.toBeInTheDocument();
});
