import { fetchLocalA2AJDocumentsByIds } from "../../src/lib/a2ajLocalBulk";
import type { A2AJDocument } from "../../src/lib/legalSources/a2aj";
import { structureNative, type NativeDocument } from "../../src/lib/structureNative";
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

async function sourceFor(document: A2AJDocument) {
  return structureNative().deriveDocumentStructure({
    kind: "provider_text",
    input: {
      provider: "a2aj",
      citation: document.citation,
      source_kind: document.docType ?? "cases",
      text: document.sectionMap ? "" : document.text,
      url: document.url,
      alternate_citation: document.alternateCitation,
      dataset: document.dataset,
      require_report_start: document.docType === "cases" && document.dataset?.toUpperCase() === "SCC",
      name: document.name,
      section_map: document.sectionMap ? Object.entries(document.sectionMap) : undefined,
    },
  });
}

function materialFromSource(documentId: number, document: A2AJDocument, source: NativeDocument): CaseMaterial {
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
      { extendedUsFallback: false },
    ),
    deterministic_structure: deterministicStructure,
    coverage: coverage(source, deterministicStructure),
  };
}

export async function materialFor(documentId: number, document: A2AJDocument) {
  return materialFromSource(documentId, document, await sourceFor(document));
}

export async function materialsFor(ids: readonly number[], documents: Map<number, A2AJDocument>) {
  const selected = ids.map((id) => documents.get(id)!);
  const sources = await Promise.all(selected.map(sourceFor));
  return new Map(ids.map((id, index) => [id, materialFromSource(id, selected[index], sources[index])]));
}

export function documentsFor(ids: readonly number[]) {
  const documents = fetchLocalA2AJDocumentsByIds({ ids: [...ids], docType: "cases", language: "en", maxChars: Number.MAX_SAFE_INTEGER });
  const missing = ids.filter((id) => !documents.has(id));
  if (missing.length) throw new Error(`A2AJ decisions unavailable: ${missing.join(", ")}`);
  return documents;
}
