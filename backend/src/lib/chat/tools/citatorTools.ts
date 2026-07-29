// Citator note-up chat tool — read path for the Stage 1 exact note-up
// graph (lib/caselawCitator.ts; built by scripts/build_citator_graph.py).
// Research-gated alongside the other legal-source tools: sealed benchmark
// runs must not see information sources beyond the matter documents.
import { graphStats, noteUpCitations } from "../../caselawCitator";
import type { OpenAIToolSchema } from "../../llm";

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
    "Note up a Canadian case citation against the locally built citator graph: corpus decisions citing it, newest first, each with the citing case's citation/name/court/date, first-occurrence paragraph, the form it was cited as, cited-side pinpoints, and a bounded excerpt. Exact citation-occurrence graph only — no treatment labels (followed/overruled) are implied. Pass the citation itself ('2019 SCC 65', '[2019] 4 S.C.R. 653'), not prose around it. Reports citator_not_installed when no graph has been built.",
    {
      type: "object",
      properties: {
        citation: {
          type: "string",
          description: "The cited decision's citation, on its own.",
        },
        size: {
          type: "number",
          description:
            "Citing cases to return, 1-50 (default 10). This pages the list only: citing_cases_total always reports every citing case in the graph, so never treat the returned count as the number of times a case has been cited.",
        },
      },
      required: ["citation"],
    },
  ),
];

/** Handles caselaw_note_up; returns null for any other tool name. */
export function executeCitatorTool(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (name !== "caselaw_note_up") return null;
  const citation = typeof args.citation === "string" ? args.citation.trim() : "";
  if (!citation) return { ok: false, error: "citation is required" };
  try {
    const result = noteUpCitations({
      citation,
      size: typeof args.size === "number" ? args.size : undefined,
    });
    if (result === null) {
      return {
        ok: false,
        error: "citator_not_installed",
        detail:
          "No local note-up graph has been built (scripts/build_citator_graph.py).",
      };
    }
    return {
      ok: true,
      citation,
      citing_cases_total: result.total,
      returned: result.entries.length,
      truncated: result.total > result.entries.length,
      graph: graphStats(),
      entries: result.entries,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
