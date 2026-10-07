import type { AuthoritiesDraft } from "./authoritiesDomain";
import { structureNative } from "./structureNative";
import { normalizeWhitespace } from "./text";

type Units = AuthoritiesDraft["units"];
/** How much of the text a footnote's proposition is (the ALR Quote Verifier's "quote context"): the passage since
 *  the note before it, or the sentence its marker ends or stands in. */
export type QuoteContext = "passage" | "sentence";

// The sentence a marker stands in, as the ALR Quote Verifier finds it (alr_quote_verifier.py _anchor_sentence_pos,
// _sentence_bounds_smart): a period in a number, an ellipsis or after a common abbreviation or a single letter does not
// end a sentence, a line break does, and a closing quotation mark after the end belongs to the sentence.
const ABBREVIATION = /(?<![\p{L}\p{N}_])(?:Dr|Mr|Mrs|Ms|Jr|Sr|Hon|Prof|Rev|St|No|Nos|pp|para|paras|vol|vols|art|arts|pt|ch|cl|sch|sec|ss|ed|eds|e\.g|i\.e|etc|cf|viz|seq|vs|al|Ltd|Inc|Co|Corp|Bros|Assn|Dept|Univ|Intl|Natl|Ct|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|[A-Za-z])\.?$/iu;
const CLOSING_DOUBLE = new Set(['"', "”", "»"]), CLOSERS = new Set([...")\"']}]”’"]);
const endsSentence = (text: string, at: number) => text[at] === "!" || text[at] === "?" || (text[at] === "." &&
  !(/\d/u.test(text[at - 1] ?? "") && /\d/u.test(text[at + 1] ?? "")) && text[at - 1] !== "." && text[at + 1] !== "." &&
  !ABBREVIATION.test(text.slice(Math.max(0, at - 12), at + 1)));
function sentenceBounds(text: string, position: number, window = 1200): [number, number] {
  const at = Math.max(0, Math.min(text.length, position));
  const low = Math.max(0, at - window), high = Math.min(text.length, at + window);
  let left = low - 1;
  for (let index = at - 1; index >= low; index -= 1) if (text[index] === "\n" || endsSentence(text, index)) { left = index; break; }
  let start = left + 1;
  if (start > 0 && start < text.length && /[.!?]/u.test(text[start - 1]) && CLOSING_DOUBLE.has(text[start])) start += 1;
  while (start < high && /\s/u.test(text[start])) start += 1;
  let end = high;
  for (let index = at; index < high; index += 1) if (text[index] === "\n" || endsSentence(text, index)) { end = index + 1; break; }
  while (end > 0 && end < text.length && /[.!?]/u.test(text[end - 1]) && CLOSING_DOUBLE.has(text[end])) end += 1;
  return [start, end];
}
/** A marker after a sentence's end stands for that sentence; anywhere else, for the one it stands in. */
function markerSentence(text: string, marker: number, after: number): [number, number] {
  let at = Math.min(Math.max(marker - 1, 0), text.length - 1), position = marker;
  while (at > 0 && /\s/u.test(text[at])) at -= 1;
  if (/[.!?]/u.test(text[at])) position = at;
  else if (CLOSERS.has(text[at])) {
    let before = at;
    while (before > 0 && CLOSERS.has(text[before])) before -= 1;
    while (before > 0 && /\s/u.test(text[before])) before -= 1;
    if (/[.!?]/u.test(text[before])) position = before;
  }
  let [start, end] = sentenceBounds(text, position);
  // A sentence that starts inside a quotation opened since the last proposition starts where the quotation's does.
  for (const [open, close] of [["“", "”"], ['"', '"']]) {
    const opened = text.lastIndexOf(open, start - 1);
    if (opened < after || opened < 0) continue;
    const closed = text.indexOf(close, opened + 1);
    if (closed >= 0 && closed < start) continue;
    const closing = text.indexOf(close, start);
    if (closing >= 0 && closing < start + 200) { [start] = sentenceBounds(text, Math.max(0, opened - 1)); break; }
  }
  return [start, end];
}

/** A quote belongs to the passage preceding one uniquely anchored footnote, or with `context` "sentence", to the
 *  sentence its marker ends or stands in. Each proposition's `start` and `end` are offsets in the body text, its
 *  units joined in order with a line break. */
export function footnotePropositions(units: Units, context: QuoteContext = "passage") {
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
  const result = new Map<number, { text: string; start: number; end: number;
    parts: Array<{ unit: Units[number]; start: number; end: number }> }>();
  // Anchors and parts are both in text order, so one pass pairs each passage with its parts.
  let previous = 0, first = 0, after = 0;
  for (const { id, position } of anchors) {
    const passage = previous; previous = position;
    while (first < parts.length && parts[first].start + parts[first].unit.text.length <= passage) first += 1;
    if (counts.get(id) !== 1 || position <= passage) continue;
    const [start, end] = context === "sentence" ? markerSentence(text, position, after) : [passage, position];
    if (context === "sentence") after = end;
    if (start >= end) continue;
    const covered: Array<{ unit: Units[number]; start: number; end: number }> = [];
    // A sentence may start before the note before it.
    let index = first;
    while (index > 0 && parts[index].start > start) index -= 1;
    for (; index < parts.length && parts[index].start < end; index += 1) {
      const { unit, start: offset } = parts[index];
      const from = Math.max(0, start - offset), to = Math.min(unit.text.length, end - offset);
      if (from < to) covered.push({ unit, start: from, end: to });
    }
    result.set(id, { text: normalizeWhitespace(text.slice(start, end)), start, end, parts: covered });
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
