import { readFileSync } from "node:fs";

import { sha256 } from "./hash";
import {
  materializeSourceStructure,
  projectSourceStructure,
  type SourceStructureInput,
} from "./sourceStructureAdapter";
import {
  legalStructureBinary,
  startStructureEngineClient,
  type StructureEngineClient,
} from "./structureEngineClient";

let sharedClient: Promise<StructureEngineClient> | undefined;
const timing = { materialize_ms: 0, derive_ms: 0, project_ms: 0 };
function client() {
  if (!sharedClient) {
    const binary = legalStructureBinary();
    sharedClient = startStructureEngineClient({
      expectedEngineSha256: sha256(readFileSync(binary)),
      requiredCapabilities: ["native_claims", "raw_recovery"],
      requireBelowNormalPriority: process.env.STRUCTURE_ENGINE_BELOW_NORMAL === "1",
      binary,
    });
  }
  return sharedClient;
}

export async function deriveSourceStructureGraphs(inputs: readonly SourceStructureInput[]) {
  const materializeStarted = performance.now();
  const materialized = inputs.map(materializeSourceStructure);
  const evidence = materialized.map(({ evidence }) => evidence);
  timing.materialize_ms += performance.now() - materializeStarted;
  let items: Awaited<ReturnType<StructureEngineClient["derive"]>>;
  const deriveStarted = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    const activePromise = client();
    const active = await activePromise;
    try {
      items = await active.derive(evidence, materialized.map(({ offsets }) => offsets.scalarLength));
      break;
    } catch (error) {
      if (attempt > 0 || active.alive()) throw error;
      if (sharedClient === activePromise) sharedClient = undefined;
    }
  }
  timing.derive_ms += performance.now() - deriveStarted;
  return items.map((item, index) => {
    if (!item.ok) throw new Error(
      `Shared structure engine rejected ${inputs[index].id}: ${item.error.code}: ${item.error.message}`,
    );
    return { materialized: materialized[index], graph: item.result };
  });
}

export async function deriveSourceStructures(inputs: readonly SourceStructureInput[]) {
  const graphs = await deriveSourceStructureGraphs(inputs);
  const projectStarted = performance.now();
  const documents = graphs.map(({ materialized, graph }) =>
    projectSourceStructure(materialized, graph));
  timing.project_ms += performance.now() - projectStarted;
  return documents;
}

export async function shutdownSourceStructureEngine() {
  const active = sharedClient;
  sharedClient = undefined;
  if (active) (await active).stop();
  timing.materialize_ms = timing.derive_ms = timing.project_ms = 0;
}

export async function sourceStructureEngineState() {
  const active = await client();
  return { limits: active.limits, capabilities: active.capabilities, priority: active.priority,
    ...active.stats(), ...timing };
}
