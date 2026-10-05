import { authoritiesInputPlan } from "mike/shared/authorities-sources.mjs";
import { reject } from "./applicationError";
import { updateAuthoritiesDraft } from "./authoritiesActions";
import { authoritiesTextRoles, authorityFilingTargets, authorityPassageTargets, bookScanPolicy } from "./authoritiesBuild";
import { authorityCitationForms, authoritiesProfile, type AuthoritiesDraft } from "./authoritiesDomain";
import type { AuthoritiesDiscrepancyRequest } from "mike/shared/authorities-contract.d.ts";
import { authoritiesDiscrepancyCorrection, reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import { authorityPdfOutline, authorityPdfText } from "./authorityPdfText";
import { applyAuthorityDiscrepancyCorrection, rejectAuthorityDiscrepancyCorrection } from "./docxOperations";
import { sha256 } from "./hash";
import type { SourceReadings } from "./sourceReadings";

/** Host callbacks verify exact input bytes; only the host publishes the corrected version. A Word brief's
 *  corrections are tracked changes, whose ids the decision keeps; "reopen" undoes a decision, rejecting
 *  the revisions it wrote and nothing else. A decision that changes only the draft is returned as one
 *  ignored. */
export async function prepareAuthoritiesCorrection<T extends { bytes: Buffer }>(
  draft: AuthoritiesDraft, input: { id: string; action: AuthoritiesDiscrepancyRequest },
  readSource: (imported: Extract<AuthoritiesDraft["import"], { kind: "document" }>) => Promise<T>,
  reviewer: typeof reviewAuthoritiesDiscrepancies = reviewAuthoritiesDiscrepancies,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const word = draft.import.kind === "document" && draft.import.fileType === "docx" ? draft.import : null;
  const corrected = async (decided: AuthoritiesDraft, change: (bytes: Buffer) => Promise<Buffer>) => {
    const source = await readSource(word!);
    signal?.throwIfAborted();
    const bytes = await change(source.bytes).catch((error) => reject(409, error instanceof Error ? error.message
      : "The Word correction could not be applied"));
    signal?.throwIfAborted();
    return { kind: "corrected" as const, draft: decided, source, bytes };
  };
  if (input.action === "reopen") {
    if (!draft.discrepancyDecisions?.[input.id]) reject(409, "This finding has no decision to undo.");
    const revisions = draft.discrepancyCorrections?.[input.id]?.revisions ?? [];
    const reopened = updateAuthoritiesDraft(draft, { type: "reopen-discrepancy", id: input.id });
    return revisions.length && word ? corrected(reopened, (bytes) => rejectAuthorityDiscrepancyCorrection(bytes, revisions))
      : { kind: "ignored" as const, draft: reopened };
  }
  const action = input.action;
  // Writes the corrections as tracked changes and records their ids with the decision.
  const decide = async (corrections: Parameters<typeof applyAuthorityDiscrepancyCorrection>[2],
    authority?: NonNullable<AuthoritiesDraft["discrepancyCorrections"]>[string]["authority"], then = (value: AuthoritiesDraft) => value) => {
    let revisions: number[] = [];
    const result = await corrected(draft, async (bytes) => {
      const written = await applyAuthorityDiscrepancyCorrection(bytes, draft.units, corrections);
      revisions = written.revisions;
      return written.bytes;
    });
    return { ...result, draft: then(updateAuthoritiesDraft(draft, { type: "resolve-discrepancy", id: input.id, action,
      correction: { revisions, ...authority ? { authority } : {} } })) };
  };
  // A citation that names a different case than the brief's name for it: the case named (its citation
  // corrected in the Word brief), the case cited, or neither.
  const cited = Object.values(draft.authorities).find(({ citedCase }) => citedCase?.id === input.id);
  if (cited && !draft.discrepancyDecisions?.[input.id]) {
    const citedCase = cited.citedCase!, named = citedCase.named;
    if (!["ignore", "keep_cited_case", ...named ? ["use_named_case"] : []].includes(action))
      reject(400, "That correction is not available for this citation");
    const before = { id: cited.id, citation: cited.citation, citedCase: structuredClone(citedCase) };
    const take = (value: AuthoritiesDraft) => action === "ignore" ? value : updateAuthoritiesDraft(value,
      { type: action === "use_named_case" ? "use-named-case" : "keep-cited-case", authorityId: cited.id });
    if (action !== "use_named_case" || !word) return { kind: "ignored" as const, draft: take(updateAuthoritiesDraft(draft,
      { type: "resolve-discrepancy", id: input.id, action, ...action === "use_named_case" ? { correction: { revisions: [], authority: before } } : {} })) };
    // Each place the brief writes the citation in full, as written there, takes the named case's.
    const corrections = Object.values(draft.occurrences).flatMap((occurrence) =>
      occurrence.authorityId === cited.id && occurrence.kind !== "reference" && occurrence.coreSpan.text
        ? [{ unitId: occurrence.unitId, start: occurrence.coreSpan.start, end: occurrence.coreSpan.end,
          expected: occurrence.coreSpan.text, replacement: named!.citation }] : []);
    if (!corrections.length) reject(409, "The correction cannot be mapped to the reviewed Word document");
    return decide(corrections, before, take);
  }
  const finding = (await reviewer(draft, signal)).find(({ id }) =>
    id === input.id && !draft.discrepancyDecisions?.[id]) ?? reject(409,
      "This discrepancy is no longer present. Review the document again.");
  if (!finding.actions.includes(action)) reject(400,
    "That correction is not available for this discrepancy");
  signal?.throwIfAborted();
  if (action === "ignore") return { kind: "ignored" as const,
    draft: updateAuthoritiesDraft(draft, { type: "resolve-discrepancy", id: finding.id, action }) };
  if (!word) reject(409, "Source corrections require an imported Word document");
  const correction = authoritiesDiscrepancyCorrection(draft, finding, action) ??
    reject(409, "The correction cannot be mapped to the reviewed Word document");
  return decide(correction);
}

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
      outline: authority && draft.outputMode !== "table" || filing && draft.settings.finalPdf
        ? { legislation: authority?.kind === "legislation" } : null,
      text: { scannedPdfPolicy: filing ? "page-margin" as const : bookScanPolicy(draft),
        citations: authority ? authorityCitationForms(draft, authority.id) : [],
        reporterOriginal: attached?.source.origin === "original",
        ocrTargets: filing ? [] : targets,
        // A statute's cited provisions are placed whatever is marked: its excerpt keeps their pages.
        passageTargets: brief ? [] : filing || linkGeometry || draft.settings.passageMarking !== "none" ||
          authority?.kind === "legislation" ? targets : [],
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
