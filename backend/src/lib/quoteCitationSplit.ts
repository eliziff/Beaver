import { structureNative, type NativeReferencePart } from "./structureNative";
import type { SourceFields, SourceSplit } from "legal-citations";

export type QuoteCitationUnit = { status: string; reasons: string[];
  parts: Array<{ start: number; end: number; text: string; anchors: string[]; reference: string;
    fields: { status: string; corrected: string; kind: string; link_candidate: string;
      pinpoint_fragments: string[]; page_pinpoints: number[]; bare_citation: string;
      citation_with_style: string; short_form: string; reasons: string[] } }>;
  delimiters: Array<[number, number, string]> };

/** Each unit's parts that cite, with what they cite: prose beside them is never a quotation's source. */
export async function splitQuoteCitationUnits(texts: string[], signal?: AbortSignal): Promise<QuoteCitationUnit[]> {
  const native = structureNative();
  return texts.map((text) => {
    signal?.throwIfAborted();
    const split = native.citationEngineCall("splitSources", JSON.stringify({ text,
      recallFirst: true, offsetUnit: "utf16" })) as SourceSplit;
    const cited = native.citationEngineCall("noteReferences", JSON.stringify({ parts: split.parts,
      offsetUnit: "utf16" })) as NativeReferencePart[];
    return { status: split.status, reasons: split.reasons, parts: cited.map(({ part, references }) => {
      signal?.throwIfAborted();
      const fields = native.citationEngineCall("sourceFields", JSON.stringify({ part })) as SourceFields;
      return { start: part.start, end: part.end, text: part.text, anchors: part.anchors,
        reference: references[0].text, fields: { ...fields,
          page_pinpoints: fields.page_pinpoints.map(Number) } };
    }), delimiters: split.delimiters };
  });
}
