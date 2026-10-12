import { cachedContent } from "../contentCache";
import { guardedRemoteFetch } from "../remoteUrlSafety";
import { structureNative } from "../structureNative";
import { canliiFileCitation, verifyIdentity } from "mike/shared/folder-pdf-match.mjs";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import type { LegalSourceProvider, LegalSourceReference } from ".";

const HOSTS = ["www.canlii.org", "canlii.org", "www.canlii.ca", "canlii.ca"];
let indexedUrl: ((text: string) => string | null) | null = null;
export const useCanliiIndex = (resolve: ((text: string) => string | null) | null) => { indexedUrl = resolve; };
const sourceUrl = (text: string) => {
  const value = structureNative().canliiCaseUrl([text], "en", null)
    ?? structureNative().canliiLawUrl(text) ?? indexedUrl?.(text);
  if (!value) return null;
  const url = new URL(value);
  // The private index keeps reporter-page PDF links; source acquisition reads their HTML sibling.
  if (/\/doc\//u.test(url.pathname)) url.pathname = url.pathname.replace(/\.pdf$/iu, ".html");
  url.hash = "";
  return url.href;
};

async function document(source: LegalSourceReference, signal?: AbortSignal) {
  if (!source.url) return null;
  const markup = await cachedContent({ scope: "shared", kind: "legal-source-canlii", key: source.url,
    version: 1, ttlMs: 24 * 60 * 60_000, produce: async () => {
      const response = await guardedRemoteFetch(source.url!, { signal, headers: { Accept: "text/html" } }, {
        label: "CanLII source", allowedHosts: HOSTS, defaultPortOnly: true, allowIpLiterals: false,
        timeoutMs: 15_000, response: { label: "CanLII judgment", maxBytes: 32 * 1024 * 1024,
          contentTypes: ["text/html", "application/xhtml+xml"] } });
      if (!response.ok || response.headers.get("cf-mitigated") === "challenge")
        throw new Error("CanLII requires a browser visit. Open its page and attach the PDF.");
      return response.text();
    } });
  signal?.throwIfAborted();
  const native = await structureNative().deriveDocumentStructure({ kind: "native_markup",
    input: { provider: "canlii", id: source.id, url: source.url, text: "", markup } });
  if (source.kind === "case" && source.citation) {
    const filenameCitation = canliiFileCitation(new URL(source.url).pathname.split("/").at(-1)!.replace(/\.html$/u, ".pdf"));
    verifyIdentity([{ lines: structureNative().documentText(native).split("\n").map((text) => ({ text })) }],
      { citation: source.citation, aliases: [source.citation, ...filenameCitation ? [filenameCitation] : []] },
      (method, request) => structureNative().citationEngineCall(method, JSON.stringify(request)));
  }
  return native;
}

/** CanLII is acquired after corpus providers miss, rather than competing with their exact matches. */
export async function canliiSource(citation: string, signal?: AbortSignal) {
  const url = sourceUrl(citation);
  if (!url) return null;
  const kind = /\/doc\//u.test(url) ? "case" : "legislation";
  const native = await document({ provider: "canlii", kind, id: url, citation, url }, signal);
  if (!native) return null;
  const text = structureNative().documentText(native);
  const { key } = structureNative().citationEngineCall("keyForText", JSON.stringify({ text: citation })) as { key: string | null };
  const title = kind === "case" ? structureNative().citationEngineCall("captionStyleOfCause",
    JSON.stringify({ text, keys: key ? [key] : [] })) as string | null : null;
  return { id: url, citation, date: null, url, title, pdfUrl: /\/doc\//u.test(url) ? url.replace(/\.html(?:#.*)?$/u, ".pdf") : null, text };
}

export const canliiLegalSourceProvider: LegalSourceProvider = {
  id: "canlii",
  canResolve: ({ text, kind }) => (kind === "case" || kind === "legislation") && !!sourceUrl(text),
  async readPassage(request) {
    const native = await document(request.source, request.signal);
    return native ? nativeDocumentPassages({ request, reference: request.source, document: native }) : [];
  },
};
