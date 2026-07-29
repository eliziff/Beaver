/**
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
