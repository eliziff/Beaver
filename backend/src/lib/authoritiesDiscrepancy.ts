import type { AuthoritiesDiscrepancy as SharedAuthoritiesDiscrepancy,
  AuthoritiesSourcePassage } from "mike/shared/authorities-contract.d.ts";
import type { AuthoritiesDiscrepancyAction, AuthoritiesDraft,
  AuthorityOccurrence } from "./authoritiesDomain";
import { a2ajLegalSourceProvider } from "./legalSources/a2aj";
import type { LegalSourcePassage, LegalSourceReference } from "./legalSources";
import { mapBounded } from "./mapBounded";
import { structureNative } from "./structureNative";
import type { BriefCorrection } from "mike/shared/engine-types/BriefCorrection";

export type { AuthoritiesSourcePassage };

export type AuthoritiesOccurrenceSource = {
  occurrenceId: string;
  cited: AuthoritiesSourcePassage;
  alternatives: AuthoritiesSourcePassage[];
  sourceVersion?: string;
  /** The retrieved passage behind `cited`, so a review can bind a claim to it. */
  citedPassage?: LegalSourcePassage;
};

/** The server alone carries the retrieved passage behind `cited`. */
export type AuthoritiesDiscrepancy = SharedAuthoritiesDiscrepancy<LegalSourcePassage>;


type ReviewDraft = Pick<AuthoritiesDraft, "units" | "occurrences">;

/** The authored pinpoint with its number replaced by the label's ("at para 12" with "par14": "at para 14"). */
export function pinpointText(authored: string, label: string) {
  const value = label.match(/\d+(?:\.\d+)*(?:\([\p{L}\p{N}]+\))*/u)?.[0] ?? label.trim();
  const match = /\d+(?:\.\d+)*(?:\([\p{L}\p{N}]+\))*/u.exec(authored);
  return value && match ? authored.slice(0, match.index) + value + authored.slice(match.index + match[0].length)
    : value || null;
}

/** What a decision on a finding writes into the brief (the engine's discrepancy_correction). */
export const authoritiesDiscrepancyCorrection = (draft: ReviewDraft, { citedPassage: _passage, ...finding }: AuthoritiesDiscrepancy,
  action: AuthoritiesDiscrepancyAction): BriefCorrection | null =>
  structureNative().authoritiesDiscrepancyCorrection(draft.units, draft.occurrences, finding, action);

export function sourceLocator(pinpoint: AuthorityOccurrence["pinpoints"][number]): {
  kind: "paragraph" | "section" | "page"; value: string; endValue?: string;
} | null {
  // The engine read the value when it read the pinpoint: its first locator and the last of a range.
  if ((pinpoint.kind !== "paragraph" && pinpoint.kind !== "section" && pinpoint.kind !== "page") || !pinpoint.first) return null;
  return { kind: pinpoint.kind, value: pinpoint.first, ...(pinpoint.last ? { endValue: pinpoint.last } : {}) };
}

/** Loads only exact, version-matched A2AJ passages; failures suppress optional findings. */
export async function reviewAuthoritiesDiscrepancies(
  draft: AuthoritiesDraft, signal?: AbortSignal,
) {
  // Only a footnote with one source and a quotation in its proposition can yield a
  // finding, so no other occurrence's passage is read.
  const native = structureNative();
  const footnotes = new Set(native.authoritiesDiscrepancyOccurrences(draft.units, draft.occurrences));
  const viewers = new Map<string, ReturnType<ReturnType<typeof structureNative>["legalSourceViewer"]>>();
  const candidates = Object.values(draft.occurrences).flatMap((occurrence) => {
    const authority = occurrence.authorityId ? draft.authorities[occurrence.authorityId] : null;
    const identity = authority?.sourceIdentity, pinpoint = occurrence.pinpoints[0];
    const locator = pinpoint && occurrence.pinpoints.length === 1 ? sourceLocator(pinpoint) : null;
    return footnotes.has(occurrence.id) && identity?.provider === "a2aj" &&
      (authority?.kind === "case" || authority?.kind === "legislation") && locator
      ? [{ occurrence, authority, identity, locator }] : [];
  });
  const supplied = (await mapBounded(candidates, async ({ occurrence, authority, identity,
    locator }): Promise<AuthoritiesOccurrenceSource[]> => {
    signal?.throwIfAborted();
    try {
      const reference: LegalSourceReference = { provider: identity.provider,
        id: identity.stableSourceId, kind: authority.kind as "case" | "legislation",
        title: authority.name, citation: authority.citation, date: identity.version,
        url: identity.externalUrl };
      const values = await a2ajLegalSourceProvider.readPassage!({ source: reference,
        locator, signal });
      const selections = values.filter(({ role }) => role === "selected"), selected = selections[0];
      if (!selected || selections.some(value => native.documentRevision(value.documentArtifact) !==
          identity.sourceSha256)) return [];
      // Several footnotes quoting one decision share its viewer.
      const mode = locator.kind === "section" ? "section" : "paragraph";
      const viewerKey = `${identity.sourceSha256}\0${mode}`;
      // The whole source: a quotation found anywhere in it says where it is.
      const viewer = viewers.get(viewerKey) ?? native.legalSourceViewer(selected.documentArtifact, mode);
      viewers.set(viewerKey, viewer);
      const alternatives = viewer.slices.flatMap(({ primary, text }) => primary?.node.label != null &&
        primary.node.kind === locator.kind
        ? [{ locator: { kind: primary.node.kind, label: primary.node.label }, text }] : []);
      return [{ occurrenceId: occurrence.id, sourceVersion: identity.sourceSha256,
        citedPassage: selected,
        cited: { locator: { kind: locator.kind, label: locator.endValue
          ? `${locator.value}–${locator.endValue}` : selected.locator.label },
          text: selections.map(value => value.text).join("\n\n") }, alternatives }];
    } catch (error) {
      if (signal?.aborted) throw error;
      return [];
    }
  })).flat();
  const passages = new Map(supplied.map(({ occurrenceId, citedPassage }) => [occurrenceId, citedPassage]));
  // The engine's findings are this review's two kinds; the retrieved passage behind each is the server's own.
  return (native.authoritiesDiscrepancies(draft.units, draft.occurrences,
    supplied.map(({ citedPassage: _passage, ...source }) => source)) as AuthoritiesDiscrepancy[])
    .map((finding) => ({ ...finding, citedPassage: passages.get(finding.occurrenceId) }))
    .filter(({ id }) => !draft.discrepancyDecisions?.[id])
    .map(finding => draft.import.kind === "document" && draft.import.fileType === "docx"
      ? finding : { ...finding, actions: ["ignore" as const] });
}
