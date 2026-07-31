/**
 * Canonical citation machinery, pure and dependency-free: the corpus
 * identity key (`citationLookupKey`) and the in-text detector
 * (`citationsInText` / `hasCitationInText`). Both are single-surface by
 * rule — a new citation regex in a consumer file is a defect.
 *
 * Canonical citation identity: the ONE Beaver port of the reference
 * implementation's corpus-index normalizer (ALR-Quote-Verifier
 * local_a2aj._citation_lookup_key — the function that keys the corpus's
 * lookup.duckdb; toa_maker._citation_key is its authority-matching cousin).
 * "RSA 2000, c A-4.2" -> "rsa2000ca4dot2": NFKC, en/em dashes to "-",
 * digit-bounded "." "-" "/" become "dot"/"dash"/"slash" so revision
 * punctuation survives the alphanumeric squeeze, casefold, strip.
 *
 * Python's casefold() is toLowerCase() plus full case folding; the one
 * folding that survives NFKC and can reach the [a-z0-9] output is
 * sharp-s -> "ss", so it is applied explicitly — the retrieval-gate
 * oracle differential test (retrievalGate.test.ts, over an oracle dump the
 * probe produces from the read-only reference) caught exactly this
 * divergence. That differential test remains the arbiter for this module.
 *
 * Returns "" when nothing survives; callers wanting a typed refusal wrap it
 * (caselawCitator does).
 */
export function citationLookupKey(value: string): string {
  let v = (value || "").normalize("NFKC");
  v = v.replace(/–/gu, "-").replace(/—/gu, "-");
  v = v.replace(/(?<=\d)\.(?=\d)/gu, "dot");
  v = v.replace(/(?<=\d)-(?=\d)/gu, "dash");
  v = v.replace(/(?<=\d)\/(?=\d)/gu, "slash");
  return v
    .toLowerCase()
    .replace(/ß/gu, "ss")
    .replace(/[^a-z0-9]+/gu, "");
}

export type CitationMatch = {
  /** The matched substring, verbatim. */
  text: string;
  start: number;
  end: number;
};

/**
 * Citation tokens as they appear in Canadian legal prose: neutral
 * citations ("2016 SCC 27", the French twin "2015 CSC 5"), [year]
 * reporter cites ("[2019] 4 S.C.R. 653"), volume-reporter-page
 * ("112 O.R. (3d) 321"), CanLII ids, and "(1985), 48 C.R. (3d) 226"-style
 * first-instance reporters. Alternation order is significant: the two
 * unambiguous shapes are tried first so a neutral or bracketed cite is
 * never split by the looser volume-reporter alternative.
 *
 * Calibrated on 3,000 random citator edges (2026-07-30) as part of the
 * prose-vs-authority-list classifier, then promoted here so every caller
 * inherits one tested surface.
 */
const CITATION_IN_TEXT_SOURCE = [
  String.raw`\b(?:19|20)\d{2}\s+[A-Z]{2,8}\s+\d+\b`,
  String.raw`\[\d{4}\]\s+\d*\s*[A-Z][A-Za-z.]{1,12}\.?\s+\d+`,
  String.raw`\b\d+\s+[A-Z][A-Za-z.']{1,14}\s*(?:\(\d[a-z]{0,2}\))?\s+\d+\b`,
  String.raw`\bCanLII\s+\d+\b`,
  String.raw`\(\d{4}\),?\s+\d+\s+[A-Z][A-Za-z.]{1,14}`,
].join("|");
const CITATION_IN_TEXT = new RegExp(CITATION_IN_TEXT_SOURCE, "gu");
// Separate non-global twin: `test` on a /g/ regex carries lastIndex.
const CITATION_IN_TEXT_TEST = new RegExp(CITATION_IN_TEXT_SOURCE, "u");

/**
 * Where the citation-shaped substrings of free text are — the ONE shared
 * in-text detector. Consumers: `citatorExcerpts.classifyCitatorExcerpt`
 * (citation spans / coverage of a citing-context excerpt) and
 * `a2ajPassageSearch` (citation short-circuit over a natural-language
 * query, and the residual non-citation tokens for the bm25 lane).
 *
 * This is detection, not identification: feed a match to
 * `citationLookupKey` (or `caselawCitator.citationAliasKeys`) to resolve
 * it. Deliberately NOT folded in: the neutral-citation parsers in
 * `canliiUrls.buildCanliiCaseUrl` and `legalSourceLinks.answerCaseCitations`,
 * which need year/court/number capture groups and a wider court-slug
 * charset gated by the CanLII route table — a different contract.
 */
export function citationsInText(text: string): CitationMatch[] {
  return [...(text || "").matchAll(CITATION_IN_TEXT)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Whether `text` contains at least one citation-shaped substring. */
export function hasCitationInText(text: string): boolean {
  return CITATION_IN_TEXT_TEST.test(text || "");
}
