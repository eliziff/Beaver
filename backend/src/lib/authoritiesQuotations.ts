import type { AuthoritiesDraft } from "./authoritiesDomain";
import { structureNative } from "./structureNative";
import { normalizeWhitespace } from "./text";

type Units = AuthoritiesDraft["units"];
/** A quote belongs to the passage preceding one uniquely anchored footnote. */
export function footnotePropositions(units: Units) {
  const body = units.filter(({ kind }) => kind === "body")
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const anchors: Array<{ id: number; position: number }> = [];
  const parts: Array<{ unit: Units[number]; start: number }> = [];
  let text = "";
  for (const unit of body) {
    parts.push({ unit, start: text.length });
    for (const [id, offset] of unit.footnoteRefs) if (Number.isSafeInteger(id) && id > 0 &&
      Number.isSafeInteger(offset) && offset >= 0 && offset <= unit.text.length)
      anchors.push({ id, position: text.length + offset });
    text += `${unit.text}\n`;
  }
  anchors.sort((a, b) => a.position - b.position || a.id - b.id);
  const counts = new Map<number, number>();
  for (const { id } of anchors) counts.set(id, (counts.get(id) ?? 0) + 1);
  const result = new Map<number, { text: string; parts: Array<{ unit: Units[number]; start: number; end: number }> }>();
  let previous = 0;
  for (const { id, position } of anchors) {
    const start = previous; previous = position;
    if (counts.get(id) !== 1 || position <= start) continue;
    result.set(id, { text: normalizeWhitespace(text.slice(start, position)),
      parts: parts.flatMap(({ unit, start: offset }) => {
        const from = Math.max(0, start - offset), to = Math.min(unit.text.length, position - offset);
        return from < to ? [{ unit, start: from, end: to }] : [];
      }) });
  }
  return result;
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
