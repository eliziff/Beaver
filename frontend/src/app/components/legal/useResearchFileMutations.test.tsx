import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { BeaverApiError } from "@/app/lib/api/client";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { useResearchFileMutations } from "./useResearchFileMutations";

const api = vi.hoisted(() => ({ actOnResearchFile: vi.fn(), getResearchFile: vi.fn(),
  runResearchFileQuery: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", () => ({
  actOnResearchFile: api.actOnResearchFile,
  getResearchFile: api.getResearchFile,
  runResearchFileQuery: api.runResearchFileQuery
}));
const file = (id: string, workingRevision = 0) => ({ document: { id }, versionId: `v-${id}`,
  workingRevision, state: { labels: {}, sources: {}, queries: null, note: "",
    schemaVersion: "beaver.research.v2" } } as ResearchFile);
beforeEach(() => vi.clearAllMocks());

it("serializes actions against each returned revision", async () => {
  const changed = vi.fn();
  api.actOnResearchFile.mockImplementation(async (id, versionId, revision) => ({
    ...file(id, revision + 1), versionId,
  }));
  const { result } = renderHook(() => useResearchFileMutations(file("one"), changed));
  await act(async () => { await Promise.all([
    result.current.act({ type: "note", markdown: "one" }),
    result.current.act({ type: "note", markdown: "two" }),
  ]); });
  expect(api.actOnResearchFile.mock.calls.map((call) => call[2])).toEqual([0, 1]);
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ workingRevision: 2 }));
});

it("does not publish a completed mutation from a closed workspace", async () => {
  let finish!: (value: ResearchFile) => void;
  api.actOnResearchFile.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const changed = vi.fn(), { result, rerender } = renderHook(({ current }) =>
    useResearchFileMutations(current, changed), { initialProps: { current: file("one") } });
  const pending = result.current.act({ type: "note", markdown: "old" });
  await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalled());
  rerender({ current: file("two") }); finish(file("one", 1));
  await act(async () => { await pending; });
  expect(changed).not.toHaveBeenCalled();
});

it("does not retry non-revision conflicts", async () => {
  api.actOnResearchFile.mockRejectedValue(new BeaverApiError({ status: 409,
    message: "Canonical passage unavailable" }));
  const { result } = renderHook(() => useResearchFileMutations(file("one"), vi.fn()));
  await expect(result.current.act({ type: "note", markdown: "one" })).rejects
    .toThrow("Canonical passage unavailable");
  expect(api.getResearchFile).not.toHaveBeenCalled();
  expect(api.actOnResearchFile).toHaveBeenCalledTimes(1);
});

it("recognizes a memo saved before its response was lost and saves subsequent edits", async () => {
  let stored = file("one"), connected = false;
  api.actOnResearchFile.mockImplementation(async (_id, _version, revision, action) => {
    if (revision !== stored.workingRevision || action.expectedMarkdown !== stored.state.note)
      throw new BeaverApiError({ status: 409, code: "memo_conflict", message: "Memo conflict" });
    stored = { ...stored, workingRevision: revision + 1, state: { ...stored.state, note: action.markdown } };
    if (!connected) { connected = true; throw new TypeError("Failed to fetch"); }
    return stored;
  });
  api.getResearchFile.mockImplementation(async () => stored);
  const changed = vi.fn(), { result } = renderHook(() => useResearchFileMutations(file("one"), changed));
  await act(async () => { await result.current.act({ type: "note", markdown: "Analysis", expectedMarkdown: "" }); });
  expect(stored.workingRevision).toBe(1);
  expect(changed).toHaveBeenLastCalledWith(stored);
  await act(async () => { await result.current.act({ type: "note", markdown: "Further analysis", expectedMarkdown: "Analysis" }); });
  expect(stored.state.note).toBe("Further analysis");
  expect(stored.workingRevision).toBe(2);
});

it("does not overwrite another writer's memo when reconnecting", async () => {
  const stored = { ...file("one", 1), state: { ...file("one").state, note: "Other analysis" } };
  api.actOnResearchFile.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockImplementation(async (_id, _version, _revision, action) => {
      if (action.expectedMarkdown !== stored.state.note)
        throw new BeaverApiError({ status: 409, code: "memo_conflict", message: "Memo conflict" });
      stored.state.note = action.markdown;
      return stored;
    });
  api.getResearchFile.mockResolvedValue(stored);
  const { result } = renderHook(() => useResearchFileMutations(file("one"), vi.fn()));
  await expect(result.current.act({ type: "note", markdown: "My draft", expectedMarkdown: "" })).rejects.toThrow("Memo conflict");
  expect(stored.state.note).toBe("Other analysis");
});
