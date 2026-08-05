// Body-plane read semantics for the SECT-INDEX arm (audit fix wave A2):
// "fully read" is interval coverage of the body span, never a char-count sum,
// and scoped-only enforcement requires an ADDRESSABLE index — the first wave
// forced scoped reads on documents whose index carried 0-7% usable anchors.
import { describe, expect, it } from "vitest";
import {
  coveredLength,
  mergeIntervals,
  readCoversBody,
} from "../localAssistantTools";
import {
  attachStructureIndex,
  indexIsAddressable,
} from "../structureIndexExperiment";

describe("mergeIntervals", () => {
  it("merges overlaps and adjacency, drops degenerates, normalizes order", () => {
    expect(
      mergeIntervals([
        [10, 20],
        [15, 30],
        [30, 40],
        [50, 50],
        [70, 60],
      ]),
    ).toEqual([
      [10, 40],
      [60, 70],
    ]);
  });
});

describe("coveredLength", () => {
  it("clamps coverage to the queried span", () => {
    expect(coveredLength([[0, 100]], 40, 60)) .toBe(20);
    expect(coveredLength([[0, 10], [90, 200]], 0, 100)).toBe(20);
    expect(coveredLength([], 0, 100)).toBe(0);
  });
});

describe("readCoversBody", () => {
  it("overlapping windows never fake completeness while a hole remains", () => {
    // The EMP run's exact failure shape: deliveredChars summed past
    // sourceChars while [38000, 39000) stayed unread.
    const read = {
      sourceChars: 46_943,
      deliveredChars: 48_584,
      bodyStart: 0,
      intervals: [
        [0, 38_000],
        [39_000, 46_943],
      ] as Array<[number, number]>,
    };
    expect(readCoversBody(read)).toBe(false);
    expect(
      readCoversBody({ ...read, intervals: [[0, 46_943]] }),
    ).toBe(true);
  });

  it("body coverage ignores the index span before bodyStart", () => {
    expect(
      readCoversBody({
        sourceChars: 1_000,
        bodyStart: 200,
        intervals: [[200, 1_000]],
      }),
    ).toBe(true);
    // Only the index was read — the body is untouched.
    expect(
      readCoversBody({
        sourceChars: 1_000,
        bodyStart: 200,
        intervals: [[0, 200]],
      }),
    ).toBe(false);
  });

  it("falls back to char counts for legacy entries and refuses empty sources", () => {
    expect(readCoversBody({ sourceChars: 100, deliveredChars: 100 })).toBe(true);
    expect(readCoversBody({ sourceChars: 100, deliveredChars: 99 })).toBe(false);
    expect(readCoversBody({ sourceChars: 0, deliveredChars: 0 })).toBe(false);
  });
});

describe("indexIsAddressable", () => {
  const served = (lines: string[], body = "BODY TEXT") => {
    const index = ["SECT-INDEX (derived …)", ...lines].join("\n");
    const full = attachStructureIndex(body, index);
    return { full, bodyOffset: full.length - body.length };
  };

  it("rejects an index with zero anchors (4 of 5 HSR docs)", () => {
    const { full, bodyOffset } = served([
      "  Section 1 — Overview",
      "  Section 2 — Findings",
      "  Section 3 — Risks",
    ]);
    expect(indexIsAddressable(full, bodyOffset)).toBe(false);
  });

  it("rejects a large index with few anchors (EMP redline: 113 lines, 8 anchored)", () => {
    const lines = Array.from({ length: 113 }, (_, i) =>
      i < 8 ? `  Section ${i} — Anchored  @${i * 100}` : `  Section ${i} — Bare`,
    );
    const { full, bodyOffset } = served(lines);
    expect(indexIsAddressable(full, bodyOffset)).toBe(false);
  });

  it("rejects a tiny fully-anchored spine below the absolute floor", () => {
    const { full, bodyOffset } = served([
      "  Section 1  @0",
      "  Section 2  @40",
      "  Section 3  @90",
    ]);
    expect(indexIsAddressable(full, bodyOffset)).toBe(false);
  });

  it("accepts a well-anchored index (company draft: 167 lines, 129 anchored)", () => {
    const lines = Array.from({ length: 167 }, (_, i) =>
      i < 129 ? `  Section ${i} — Anchored  @${i * 100}` : `  Section ${i} — Bare`,
    );
    const { full, bodyOffset } = served(lines);
    expect(indexIsAddressable(full, bodyOffset)).toBe(true);
  });

  it("rejects when no index is attached (bodyOffset 0)", () => {
    expect(indexIsAddressable("BODY TEXT", 0)).toBe(false);
  });

  it("does not count the banner line as an entry", () => {
    // 5 anchored entries out of 5 → addressable; the banner must not dilute
    // the fraction or satisfy the anchored count by accident.
    const { full, bodyOffset } = served([
      "  Section 1  @0",
      "  Section 2  @40",
      "  Section 3  @90",
      "  Section 4  @140",
      "  Section 5  @190",
    ]);
    expect(indexIsAddressable(full, bodyOffset)).toBe(true);
  });
});
