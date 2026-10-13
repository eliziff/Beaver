import { structureNative } from "./structureNative";

/**
 * Court-hierarchy levels for the A2AJ corpus court codes (the exact
 * values of citator case_doc.court and the a2aj_corpus/cases directory
 * names — all 28 verified against the 2026-07-30 full citator build).
 *
 * Used as a ranking prior for stands-for profiles (research plan D2):
 * appellate characterizations of a cited case outrank trial ones, which
 * outrank tribunal ones (a hierarchy prior). Levels order courts;
 * they are NOT authority weights and imply no treatment judgment.
 *
 * Unknown codes return null (typed refusal) — callers must handle,
 * never default.
 */

export type CourtLevel = {
  /** 5 apex > 4 appellate > 3 superior/federal trial > 2 inferior trial > 1 tribunal */
  level: 1 | 2 | 3 | 4 | 5;
  kind:
    | "apex"
    | "appellate"
    | "superior_trial"
    | "inferior_trial"
    | "tribunal";
};

const RANK: Record<CourtLevel["kind"], CourtLevel["level"]> = {
  apex: 5, appellate: 4, superior_trial: 3, inferior_trial: 2, tribunal: 1,
};
const levels = new Map<string, CourtLevel | null>();

export function courtLevel(code: string | null | undefined): CourtLevel | null {
  if (!code?.trim()) return null;
  const surface = code.trim().toUpperCase();
  if (levels.has(surface)) return levels.get(surface)!;
  const courts = structureNative().citationEngineCall("registry",
    JSON.stringify({ table: "courts", surface })) as Array<{ hierarchy: CourtLevel["kind"] }>;
  const court = courts[0];
  const result = court ? { level: RANK[court.hierarchy], kind: court.hierarchy } : null;
  levels.set(surface, result);
  return result;
}
