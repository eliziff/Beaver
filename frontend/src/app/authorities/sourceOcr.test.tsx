import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSourceOcr, type ScannedPdf } from "./sourceOcr";
import type { AuthoritiesHost } from "./host";

const scan: ScannedPdf = { role: "scan", name: "Case", sourceSha256: "one",
  textlessPages: [1, 2, 3], demand: "1" };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
};
describe("changing OCR demand", () => {
  it("recognizes the whole PDF when no cited page has a safe binding", async () => {
    const host = { sourceOcr: { progress: vi.fn(), cancel: vi.fn(),
      start: async (_id: string, _roles: string[], pages?: number[]) => {
        if (pages && !pages.length) throw new Error("Choose at least one page");
        return [{ role: "scan", documentId: "whole-pdf", done: true }];
      } } } as unknown as AuthoritiesHost;
    const { result } = renderHook(() => useSourceOcr(host, "draft"));
    await act(async () => { await result.current.begin([{ ...scan, priorityPages: [] }]); });
    expect(result.current.tracked.scan).toMatchObject({ state: "done", documentId: "whole-pdf" });
  });
  it("does not let an earlier completion finish newly requested pages", async () => {
    const first = deferred<Array<{ role: string; documentId: string; done: boolean }>>();
    const start = vi.fn().mockReturnValueOnce(first.promise)
      .mockResolvedValue([{ role: "scan", documentId: "expanded" }]);
    const host = { sourceOcr: { start, progress: vi.fn(), cancel: vi.fn() } } as unknown as AuthoritiesHost;
    const { result } = renderHook(() => useSourceOcr(host, "draft"));
    let initial!: Promise<void>, expanded!: Promise<void>;
    act(() => { initial = result.current.begin([scan]); });
    await act(async () => { await Promise.resolve(); });
    act(() => { expanded = result.current.begin([{ ...scan, demand: "1,3" }], [1, 3]); });
    await act(async () => { first.resolve([{ role: "scan", documentId: "old", done: true }]); await initial; await expanded; });
    expect(result.current.tracked.scan).toMatchObject({ state: "running", documentId: "expanded", demand: "1,3" });
    expect(start.mock.calls[1][2]).toEqual([1, 3]);
  });
  it("keeps a pause and reset safe from a late start response", async () => {
    const first = deferred<Array<{ role: string; documentId: string; done: boolean }>>();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const host = { sourceOcr: { start: vi.fn(() => first.promise), progress: vi.fn(), cancel } } as unknown as AuthoritiesHost;
    const { result } = renderHook(() => useSourceOcr(host, "draft"));
    let initial!: Promise<void>, stopped!: Promise<void>;
    act(() => { initial = result.current.begin([scan]); });
    await act(async () => { await Promise.resolve(); });
    act(() => { stopped = result.current.stop(["scan"], true); });
    await act(async () => { first.resolve([{ role: "scan", documentId: "old", done: true }]); await initial; await stopped; });
    expect(result.current.tracked.scan.state).toBe("paused");
    act(() => result.current.reset());
    expect(result.current.tracked).toEqual({});
  });
});
