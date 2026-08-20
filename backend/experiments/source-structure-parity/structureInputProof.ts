import { createHash } from "node:crypto";

import type { StructureEvidenceV1 } from "../../src/lib/structureWire";

export const STRUCTURE_INPUT_BYTES_CONTRACT =
  "structure-input.v1: u64le-length-framed contract tag, canonical evidence metadata, and raw UTF-8 text; object keys sorted, array order preserved";

function json(value: unknown) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Structure evidence contains an undefined value");
  return encoded;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return json(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Structure evidence contains a non-finite number");
    return json(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().flatMap((key) => record[key] === undefined ? [] : [
      `${json(key)}:${canonicalJson(record[key])}`,
    ]).join(",")}}`;
  }
  throw new TypeError(`Structure evidence contains unsupported ${typeof value}`);
}

function framed(hash: ReturnType<typeof createHash>, value: Buffer | string) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

/** Exact proof of the provider-neutral wire input; independent of JS object insertion order. */
export function structureInputSha256(evidence: StructureEvidenceV1) {
  const { text, ...metadata } = evidence;
  const hash = createHash("sha256");
  framed(hash, "beaver-structure-input-v1");
  framed(hash, canonicalJson(metadata));
  framed(hash, text);
  return hash.digest("hex");
}
