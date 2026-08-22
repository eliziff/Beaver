import { describe, expect, it } from "vitest";

import {
  materializeSourceStructure,
  type SourceStructureInput,
} from "../sourceStructureAdapter";

const input = (text: string, start: number, end: number): SourceStructureInput => ({
  provider: "courtlistener",
  id: "range-control",
  text,
  providerRevision: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  scope: { kind: "complete" },
  profile: "case_lossy",
  nativeBlocks: [{ kind: "paragraph", label: "par1", start, end, origin: "native" }],
  order: "position",
});

describe("SourceDoc structure evidence", () => {
  it("rejects invalid provider UTF-16 boundaries", () => {
    expect(() => materializeSourceStructure(input("text", 0, 5)))
      .toThrow("invalid provider UTF-16 range");
    expect(() => materializeSourceStructure({
      ...input("text", 0, 4),
      exclusions: [{ start: -1, end: 2 }],
    })).toThrow("invalid provider UTF-16 range");
    expect(() => materializeSourceStructure(input("A\u{1f4da}B", 0, 2)))
      .toThrow("splits a Unicode scalar");
  });
});
