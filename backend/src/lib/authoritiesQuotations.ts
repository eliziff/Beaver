import type { AuthoritiesDraft } from "./authoritiesDomain";
import { structureNative } from "./structureNative";
import { normalizeWhitespace } from "./text";

type Units = AuthoritiesDraft["units"];
/** How much of the text a footnote's proposition is (the ALR Quote Verifier's "quote context"): the passage since
 *  the note before it, or the sentence its marker ends or stands in. */
export type QuoteContext = "passage" | "sentence";

/** A quote belongs to the passage preceding one uniquely anchored footnote, or with `context` "sentence", to the
 *  sentence its marker ends or stands in (the engine's footnote_propositions). Each proposition's `start` and `end`
 *  are offsets in the body text, its units joined in order with a line break. */
export function footnotePropositions(units: Units, context: QuoteContext = "passage") {
  const { propositions } = structureNative().footnotePropositions(units, context);
  return new Map(propositions.map(({ footnoteId, parts, ...proposition }) => [footnoteId, { ...proposition,
    parts: parts.map(({ unit, start, end }) => ({ unit: units[unit], start, end })) }]));
}
export function markedQuotations(text: string) {
  return [...new Set(structureNative().markedQuoteSpans(text).map(({ text }) => normalizeWhitespace(text)))]
    .filter(quote => quote.length >= 8 && (quote.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 2);
}
/** Multiple citations (including unresolved ones) cannot each claim all of a note's quotations. */
export function singleSourceFootnote(draft: Pick<AuthoritiesDraft, "units" | "occurrences">, unit: Units[number]) {
  return unit.kind === "footnote" && unit.occurrenceIds.length === 1
    ? draft.occurrences[unit.occurrenceIds[0]] : undefined;
}
