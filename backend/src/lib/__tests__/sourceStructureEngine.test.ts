import { describe, expect, it } from "vitest";

import {
  materializeSourceStructure,
  projectSourceStructure,
  type SourceStructureInput,
} from "../sourceStructureAdapter";
import type { StructureGraphV1 } from "../structureWire";

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

  it("preserves provider order for tied stable-position claims without changing position order", () => {
    const tied = {
      ...input("text", 0, 4),
      nativeBlocks: [
        { kind: "paragraph", label: "par2", start: 0, end: 4, origin: "native" },
        { kind: "footnote", label: "fn1", start: 0, end: 4, origin: "native" },
      ],
    } satisfies SourceStructureInput;
    const materialized = materializeSourceStructure(tied);
    const graph: StructureGraphV1 = {
      schema_version: "legalpdf.structure-graph.v1",
      document_id: tied.id,
      text_sha256: materialized.evidence.text_sha256,
      source_sha256: tied.sourceSha256,
      status: "complete",
      nodes: materialized.evidence.native_claims.map((claim) => ({
        id: claim.id, kind: claim.kind, label: claim.label, range: claim.range,
        origin_id: claim.origin_id, source: "native",
      })),
      boundaries: [], relations: [], diagnostics: [],
    };
    expect(projectSourceStructure({ ...materialized,
      input: { ...tied, order: "stable-position" } }, graph).blocks.map(({ label }) => label))
      .toEqual(["par2", "fn1"]);
    expect(projectSourceStructure(materialized, graph).blocks.map(({ label }) => label))
      .toEqual(["fn1", "par2"]);
  });
});
