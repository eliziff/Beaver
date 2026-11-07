/** How the book of authorities reads its sources' PDFs. Only a host that builds the book loads this. */
import { authoritiesInputPlan, authorityExcerpt } from "mike/shared/authorities-sources.mjs";
import { authoritiesTextRoles, authorityFilingTargets, authorityPassageTargets, bookScanPolicy,
  excerptContextTargets } from "./authoritiesBuild";
import { authorityCitationForms, authoritiesProfile, type AuthoritiesDraft } from "./authoritiesDomain";
import { authorityPdfOutline, authorityPdfText } from "./authorityPdfText";
import { sha256 } from "./hash";
import type { SourceReadings } from "./sourceReadings";

type ReadInput = Parameters<typeof authorityPdfText>[0];

/** How a draft reads its sources' PDFs. Given the readings a runtime keeps, a source already read
 *  for the same inputs is not read again. */
function sourceReading(draft: AuthoritiesDraft, readings?: SourceReadings) {
  const plan = authoritiesInputPlan(draft, authoritiesProfile(draft.settings.profileId).requirements);
  /** All that reading a role's PDF takes besides its bytes, as data: the readings' key. */
  const request = (role: string) => {
    const attached = plan.authoritySources.find(({ source }) => source.bindingRole === role);
    const authority = attached?.authority;
    const brief = plan.briefPdf?.bindingRole === role;
    const filing = brief || !authority && draft.import.kind === "document" &&
      draft.import.fileType === "pdf" && role === draft.import.bindingRole;
    const targets = authority ? authorityPassageTargets(draft, authority.id)
      : filing && !brief ? authorityFilingTargets(draft) : [];
    const linkGeometry = !!(draft.settings.finalPdf && draft.settings.linkPinpoints);
    const linkFiling = brief && !!(draft.settings.linkTabs || draft.settings.linkPinpoints);
    return {
      // The book nests each authority's own headings and sections under its tab; a final PDF
      // without bookmarks of its own is outlined by the brief's headings.
      outline: authority && plan.bookRoles.has(role) && draft.settings.bookmarks === "headings" || filing && draft.settings.finalPdf
        ? { legislation: authority?.kind === "legislation" } : null,
      text: { scannedPdfPolicy: filing ? "page-margin" as const : bookScanPolicy(draft),
        citations: authority ? authorityCitationForms(draft, authority.id) : [],
        reporterOriginal: attached?.source.origin === "original",
        ocrTargets: filing ? [] : targets,
        // A statute's cited provisions are placed whatever is marked, as are an excerpt's cited passages and
        // the paragraphs around them: its excerpt keeps their pages.
        passageTargets: brief ? [] : [...filing || linkGeometry || draft.settings.passageMarking !== "none" ||
          authority?.kind === "legislation" || authority && authorityExcerpt(draft, authority) ? targets : [],
          ...authority ? excerptContextTargets(draft, authority) : []],
        // A brief's citations are placed by its own text, as the draft reviewed them.
        ...(linkFiling ? { filing: { ...draft, stage: undefined, authorities: Object.fromEntries(Object.entries(
          draft.authorities).map(([id, { annotations: _, ...authority }]) => [id, authority])) } } : {}) },
    };
  };
  const kept = <T>(kind: string, part: unknown, input: ReadInput, read: (input: ReadInput) => Promise<T>) => {
    if (!readings) return read(input);
    const { bytes, signal: _, progress: __, ...rest } = input;
    return readings({ kind, part, input: { ...rest, sourceSha256: rest.sourceSha256 ?? sha256(bytes) } }, input, read);
  };
  /** A role's text, pages and passages, as a build reads them. */
  const readText = async (role: string, input: ReadInput) => {
    input.signal?.throwIfAborted();
    const { text } = request(role), { filing, ...read } = text;
    const result = await kept("text", text, input, (input) => authorityPdfText({ ...input, ...read,
      ...(filing ? { passageTargets: (pages: string[]) => authorityFilingTargets(draft, pages) } : {}) }));
    input.signal?.throwIfAborted();
    // The paragraphs placed for an excerpt's context are its pages, never passages of their own.
    const context = (cited: boolean) => result.passageGeometry?.targets.filter(({ id }) => id.startsWith("context:") !== cited);
    const contextPages = [...new Set(context(false)?.flatMap(({ status, pages }) =>
      status === "found" ? pages.map(({ pageNumber }) => pageNumber - 1) : []))];
    return { pageTextByPage: result.pageTextByPage,
      ...(result.pageLabels ? { pageLabels: result.pageLabels, pageBindings: result.pageBindings } : {}),
      ...(result.ocrTextByPage.some(Boolean) ? { ocrTextByPage: result.ocrTextByPage } : {}),
      ...(result.passageGeometry ? { passageGeometry: { ...result.passageGeometry, targets: context(true)! } } : {}),
      ...(contextPages.length ? { contextPages } : {}) };
  };
  return { plan, request, kept, readText };
}

/** A role's text, pages and passages as a build reads them, asking nothing of other sources. */
export const authoritiesSourceText = (draft: AuthoritiesDraft, readings?: SourceReadings) =>
  sourceReading(draft, readings).readText;

/** Same role decisions and text projection for Library and standalone. */
export function createAuthoritiesPreparation(draft: AuthoritiesDraft, readings?: SourceReadings) {
  const { plan, request, kept, readText } = sourceReading(draft, readings);
  const textRoles = authoritiesTextRoles(draft);
  return { ...plan, textRoles,
    async prepareText(role: string, input: ReadInput) {
      input.signal?.throwIfAborted();
      const { outline: outlined } = request(role);
      const outline = outlined ? await kept("outline", outlined, input, (input) =>
        authorityPdfOutline({ ...input, ...outlined })).catch((error) => {
        if (input.signal?.aborted) throw error;
        return [];
      }) : [];
      return { ...(textRoles.has(role) ? await readText(role, input) : { pageBindings: undefined }),
        ...(outline.length ? { outline } : {}) };
    },
  };
}
