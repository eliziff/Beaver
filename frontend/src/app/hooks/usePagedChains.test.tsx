import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { usePagedChains } from "./usePagedChains";

it("refreshes only changed content, retaining visible items and loaded page depth", async () => {
  let finish: (() => void) | undefined;
  const load = vi.fn(async (key: string, cursor: string | null) => {
    if (finish === undefined) await new Promise<void>((resolve) => { finish = resolve; });
    return { items: [`${key}-${cursor ?? "first"}`], next_cursor: cursor ? null : "second" };
  });
  const { result, rerender } = renderHook(({ revisions }) =>
    usePagedChains(load, [], "a", true, revisions),
  { initialProps: { revisions: { a: "1", b: "1" } } });
  await act(async () => finish!());
  await act(async () => { await result.current.fetchPage("a", "second", true);
    await result.current.fetchPage("b", null, false); });
  expect(result.current.chains.a.items).toEqual(["a-first", "a-second"]);
  const unchanged = result.current.chains.b;
  finish = undefined;
  rerender({ revisions: { a: "2", b: "1" } });
  expect(result.current.chains.a.items).toEqual(["a-first", "a-second"]);
  expect(result.current.chains.b).toBe(unchanged);
  await act(async () => finish!());
  await waitFor(() => expect(result.current.chains.a.loading).toBe(false));
  expect(result.current.chains.a.items).toEqual(["a-first", "a-second"]);
  expect(result.current.chains.b).toBe(unchanged);
  expect(load.mock.calls.map(([key]) => key)).toEqual(["a", "a", "b", "a", "a"]);
});
