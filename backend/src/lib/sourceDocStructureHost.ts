import type { SourceDocBlock } from "./sourceDoc";
import {
  finalizeA2AJSourceStructure,
  prepareA2AJSourceStructure,
  type CompileInput,
} from "./sourceDocA2AJ";
import {
  prepareJournalSourceStructure,
  type JournalPageRow,
} from "./sourceDocJournal";
import {
  prepareNativeMarkupSourceStructure,
  type NativeMarkupSourceInput,
} from "./sourceDocNativeMarkup";
import { deriveSourceStructures } from "./sourceStructureEngine";

export async function deriveA2AJSourceDoc(
  input: CompileInput,
  scope: { kind: "complete" | "excerpt"; excerptOf?: string } = { kind: "complete" },
) {
  const prepared = prepareA2AJSourceStructure(input, scope);
  const [document] = await deriveSourceStructures([prepared.structure]);
  return finalizeA2AJSourceStructure(prepared, document);
}

export async function deriveNativeMarkupSourceDoc(input: NativeMarkupSourceInput) {
  return (await deriveSourceStructures([prepareNativeMarkupSourceStructure(input)]))[0];
}

export async function deriveJournalSourceDoc(
  articleId: number,
  url: string,
  text: string,
  pageRows: JournalPageRow[],
  nativeBlocks?: SourceDocBlock[],
) {
  return (await deriveSourceStructures([
    prepareJournalSourceStructure({ articleId, url, text, pageRows, nativeBlocks }),
  ]))[0];
}
