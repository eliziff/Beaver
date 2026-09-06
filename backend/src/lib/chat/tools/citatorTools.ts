import {
  noteUpAnalysis,
  noteUpCitations,
  type NoteUpCourtScope,
  type NoteUpSort,
  type StandsForCandidate,
} from "../../caselawCitator";
import type { Tool } from "../../llm";
import { safeErrorLog } from "../../safeError";
import { legalSourceResource } from "../../resourceReferences";
import type { BeaverToolPolicy } from "../toolRegistry";
import {
  attestedPassageReceipt,
  citatorNoteUpReceipt,
  type LegalEvidenceReceipt,
} from "../legalEvidence";

const NOTE_UP_TOOL_NAME = "note_up";

const NOTE_UP_DESCRIPTION =
  "Trace citations and discussion of a Canadian decision in later decisions and law journals. Returns attributed passages and locators without treatment labels. Read returned resources for context.";

export const CITATOR_TOOL: Tool & BeaverToolPolicy = {
  name: NOTE_UP_TOOL_NAME,
  specialist: true,
  research: true,
  reader: ["CA"],
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
            "Target paragraph in the cited decision; filters judicial and journal passages.",
        },
        size: {
          type: "integer",
          minimum: 1,
          maximum: 24,
          description: "Maximum per lane; defaults to 10 citing decisions and 8 analysis passages.",
        },
        court_scope: {
          type: "string",
          enum: ["all", "scc", "appellate", "trial", "tribunal"],
          description:
            "Filters judicial sources; default all. Journals remain included.",
        },
        court_code: {
          type: "string",
          description:
            "Exact court code, e.g. ONCA; requires court_scope all.",
        },
        sort: {
          type: "string",
          enum: ["newest", "most_discussed"],
          description:
            "Citing-decision order; other lanes keep their own ranking.",
        },
      },
      required: ["citation"],
      additionalProperties: false,
  },
};

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
  ...(passage.sourceKind === "commentary" && passage.sourceArticleId
    ? { resource: legalSourceResource({ provider: "journal", kind: "journal",
        id: passage.sourceArticleId, language: passage.language ?? "en" }) }
    : passage.sourceKind === "case" && passage.citingCitation
      ? { resource: legalSourceResource({ provider: "a2aj", kind: "case",
          id: passage.citingCitation, language: passage.language ?? "en" }) } : {}),
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
          ...(entry.citation ? { resource: legalSourceResource({ provider: "a2aj", kind: "case",
            id: entry.citation, language: entry.language ?? "en" }) } : {}),
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
    console.warn("[citator] lookup failed", safeErrorLog(error));
    return {
      payload: {
        ok: false,
        error: "Citator lookup failed.",
      },
    };
  }
}
