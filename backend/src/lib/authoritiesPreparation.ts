/** How the book of authorities reads its sources' PDFs. Only a host that builds the book loads this. */
import { authoritiesInputPlan } from "mike/shared/authorities-sources.mjs";
import { authoritiesTextRoles, authorityFilingTargets, authorityPassageTargets, bookScanPolicy } from "./authoritiesBuild";
import { authorityCitationForms, authoritiesProfile, type AuthoritiesDraft } from "./authoritiesDomain";
import { authorityPdfOutline, authorityPdfReading, instrumentReading } from "./authorityPdfText";
import { structureNative } from "./structureNative";

type ReadInput = Parameters<typeof authorityPdfReading>[0];

/** How a draft reads its sources' PDFs: an authority's as its document, the brief's or filing's as its pages' text
 *  and the citations placed on them. */
function sourceReading(draft: AuthoritiesDraft) {
  const plan = authoritiesInputPlan(draft, authoritiesProfile(draft.settings.profileId).requirements);
  /** All that reading a role's PDF takes besides its bytes. */
  const request = (role: string) => {
    const authority = plan.authoritySources.find(({ source }) => source.bindingRole === role)?.authority;
    const brief = plan.briefPdf?.bindingRole === role;
    const filing = brief || !authority && draft.import.kind === "document" &&
      draft.import.fileType === "pdf" && role === draft.import.bindingRole;
    return { authority, brief, filing,
      // The book nests each authority's own headings and sections under its tab; a final PDF
      // without bookmarks of its own is outlined by the brief's headings.
      outline: authority && plan.bookRoles.has(role) && draft.settings.bookmarks === "headings" || filing && draft.settings.finalPdf,
      text: { scannedPdfPolicy: filing ? "page-margin" as const : bookScanPolicy(draft),
        instrument: instrumentReading(authority),
        citations: authority ? authorityCitationForms(draft, authority.id) : [],
        ocrTargets: authority ? authorityPassageTargets(draft, authority.id) : [] } };
  };
  /** A role's reading as a build takes it. */
  const readText = async (role: string, input: ReadInput) => {
    input.signal?.throwIfAborted();
    const { filing, brief, text } = request(role);
    const reading = await authorityPdfReading({ ...input, ...text });
    input.signal?.throwIfAborted();
    if (!filing) return reading ? { reading } : {};
    // A brief's citations are placed by its own text, as the draft reviewed them.
    const native = structureNative(), pageTextByPage = reading ? native.pdfPageTexts(reading.document) : [];
    const targets = !brief ? authorityFilingTargets(draft) : draft.settings.linkTabs || draft.settings.linkPinpoints
      ? authorityFilingTargets(draft, pageTextByPage) : [];
    const passageGeometry = reading && targets.length
      ? await native.pdfPassageGeometry(reading.document, targets, []) : undefined;
    return { pageTextByPage, ...(passageGeometry ? { passageGeometry } : {}) };
  };
  return { plan, request, readText };
}

/** A role's reading as a build takes it, asking nothing of other sources. */
export const authoritiesSourceText = (draft: AuthoritiesDraft) => sourceReading(draft).readText;

/** Same role decisions and reading for Library and standalone. */
export function createAuthoritiesPreparation(draft: AuthoritiesDraft) {
  const { plan, request, readText } = sourceReading(draft);
  const textRoles = authoritiesTextRoles(draft);
  return { ...plan, textRoles,
    async prepareText(role: string, input: ReadInput) {
      input.signal?.throwIfAborted();
      const { outline: outlined, text } = request(role);
      const outline = outlined ? await authorityPdfOutline({ ...input, instrument: text.instrument }).catch((error) => {
        if (input.signal?.aborted) throw error;
        return [];
      }) : [];
      return { ...(textRoles.has(role) ? await readText(role, input) : {}),
        ...(outline.length ? { outline } : {}) };
    },
  };
}
