import { a2ajStorePath } from "../../src/lib/legalDataPath";
import { structureNative, type A2AJStoreDocument, type NativeDocument } from "../../src/lib/structureNative";
import { decisionCitationInventory } from "../a2aj-decision-roster/caseDecisionMvp";
import { modelSourceLines } from "../a2aj-decision-roster/caseTargetMvpReduced";
import { analyzeTextOpinionStructure } from "../a2aj-decision-roster/legalOpinionBoundaries";
import { paragraphCoverageEnd, type CaseMaterial } from "./contract";

function substantiveParagraph(text: string) {
  const compact = text.replace(/\s+/gu, " ").trim();
  if ((compact.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0) < 8) return false;
  if (/^(?:reasons?|judgment|decision)(?:\s+of|\s+for|\s+by)?\b[^.!?]{0,160}$/iu.test(compact)) return false;
  if (/^(?:the\s+honourable\s+)?[\p{L}\p{M}.'’\-]+(?:\s+[\p{L}\p{M}.'’\-]+){0,5}\s+(?:C\.?J\.?|J\.?A\.?|J\.?)$/iu.test(compact)) return false;
  if (/^(?:solicitors?|counsel|appearances?|coram|present|heard|released|date|docket|file\s+no\.?|citation)\b/iu.test(compact)) return false;
  return true;
}

function coverage(
  source: NativeDocument,
  deterministic: NonNullable<CaseMaterial["deterministic_structure"]>,
): CaseMaterial["coverage"] {
  if (deterministic.status !== "ready") return { status: "not_asserted", spans: [] };
  const sourceText = structureNative().documentText(source);
  const spans = structureNative().documentAnchors(source).filter(({ kind }) => kind === "paragraph").flatMap((block) => {
    const text = sourceText.slice(block.start, block.end);
    const start = block.start + (text.match(/^\s*/u)?.[0].length ?? 0);
    const trimmedEnd = block.start + paragraphCoverageEnd(text);
    const insideKnownOpinion = deterministic.opinions.some((opinion) =>
      start >= opinion.start && trimmedEnd <= opinion.end
    );
    return insideKnownOpinion && substantiveParagraph(text)
      ? [{ start, end: trimmedEnd, label: block.label }]
      : [];
  });
  return { status: spans.length ? "asserted" : "not_asserted", spans };
}

function materialFromSource(documentId: number, document: A2AJStoreDocument): CaseMaterial {
  const source = document.native;
  const text = structureNative().documentText(source);
  const paragraphs = structureNative().documentAnchors(source).filter(({ kind }) => kind === "paragraph");
  const deterministic = analyzeTextOpinionStructure({
    text,
    paragraphs: paragraphs.map(({ label, start, end }) => ({ label, start, end })),
    firstParagraphStart: paragraphs[0]?.start,
  }).deterministic;
  const deterministicStructure: NonNullable<CaseMaterial["deterministic_structure"]> = {
    status: deterministic.status,
    panel: deterministic.panel,
    nonparticipants: deterministic.nonparticipants,
    opinions: deterministic.opinions.map((opinion) => ({
      id: opinion.id,
      authors: opinion.authors,
      joiners: opinion.joiners ?? [],
      alignment: opinion.alignment,
      start: opinion.start,
      end: opinion.end,
      start_quote: opinion.startQuote,
      end_quote: opinion.endQuote,
      substantive_words: opinion.substantiveWords,
    })),
    judges: deterministic.judges.map((judge) => ({
      name: judge.name,
      result_side: judge.resultSide,
      relationship: judge.relationship,
      opinion_ids: judge.opinionIds,
    })),
    refusals: deterministic.refusals,
  };
  return {
    document_id: documentId,
    citation: document.citation,
    name: document.name,
    date: document.date,
    dataset: document.dataset,
    language: document.language,
    url: document.url,
    text,
    source_lines: modelSourceLines(text),
    citation_inventory: decisionCitationInventory(
      text,
      document.citation,
      paragraphs.at(-1)?.end ?? text.length,
    ),
    deterministic_structure: deterministicStructure,
    coverage: coverage(source, deterministicStructure),
  };
}

export function materialFor(documentId: number, document: A2AJStoreDocument) {
  return materialFromSource(documentId, document);
}

export function materialsFor(ids: readonly number[], documents: Map<number, A2AJStoreDocument>) {
  return new Map(ids.map((id) => [id, materialFromSource(id, documents.get(id)!)]));
}

/** The store's decisions with these ids, read and derived by the engine; one the store lacks is left out. */
export async function storeDocuments(ids: readonly number[]) {
  return new Map((await structureNative().a2ajStoreDocuments(a2ajStorePath(), [...ids], "cases", "en") ?? [])
    .map((document) => [document.id, document]));
}

export async function documentsFor(ids: readonly number[]) {
  const documents = await storeDocuments(ids);
  const missing = ids.filter((id) => !documents.has(id));
  if (missing.length) throw new Error(`A2AJ decisions unavailable: ${missing.join(", ")}`);
  return documents;
}
