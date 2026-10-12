// What a quote check means for the article's own document, for the Word add-in to write into the open document and for
// the page to write into a Word copy: the workbook's rows (so each part's link is the workbook's) placed on the footnotes' text, and the spans whose text the check compares with the source, each with its
// correction both ways: the workbook's ("marked": the author's changes in square brackets, omissions as ellipses) and
// the source's own words ("source"). Only mapping: links, references, corrections and statuses are the primitives'.
import { pinpointText } from "../authoritiesDiscrepancy";
import type { AuthoritiesDraft } from "../authoritiesDomain";
import { characterPlan, highlightRuns, sequenceOpcodes } from "mike/shared/sequence-diff.mjs";
import type { DocxSpanWrite } from "../docxOperations";
import type { checkQuotes, QuoteCheck } from "../quoteCheck";
import type { alrRows } from "./checkedWorkbook";
import { partLinks, writtenAddress } from "mike/shared/runtime/wordLinks.mjs";

type Check = Awaited<ReturnType<typeof checkQuotes>>;
type Span = { start: number; end: number; text: string };

/** A footnote's part as the workbook writes it, where it is in the note, and the citation it holds: its link (the
 *  workbook's Citation link, at the pinpoint where it has one), its citation's own words (`core`, never its style of
 *  cause) and its pinpoint. */
export type WordPart = { index: number; start: number; end: number; text: string; link: string;
  occurrenceId: string | null; core: Span | null; pinpoint: Span | null; editorLink: boolean;
  /** A web address the citation writes out, where it is its link: the words its link goes on. */
  written: Span | null };

/** A quotation's selected check against the sources its note cites, with what a correction writes each way. */
export type WordQuote = { id: string; unitId: string; start: number; end: number; text: string;
  status: QuoteCheck["status"] | "found";
  /** Wording accepted by a computed comparison; independent of the native locator's precision. */
  perfect: boolean; pinpoint: string; detail: string; link: string;
  marked: string | null; source: string | null;
  /** The note's part it was checked against (its place in `parts`), or null. */
  part: number | null };
/** A span the check compares with the source: the text there, and what it is corrected to, the workbook's way and the
 *  source's (equal to `expected` where it matches; null where it is left as written). */
export type WordSpan = { id: string; kind: "quote" | "pinpoint"; unitId: string; start: number; end: number;
  expected: string; marked: string | null; source: string | null };
export type WordNote = { unitId: string; number: string; parts: WordPart[]; quotes: WordQuote[] };
export type WordResult = { units: Array<{ id: string; kind: "body" | "footnote"; text: string }>; notes: WordNote[]; spans: WordSpan[] };
/** How a correction writes a quotation: the workbook's way, or in the source's own words. */
export type Correction = "marked" | "source";
export type WordCitation = "first" | "best";

const LOCATOR = { par: "paragraph", "page ": "page", sec: "section" } as Record<string, string>;
const found = (check: QuoteCheck) => !!check.receipt && check.receipt.match.location !== "unmatched";
const OUTER = /^[\s"“”«»„']+|[\s"“”«»„']+$/gu, CLOSE = /[.,;:!?]+$/u;
/** Text between the authored quotation's own outer quotation marks, as the authored quotation has them. */
const quoted = (authored: string, words: string) =>
  `${/^["“«„']*/u.exec(authored)![0]}${words}${/["”»']*$/u.exec(authored)![0]}`;
/** A correction keeps more of the authored characters than it changes; one that would replace the quotation with other
 *  text (a match the check made on too wide a passage) is not written. */
function corrects(authored: string, target: string) {
  const kept = sequenceOpcodes([...authored], [...target]).reduce((sum, [kind, a0, a1]) => kind === "equal" ? sum + a1 - a0 : sum, 0);
  return kept > authored.length - kept + target.length - kept;
}
/** When in doubt, a quotation is left as written: a correction any of whose changes only adds or removes spaces (the
 *  source's text read with a space too many, say "T.’ s") is none. */
const spacesOnly = (authored: string, target: string) => sequenceOpcodes([...authored], [...target])
  .some(([kind, a0, a1, b0, b1]) => kind !== "equal" && /^\s*$/u.test(authored.slice(a0, a1) + target.slice(b0, b1)));
/** The workbook's corrected quotation in the authored quotation's own quotation marks. */
function markedWords(authored: string, corrected: string) {
  const words = corrected.replace(OUTER, "");
  if (!words) return null;
  const target = quoted(authored, words);
  return target !== authored && !spacesOnly(authored, target) && corrects(authored, target) ? target : null;
}
/** The source's words for an authored quotation, with the authored quotation's outer quotation marks and closing
 *  punctuation (where it falls is the citing text's choice, not the source's). A quotation the author already altered
 *  (brackets, an ellipsis) is left as written. */
function sourceWords(authored: string, fragment: string) {
  const words = fragment.replace(OUTER, "").replace(CLOSE, "");
  if (!words || /[[\]…]|\.\.\./u.test(authored)) return null;
  const target = quoted(authored, `${words}${CLOSE.exec(authored.replace(OUTER, ""))?.[0] ?? ""}`);
  return target !== authored && !spacesOnly(authored, target) && corrects(authored, target) ? target : null;
}

/** The best wording check, then the most precise locator: word for word, at the cited place, closest;
 *  or, found nowhere, the first. */
function bestCheck(checks: QuoteCheck[]) {
  const hits = checks.filter(found);
  const rank = (check: QuoteCheck) => [check.status === "verified" && check.receipt!.comparison ? 1 : 0,
    check.receipt!.match.perfect ? 1 : 0, check.receipt!.match.location.startsWith("cited") ? 1 : 0, check.receipt!.match.score];
  return hits.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || y[3] - x[3];
  })[0] ?? checks[0];
}

/** The check's results on the article's text, from the rows its workbook was written with. */
export function wordResult(draft: AuthoritiesDraft, check: Check, rows: Awaited<ReturnType<typeof alrRows>>,
  citation: WordCitation = "first"): WordResult {
  const units = [...draft.units].sort((a, b) => a.ordinal - b.ordinal);
  const notes = new Map<string, WordNote>();
  const cursor = new Map<string, number>();
  // Each part's quotation link, as its workbook row gives it (the Python app's "Corrected quote" link).
  const quoteLinks = new Map<string, Array<{ start: number; end: number; link: string }>>();
  for (const row of rows) {
    const unit = units.find((item) => item.kind === "footnote" && item.footnoteId === row.footnote_id);
    if (!unit) continue;
    const note: WordNote = notes.get(unit.id) ?? { unitId: unit.id, number: row.footnote_display_id, parts: [], quotes: [] };
    notes.set(unit.id, note);
    // The workbook's parts are the note's, in order: each is found after the one before.
    const start = unit.text.indexOf(row.citation_part_text, cursor.get(unit.id) ?? 0);
    if (start < 0) continue;
    const end = start + row.citation_part_text.length;
    cursor.set(unit.id, end);
    quoteLinks.set(unit.id, [...quoteLinks.get(unit.id) ?? [], { start, end, link: String(row.quote_match_link ?? "") }]);
    const occurrence = unit.occurrenceIds.map((id: string) => draft.occurrences[id])
      .find((item) => item && item.start >= start && item.start < end);
    const link = occurrence?.link ?? String(row.citation_part_link);
    note.parts.push({ index: Number(row.citation_part_index), start, end, text: row.citation_part_text,
      link, occurrenceId: occurrence?.id ?? null,
      core: occurrence?.coreSpan.text ? occurrence.coreSpan : null, pinpoint: occurrence?.pinpointSpan ?? null, editorLink: !!occurrence?.link,
      written: writtenAddress(row.citation_part_text, start, link) });
  }
  const spans: WordSpan[] = [], pinpoints = new Map<string, WordSpan | null>();
  for (const quote of check.quotes) {
    const noteId = quote.candidates[0]?.unitId, note = noteId ? notes.get(noteId) : undefined;
    const unit = units.find((item) => item.id === quote.unitId);
    if (!note || !unit || unit.text.slice(quote.start, quote.end) !== quote.quote) continue;
    const best = citation === "best" ? bestCheck(quote.checks)
      : quote.checks.find(({ candidateId }) => candidateId === quote.candidates[0]?.id) ?? quote.checks[0];
    const match = best && found(best) ? best.receipt!.match : null;
    // The citation the result was checked against: its row's link opens the passage, as the workbook's does.
    const candidate = best && quote.candidates.find(({ id }) => id === best.candidateId);
    // The note's parts and their quotation links are listed alike, so a part's place is its link's.
    const placed = candidate ? quoteLinks.get(candidate.unitId) ?? [] : [];
    const part = candidate ? placed.findIndex(({ start, end }) => start <= candidate.start && candidate.start < end) : -1;
    const authored = quote.quote.trim();
    const compared = !!best?.receipt?.comparison, supported = !!match && compared && best.status === "verified";
    // Only a computed wording mismatch is corrected; a short fuzzy hit does not justify changing the author's words.
    const certain = !!match && compared && !supported && authored.split(/\s+/u).length >= 4;
    const marked = certain ? markedWords(authored, match!.corrected) : null;
    const source = certain ? sourceWords(authored, match!.fragment) : null;
    note.quotes.push({ id: quote.id, unitId: quote.unitId, start: quote.start, end: quote.end, text: quote.quote,
      status: match ? "found" : best?.status ?? "unresolved", perfect: supported, pinpoint: match?.pinpoint ?? "",
      detail: best?.detail ?? "", link: placed[part]?.link || best?.receipt?.link || "", marked, source,
      part: candidate?.unitId === note.unitId && part >= 0 ? part : null });
    if (!match || (!supported && !marked && !source)) continue;
    // The quotation inside the same outer spaces.
    const lead = quote.quote.length - quote.quote.trimStart().length, trail = quote.quote.length - quote.quote.trimEnd().length;
    spans.push({ id: `quote:${quote.id}`, kind: "quote", unitId: quote.unitId, start: quote.start + lead, end: quote.end - trail,
      expected: authored, marked: supported ? authored : marked, source: supported ? authored : source });
    // Found word for word at another paragraph, page or provision of the kind its one pinpoint (not a range) names: that
    // pinpoint, renumbered.
    const occurrence = best.candidateId ? draft.occurrences[best.candidateId] : undefined, span = occurrence?.pinpointSpan;
    const [, kind] = /^(par|page |sec)/u.exec(match.labels[0] ?? "") ?? [];
    if (!supported || !match.perfect || !match.location.startsWith("alternate") || match.labels.length !== 1 || !occurrence || !span ||
      occurrence.pinpoints.length !== 1 || occurrence.pinpoints[0].last || LOCATOR[kind] !== occurrence.pinpoints[0].kind) continue;
    const target = pinpointText(span.text, match.labels[0]) ?? span.text;
    const key = `${occurrence.unitId}:${span.start}`, earlier = pinpoints.get(key);
    // Two quotations that send one pinpoint to different places leave it as written.
    pinpoints.set(key, earlier === undefined || earlier?.marked === target ? { id: `pinpoint:${occurrence.id}`, kind: "pinpoint",
      unitId: occurrence.unitId, start: span.start, end: span.end, expected: span.text, marked: target, source: target } : null);
  }
  for (const span of pinpoints.values()) if (span && span.marked !== span.expected) spans.push(span);
  return { units: units.map(({ id, kind, text }) => ({ id, kind, text })), notes: [...notes.values()], spans };
}

/** How a Word copy writes the results: tracked corrections, coloured quotations, both or neither, and
 *  the citations' pinpoints linked. */
export type WordCopy = { quotations: "tracked" | "highlight" | "both" | null; links: boolean; correction: Correction };
/** The writes a Word copy makes (Beaver's writeDocxSpans), each correction in the fewest changed characters (however long), as the
 *  Word add-in writes it; a link where a correction changes its text is left out. */
export function documentWrites(result: WordResult, { quotations, links, correction }: WordCopy): DocxSpanWrite[] {
  const writes: DocxSpanWrite[] = [];
  for (const span of result.spans) {
    if (quotations === "tracked" || quotations === "both") {
      const target = span[correction];
      if (target && target !== span.expected) for (const [start, length, replacement] of characterPlan(span.expected, target))
        writes.push({ kind: "replace", unitId: span.unitId, start: span.start + start, end: span.start + start + length,
          expected: span.expected.slice(start, start + length), replacement });
    }
    if ((quotations === "highlight" || quotations === "both") && span.kind === "quote") {
      const target = span[correction] ?? span.source ?? span.marked;
      if (target) for (const [from, to, changed] of highlightRuns(span.expected, characterPlan(span.expected, target)))
        writes.push({ kind: "highlight", unitId: span.unitId, start: span.start + from, end: span.start + to,
          expected: span.expected.slice(from, to), color: changed ? "red" : "green" });
    }
  }
  const edited = writes.filter(({ kind }) => kind === "replace");
  if (links) for (const note of result.notes) for (const part of note.parts) {
    if (!/^https?:/u.test(part.link)) continue;
    for (const { span, url } of partLinks(part, part.link)) if (!edited.some((write) => write.unitId === note.unitId &&
      write.start < span.end && span.start < Math.max(write.end, write.start + 1)))
      writes.push({ kind: "link", unitId: note.unitId, start: span.start, end: span.end, expected: span.text, url });
  }
  return writes;
}
