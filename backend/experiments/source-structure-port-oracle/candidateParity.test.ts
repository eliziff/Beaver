import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { legalStructureBinary } from "../../src/lib/structureEngineClient";
import { compareCandidates } from "./candidate";

const binary = legalStructureBinary();

describe.runIf(
  process.env.STRUCTURE_SIDECAR_CONTRACT === "1" && existsSync(binary),
)("real SourceDocs to shared-Rust parity", () => {
  it("preserves 23 frozen SourceDocs and does not recover inside a final journal export", async () => {
    const results = await compareCandidates(binary);
    expect(results.filter(({ passthrough }) => passthrough)).toHaveLength(3);
    expect(results).toHaveLength(24);
    expect(results.filter(({ ok }) => !ok)).toEqual([{
      id: "journal-final-recovery-9284", ok: false, passthrough: false,
      expected_blocks: 2, actual_blocks: 1, first_mismatch: 1,
      expected: ["paragraph", "par1", 0, 1264, "heuristic", null, [], null], actual: null,
      public_sha256: "cc51a66802adc7f68237a54afee956ad45c017ba569ffe13aac515e6376a3a02",
      canonical_sha256: "9dbf5cfc15bc4d8b9618258222ed2930a3c9767281079a2ea7bcfd935be18daa",
    }]);
  });
});
