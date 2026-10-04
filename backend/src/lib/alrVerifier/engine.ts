// The citation engine calls ALR composes (legal-structure's legal-citations engine).
import { structureNative } from "../structureNative";

export const engine = <T = unknown>(method: string, request: unknown): T =>
  structureNative().citationEngineCall(method, JSON.stringify(request)) as T;

export type SplitPart = { start: number; end: number; text: string; anchors: string[] };
export type SourceFields = { status: string; corrected: string; kind: string; link_candidate: string;
  pinpoint_fragments: string[]; page_pinpoints: Array<string | number>; bare_citation: string;
  citation_with_style: string; short_form: string; reasons: string[] };
export type EngineCitation = { form: string; format?: string; authority?: string; key?: string;
  span: { start: number; end: number; text: string }; fields: Record<string, string | undefined>;
  pinpoints?: Array<{ kind: string; first?: string; last?: string; text?: string }> };

export const referenceInfo = (text: string) =>
  engine<{ kind: "" | "ibid" | "supra"; notes: string[]; normalized: string }>("referenceInfo", { text: text ?? "" });
export const refKind = (text: string) => referenceInfo(text).kind;
export const isIbid = (text: string) => refKind(text) === "ibid";
export function supraNoteNumber(text: string) {
  const note = referenceInfo(text).notes[0];
  return note !== undefined && /^\d+$/u.test(note) ? Number(note) : null;
}
export const supraHint = (text: string, aggressive: boolean) => engine<string>("supraHint", { text: text ?? "", aggressive });
export const fallbackSupraHint = (text: string) => engine<string>("supraHint", { text: text ?? "", aggressive: false, fallback: true });
export const reanchor = (link: string, text: string) => engine<string>("reanchorReference", { link: link ?? "", text: text ?? "" });
export const bareCitation = (text: string, kind: string) => engine<string>("bareCitation", { text: text ?? "", kind });
export const citations = (text: string) => engine<{ citations: EngineCitation[] }>("extract",
  { text, options: { resolve: false, parallel: false }, offsetUnit: "utf16" }).citations;
export function citationUrl(citation: EngineCitation, options: { anchor?: boolean; language?: string } = {}) {
  return engine<{ urls: Array<{ url: string | null }> }>("url", { citation, ...options }).urls[0]?.url ?? null;
}
