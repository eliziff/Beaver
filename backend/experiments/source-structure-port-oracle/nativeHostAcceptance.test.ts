import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { expect, test } from "vitest";

import type { SourceDoc, SourceDocBlock } from "../../src/lib/sourceDoc";
import {
  finalizeA2AJSourceStructure,
  prepareA2AJSourceStructure,
  type CompileInput,
} from "../../src/lib/sourceDocA2AJ";
import {
  journalFinalContractSource,
  prepareJournalSourceStructure,
  type JournalPageRow,
} from "../../src/lib/sourceDocJournal";
import { prepareNativeMarkupSourceStructure } from "../../src/lib/sourceDocNativeMarkup";
import {
  legalStructureBinary,
  setBelowNormalProcessPriority,
  startStructureEngineClient,
} from "../../src/lib/structureEngineClient";
import {
  materializeSourceStructure,
  projectSourceStructure,
} from "../../src/lib/sourceStructureAdapter";
import { canonicalSourceDocBytes, sourceDocPublicBytes } from "../source-structure-parity/canonical";

const ROOT = path.resolve(__dirname, "../../..");
const VECTOR_FILE = path.join(__dirname, "vectors.json");
const NATIVE_BINARY_SHA256 = "526dcce01aa4dddd0e0409f40afcbab63c09a4f48f4611e2d4590322f4b228bf";
const ALL_NATIVE = new Set([
  "a2aj-laws-ab-abc-benefits-s8",
  "courtlistener-cap-372us335",
  "courtlistener-table-4589554",
  "tna-eat-2025-1",
  "journal-final-native-12027",
]);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type Vector = {
  id: string;
  scope: { kind: "complete" | "excerpt"; excerpt_of?: string };
  fixture: { path: string; sha256: string };
  expected: { value: { final: {
    public_utf16_json: { sha256: string };
    canonical_utf16_json: { sha256: string };
    blocks: Array<{
      kind: string; label: string; utf16: [number, number]; origin: string;
      anchor: string | null; aliases: string[]; parent: string | null;
    }>;
  } } };
};

function load(vector: Vector) {
  const bytes = readFileSync(path.resolve(ROOT, vector.fixture.path));
  expect(sha(bytes), `${vector.id} fixture hash`).toBe(vector.fixture.sha256);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

function nativeMarkupInput(vector: Vector, value: Record<string, unknown>) {
  const provider = vector.id.startsWith("courtlistener-") ? "courtlistener"
    : vector.id.startsWith("tna-") ? "tna"
      : vector.id.startsWith("govinfo-") ? "govinfo" : "govuk-et";
  const markup = String(value.markup ?? "");
  return prepareNativeMarkupSourceStructure({
    provider,
    id: String(value.id ?? value.citation ?? value.packageId ?? value.caseNumber ?? vector.id),
    text: String(value.text ?? markup),
    markup,
    citation: value.citation == null ? null : String(value.citation),
    scope: { kind: vector.scope.kind, excerptOf: vector.scope.excerpt_of },
  });
}

function journalInput(vector: Vector, value: Record<string, unknown>) {
  const row = value.row as Record<string, unknown>, pageRows = value.pageRows as JournalPageRow[];
  const articleId = Number(row.article_id), url = String(row.galley_url ?? row.url_en ?? "");
  let text = String(row.text ?? ""), nativeBlocks: SourceDocBlock[] | undefined;
  if (typeof value.pages_gzip_base64 === "string") {
    const pages = gunzipSync(Buffer.from(value.pages_gzip_base64, "base64"));
    const source = journalFinalContractSource(articleId, pages, pageRows);
    if (!source) throw new Error(`${vector.id}: invalid final contract fixture`);
    text = source.text; nativeBlocks = source.blocks;
  }
  return prepareJournalSourceStructure({ articleId, url, text, pageRows, nativeBlocks });
}

function prepare(vector: Vector) {
  const value = load(vector);
  if (vector.id.startsWith("a2aj-")) {
    const prepared = prepareA2AJSourceStructure(value as CompileInput, {
      kind: vector.scope.kind, excerptOf: vector.scope.excerpt_of,
    });
    return { structure: prepared.structure,
      finish: (document: SourceDoc) => finalizeA2AJSourceStructure(prepared, document) };
  }
  const structure = vector.id.startsWith("journal-")
    ? journalInput(vector, value) : nativeMarkupInput(vector, value);
  return { structure, finish: (document: SourceDoc) => document };
}

const tuple = (block: SourceDocBlock) => [block.kind, block.label, block.start, block.end,
  block.origin, block.anchor ?? null, block.aliases ?? [], block.parentLabel ?? null];
const expectedTuple = (block: Vector["expected"]["value"]["final"]["blocks"][number]) =>
  [block.kind, block.label, ...block.utf16, block.origin, block.anchor, block.aliases, block.parent];

test("native host preserves claims and honors authoritative journal coverage", async () => {
  setBelowNormalProcessPriority();
  const binary = path.resolve(legalStructureBinary({
    ...process.env,
    LEGAL_STRUCTURE_BINARY: path.join(
      ROOT, "legal-pdf-parser", "target", "release", "legal-structure-native.exe",
    ),
  }));
  expect(sha(readFileSync(binary)), "pinned native binary").toBe(NATIVE_BINARY_SHA256);
  const frozen = JSON.parse(readFileSync(VECTOR_FILE, "utf8")) as {
    suites: { real_captured: Vector[] };
  };
  const passthrough = frozen.suites.real_captured.filter(({ id }) => id.startsWith("local-pdf-"));
  const vectors = frozen.suites.real_captured.filter(({ id }) => !id.startsWith("local-pdf-"));
  expect(passthrough.map(({ id }) => id)).toEqual([
    "local-pdf-native", "local-pdf-hybrid", "local-pdf-flat",
  ]);
  expect(vectors).toHaveLength(21);

  const prepared = vectors.map(prepare);
  const materialized = prepared.map(({ structure }) => materializeSourceStructure(structure));
  const client = await startStructureEngineClient({
    binary, expectedEngineSha256: NATIVE_BINARY_SHA256, requiredCapabilities: ["native_claims"],
    requireBelowNormalPriority: true, timeoutMs: 10_000,
  });
  try {
    expect(client.capabilities).toEqual(["native_claims"]);
    const graphs = [];
    for (const document of materialized) {
      const [item] = await client.derive([document.evidence], [document.offsets.scalarLength]);
      if (!item.ok) throw new Error(`${item.id}: ${item.error.code}: ${item.error.message}`);
      graphs.push(item.result);
    }
    expect(vectors.filter((_, index) => graphs[index].status === "complete").map(({ id }) => id))
      .toEqual(["journal-final-native-12027", "journal-final-recovery-9284"]);
    expect(graphs.every(({ nodes }) => nodes.every(({ source }) => source === "native"))).toBe(true);

    for (let index = 0; index < vectors.length; index += 1) {
      const vector = vectors[index];
      if (!ALL_NATIVE.has(vector.id)) continue;
      expect(vector.expected.value.final.blocks.every(({ origin }) => origin === "native")).toBe(true);
      const actual = prepared[index].finish(projectSourceStructure(materialized[index], graphs[index]));
      expect(actual.blocks.map(tuple), vector.id).toEqual(vector.expected.value.final.blocks.map(expectedTuple));
      expect(sha(sourceDocPublicBytes(actual)), `${vector.id} public`).toBe(
        vector.expected.value.final.public_utf16_json.sha256,
      );
      expect(sha(canonicalSourceDocBytes(actual)), `${vector.id} canonical`).toBe(
        vector.expected.value.final.canonical_utf16_json.sha256,
      );
    }
    expect(ALL_NATIVE.size).toBe(5);
  } finally {
    client.stop();
  }
}, 15_000);
