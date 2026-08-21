import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { createSourceDoc, type SourceDocBlock } from "../../src/lib/sourceDoc";
import type { CompileInput } from "../../src/lib/sourceDocA2AJ";
import {
  deriveA2AJSourceDoc,
  deriveJournalJsonlSourceDoc,
  deriveJournalSourceDoc,
  deriveNativeMarkupSourceDoc,
  type JournalPageRow,
} from "../../src/lib/sourceDocStructureHost";
import { shutdownSourceStructureEngine } from "../../src/lib/sourceStructureEngine";
import { setBelowNormalProcessPriority } from "../../src/lib/structureEngineClient";
import { canonicalSourceDocBytes, sourceDocPublicBytes } from "../source-structure-parity/canonical";

const ROOT = path.resolve(__dirname, "../../..");
const VECTOR_FILE = path.join(__dirname, "vectors.json");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type Vector = {
  id: string;
  fixture: { path: string; sha256: string };
  expected: { value: { final: {
    public_utf16_json: { sha256: string };
    canonical_utf16_json: { sha256: string };
    blocks: Array<{
      kind: string;
      label: string;
      utf16: [number, number];
      origin: string;
      anchor: string | null;
      aliases: string[];
      parent: string | null;
    }>;
  } } };
};

function fixture(vector: Vector) {
  const bytes = readFileSync(path.resolve(ROOT, vector.fixture.path));
  if (sha(bytes) !== vector.fixture.sha256) throw new Error(`${vector.id}: fixture hash changed`);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

async function nativeMarkup(vector: Vector, value: Record<string, unknown>) {
  const provider = vector.id.startsWith("courtlistener-") ? "courtlistener"
    : vector.id.startsWith("tna-") ? "tna"
      : vector.id.startsWith("govinfo-") ? "govinfo" : "govuk-et";
  const markup = String(value.markup ?? "");
  return deriveNativeMarkupSourceDoc({
    provider,
    id: String(value.id ?? value.citation ?? value.packageId ?? value.caseNumber ?? vector.id),
    text: String(value.text ?? markup),
    markup,
    citation: value.citation == null ? null : String(value.citation),
  });
}

async function journal(vector: Vector, value: Record<string, unknown>) {
  const row = value.row as Record<string, unknown>;
  const pageRows = value.pageRows as JournalPageRow[];
  const id = Number(row.article_id);
  const url = String(row.galley_url ?? row.url_en ?? "");
  if (typeof value.pages_gzip_base64 === "string") {
    const jsonl = gunzipSync(Buffer.from(value.pages_gzip_base64, "base64")).toString("utf8");
    return deriveJournalJsonlSourceDoc(id, url, jsonl, pageRows);
  }
  return deriveJournalSourceDoc(id, url, String(row.text ?? ""), pageRows);
}

function localPdf(value: Record<string, unknown>) {
  const source = (value.response as { result: { source_doc: Parameters<typeof createSourceDoc>[0] } })
    .result.source_doc;
  return createSourceDoc(source);
}

async function derive(vector: Vector) {
  const value = fixture(vector);
  if (vector.id.startsWith("a2aj-")) return deriveA2AJSourceDoc(value as CompileInput);
  if (/^(?:courtlistener|tna|govinfo|govuk-et)-/u.test(vector.id)) {
    return nativeMarkup(vector, value);
  }
  if (vector.id.startsWith("journal-")) return journal(vector, value);
  return localPdf(value);
}

function tuple(block: SourceDocBlock) {
  return [block.kind, block.label, block.start, block.end, block.origin, block.anchor ?? null,
    block.aliases ?? [], block.parentLabel ?? null];
}

function expectedTuple(block: Vector["expected"]["value"]["final"]["blocks"][number]) {
  return [block.kind, block.label, ...block.utf16, block.origin, block.anchor,
    block.aliases, block.parent];
}

export async function compareCandidates(binary: string, selected: string[] = []) {
  setBelowNormalProcessPriority();
  process.env.STRUCTURE_ENGINE_BELOW_NORMAL = "1";
  process.env.LEGAL_STRUCTURE_BINARY = path.resolve(binary);
  const frozen = JSON.parse(readFileSync(VECTOR_FILE, "utf8")) as {
    suites: { real_captured: Vector[] };
  };
  const vectors = frozen.suites.real_captured.filter(
    ({ id }) => !selected.length || selected.includes(id),
  );
  try {
    const results = [];
    for (const vector of vectors) {
      const actual = await derive(vector);
      const actualTuples = actual.blocks.map(tuple);
      const expectedTuples = vector.expected.value.final.blocks.map(expectedTuple);
      const first = expectedTuples.findIndex(
        (value, at) => JSON.stringify(value) !== JSON.stringify(actualTuples[at]),
      );
      const publicHash = sha(sourceDocPublicBytes(actual));
      const canonicalHash = sha(canonicalSourceDocBytes(actual));
      results.push({
        id: vector.id,
        ok: publicHash === vector.expected.value.final.public_utf16_json.sha256 &&
          canonicalHash === vector.expected.value.final.canonical_utf16_json.sha256,
        passthrough: vector.id.startsWith("local-pdf-"),
        expected_blocks: expectedTuples.length,
        actual_blocks: actualTuples.length,
        first_mismatch: first,
        expected: first < 0 ? null : expectedTuples[first] ?? null,
        actual: first < 0 ? null : actualTuples[first] ?? null,
        public_sha256: publicHash,
        canonical_sha256: canonicalHash,
      });
    }
    return results;
  } finally {
    await shutdownSourceStructureEngine();
  }
}

if (require.main === module) {
  const binary = process.argv[2];
  if (!binary) throw new Error("usage: tsx candidate.ts <legal-structure-binary> [vector-id ...]");
  compareCandidates(binary, process.argv.slice(3))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`));
}
