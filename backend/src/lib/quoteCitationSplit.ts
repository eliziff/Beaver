import { inSqliteRun, onSqliteRunEnd } from "./legalDataPath";
import { structureNative } from "./structureNative";

export type QuoteCitationUnit = { status: string; reasons: string[];
  parts: Array<{ start: number; end: number; text: string; anchors: string[]; reference: string;
    fields: { status: string; corrected: string; kind: string; link_candidate: string;
      pinpoint_fragments: string[]; page_pinpoints: number[]; bare_citation: string;
      citation_with_style: string; short_form: string; reasons: string[] } }>;
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
    const units = await structureNative().citationEngineCallAsync("quoteCitationUnits",
      JSON.stringify({ texts: missing })) as QuoteCitationUnit[];
    // The engine gives a part's page pinpoints as it reads them, in words.
    units.forEach((unit, index) => kept.set(missing[index], { ...unit, parts: unit.parts.map((part) => ({ ...part,
      fields: { ...part.fields, page_pinpoints: part.fields.page_pinpoints.map(Number) } })) }));
  }
  signal?.throwIfAborted();
  return texts.map((text) => structuredClone(kept.get(text)!));
}
