/**
 * Court-hierarchy levels for the A2AJ corpus court codes (the exact
 * values of citator case_doc.court and the a2aj_corpus/cases directory
 * names — all 28 verified against the 2026-07-30 full citator build).
 *
 * Used as a ranking prior for stands-for profiles (research plan D2):
 * appellate characterizations of a cited case outrank trial ones, which
 * outrank tribunal ones (Eli's hierarchy prior). Levels order courts;
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

const LEVELS: Record<string, CourtLevel> = {
  SCC: { level: 5, kind: "apex" },

  FCA: { level: 4, kind: "appellate" },
  CMAC: { level: 4, kind: "appellate" },
  BCCA: { level: 4, kind: "appellate" },
  ONCA: { level: 4, kind: "appellate" },
  NSCA: { level: 4, kind: "appellate" },
  YKCA: { level: 4, kind: "appellate" },

  BCSC: { level: 3, kind: "superior_trial" },
  NSSC: { level: 3, kind: "superior_trial" },
  FC: { level: 3, kind: "superior_trial" },
  TCC: { level: 3, kind: "superior_trial" },

  NSPC: { level: 2, kind: "inferior_trial" },
  NSFC: { level: 2, kind: "inferior_trial" },
  NSSM: { level: 2, kind: "inferior_trial" },

  CART: { level: 1, kind: "tribunal" },
  CHRT: { level: 1, kind: "tribunal" },
  CIRB: { level: 1, kind: "tribunal" },
  CITT: { level: 1, kind: "tribunal" },
  CT: { level: 1, kind: "tribunal" },
  FPSLREB: { level: 1, kind: "tribunal" },
  OHSTC: { level: 1, kind: "tribunal" },
  OIC: { level: 1, kind: "tribunal" },
  PSDPT: { level: 1, kind: "tribunal" },
  RAD: { level: 1, kind: "tribunal" },
  RLLR: { level: 1, kind: "tribunal" },
  RPD: { level: 1, kind: "tribunal" },
  SCT: { level: 1, kind: "tribunal" },
  SST: { level: 1, kind: "tribunal" },
  TATC: { level: 1, kind: "tribunal" },
};

export function courtLevel(code: string | null | undefined): CourtLevel | null {
  if (!code) return null;
  return LEVELS[code.trim().toUpperCase()] ?? null;
}
