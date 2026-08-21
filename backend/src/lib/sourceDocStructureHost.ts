import {
  type CompileInput,
} from "./sourceDocA2AJ";
import {
  type NativeMarkupSourceInput,
} from "./sourceDocNativeMarkup";
import {
  a2ajSourceDocNative,
  nativeMarkupSourceDocNative,
} from "./structureNative";

export async function deriveA2AJSourceDoc(
  input: CompileInput,
  scope: { kind: "complete" | "excerpt"; excerptOf?: string } = { kind: "complete" },
) {
  return a2ajSourceDocNative({
    citation: input.citation,
    source_kind: input.docType,
    text: input.text,
    ...(input.id ? { id: input.id } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.dataset ? { dataset: input.dataset } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.alternateCitation ? { alternate_citation: input.alternateCitation } : {}),
    ...(input.sectionMap ? { section_map: Object.entries(input.sectionMap) } : {}),
    ...(scope.kind === "excerpt" && scope.excerptOf ? { excerpt_of: scope.excerptOf } : {}),
  });
}

export async function deriveNativeMarkupSourceDoc(input: NativeMarkupSourceInput) {
  return nativeMarkupSourceDocNative(input);
}
