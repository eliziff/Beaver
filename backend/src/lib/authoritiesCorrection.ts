/** A discrepancy's decision: the draft it leaves, and the Word brief its correction writes. */
import { reject } from "./applicationError";
import { updateAuthoritiesDraft } from "./authoritiesActions";
import type { AuthoritiesDraft } from "./authoritiesDomain";
import type { AuthoritiesDiscrepancyRequest } from "mike/shared/authorities-contract.d.ts";
import { authoritiesDiscrepancyCorrection, reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import { applyAuthorityDiscrepancyCorrection, rejectAuthorityDiscrepancyCorrection } from "./docxOperations";

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
    if (!["ignore", "keep_cited_case", "use_cited_name", ...named ? ["use_named_case"] : []].includes(action))
      reject(400, "That correction is not available for this citation");
    const before = { id: cited.id, citation: cited.citation, name: cited.name, citedCase: structuredClone(citedCase) };
    const take = (value: AuthoritiesDraft) => action === "ignore" ? value : updateAuthoritiesDraft(value,
      { type: action === "use_named_case" ? "use-named-case" : "keep-cited-case", authorityId: cited.id });
    if (action === "use_cited_name") {
      if (!word) reject(409, "Source corrections require an imported Word document");
      // The citation is right: each place the brief writes the case in full takes the name of the case it cites.
      const corrections = Object.values(draft.occurrences).flatMap((occurrence) => {
        if (occurrence.authorityId !== cited.id || occurrence.kind === "reference") return [];
        const { authoritySpan: whole, coreSpan: core } = occurrence;
        const name = whole.text.slice(0, Math.max(0, core.start - whole.start)).replace(/[\s,]+$/u, "");
        return name && name !== citedCase.name ? [{ unitId: occurrence.unitId, start: whole.start, end: whole.start + name.length,
          expected: name, replacement: citedCase.name }] : [];
      });
      if (!corrections.length) reject(409, "The correction cannot be mapped to the reviewed Word document");
      return decide(corrections, before, take);
    }
    if (action !== "use_named_case" || !word) return { kind: "ignored" as const, draft: take(updateAuthoritiesDraft(draft,
      { type: "resolve-discrepancy", id: input.id, action, ...action !== "ignore" ? { correction: { revisions: [], authority: before } } : {} })) };
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
