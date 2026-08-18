import {
  noteUpAnalysis,
  noteUpCitations,
  type NoteUpCourtScope,
  type NoteUpSort,
  type StandsForCandidate,
} from "../../caselawCitator";
import type { Tool } from "../../llm";
import {
  attestedPassageReceipt,
  citatorNoteUpReceipt,
  type LegalEvidenceReceipt,
} from "../legalEvidence";

export const NOTE_UP_TOOL_NAME = "note_up";

const NOTE_UP_DESCRIPTION =
  "Trace how a Canadian decision is cited and discussed. Returns citing decisions, explanatory passages from later decisions, and relevant law-journal analysis with source citations and locators. Supports cited-paragraph and court filters. Does not assign treatment labels.";

export const CITATOR_TOOLS: Tool[] = [{
  name: NOTE_UP_TOOL_NAME,
  annotations: { readOnlyHint: true },
  description: NOTE_UP_DESCRIPTION,
  inputSchema: {
      type: "object",
      properties: {
        citation: {
          type: "string",
          description: "One Canadian decision citation, such as 2019 SCC 65.",
        },
        cited_paragraph: {
          type: "integer",
          minimum: 1,
          description:
            "Optional paragraph number on the cited side. Applies to both judicial discussion and journal analysis.",
        },
        size: {
          type: "integer",
          minimum: 1,
          maximum: 24,
          description: "Maximum results in each source-role lane; default 10.",
        },
        court_scope: {
          type: "string",
          enum: ["all", "scc", "appellate", "trial", "tribunal"],
          description:
            "Judicial sources to include. Does not suppress journal analysis. Defaults to all.",
        },
        court_code: {
          type: "string",
          description:
            "Optional exact corpus court code, such as ONCA. Use only with court_scope all.",
        },
        sort: {
          type: "string",
          enum: ["newest", "most_discussed"],
          description:
            "Ordering within the citing-decisions lane. Other lanes retain their own source-appropriate ordering.",
        },
      },
      required: ["citation"],
      additionalProperties: false,
  },
}];

export type CitatorToolExecution = {
  payload: Record<string, unknown>;
  evidences?: LegalEvidenceReceipt[];
};

const mapPassage = (
  passage: StandsForCandidate,
  evidence: LegalEvidenceReceipt,
) => ({
  source_citation: passage.citingCitation,
  source_name: passage.citingName,
  journal_name: passage.journalName,
  court: passage.citingCourt,
  date: passage.citingDate,
  paragraph: passage.paragraph,
  page: passage.pageLabel,
  passage: passage.text,
  evidence_id: evidence.evidence_id,
  read: passage.sourceKind === "commentary"
    ? {
        tool: "public_legal_source_fetch",
        provider: "journal",
        identifier: passage.sourceArticleId ?? passage.citingCitation,
      }
    : { tool: "a2aj_fetch", citation: passage.citingCitation },
});

export function executeCitatorTool(
  name: string,
  args: Record<string, unknown>,
): CitatorToolExecution | null {
  if (name !== NOTE_UP_TOOL_NAME) return null;
  const citation = typeof args.citation === "string" ? args.citation.trim() : "";
  if (!citation) return { payload: { ok: false, error: "citation is required" } };
  const courtScope = (["all", "scc", "appellate", "trial", "tribunal"] as const)
    .includes(args.court_scope as NoteUpCourtScope)
    ? args.court_scope as NoteUpCourtScope
    : "all";
  const courtCode = typeof args.court_code === "string"
    ? args.court_code.trim().toUpperCase()
    : "";
  if (courtCode && courtScope !== "all") {
    return {
      payload: {
        ok: false,
        error: "court_code cannot be combined with a non-all court_scope",
      },
    };
  }
  const citedParagraph = typeof args.cited_paragraph === "number"
    ? Math.trunc(args.cited_paragraph)
    : undefined;
  const size = typeof args.size === "number" ? args.size : undefined;
  const sort: NoteUpSort = args.sort === "most_discussed"
    ? "most_discussed"
    : "newest";
  try {
    const citations = noteUpCitations({
      citation,
      citedParagraph,
      size,
      courtScope,
      courtCode: courtCode || undefined,
      sort,
    });
    const analysis = noteUpAnalysis({
      citation,
      citedParagraph,
      size,
      courtScope,
      courtCode: courtCode || undefined,
    });
    if (!citations || !analysis) {
      return {
        payload: {
          ok: false,
          error: "citator_not_installed",
          detail: "No local note-up graph has been built.",
        },
      };
    }
    const citingEvidence = citations.entries.map((entry) =>
      citatorNoteUpReceipt({ citedCitation: citation, entry }));
    const judicialEvidence = analysis.judicialDiscussion.map((passage) =>
      attestedPassageReceipt({ citedCitation: citation, passage }));
    const journalEvidence = (analysis.journalAnalysis ?? []).map((passage) =>
      attestedPassageReceipt({ citedCitation: citation, passage }));
    return {
      evidences: [...citingEvidence, ...judicialEvidence, ...journalEvidence],
      payload: {
        ok: true,
        target: citation,
        cited_paragraph: citedParagraph ?? null,
        citing_decisions_total: citations.total,
        citing_decisions: citations.entries.map((entry, index) => ({
          citation: entry.citation,
          name: entry.name,
          court: entry.court,
          date: entry.date,
          paragraph: entry.paragraph,
          occurrences: entry.occurrences,
          distinct_paragraphs: entry.distinctParagraphs,
          cited_as: entry.citedAs,
          pinpoints: entry.pinpoints,
          passage: entry.excerpt,
          evidence_id: citingEvidence[index].evidence_id,
        })),
        judicial_discussion: analysis.judicialDiscussion.map((passage, index) =>
          mapPassage(passage, judicialEvidence[index])),
        journal_analysis_available: analysis.journalAnalysis !== null,
        journal_analysis: (analysis.journalAnalysis ?? []).map((passage, index) =>
          mapPassage(passage, journalEvidence[index])),
      },
    };
  } catch (error) {
    return {
      payload: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
