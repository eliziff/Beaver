import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BeaverApiError } from "@/app/lib/api/client";
import type { ResearchAction, ResearchFile } from "@/app/lib/researchFiles";
import ResearchMemoPane from "./ResearchMemoPane";

vi.mock("./ResearchMemoEditor", () => ({ default: ({ value, onChange }: {
  value: string; onChange: (markdown: string) => void;
}) => <textarea aria-label="Memo" value={value} onChange={(event) => onChange(event.target.value)} /> }));
const file: ResearchFile = {
  document: { id: "memo-file", filename: "Research.research.md", project_id: "project-1",
    file_type: "md", pdf_storage_path: null, size_bytes: null, page_count: null, created_at: null },
  versionId: "v1", workingRevision: 0,
  state: { schemaVersion: "beaver.research.v2", sources: {}, labels: {}, queries: null, note: "Initial memo" },
};
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.useRealTimers());

it("recovers an unsaved draft after a failed save and reopening the workspace", async () => {
  const mutations = { act: vi.fn().mockRejectedValue(new Error("The memo changed elsewhere.")), query: vi.fn() };
  const props = { file, mutations, onOpenCitation: vi.fn() };
  vi.useFakeTimers();
  const view = render(<ResearchMemoPane {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Memo" }), { target: { value: "My unsaved analysis" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
  expect(screen.getByRole("alert")).toHaveTextContent("The memo changed elsewhere.");
  view.unmount();
  render(<ResearchMemoPane {...props} file={{ ...file, state: { ...file.state, note: "Newer saved analysis" } }} />);
  expect(screen.getByRole("textbox", { name: "Memo" })).toHaveValue("My unsaved analysis");
});

it("keeps edits typed while a save is in flight and saves them against the new base", async () => {
  let release!: () => void, stored = file.state.note;
  const first = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  const mutations = { act: async (action: ResearchAction) => {
    if (action.type !== "note") throw new Error("Expected a memo");
    if (++writes === 1) await first;
    if (action.expectedMarkdown !== stored) throw new Error("Memo conflict");
    stored = action.markdown;
    return { ...file, state: { ...file.state, note: stored } };
  }, query: vi.fn() };
  render(<ResearchMemoPane file={file} mutations={mutations} onOpenCitation={vi.fn()} />);
  const input = screen.getByRole("textbox", { name: "Memo" });
  fireEvent.change(input, { target: { value: "First edit" } });
  await waitFor(() => expect(writes).toBe(1));
  fireEvent.change(input, { target: { value: "First edit and further analysis" } });
  release();
  await waitFor(() => expect(stored).toBe("First edit and further analysis"), { timeout: 3000 });
  expect(input).toHaveValue(stored);
});

it.each([false, true])("recovers an interrupted save and later edits after reopening (server committed: %s)", async (committed) => {
  vi.useFakeTimers();
  let stored = file.state.note, connected = false;
  const mutations = { act: async (action: ResearchAction) => {
    if (action.type !== "note") throw new Error("Expected a memo");
    if (!connected) { if (committed) stored = action.markdown; throw new TypeError("Failed to fetch"); }
    if (action.markdown !== stored && action.expectedMarkdown !== stored) throw new Error("Memo conflict");
    stored = action.markdown;
    return { ...file, state: { ...file.state, note: stored } };
  }, query: vi.fn() };
  const view = render(<ResearchMemoPane file={file} mutations={mutations} onOpenCitation={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Memo" }), { target: { value: "Analysis" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not connect to save.");
  expect(screen.queryByRole("button", { name: /load saved memo/i })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Memo" }), { target: { value: "Analysis with further edits" } });
  view.unmount();
  connected = true;
  render(<ResearchMemoPane file={{ ...file, state: { ...file.state, note: stored } }} mutations={mutations} onOpenCitation={vi.fn()} />);
  expect(screen.getByRole("textbox", { name: "Memo" })).toHaveValue("Analysis with further edits");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(stored).toBe("Analysis with further edits");
  expect(screen.getByRole("textbox", { name: "Memo" })).toHaveValue(stored);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(sessionStorage.getItem("beaver.research.memo-draft:memo-file")).toBeNull();
});

it("requires an explicit discard before replacing a conflicting draft", async () => {
  const mutations = { act: vi.fn().mockRejectedValue(new BeaverApiError({ status: 409, code: "memo_conflict",
    message: "The memo changed elsewhere." })), query: vi.fn() };
  render(<ResearchMemoPane file={file} mutations={mutations} onOpenCitation={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Memo" }), { target: { value: "Keep this analysis" } });
  fireEvent.click(await screen.findByRole("button", { name: "Load saved memo" }, { timeout: 3000 }));
  expect(screen.getByRole("alertdialog", { name: "Discard this draft?" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("textbox", { name: "Memo" })).toHaveValue("Keep this analysis");
  expect(JSON.parse(sessionStorage.getItem("beaver.research.memo-draft:memo-file")!).markdown).toBe("Keep this analysis");
});
