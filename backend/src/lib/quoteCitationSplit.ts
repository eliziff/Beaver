import { structureNative } from "./structureNative";

export type QuoteCitationUnit = { status: string; reasons: string[];
  parts: Array<{ start: number; end: number; text: string; anchors: string[]; reference: string;
    fields: { status: string; corrected: string; kind: string; link_candidate: string;
      pinpoint_fragments: string[]; page_pinpoints: number[]; bare_citation: string;
      citation_with_style: string; short_form: string; reasons: string[] } }>;
  delimiters: Array<[number, number, string]> };

/** Each unit's parts, every one as the note splitter gives it, with what the parts that cite
 *  cite: a quotation's source may be commentary in a note that cites nothing. */
export async function splitQuoteCitationUnits(texts: string[], signal?: AbortSignal): Promise<QuoteCitationUnit[]> {
  signal?.throwIfAborted();
  // The engine gives a part's page pinpoints as it reads them, in words.
  const units = structureNative().citationEngineCall("quoteCitationUnits", JSON.stringify({ texts })) as QuoteCitationUnit[];
  return units.map((unit) => ({ ...unit, parts: unit.parts.map((part) => ({ ...part,
    fields: { ...part.fields, page_pinpoints: part.fields.page_pinpoints.map(Number) } })) }));
}
