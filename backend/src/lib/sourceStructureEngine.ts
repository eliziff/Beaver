import {
  materializeSourceStructure,
  type SourceStructureInput,
} from "./sourceStructureAdapter";
import { deriveStructureGraphsNative, sourceDocsNative } from "./structureNative";
import { getPriority } from "node:os";

const timing = { materialize_ms: 0, derive_ms: 0, project_ms: 0 };
let documents = 0;
let batches = 0;

export async function deriveSourceStructureGraphs(inputs: readonly SourceStructureInput[]) {
  const materializeStarted = performance.now();
  const materialized = inputs.map(materializeSourceStructure);
  const evidence = materialized.map(({ evidence }) => evidence);
  timing.materialize_ms += performance.now() - materializeStarted;
  const deriveStarted = performance.now();
  const graphs = deriveStructureGraphsNative(
    evidence, materialized.map(({ offsets }) => offsets.scalarLength),
  );
  timing.derive_ms += performance.now() - deriveStarted;
  documents += graphs.length;
  batches += 1;
  return graphs.map((graph, index) => ({ materialized: materialized[index], graph }));
}

export async function deriveSourceStructures(inputs: readonly SourceStructureInput[]) {
  const materializeStarted = performance.now();
  const materialized = inputs.map(materializeSourceStructure);
  timing.materialize_ms += performance.now() - materializeStarted;
  const deriveStarted = performance.now();
  const output = sourceDocsNative(materialized.map(({ evidence, originalClaims }) => ({
    kind: "evidence" as const,
    input: evidence,
    original_claims: Object.fromEntries(originalClaims),
    original_claim_orders: Object.fromEntries(
      [...originalClaims].map(([id, block]) => [id, Object.keys(block)]),
    ),
  })));
  timing.derive_ms += performance.now() - deriveStarted;
  documents += output.length;
  batches += 1;
  return output;
}

export async function shutdownSourceStructureEngine() {
  documents = 0;
  batches = 0;
  timing.materialize_ms = timing.derive_ms = timing.project_ms = 0;
}

export async function sourceStructureEngineState() {
  const priority = getPriority(0);
  return {
    limits: { max_documents: Number.MAX_SAFE_INTEGER, max_bytes: Number.MAX_SAFE_INTEGER },
    capabilities: ["native_claims", "raw_recovery"] as const,
    priority: { class: "BELOW_NORMAL" as const, parent_pid: process.pid, child_pid: process.pid,
      parent_priority: priority, child_priority: priority },
    batches, documents, request_bytes: 0, ...timing,
  };
}
