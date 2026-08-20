import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildOracle } from "./oracle";

const VECTORS = path.join(__dirname, "vectors.json");
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function verifyOracle(write = false) {
  const observed = buildOracle();
  const bytes = `${JSON.stringify(observed)}\n`;
  if (write) writeFileSync(VECTORS, bytes);
  const frozen = JSON.parse(readFileSync(VECTORS, "utf8")) as typeof observed;
  assert.deepEqual(observed, frozen);
  assert.equal(frozen.schema_version, "source-structure-port-oracle.v1");
  assert.equal(frozen.suites.real_captured.length, 24);
  assert.deepEqual(
    [...new Set(frozen.suites.real_captured.map(({ profile }) => profile))].sort(),
    ["case_contiguous_complete", "case_lossy", "case_rooted_complete", "journal", "legislation"],
  );
  for (const vector of frozen.suites.real_captured) {
    assert.equal(vector.provenance, "real-captured");
    const fixture = path.resolve(__dirname, "../../..", vector.fixture.path);
    assert.equal(sha(readFileSync(fixture)), vector.fixture.sha256, vector.id);
    assert.equal(sha(JSON.stringify(vector.expected.value)), vector.expected.sha256, vector.id);
  }
  const parity = frozen.suites.provider_final_parity;
  assert.deepEqual(
    Object.keys(parity.row_bindings).sort(),
    parity.coverage_rows.map(({ id }) => id).sort(),
  );
  const vectorIds = new Set(frozen.suites.real_captured.map(({ id }) => id));
  for (const [row, binding] of Object.entries(parity.row_bindings)) {
    if (typeof binding === "string") assert(vectorIds.has(binding), row);
    else {
      assert.equal(binding.status, "not_applicable", row);
      assert.match(binding.query_sha256 ?? "", /^[0-9a-f]{64}$/u, row);
    }
  }
  const serialized = JSON.stringify(frozen);
  assert(!/[A-Za-z]:[\\/]|AppData|LOCALAPPDATA/u.test(serialized));
  assert.equal(frozen.suites.synthetic_offset_control.utf16_length, 10);
  assert.equal(frozen.suites.synthetic_offset_control.scalar_length, 8);
  return { bytes: Buffer.byteLength(bytes), sha256: sha(bytes), vectors: 24 };
}

if (require.main === module) {
  const result = verifyOracle(process.argv.includes("--write"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
