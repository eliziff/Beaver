import { describe, expect, it, vi } from "vitest";
import { sourceReadings } from "./sourceReadings";

type Input = { signal?: AbortSignal; progress?: (done: number, total: number) => void };

describe("kept source readings", () => {
  it("joins a running reading, tells each reader its progress, and stops it only once every reader has gone", async () => {
    const readings = sourceReadings();
    let finish = (_: { pages: string[] }) => {}, input: Input = {};
    const read = vi.fn((given: Input) => { input = given; return new Promise<{ pages: string[] }>((resolve) => { finish = resolve; }); });
    const heard: string[] = [], first = new AbortController();
    const one = readings({ source: "a" }, { signal: first.signal, progress: (done) => heard.push(`one ${done}`) }, read);
    const two = readings({ source: "a" }, { progress: (done) => heard.push(`two ${done}`) }, read);
    input.progress?.(1, 2);
    first.abort(new Error("left"));
    await expect(one).rejects.toThrow("left");
    expect(input.signal?.aborted).toBe(false);
    input.progress?.(2, 2);
    finish({ pages: ["read once"] });
    const value = await two;
    expect(value).toEqual({ pages: ["read once"] });
    expect(read).toHaveBeenCalledTimes(1);
    expect(heard).toEqual(["one 1", "two 1", "two 2"]);
    // Each reader has its own copy: changing one does not change the reading kept.
    value.pages.push("changed");
    expect(await readings({ source: "a" }, {}, read)).toEqual({ pages: ["read once"] });

    const alone = new AbortController();
    const abandoned = readings({ source: "b" }, { signal: alone.signal }, read);
    alone.abort(new Error("gone"));
    await expect(abandoned).rejects.toThrow("gone");
    expect(input.signal?.aborted).toBe(true);
  });

  it("keeps the readings used last within its limit and reads again what it let go", async () => {
    const readings = sourceReadings(50), read = vi.fn(async (_: Input) => ({ text: "x".repeat(10) }));
    for (const source of ["a", "b", "a", "c", "a", "b"]) await readings({ source }, {}, read);
    // a, b, a (kept), c (b goes), a (kept), b (read again; c goes).
    expect(read).toHaveBeenCalledTimes(4);
    expect(await readings({ source: "large" }, {}, async () => ({ text: "x".repeat(100) }))).toEqual({ text: "x".repeat(100) });
    await readings({ source: "a" }, {}, read);
    expect(read).toHaveBeenCalledTimes(4);
  });
});
