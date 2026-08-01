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
    "A local citation graph over 224,970 Canadian decisions: 2,541,822 citation edges naming 540,948 distinct cited decisions, built offline with no network call. Given a decision's citation, returns the corpus decisions that cite it, newest first — each with the citing case's citation, name, court and date, the paragraph where the citation first appears, the form in which it was cited, the pinpoints it cited into, and a bounded excerpt of the citing passage. `provider` carries the corpus's own curated cited-lists alongside the extracted edges, including citations recorded as citing this decision from outside the corpus. What it records is citation OCCURRENCE and its context, not editorial treatment: there are no followed/overruled/distinguished labels, and the excerpt is the citing court's own words. Reports citator_not_installed when no graph is built.",
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
      provider: result.provider
        ? {
            citing_in_corpus: result.provider.citingInCorpus,
            citing_reported: result.provider.citingReported,
          }
        : null,
      graph: graphStats(),
      entries: result.entries,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
