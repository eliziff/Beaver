import { cachedContent } from "../contentCache";
import { retriedRemoteFetch } from "../remoteUrlSafety";
import { structureNative } from "../structureNative";
import { canliiFileCitation, verifyIdentity } from "mike/shared/folder-pdf-match.mjs";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import { lookupsLeaveComputer, type LegalSourceProvider, type LegalSourceReference } from ".";

const HOSTS = ["www.canlii.org", "canlii.org", "www.canlii.ca", "canlii.ca"];
type IndexedUrl = (text: string, firstPinpoint?: string | null) => string | null;
let indexedUrl: IndexedUrl | null = null;
/** A host's own lookup of a decision's CanLII page, for a citation the engine builds no page for. */
export const useCanliiIndex = (resolve: IndexedUrl | null) => { indexedUrl = resolve; };
/** The CanLII page of the decision `text` cites, from the host's lookup; null without one, or where it finds none.
 *  At its first paragraph pinpoint (`firstPinpoint`, "par12"). */
export const indexedCaseUrl: IndexedUrl = (text, firstPinpoint) => indexedUrl?.(text, firstPinpoint) ?? null;
const sourceUrl = (text: string) => {
  const value = structureNative().canliiCaseUrl([text], "en", null)
    ?? structureNative().canliiLawUrl(text) ?? indexedCaseUrl(text);
  if (!value) return null;
  const url = new URL(value);
  // A looked-up page may be a reporter-page PDF; source acquisition reads its HTML sibling.
  if (/\/doc\//u.test(url.pathname)) url.pathname = url.pathname.replace(/\.pdf$/iu, ".html");
  url.hash = "";
  return url.href;
};

/** CanLII refused this app its pages (its challenge, which only a browser visit passes): it refuses every page alike,
 *  so no other form of the citation is asked. The page's PDF is attached instead. */
export class CanliiRefused extends Error {
  constructor() { super("CanLII requires a browser visit. Open its page and attach the PDF."); }
}

/** The page CanLII publishes at the source's address, as far as CanLII redirects it; null where it publishes none
 *  there (404, 410), or where a decision's page is not the decision cited (its own citation is another). */
async function document(source: LegalSourceReference, signal?: AbortSignal) {
  if (!source.url) return null;
  const markup = await cachedContent({ scope: "shared", kind: "legal-source-canlii", key: source.url,
    version: 1, ttlMs: 24 * 60 * 60_000, produce: async () => {
      const response = await retriedRemoteFetch(source.url!, { signal, headers: { Accept: "text/html" } }, {
        label: "CanLII source", allowedHosts: HOSTS, defaultPortOnly: true, allowIpLiterals: false, maxRedirects: 3,
        timeoutMs: 15_000, response: { label: "CanLII judgment", maxBytes: 32 * 1024 * 1024,
          contentTypes: ["text/html", "application/xhtml+xml"] } });
      if (response.status === 404 || response.status === 410) return "";
      if (response.status === 403 || response.headers.get("cf-mitigated") === "challenge") throw new CanliiRefused();
      if (!response.ok) throw new Error(`CanLII answered ${response.status} for ${source.url}.`);
      return response.text();
    } });
  signal?.throwIfAborted();
  if (!markup) return null;
  const native = await structureNative().deriveDocumentStructure({ kind: "native_markup",
    input: { provider: "canlii", id: source.id, url: source.url, text: "", markup } });
  if (source.kind === "case" && source.citation) {
    const filenameCitation = canliiFileCitation(new URL(source.url).pathname.split("/").at(-1)!.replace(/\.html$/u, ".pdf"));
    // verifyIdentity answers only by throwing: the page names another decision, or none it can read.
    try {
      verifyIdentity([{ lines: structureNative().documentText(native).split("\n").map((text) => ({ text })) }],
        { citation: source.citation, aliases: [source.citation, ...filenameCitation ? [filenameCitation] : []] },
        (method, request) => structureNative().citationEngineCall(method, JSON.stringify(request)));
    } catch { return null; }
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
  canResolve: ({ text, kind }) => (kind === "case" || kind === "legislation") && lookupsLeaveComputer() && !!sourceUrl(text),
  async readPassage(request) {
    const native = await document(request.source, request.signal);
    return native ? nativeDocumentPassages({ request, reference: request.source, document: native }) : [];
  },
};
