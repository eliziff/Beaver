/**
 * Deterministic drafting lint: modal force and ambiguous-syntax rules.
 *
 * The rules here are the citable, rule-like subset of drafting guidance —
 * federal legistic guidance (obligations take "must", prohibitions take
 * "must not", never "may not") and the ambiguous-syntax smell family from
 * the Law Smells taxonomy ("and/or", stacked modals). The linter DETECTS
 * deterministically with exact spans and autofix eligibility; whether a
 * flagged span is genuinely defective is the residual-semantics question
 * a model (or the drafter) answers over the excerpt alone — the model
 * never hunts for these from scratch.
 */

export type DraftingSeverity = "error" | "warning" | "info";

export interface DraftingFinding {
  rule: string;
  severity: DraftingSeverity;
  index: number;
  match: string;
  excerpt: string;
  message: string;
  /** Replacement for `match` when the fix is unambiguous; absent = escalate. */
  autofix?: string;
}

export interface ModalProfile {
  shall: number;
  must: number;
  may: number;
  will: number;
  "must not": number;
  "may not": number;
}

export interface DraftingLintReport {
  findings: DraftingFinding[];
  counts: Record<string, number>;
  modalProfile: ModalProfile;
}

const EXCERPT_RADIUS = 70;

function excerptAround(text: string, index: number, length: number): string {
  const from = Math.max(0, index - EXCERPT_RADIUS);
  const to = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/gu, " ")}${to < text.length ? "…" : ""}`;
}

const countMatches = (text: string, re: RegExp) => [...text.matchAll(re)].length;

/**
 * Lint plain legal text. Deterministic and read-only; findings carry the
 * exact span, a bounded excerpt, and autofix eligibility.
 */
export function draftingLint(text: string): DraftingLintReport {
  const findings: DraftingFinding[] = [];

  const push = (
    rule: string,
    severity: DraftingSeverity,
    match: RegExpMatchArray,
    message: string,
    autofix?: string,
  ) => {
    const index = match.index ?? 0;
    findings.push({
      rule,
      severity,
      index,
      match: match[0],
      excerpt: excerptAround(text, index, match[0].length),
      message,
      autofix,
    });
  };

  // "may not" as a prohibition is ambiguous between lack-of-permission and
  // prohibition; federal drafting guidance says prohibitions take "must
  // not". Whether THIS instance is a prohibition is residual semantics —
  // no blind autofix.
  for (const match of text.matchAll(/\bmay\s+not\b/giu)) {
    push(
      "may-not-prohibition",
      "warning",
      match,
      'Ambiguous modal: "may not" reads as either lack of permission or prohibition. Prohibitions take "must not" (federal legistic guidance); confirm intent before rewording.',
    );
  }

  // "and/or" — the canonical ambiguous-syntax smell.
  for (const match of text.matchAll(/\band\/or\b/giu)) {
    push(
      "and-or",
      "warning",
      match,
      '"and/or" is ambiguous (Law Smells: ambiguous syntax). Usually "A or B or both" or a plain "or" is intended.',
    );
  }

  // Stacked modals ("shall must", "must may") are drafting typos.
  for (const match of text.matchAll(/\b(?:shall|must|may|will)\s+(?:shall|must|may|will)\b/giu)) {
    push(
      "stacked-modals",
      "error",
      match,
      "Two modal verbs in a row — almost certainly an editing artifact.",
    );
  }

  const modalProfile: ModalProfile = {
    shall: countMatches(text, /\bshall\b/giu),
    must: countMatches(text, /\bmust\b/giu),
    may: countMatches(text, /\bmay\b/giu),
    will: countMatches(text, /\bwill\b/giu),
    "must not": countMatches(text, /\bmust\s+not\b/giu),
    "may not": countMatches(text, /\bmay\s+not\b/giu),
  };

  // Mixed obligation registers: a document that uses BOTH "shall" and
  // "must" as obligation modals has drifted (often from pasted precedent).
  // One finding at the minority form's first occurrence, not per-hit spam.
  const shallCount = modalProfile.shall;
  const mustCount = modalProfile.must - modalProfile["must not"];
  if (shallCount > 0 && mustCount > 0) {
    const minority = shallCount <= mustCount ? /\bshall\b/giu : /\bmust\b(?!\s+not)/giu;
    const first = [...text.matchAll(minority)][0];
    if (first) {
      push(
        "mixed-shall-must",
        "warning",
        first,
        `Document mixes obligation modals: shall×${shallCount}, must×${mustCount}. Pick one register (modern drafting guidance prefers "must"); mixed modals usually mean pasted precedent.`,
      );
    }
  }

  findings.sort((a, b) => a.index - b.index);
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
  }
  return { findings, counts, modalProfile };
}
