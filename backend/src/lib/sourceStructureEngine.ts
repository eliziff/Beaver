import {
  materializeSourceStructure,
  type SourceStructureInput,
} from "./sourceStructureAdapter";
import {
  deriveInstrumentStructureNative,
  deriveStructureGraphsNative,
  type InstrumentReferenceEvidence,
} from "./structureNative";

export async function deriveSourceStructureGraphs(inputs: readonly SourceStructureInput[]) {
  const materialized = inputs.map(materializeSourceStructure);
  const evidence = materialized.map(({ evidence }) => evidence);
  const graphs = deriveStructureGraphsNative(
    evidence, materialized.map(({ offsets }) => offsets.scalarLength),
  );
  return graphs.map((graph, index) => ({ materialized: materialized[index], graph }));
}

export function deriveInstrumentSourceStructure(
  inputs: readonly SourceStructureInput[],
  text: string,
  references: InstrumentReferenceEvidence[],
) {
  const materialized = inputs.map(materializeSourceStructure);
  const evidence = materialized.map(({ evidence }) => evidence);
  const { selected, graph, contents } = deriveInstrumentStructureNative(
    text,
    evidence,
    materialized.map(({ offsets }) => offsets.scalarLength),
    references,
  );
  return { materialized: materialized[selected], graph, contents };
}
