import { authoritiesInputPlan } from "mike/shared/authorities-sources.mjs";
import { reject } from "./applicationError";
import { updateAuthoritiesDraft } from "./authoritiesActions";
import { authoritiesTextRoles, authorityFilingTargets, authorityPassageTargets } from "./authoritiesBuild";
import { authorityCitationForms, authoritiesProfile, type AuthoritiesDraft, type AuthoritiesDiscrepancyAction } from "./authoritiesDomain";
import { authoritiesDiscrepancyCorrection, reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import { authorityPdfOutline, authorityPdfText } from "./authorityPdfText";
import { applyAuthorityDiscrepancyCorrection } from "./docxOperations";
import { sha256 } from "./hash";
import type { SourceReadings } from "./sourceReadings";

/** Host callbacks verify exact input bytes; only the host publishes the corrected version. */
export async function prepareAuthoritiesCorrection<T extends { bytes: Buffer }>(
  draft: AuthoritiesDraft, input: { id: string; action: AuthoritiesDiscrepancyAction },
  readSource: (imported: Extract<AuthoritiesDraft["import"], { kind: "document" }>) => Promise<T>,
  reviewer: typeof reviewAuthoritiesDiscrepancies = reviewAuthoritiesDiscrepancies,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const finding = (await reviewer(draft, signal)).find(({ id }) =>
    id === input.id && !draft.discrepancyDecisions?.[id]) ?? reject(409,
      "This discrepancy is no longer present. Review the document again.");
  if (!finding.actions.includes(input.action)) reject(400,
    "That correction is not available for this discrepancy");
  const decided = updateAuthoritiesDraft(draft,
    { type: "resolve-discrepancy", id: finding.id, action: input.action });
  signal?.throwIfAborted();
  if (input.action === "ignore") return { kind: "ignored" as const, draft: decided };
  const imported = draft.import.kind === "document" && draft.import.fileType === "docx"
    ? draft.import : reject(409, "Source corrections require an imported Word document");
  const source = await readSource(imported);
  signal?.throwIfAborted();
  const correction = authoritiesDiscrepancyCorrection(draft, finding, input.action) ??
    reject(409, "The correction cannot be mapped to the reviewed Word document");
  const bytes = await applyAuthorityDiscrepancyCorrection(source.bytes, draft.units, correction)
    .catch((error) => reject(409, error instanceof Error ? error.message
      : "The Word correction could not be applied"));
  signal?.throwIfAborted();
  return { kind: "corrected" as const, draft: decided, source, bytes };
}

type ReadInput = Parameters<typeof authorityPdfText>[0];

/** Same role decisions and text projection for Library and standalone. Given the readings a
 *  runtime keeps, a source already read for the same inputs is not read again. */
export function createAuthoritiesPreparation(draft: AuthoritiesDraft, readings?: SourceReadings) {
  const plan = authoritiesInputPlan(draft, authoritiesProfile(draft.settings.profileId).requirements);
  const textRoles = authoritiesTextRoles(draft);
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
      outline: authority && draft.outputMode !== "table" || filing && draft.settings.finalPdf
        ? { legislation: authority?.kind === "legislation" } : null,
      text: { scannedPdfPolicy: filing ? "page-margin" as const : draft.settings.scannedPdfPolicy,
        citations: authority ? authorityCitationForms(draft, authority.id) : [],
        reporterOriginal: attached?.source.origin === "original",
        ocrTargets: filing ? [] : targets,
        passageTargets: brief ? [] : filing || linkGeometry || draft.settings.passageMarking !== "none" ? targets : [],
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
    return { pageTextByPage: result.pageTextByPage,
      ...(result.pageLabels ? { pageLabels: result.pageLabels, pageBindings: result.pageBindings } : {}),
      ...(result.ocrTextByPage.some(Boolean) ? { ocrTextByPage: result.ocrTextByPage } : {}),
      ...(result.passageGeometry ? { passageGeometry: result.passageGeometry } : {}) };
  };
  return { ...plan, textRoles, readText,
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
