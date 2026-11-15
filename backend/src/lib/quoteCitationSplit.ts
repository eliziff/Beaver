import { inSqliteRun, onSqliteRunEnd } from "./legalDataPath";
import { structureNative } from "./structureNative";
import type { QuoteCitationUnit } from "mike/shared/engine-types/QuoteCitationUnit";
import type { AuthoritiesReviewUnit, AuthorityNotePart } from "mike/shared/authorities-contract.d.ts";

/** A unit's part as a quotation's check reads it: its place in the unit's text, its text, the first authority it refers
 *  to and its citation fields. */
export type CitationPart = Pick<AuthorityNotePart, "start" | "end" | "text" | "reference" | "fields">;

// The body units an operation splits, kept while it runs: finding sources splits the units the quote check splits again.
const split = new Map<string, QuoteCitationUnit>();
onSqliteRunEnd(() => split.clear());

/** Each unit's parts: a note's as the import's citation engine split it (its `parts`); a body unit's, which the import
 *  does not split, as the note splitter gives it, with what the parts that cite cite. The engine splits the body units
 *  off this thread, several at once. */
export async function unitCitationParts(units: ReadonlyArray<AuthoritiesReviewUnit>, signal?: AbortSignal)
  : Promise<Array<{ parts: CitationPart[] }>> {
  signal?.throwIfAborted();
  const kept = inSqliteRun() ? split : new Map<string, QuoteCitationUnit>();
  const body = units.filter((unit) => unit.kind === "body").map(({ text }) => text);
  const missing = [...new Set(body.filter((text) => !kept.has(text)))];
  if (missing.length) {
    const read = await structureNative().quoteCitationUnits(missing);
    read.forEach((unit, index) => kept.set(missing[index], unit));
  }
  signal?.throwIfAborted();
  // The receipts' parts: their place, text, reference and fields.
  const part = ({ start, end, text, fields, reference }: AuthorityNotePart): CitationPart =>
    ({ start, end, text, reference, fields: structuredClone(fields) });
  return units.map((unit) => ({ parts: (unit.kind === "body" ? kept.get(unit.text)!.parts : unit.parts ?? []).map(part) }));
}
