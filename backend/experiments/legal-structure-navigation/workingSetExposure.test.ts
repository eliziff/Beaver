import { describe, expect, it } from "vitest";
import {
  coveredLength,
  mergeIntervals,
  readCoversBody,
} from "./workingSetExposure";

describe("working-set body exposure", () => {
  it("merges overlaps and measures only the requested span", () => {
    expect(mergeIntervals([
      [10, 20], [15, 30], [30, 40], [50, 50], [70, 60],
    ])).toEqual([[10, 40], [60, 70]]);
    expect(coveredLength([[0, 10], [90, 200]], 0, 100)).toBe(20);
  });

  it("does not mistake overlapping windows or an index for a full read", () => {
    expect(readCoversBody({
      sourceChars: 46_943,
      deliveredChars: 48_584,
      intervals: [[0, 38_000], [39_000, 46_943]],
    })).toBe(false);
    expect(readCoversBody({
      sourceChars: 1_000,
      bodyStart: 200,
      intervals: [[0, 200]],
    })).toBe(false);
    expect(readCoversBody({
      sourceChars: 1_000,
      bodyStart: 200,
      intervals: [[200, 1_000]],
    })).toBe(true);
  });
});
