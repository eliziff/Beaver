import { authoritiesInputPlan } from "mike/shared/authorities-sources.mjs";
import { reject } from "./applicationError";
import { updateAuthoritiesDraft } from "./authoritiesActions";
import { authoritiesTextRoles, authorityPassageTargets } from "./authoritiesBuild";
import { authoritiesProfile, type AuthoritiesDraft, type AuthoritiesDiscrepancyAction } from "./authoritiesDomain";
import { authoritiesDiscrepancyCorrection, reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import { authorityPdfText } from "./authorityPdfText";
import { applyAuthorityDiscrepancyCorrection } from "./docxOperations";

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

/** Same role decisions and text projection for Library and standalone; no additional cache. */
export function createAuthoritiesPreparation(draft: AuthoritiesDraft) {
  const plan = authoritiesInputPlan(draft, authoritiesProfile(draft.settings.profileId).requirements);
  const textRoles = authoritiesTextRoles(draft);
  return { ...plan, textRoles,
    async prepareText(role: string, input: Parameters<typeof authorityPdfText>[0]) {
      input.signal?.throwIfAborted();
      if (!textRoles.has(role)) return {};
      const authority = plan.authoritySources.find(({ source }) => source.bindingRole === role)?.authority;
      const targets = authority ? authorityPassageTargets(draft, authority.id) : [];
      const text = await authorityPdfText({ ...input, scannedPdfPolicy: draft.settings.scannedPdfPolicy,
        ocrTargets: targets, passageTargets: draft.settings.passageMarking === "none" ? [] : targets });
      input.signal?.throwIfAborted();
      return { pageTextByPage: text.pageTextByPage,
        ...(text.ocrTextByPage.some(Boolean) ? { ocrTextByPage: text.ocrTextByPage } : {}),
        ...(text.passageGeometry ? { passageGeometry: text.passageGeometry } : {}) };
    },
  };
}
