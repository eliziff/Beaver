import { inSqliteRun, onSqliteRunEnd } from "./legalDataPath";
import { structureNative } from "./structureNative";

/** A note split into its citation parts, each with the citation engine's fields of it (`SourceFields`). */
export type QuoteCitationUnit = { status: string; reasons: string[];
  parts: Array<{ start: number; end: number; text: string; anchors: string[]; reference: string;
    fields: import("legal-citations").SourceFields }>;
  delimiters: Array<[number, number, string]> };

// The units an operation splits, kept while it runs: finding sources splits the notes the quote check splits again.
const split = new Map<string, QuoteCitationUnit>();
onSqliteRunEnd(() => split.clear());

/** Each unit's parts, every one as the note splitter gives it, with what the parts that cite
 *  cite: a quotation's source may be commentary in a note that cites nothing. The engine splits them off this thread,
 *  several at once. */
export async function splitQuoteCitationUnits(texts: string[], signal?: AbortSignal): Promise<QuoteCitationUnit[]> {
  signal?.throwIfAborted();
  const kept = inSqliteRun() ? split : new Map<string, QuoteCitationUnit>();
  const missing = [...new Set(texts.filter((text) => !kept.has(text)))];
  if (missing.length) {
    const units = await structureNative().offThread("citationEngineCall", "quoteCitationUnits",
      { texts: missing }) as QuoteCitationUnit[];
    units.forEach((unit, index) => kept.set(missing[index], unit));
  }
  signal?.throwIfAborted();
  return texts.map((text) => structuredClone(kept.get(text)!));
}
