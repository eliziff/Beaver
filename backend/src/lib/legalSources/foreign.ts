import { structureNative, type NativeDocument } from "../structureNative";
import type { ForeignCase } from "mike/shared/engine-types/ForeignCase";
import { answered, lookupsLeaveComputer, type LegalSourceProvider, type LegalSourceReference } from ".";
import { nativeDocumentPassages } from "./nativeDocumentPassages";

/** The publishers abroad the engine reads a decision from (legal-structure-features foreign_case.rs). */
const NAMES = { tna: "The National Archives", "govuk-et": "GOV.UK", govinfo: "GovInfo" } as const;
type Publisher = keyof typeof NAMES;

/** A decision a publisher abroad holds, as a passage read keeps it: its document and the PDFs its publisher offers. */
export type RemoteLegalSourceDocument = { provider: Publisher; identity: string; title: string | null; url: string;
  native: NativeDocument; attachments: ForeignCase["attachments"] };

/** The decision the citations in `text` name, as `publisher` holds it (at `saved`, its page, where an earlier lookup
 *  kept it); null where it holds none. */
async function foreignCase(publisher: Publisher, text: string, signal?: AbortSignal, saved?: string | null) {
  signal?.throwIfAborted();
  const outcome = await structureNative().foreignCase(text, publisher, saved ?? null);
  signal?.throwIfAborted();
  return answered(outcome, NAMES[publisher]);
}

const reference = (found: ForeignCase) => ({ provider: found.provider, kind: "case", id: found.id, title: found.title,
  citation: found.citation, url: found.url }) satisfies LegalSourceReference;

/** A source as Authorities reads one: its id (Find Case Law's in lower case, as drafts keep it), citation, page, title,
 *  the PDF its publisher gives and its text. */
export const foreignCaseSource = (publisher: Publisher) => async (citation: string, signal?: AbortSignal) => {
  const found = await foreignCase(publisher, citation, signal);
  return found && { id: publisher === "tna" ? found.id.toLowerCase() : found.id, citation: found.citation, date: null,
    url: found.url, title: found.title, pdfUrl: found.pdfUrl, text: structureNative().documentText(found.native) };
};

const provider = (publisher: Publisher): LegalSourceProvider<RemoteLegalSourceDocument> => ({
  id: publisher,
  canResolve: ({ kind, text }) => kind === "case" && lookupsLeaveComputer(publisher)
    && structureNative().foreignCaseClaimed(text).includes(publisher),
  async resolve({ text, signal }) {
    const found = await foreignCase(publisher, text, signal);
    return found ? [reference(found)] : [];
  },
  async readPassage(request) {
    const found = await foreignCase(publisher, request.source.citation || request.source.id, request.signal, request.source.url);
    if (!found) return [];
    const document = { provider: publisher, identity: found.id, title: found.title, url: found.url, native: found.native,
      attachments: found.attachments };
    return nativeDocumentPassages({ request, document: found.native, reference: { ...request.source, ...reference(found) },
      native: document });
  },
});

export const foreignCaseProviders = { tna: provider("tna"), "govuk-et": provider("govuk-et"), govinfo: provider("govinfo") };

/** A Constitution Act or annual statute of Canada no consolidated act holds, as Justice Laws publishes it: its official
 *  PDF, and its title where the brief gives it no name (the engine's justice_laws). */
export const justiceLawsProvider = { canResolve: ({ kind }: { kind: string }) => kind === "legislation" };
export async function justiceLawsSource(citation: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const found = answered(await structureNative().justiceLaws(citation, lookupsLeaveComputer()), "Justice Laws");
  signal?.throwIfAborted();
  return found && { id: found.id, citation: found.citation, date: null, title: found.title, url: found.url,
    pdfUrl: found.pdfUrl, text: "", titleIfUnnamed: true };
}
