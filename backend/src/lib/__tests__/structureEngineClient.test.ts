import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { startStructureEngineClient } from "../structureEngineClient";
import {
  STRUCTURE_EVIDENCE_SCHEMA,
  documentScalarOffsets,
  type StructureEvidenceV1,
} from "../structureWire";

const ENGINE_HASH = "a".repeat(64);
const TEXT = "Alberta A\u{1d11e}B";
const DOUBLE = String.raw`
const readline = require("node:readline");
process.stdout.write(JSON.stringify({
  type: "hello", protocol: "legalpdf.structure-sidecar.v1",
  evidence_schema: "legalpdf.structure-evidence.v1", result_schema: "legalpdf.structure-graph.v1",
  engine_sha256: process.env.ENGINE_HASH, capabilities: process.env.CAPABILITIES.split(","),
  max_documents: Number(process.env.MAX_DOCUMENTS), max_bytes: Number(process.env.MAX_BYTES),
}) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (process.env.MODE === "crash") {
    process.stdout.write('{"type":"result_batch"');
    process.exit(2);
  }
  const documents = process.env.MODE === "reverse" ? [...request.documents].reverse() : request.documents;
  const items = documents.map(({ document_id }) => ({
    id: document_id, ok: false,
    error: { code: "unsupported_evidence_shape", message: request.request_id },
  }));
  process.stdout.write(JSON.stringify({
    type: "result_batch", request_id: request.request_id, items,
  }) + "\n");
});
`;

function evidence(id: string, text = TEXT): StructureEvidenceV1 {
  const scalarLength = documentScalarOffsets(text).scalarLength;
  return {
    schema_version: STRUCTURE_EVIDENCE_SCHEMA,
    document_id: id,
    provider: "a2aj",
    provider_revision: "b".repeat(64),
    profile: "legislation",
    require_report_start: false,
    allow_hyphenated_sections: false,
    text,
    text_sha256: createHash("sha256").update(text).digest("hex"),
    offset_unit: "unicode-scalar",
    scope: { kind: "excerpt", excerpt_of: "transport control" },
    origins: [], units: [], native_claims: [], exclusions: [], paragraph_breaks: [],
    coverage: (["paragraph", "prose", "page", "section", "heading", "footnote", "endnote"] as const)
      .map((kind) => ({ kind, range: { start: 0, end: scalarLength }, state: "absent", reason: "flat text" })),
  };
}

function startDouble(options: {
  maxDocuments?: number; maxBytes?: number; mode?: string; capabilities?: string;
} = {}) {
  return startStructureEngineClient({
    expectedEngineSha256: ENGINE_HASH,
    requiredCapabilities: ["native_claims", "raw_recovery"],
    requireBelowNormalPriority: process.env.STRUCTURE_ENGINE_BELOW_NORMAL === "1",
    binary: process.execPath,
    arguments: ["-e", DOUBLE],
    timeoutMs: 5_000,
    env: {
      ...process.env,
      ENGINE_HASH,
      MAX_DOCUMENTS: String(options.maxDocuments ?? 25),
      MAX_BYTES: String(options.maxBytes ?? 134_217_728),
      MODE: options.mode ?? "errors",
      CAPABILITIES: options.capabilities ?? "native_claims,raw_recovery",
    },
  });
}

describe("structure engine transport", () => {
  it("maps valid scalar offsets and rejects broken UTF-16", () => {
    const offsets = documentScalarOffsets(TEXT);
    expect(offsets.scalarLength).toBe(TEXT.length - 1);
    expect(offsets.scalarToUtf16(offsets.scalarLength)).toBe(TEXT.length);
    expect(() => offsets.utf16ToScalar(TEXT.indexOf("\u{1d11e}") + 1)).toThrow("splits");
    expect(() => documentScalarOffsets("\ud800")).toThrow("unpaired");
  });

  it("honours document and byte caps while preserving item order", async () => {
    const client = await startDouble({ maxDocuments: 2 });
    try {
      const documents = [evidence("large", "x".repeat(20_000)), evidence("small-a"), evidence("small-b")];
      const items = await client.derive(documents);
      expect(items.map(({ id }) => id)).toEqual(["large", "small-a", "small-b"]);
      expect(items.every((item) => !item.ok && item.error.code === "unsupported_evidence_shape")).toBe(true);
      expect(items[0].ok || items[1].ok ? null : items[0].error.message)
        .toBe(items[1].ok ? null : items[1].error.message);
      expect(items[1].ok || items[2].ok ? null : items[1].error.message)
        .not.toBe(items[2].ok ? null : items[2].error.message);
    } finally {
      client.stop();
    }

    const one = evidence("byte-a");
    const singleLine = `{"type":"derive_batch","request_id":"ts-1","documents":[${JSON.stringify(one)}]}`;
    const byteClient = await startDouble({ maxBytes: Buffer.byteLength(singleLine) });
    try {
      const items = await byteClient.derive([one, evidence("byte-b")]);
      expect(items[0].ok || items[1].ok ? null : items[0].error.message)
        .not.toBe(items[1].ok ? null : items[1].error.message);
    } finally {
      byteClient.stop();
    }
  });

  it("fails closed on correlation, crash, and capability errors", async () => {
    const reversed = await startDouble({ mode: "reverse" });
    await expect(reversed.derive([evidence("first"), evidence("second")]))
      .rejects.toThrow("uncorrelated");
    expect(reversed.alive()).toBe(false);
    await expect(reversed.derive([evidence("no-fallback")])).rejects.toThrow();

    const crashed = await startDouble({ mode: "crash" });
    await expect(crashed.derive([evidence("crash")])).rejects.toThrow("truncated response");
    expect(crashed.alive()).toBe(false);
    await expect(startDouble({ capabilities: "native_claims" })).rejects.toThrow("incompatible hello");
  });
});
