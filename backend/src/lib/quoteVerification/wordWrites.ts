// The writes a quote check makes on the article's own document, for every host that writes them: the Word copy (into
// the file, docxWriteSpans) and the Word add-in (into the open document, through Office.js). Each span is written by
// the plan the verifier made for it; nothing here reads the engine, so the add-in's pane loads it as it is.
import type { DocxSpanWrite } from "mike/shared/engine-types/DocxSpanWrite";
import { partLinks, writtenAddress } from "mike/shared/runtime/wordLinks.mjs";
import type { WordCopy, WordPart, WordPlan, WordResult } from "./wordResult";

/** A write on a span of a unit's text: corrected by its plan's edits (as tracked changes), coloured by its highlight
 *  runs, or linked (`replace`: in place of a link it has). */
export type WordWrite = { unitId: string; start: number; end: number; expected: string } & (
  { kind: "tracked"; edits: WordPlan["edits"] } | { kind: "highlight"; highlights: WordPlan["highlights"] }
  | { kind: "link"; url: string; replace?: boolean });

/** The writes `copy` asks for: each span by its plan, then each citation part's links, its words to the page and its
 *  pinpoint to the paragraph (a link where a correction changes the text is left out). A host leaves out a unit it has
 *  written already (`open`), and gives a part's link where it has another, or none (`linkOf`). */
export function wordWrites(result: WordResult, { quotations, links, correction }: WordCopy,
  { open = () => true, linkOf = (part) => part.link }: { open?: (unitId: string) => boolean; linkOf?: (part: WordPart) => string | null } = {}) {
  const writes: WordWrite[] = [];
  for (const span of result.spans.filter(({ unitId }) => open(unitId))) {
    const at = { unitId: span.unitId, start: span.start, end: span.end, expected: span.expected };
    const tracked = quotations === "tracked" || quotations === "both" ? span.plans.tracked[correction] : null;
    const coloured = quotations === "highlight" || quotations === "both" ? span.plans.highlight[correction] : null;
    if (tracked) writes.push({ ...at, kind: "tracked", edits: tracked.edits });
    if (coloured) writes.push({ ...at, kind: "highlight", highlights: coloured.highlights });
  }
  const edited = (unitId: string, start: number, end: number) => writes.some((write) => write.kind === "tracked" && write.unitId === unitId
    && write.edits.some(([from, length]) => write.start + from < end && start < write.start + from + Math.max(length, 1)));
  if (links) for (const note of result.notes.filter(({ unitId }) => open(unitId))) for (const part of note.parts) {
    const link = linkOf(part);
    if (!link || !/^https?:/u.test(link)) continue;
    for (const { span, url } of partLinks({ ...part, written: writtenAddress(part.text, part.start, link) }, link))
      if (!edited(note.unitId, span.start, span.end))
        writes.push({ unitId: note.unitId, start: span.start, end: span.end, expected: span.text, kind: "link", url });
  }
  return writes;
}

/** The writes as the Word copy's writer takes them: each edit and each highlight run a span of its own. */
export const docxWrites = (writes: WordWrite[]): DocxSpanWrite[] => writes.flatMap((write): DocxSpanWrite[] => {
  const { unitId, start, expected } = write;
  if (write.kind === "link") return [{ kind: "link", unitId, start, end: write.end, expected, url: write.url }];
  if (write.kind === "tracked") return write.edits.map(([from, length, replacement]) => ({ kind: "replace", unitId,
    start: start + from, end: start + from + length, expected: expected.slice(from, from + length), replacement }));
  return write.highlights.map(([from, to, changed]) => ({ kind: "highlight", unitId, start: start + from, end: start + to,
    expected: expected.slice(from, to), color: changed ? "red" : "green" }));
});
