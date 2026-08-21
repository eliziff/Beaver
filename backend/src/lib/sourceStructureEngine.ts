import {
  materializeSourceStructure,
  type SourceStructureInput,
} from "./sourceStructureAdapter";
import { deriveStructureGraphsNative } from "./structureNative";

export async function deriveSourceStructureGraphs(inputs: readonly SourceStructureInput[]) {
  const materialized = inputs.map(materializeSourceStructure);
  const evidence = materialized.map(({ evidence }) => evidence);
  const graphs = deriveStructureGraphsNative(
    evidence, materialized.map(({ offsets }) => offsets.scalarLength),
  );
  return graphs.map((graph, index) => ({ materialized: materialized[index], graph }));
}
