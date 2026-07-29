// Local A2AJ Hansard chat tools — the read path for the imported debates
// plane (lib/a2ajHansard.ts; imported by scripts/import_a2aj_hansard.py).
// Research-gated alongside the other legal-source tools: sealed benchmark
// runs must not see information sources beyond the matter documents.
import {
  fetchLocalHansardIntervention,
  searchLocalHansard,
} from "../../a2ajHansard";
import type { OpenAIToolSchema } from "../../llm";

const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAIToolSchema => ({
  type: "function",
  function: { name, description, parameters },
});

export const HANSARD_TOOLS: OpenAIToolSchema[] = [
  tool(
    "hansard_search",
    "Search the locally imported A2AJ Hansard corpus (Ontario Legislative Assembly debates), with optional speaker and date filters. Returns snippets with stable ids for hansard_fetch. Reports hansard_not_installed when no local database has been imported.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Full-text query; tokens are AND-ed and prefix-matched.",
        },
        size: { type: "number", description: "Maximum results, 1-50 (default 10)." },
        speaker: {
          type: "string",
          description: "Optional speaker-name substring filter.",
        },
        start_date: {
          type: "string",
          description: "Optional ISO date lower bound (inclusive).",
        },
        end_date: {
          type: "string",
          description: "Optional ISO date upper bound (inclusive).",
        },
        sort: {
          type: "string",
          enum: ["relevance", "newest_first", "oldest_first"],
          description: "Result order; default relevance (BM25).",
        },
      },
      required: ["query"],
    },
  ),
  tool(
    "hansard_fetch",
    "Fetch one full Hansard intervention by the id returned from hansard_search.",
    {
      type: "object",
      properties: {
        id: { type: "string", description: "Intervention id from hansard_search." },
      },
      required: ["id"],
    },
  ),
];

/** Handles hansard_* calls; returns null for any other tool name. */
export function executeHansardTool(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (name === "hansard_search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { ok: false, error: "query is required" };
    try {
      const hits = searchLocalHansard({
        query,
        size: typeof args.size === "number" ? args.size : undefined,
        speaker: typeof args.speaker === "string" ? args.speaker : undefined,
        startDate:
          typeof args.start_date === "string" ? args.start_date : undefined,
        endDate: typeof args.end_date === "string" ? args.end_date : undefined,
        sortResults:
          args.sort === "newest_first"
            ? "newest_first"
            : args.sort === "oldest_first"
              ? "oldest_first"
              : "default",
      });
      if (hits === null) {
        return {
          ok: false,
          error: "hansard_not_installed",
          detail:
            "No local Hansard database found. Import one with backend/scripts/import_a2aj_hansard.py.",
        };
      }
      return { ok: true, hit_count: hits.length, hits };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Hansard search failed",
      };
    }
  }
  if (name === "hansard_fetch") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) return { ok: false, error: "id is required" };
    try {
      const intervention = fetchLocalHansardIntervention({ id });
      if (!intervention) {
        return {
          ok: false,
          error: "hansard_intervention_not_found",
          detail:
            "No intervention with that id (or no Hansard database has been imported).",
        };
      }
      return { ok: true, intervention };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Hansard fetch failed",
      };
    }
  }
  return null;
}
