// Citator note-up chat tool — read path for the Stage 1 exact note-up
// graph (lib/caselawCitator.ts; built by scripts/build_citator_graph.py).
// Research-gated alongside the other legal-source tools: sealed benchmark
// runs must not see information sources beyond the matter documents.
import {
  noteUpCitations,
  type NoteUpCourtScope,
  type NoteUpSort,
} from "../../caselawCitator";
import type { OpenAIToolSchema } from "../../llm";
import {
  citatorNoteUpReceipt,
  type LegalEvidenceReceipt,
} from "../legalEvidenceExperiment";

const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAIToolSchema => ({
  type: "function",
  function: { name, description, parameters },
});

export const CITATOR_TOOLS: OpenAIToolSchema[] = [
  tool(
    "caselaw_note_up",
    "Find Canadian decisions that cite one case. Filter by court level or exact court code; sort by date or by how often each decision discusses the cited case. Returns bounded citing passages and occurrence counts, not editorial treatment labels.",
    {
      type: "object",
      properties: {
        citation: {
          type: "string",
          description:
            "The cited decision's citation on its own ('2019 SCC 65'), not prose around it.",
        },
        size: {
          type: "number",
          description:
            "Citing cases to return, 1-50 (default 10). Paging only — citing_cases_total is the real count; never read the returned count as how often the case was cited.",
        },
        court_scope: {
          type: "string",
          enum: ["all", "scc", "appellate", "trial", "tribunal"],
          description:
            "Court level to include. appellate excludes SCC; trial includes superior and inferior trial courts. Defaults to all.",
        },
        court_code: {
          type: "string",
          description:
            "Optional exact corpus court code, such as ONCA or BCSC. Use only with court_scope all.",
        },
        sort: {
          type: "string",
          enum: ["newest", "most_discussed"],
          description:
            "newest sorts by decision date. most_discussed ranks exact citation occurrences, then distinct citing paragraphs, court level, and recency. Defaults to newest.",
        },
      },
      required: ["citation"],
    },
  ),
];

/** Handles caselaw_note_up; returns null for any other tool name. */
export type CitatorToolExecution = {
  payload: Record<string, unknown>;
  evidences?: LegalEvidenceReceipt[];
};

export function executeCitatorTool(
  name: string,
  args: Record<string, unknown>,
): CitatorToolExecution | null {
  if (name !== "caselaw_note_up") return null;
  const citation = typeof args.citation === "string" ? args.citation.trim() : "";
  if (!citation) return { payload: { ok: false, error: "citation is required" } };
  const courtScope = (["all", "scc", "appellate", "trial", "tribunal"] as const).includes(
    args.court_scope as NoteUpCourtScope,
  )
    ? (args.court_scope as NoteUpCourtScope)
    : "all";
  const courtCode =
    typeof args.court_code === "string" ? args.court_code.trim().toUpperCase() : "";
  if (courtCode && courtScope !== "all") {
    return {
      payload: {
        ok: false,
        error: "court_code cannot be combined with a non-all court_scope",
      },
    };
  }
  const sort: NoteUpSort =
    args.sort === "most_discussed" ? "most_discussed" : "newest";
  try {
    const result = noteUpCitations({
      citation,
      size: typeof args.size === "number" ? args.size : undefined,
      courtScope,
      courtCode: courtCode || undefined,
      sort,
    });
    if (result === null) {
      return {
        payload: {
          ok: false,
          error: "citator_not_installed",
          detail:
            "No local note-up graph has been built (scripts/build_citator_graph.py).",
        },
      };
    }
    const evidences = result.entries.map((entry) =>
      citatorNoteUpReceipt({ citedCitation: citation, entry }),
    );
    return {
      evidences,
      payload: {
        ok: true,
        citation,
        court_scope: courtScope,
        court_code: courtCode || null,
        sort,
        citing_cases_total: result.total,
        returned: result.entries.length,
        truncated: result.total > result.entries.length,
        entries: result.entries.map((entry, index) => ({
          citation: entry.citation,
          name: entry.name,
          court: entry.court,
          court_level: entry.courtLevel,
          date: entry.date,
          url: entry.url,
          paragraph: entry.paragraph,
          occurrences: entry.occurrences,
          distinct_paragraphs: entry.distinctParagraphs,
          cited_as: entry.citedAs,
          pinpoints: entry.pinpoints,
          passage: entry.excerpt,
          evidence_id: evidences[index].evidence_id,
        })),
      },
    };
  } catch (error) {
    return { payload: { ok: false, error: (error as Error).message } };
  }
}
