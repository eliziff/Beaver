/**
 * Deterministic near-miss repair for failed quotation claims, ported in
 * approach from ALR-Quote-Verifier (Eli's reference implementation; see
 * `_quote_match_score` / `_build_corrected_citation` there): token-level
 * alignment between a claimed quotation and its cited span. Where ALR
 * emits McGill-style bracket-edited corrections, Beaver's verbatim tier
 * accepts only contiguous substrings of the span — so the repair offered
 * here is the span's own best-matching contiguous token window, which
 * passes the tier by construction when requoted exactly.
 */

const TOKEN_RE = /\p{L}[\p{L}\p{N}'’‐-―-]*|\p{N}+/gu;

type SpanToken = { norm: string; start: number; end: number };

function normToken(raw: string): string {
  return raw
    .replace(/[‘’‚′]/gu, "'")
    .replace(/[–—−‐-―]/gu, "-")
    .toLowerCase();
}

function tokenizeWithOffsets(text: string): SpanToken[] {
  const tokens: SpanToken[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    tokens.push({
      norm: normToken(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

export type QuoteRepair = {
  /** Matched tokens of the longest common contiguous run. */
  matched: number;
  /** Word-token count of the claimed quotation. */
  claimTokens: number;
  /** matched / claimTokens (0 when the claim has no word tokens). */
  score: number;
  /**
   * The cited span's own contiguous text covering the longest common
   * token run — verbatim in the span by construction — or null when the
   * overlap is too thin to ground a suggestion.
   */
  excerpt: string | null;
};

/**
 * Longest common CONTIGUOUS token run between claim and span (classic
 * O(n*m) DP), rendered back to the span's original characters. Inputs
 * are capped to keep rejection-path cost bounded; spans here are
 * passage-scoped receipts, not documents.
 */
export function nearestVerbatimExcerpt(
  claimBody: string,
  spanText: string,
): QuoteRepair {
  const claim = tokenizeWithOffsets(claimBody).slice(0, 400);
  const span = tokenizeWithOffsets(spanText).slice(0, 4_000);
  const empty: QuoteRepair = {
    matched: 0,
    claimTokens: claim.length,
    score: 0,
    excerpt: null,
  };
  if (!claim.length || !span.length) return empty;
  let best = 0;
  let bestSpanEnd = 0;
  let previous = new Array<number>(claim.length + 1).fill(0);
  for (let i = 1; i <= span.length; i += 1) {
    const current = new Array<number>(claim.length + 1).fill(0);
    for (let j = 1; j <= claim.length; j += 1) {
      if (span[i - 1].norm !== claim[j - 1].norm) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) {
        best = current[j];
        bestSpanEnd = i;
      }
    }
    previous = current;
  }
  const excerpt =
    best >= 6
      ? spanText.slice(
          span[bestSpanEnd - best].start,
          span[bestSpanEnd - 1].end,
        )
      : null;
  return {
    matched: best,
    claimTokens: claim.length,
    score: best / claim.length,
    excerpt: excerpt !== null && excerpt.length >= 25 ? excerpt : null,
  };
}

/**
 * One bounded repair suggestion line for a rejection message, or null
 * when no cited span overlaps the claim enough to suggest honestly
 * (thin overlap must stay a plain rejection — never a lookalike quote).
 */
export function quoteRepairSuggestion(
  claimBody: string,
  spans: string[],
): string | null {
  let best: QuoteRepair | null = null;
  for (const span of spans) {
    const repair = nearestVerbatimExcerpt(claimBody, span);
    if (repair.excerpt !== null && (best === null || repair.score > best.score))
      best = repair;
  }
  if (best === null || best.score < 0.5) return null;
  const excerpt =
    best.excerpt!.length > 600
      ? best.excerpt!.slice(0, best.excerpt!.lastIndexOf(" ", 600))
      : best.excerpt!;
  return `closest verbatim excerpt of its cited span (${best.matched} of ${best.claimTokens} words match): “${excerpt}” — if this serves, resubmit quoting it EXACTLY as shown`;
}
