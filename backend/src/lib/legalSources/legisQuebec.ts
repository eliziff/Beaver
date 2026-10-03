import { publisherPdfCandidate } from "../legalSourcePresentation";
import { structureNative } from "../structureNative";

/** The LégisQuébec page of a Quebec statute or regulation the shared citation grammar reads
 *  ("CQLR c C-25.01", "RLRQ c B-1, r 3"); null for any other citation. A2AJ holds no Quebec
 *  legislation, and LégisQuébec publishes each consolidation as an official PDF. */
export function legisQuebecPage(citation: string) {
  const [, family, jurisdiction, series, , chapter] = structureNative().citationLookupKey(citation).split(":");
  if (jurisdiction !== "ca-qc" || series !== "cqlr" || !chapter) return null;
  const [act, regulation] = family === "regulation" ? chapter.split(/-r-(?=[^-]+$)/u) : [chapter];
  if (family !== "statute" && !(family === "regulation" && regulation)) return null;
  const id = `${act.toUpperCase()}${regulation ? `, r. ${regulation}` : ""}`;
  return { id, url: `https://www.legisquebec.gouv.qc.ca/en/document/${regulation ? "cr" : "cs"}/${encodeURI(id)}` };
}

export const legisQuebecLegalSourceProvider = {
  canResolve: ({ text, kind }: { text: string; kind: string }) => kind === "legislation" && !!legisQuebecPage(text),
};

/** The official PDF stands for the enactment: LégisQuébec's text is not read. */
export async function legisQuebecSource(citation: string) {
  const page = legisQuebecPage(citation);
  const pdfUrl = page && publisherPdfCandidate(page.url);
  return page && pdfUrl ? { id: page.id.toLowerCase(), citation: citation.trim(), date: null,
    url: page.url, title: null, pdfUrl, text: "" } : null;
}
