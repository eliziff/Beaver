import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { legalStructureBinary } from "../../src/lib/structureEngineClient";
import { compareCandidates } from "./candidate";

const binary = legalStructureBinary();

describe.runIf(
  process.env.STRUCTURE_SIDECAR_CONTRACT === "1" && existsSync(binary),
)("real SourceDocs to shared-Rust parity", () => {
  it("preserves 20 frozen SourceDocs and binds four reviewed quality deltas", async () => {
    const results = await compareCandidates(binary);
    expect(results.filter(({ passthrough }) => passthrough)).toHaveLength(3);
    expect(results).toHaveLength(24);
    expect(results.filter(({ ok }) => !ok)).toEqual([
      {
        id: "a2aj-laws-fed-criminalcode-s231", ok: false, passthrough: false,
        expected_blocks: 22, actual_blocks: 22, first_mismatch: 4,
        expected: ["section", "sec231(4)", 710, 850, "heuristic", null, [], "sec231"],
        actual: ["section", "sec231(4)", 710, 1392, "heuristic", null, [], "sec231"],
        public_sha256: "04c603e4e05ea33208c88bc0567f65a05c8f130f509f3d0ee4042e3a0f11b411",
        canonical_sha256: "2e8a85507cd2b625d36e8b35e08a3907a5a0978874a8ed9ee44da393c0df65cb",
      },
      {
        id: "a2aj-laws-fed-criminalcode-sectionmap", ok: false, passthrough: false,
        expected_blocks: 53, actual_blocks: 53, first_mismatch: 1,
        expected: ["section", "sec22.1(a)", 122, 170, "heuristic", null, [], "sec22.1"],
        actual: ["section", "sec22.1(a)", 122, 450, "heuristic", null, [], "sec22.1"],
        public_sha256: "244d5cf40421b504a28b8f29b58ce13f07e4ec2b790be6d820762eeeba6a3f80",
        canonical_sha256: "771787447b7b684bd28908582fbe659a00e4e5d7f617865227b37585f32b9635",
      },
      {
        id: "a2aj-regs-on-oreg267-03", ok: false, passthrough: false,
        expected_blocks: 64, actual_blocks: 64, first_mismatch: 1,
        expected: ["section", "sec2(1)", 0, 76, "heuristic", null, [], "sec2"],
        actual: ["section", "sec2(1)", 0, 832, "heuristic", null, [], "sec2"],
        public_sha256: "c390772151b27d62946f7f592e296340540bcbfdcc5f143ba780d8035b101775",
        canonical_sha256: "78d10fff58bfaa0010f1164cc021804c5784d21e0a065b6609f15935a2cfc6d4",
      },
      {
        id: "journal-final-recovery-9284", ok: false, passthrough: false,
        expected_blocks: 2, actual_blocks: 1, first_mismatch: 1,
        expected: ["paragraph", "par1", 0, 1264, "heuristic", null, [], null], actual: null,
        public_sha256: "cc51a66802adc7f68237a54afee956ad45c017ba569ffe13aac515e6376a3a02",
        canonical_sha256: "9dbf5cfc15bc4d8b9618258222ed2930a3c9767281079a2ea7bcfd935be18daa",
      },
    ]);
  });
});
