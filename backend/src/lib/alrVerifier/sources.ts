// The sources ALR reads quotations against, adapted from Beaver's legal-source operations:
// A2AJ (local corpus first, then api.a2aj.ca), the journals database, and US/UK case providers.
import { legalSourceOperations } from "../legalSourceApplication";
import { journalLegalSourceProvider } from "../legalSources/journal";
import { a2ajLegalSourceProvider } from "../legalSources/a2aj";
import type { LegalSourceReference } from "../legalSources";
import { structureNative, type NativeDocument } from "../structureNative";

export type SourceBlock = { kind: "paragraph" | "page" | "section"; label: string; start: number; end: number; text: string };
export type SourceDocument = { text: string; blocks: SourceBlock[]; native?: NativeDocument };
export type JournalHit = { articleId: string; title: string; journal: string; citation: string; galleyUrl: string };

export type AlrSources = {
  resolve(text: string, kind: "case" | "legislation", language?: "en" | "fr"): Promise<LegalSourceReference | null>;
  document(reference: LegalSourceReference): Promise<SourceDocument | null>;
  foreignCaseUrl(text: string): Promise<string>;
  journals(text: string, limit: number): Promise<JournalHit[]>;
  /** Times a lookup could not be answered (offline, rate-limited): reported, never fatal. */
  failures: string[];
};

/** A native document's text with its paragraphs, pages and provisions as ALR names them. */
export function sourceDocument(native: NativeDocument): SourceDocument {
  const engine = structureNative(), text = engine.documentText(native);
  const blocks = engine.documentAnchors(native).flatMap((anchor): SourceBlock[] => {
    if (anchor.kind !== "paragraph" && anchor.kind !== "page" && anchor.kind !== "section") return [];
    // Native labels may carry their kind ("page333", "para 12", "s. 4"); ALR names them "par12", "page 333", "sec4".
    const prefix = { paragraph: /^(?:paras?\.?|par|¶)\s*(?=\d)/iu, page: /^(?:pages?|pp?\.?)\s*(?=\d)/iu,
      section: /^(?:sections?|ss?\.|sec)\s*(?=\d)/iu }[anchor.kind];
    const value = anchor.label.trim().replace(prefix, "").replace(/^\[(.*)\]$/u, "$1");
    const label = anchor.kind === "paragraph" ? `par${value}` : anchor.kind === "page" ? `page ${value}` : `sec${value}`;
    return [{ kind: anchor.kind, label, start: anchor.start, end: anchor.end, text: text.slice(anchor.start, anchor.end) }];
  });
  return { text, blocks, native };
}

/** Quotation sources from Beaver's providers. Citations resolve through A2AJ alone; other case
 *  providers answer only foreign citations, and never in a local-only run. */
export function beaverSources(options: { localOnly?: boolean } = {}, operations = legalSourceOperations): AlrSources {
  const failures: string[] = [];
  const resolved = new Map<string, Promise<LegalSourceReference | null>>();
  const documents = new Map<string, Promise<SourceDocument | null>>();
  const attempt = async <T>(label: string, work: () => Promise<T>, empty: T) => {
    try { return await work(); }
    catch (error) { failures.push(`${label}: ${(error as Error)?.message ?? error}`); return empty; }
  };
  return {
    failures,
    resolve(text, kind, language = "en") {
      const key = JSON.stringify([text, kind, language]);
      if (!text.trim()) return Promise.resolve(null);
      if (!resolved.has(key)) resolved.set(key, attempt(`resolve ${text}`, async () => {
        const request = { text, kind, language };
        if (!a2ajLegalSourceProvider.canResolve?.(request)) return null;
        const found = await a2ajLegalSourceProvider.resolve!(request);
        return found.length === 1 ? found[0] : null;
      }, null));
      return resolved.get(key)!;
    },
    document(reference) {
      const key = JSON.stringify([reference.provider, reference.id, reference.collection, reference.language]);
      if (!documents.has(key)) documents.set(key, attempt(`read ${reference.citation ?? reference.id}`, async () => {
        const read = await operations.readPassage({ source: reference });
        const native = read.status === "found" ? read.values[0]?.documentArtifact : null;
        return native ? sourceDocument(native) : null;
      }, null));
      return documents.get(key)!;
    },
    async foreignCaseUrl(text) {
      const foreign = structureNative().providerCitationsInText(text).some(({ jurisdiction }) =>
        jurisdiction !== "ca" && !jurisdiction?.startsWith("ca-"));
      if (!foreign || options.localOnly) return "";
      return attempt(`resolve ${text}`, async () => {
        const result = await operations.resolve({ text, kind: "case" });
        return result.status === "found" && result.value.provider !== "a2aj" ? result.value.url ?? "" : "";
      }, "");
    },
    journals: (text, limit) => attempt(`journal ${text}`, async () =>
      journalLegalSourceProvider.find(text, limit).map((row) => ({ articleId: String(row.articleId), title: row.name,
        journal: row.journalName ?? "", citation: row.citation, galleyUrl: row.url ?? "" })), [] as JournalHit[]),
  };
}
