import type { AuthoritiesDiscrepancy as SharedAuthoritiesDiscrepancy,
  AuthoritiesSourcePassage } from "mike/shared/authorities-contract.d.ts";
import type { AuthoritiesDiscrepancyAction, AuthoritiesDraft,
  AuthorityOccurrence } from "./authoritiesDomain";
import { canonicalJsonSha256 } from "./hash";
import { a2ajLegalSourceProvider } from "./legalSources/a2aj";
import type { LegalSourcePassage, LegalSourceReference } from "./legalSources";
import { mapBounded } from "./mapBounded";
import { structureNative } from "./structureNative";
import { normalizeWhitespace } from "./text";
import { footnotePropositions, markedQuotations, singleSourceFootnote } from "./authoritiesQuotations";

export type { AuthoritiesSourcePassage };

export type AuthoritiesOccurrenceSource = {
  occurrenceId: string;
  cited: AuthoritiesSourcePassage;
  alternatives?: readonly AuthoritiesSourcePassage[];
  sourceVersion?: string;
  /** The retrieved passage behind `cited`, so a review can bind a claim to it. */
  citedPassage?: LegalSourcePassage;
};

/** The server alone carries the retrieved passage behind `cited`. */
export type AuthoritiesDiscrepancy = SharedAuthoritiesDiscrepancy<LegalSourcePassage>;

export type AuthoritiesDiscrepancyCorrection = {
  unitId: string; start: number; end: number; expected: string; replacement: string;
};

type ReviewDraft = Pick<AuthoritiesDraft, "units" | "occurrences">;

/** Two passages of a source are one where the source labels them alike ("12–14", "12-14"). */
const sameLocator = (left: AuthoritiesSourcePassage, right: AuthoritiesSourcePassage) => {
  const label = ({ locator }: AuthoritiesSourcePassage) => locator.label.replace(/\s+/gu, "").replace(/[\u2013\u2014]/gu, "-");
  return left.locator.kind === right.locator.kind && label(left) === label(right);
};

/** Only substantive wording is a difference: case, diacritics, quote/dash variants and
 * compatibility width are noise, and the authored quote's edge punctuation is the author's. */
const foldForComparison = (value: string) => normalizeWhitespace(value)
  .normalize("NFKD").replace(/\p{M}+/gu, "")
  .replace(/["“”«»„]/gu, '"').replace(/['‘’‚`´]/gu, "'").replace(/[‐‑‒–—―−]/gu, "-").toLowerCase();
const trimEdgePunctuation = (value: string) =>
  value.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");

function exactCount(text: string, quote: string) {
  text = foldForComparison(text); quote = trimEdgePunctuation(foldForComparison(quote));
  if (!quote) return 0;
  let count = 0;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + quote.length)) {
    if (++count === 2) break;
  }
  return count;
}

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The source passage an authored quotation's words closely align with, where it occurs once. */
const verbatimRepair = (authored: string, source: string) => structureNative().verbatimRepair(authored, source);

function quoteTarget(units: ReviewDraft["units"], footnoteId: number, quote: string) {
  const context = footnotePropositions(units).get(footnoteId);
  const pattern = new RegExp(quote.trim().split(/\s+/u).map(escapePattern).join("\\s+"), "gu");
  const targets = context?.parts.flatMap(({ unit, start, end }) =>
    [...unit.text.slice(start, end).matchAll(pattern)].map(match => ({ unitId: unit.id,
      start: start + match.index, end: start + match.index + match[0].length,
      expected: match[0], replacement: "" }))) ?? [];
  return targets.length === 1 ? targets[0] : null;
}

/** The authored pinpoint with its number replaced by the label's ("at para 12" with "par14": "at para 14"). */
export function pinpointText(authored: string, label: string) {
  const value = label.match(/\d+(?:\.\d+)*(?:\([\p{L}\p{N}]+\))*/u)?.[0] ?? label.trim();
  const match = /\d+(?:\.\d+)*(?:\([\p{L}\p{N}]+\))*/u.exec(authored);
  return value && match ? authored.slice(0, match.index) + value + authored.slice(match.index + match[0].length)
    : value || null;
}

function findingId(occurrence: AuthorityOccurrence,
  source: AuthoritiesOccurrenceSource, kind: AuthoritiesDiscrepancy["kind"], quote: string) {
  // Unrelated Word edits must not resurrect dismissed findings. Relevant text, source
  // version, authority and pinpoint still invalidate the decision independently.
  return canonicalJsonSha256(["beaver.authorities-discrepancy.v2", occurrence.unitId,
    source.sourceVersion ?? source.cited.text, occurrence.citation, occurrence.authorityId,
    occurrence.pinpoints.map(({ kind, text }) => ({ kind, text })), kind, quote, source.cited.locator]);
}

/** Returns only deterministic findings; source resolution and persistence stay with the caller. */
export function findAuthoritiesDiscrepancies(
  draft: ReviewDraft,
  supplied: readonly AuthoritiesOccurrenceSource[],
): AuthoritiesDiscrepancy[] {
  const native = structureNative(), propositions = footnotePropositions(draft.units);
  const sources = new Map<string, AuthoritiesOccurrenceSource | null>();
  for (const source of supplied) {
    sources.set(source.occurrenceId, sources.has(source.occurrenceId) ? null : source);
  }
  const findings: AuthoritiesDiscrepancy[] = [];
  const footnotes = [...draft.units].filter(({ kind }) => kind === "footnote")
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  for (const unit of footnotes) {
    if (!unit.footnoteId) continue;
    const occurrence = singleSourceFootnote(draft, unit);
    if (!occurrence?.authorityId) continue;
    const source = sources.get(occurrence.id), proposition = propositions.get(unit.footnoteId)?.text;
    if (occurrence.unitId !== unit.id || occurrence.pinpoints.length !== 1 ||
        !source?.cited.text.trim() || !proposition) continue;
    for (const authoredQuote of markedQuotations(proposition)) {
      // Contained in the cited passage means verbatim; there is nothing to report.
      if (exactCount(source.cited.text, authoredQuote)) continue;
      const evidenceId = "authorities-source";
      if (!native.groundedProseErrors(`\u201c${authoredQuote}\u201d`, [evidenceId], [{
        evidenceId, text: source.cited.text, labels: [],
      }]).length) continue;
      let matchCount = 0, found: AuthoritiesSourcePassage | null = null;
      for (const candidate of source.alternatives ?? []) {
        if (candidate.locator.kind !== source.cited.locator.kind) continue;
        const count = exactCount(candidate.text, authoredQuote);
        if (!count) continue;
        matchCount += count;
        if (matchCount === 1) found = { ...candidate, text: authoredQuote };
        else { found = null; break; }
      }
      const base = { occurrenceId: occurrence.id, authorityId: occurrence.authorityId!,
        footnoteId: unit.footnoteId, citation: occurrence.citation, proposition,
        authoredQuote, authoredPinpoint: { kind: occurrence.pinpoints[0].kind, text: occurrence.pinpoints[0].text }, cited: source.cited,
        citedPassage: source.citedPassage };
      if (matchCount === 1 && found && !sameLocator(source.cited, found)) {
        const replacement = occurrence.pinpointSpan && pinpointText(
          occurrence.pinpointSpan.text, found.locator.label);
        const kind = "wrong_pinpoint" as const;
        findings.push({ ...base, kind, found,
          id: findingId(occurrence, source, kind, authoredQuote),
          actions: replacement ? ["ignore", "pinpoint"] : ["ignore"] });
      } else if (!matchCount) {
        const repair = verbatimRepair(authoredQuote, source.cited.text);
        const excerpt = repair ? { ...source.cited, text: repair } : null;
        const target = excerpt && quoteTarget(draft.units, unit.footnoteId, authoredQuote);
        const kind = excerpt ? "quote_mismatch" as const : "quote_unlocated" as const;
        findings.push({ ...base, ...(excerpt ? { kind: "quote_mismatch" as const, found: excerpt }
          : { kind: "quote_unlocated" as const, found: null }),
          id: findingId(occurrence, source, kind, authoredQuote),
          actions: target ? ["ignore", "quote_exact", "quote_editorial"] : ["ignore"] });
      }
    }
  }
  return findings;
}

/** The source's words as the author quoted them: the author's changes bracketed, source words left out inside the
 *  quotation an ellipsis (the engine's port of the pinned Authorities oracle). */
export function editorialQuote(authoredQuote: string, sourceQuote: string) {
  return structureNative().editorialQuote(authoredQuote, sourceQuote);
}

/** Mechanical match locations and the same correction/diff used by Authorities review. */
export function quoteTextComparison(authored: string, source: string) {
  return structureNative().quoteComparison(authored, source);
}

export function authoritiesDiscrepancyCorrection(
  draft: ReviewDraft, finding: AuthoritiesDiscrepancy, action: AuthoritiesDiscrepancyAction,
): AuthoritiesDiscrepancyCorrection | null {
  if (action === "ignore" || finding.kind === "quote_unlocated" || !finding.actions.includes(action)) return null;
  if (action === "pinpoint" && finding.kind === "wrong_pinpoint") {
    const occurrence = draft.occurrences[finding.occurrenceId], span = occurrence?.pinpointSpan;
    const replacement = span && pinpointText(span.text, finding.found.locator.label);
    return span && replacement ? { unitId: occurrence.unitId, start: span.start, end: span.end,
      expected: span.text, replacement } : null;
  }
  if ((action === "quote_exact" || action === "quote_editorial") && finding.kind === "quote_mismatch" &&
      finding.found && verbatimRepair(finding.authoredQuote, finding.found.text)) {
    const target = quoteTarget(draft.units, finding.footnoteId, finding.authoredQuote);
    return target ? { ...target, replacement: action === "quote_exact" ? finding.found.text
      : editorialQuote(finding.authoredQuote, finding.found.text) } : null;
  }
  return null;
}

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
  const propositions = footnotePropositions(draft.units), footnotes = new Set<string>();
  for (const unit of draft.units) {
    const proposition = unit.kind === "footnote" && unit.footnoteId
      ? propositions.get(unit.footnoteId)?.text : undefined;
    const occurrence = proposition && markedQuotations(proposition).length
      ? singleSourceFootnote(draft, unit) : null;
    if (occurrence) footnotes.add(occurrence.id);
  }
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
      if (!selected || selections.some(value => structureNative().documentRevision(value.documentArtifact) !==
          identity.sourceSha256)) return [];
      // Several footnotes quoting one decision share its viewer.
      const mode = locator.kind === "section" ? "section" : "paragraph";
      const viewerKey = `${identity.sourceSha256}\0${mode}`;
      // The whole source: a quotation found anywhere in it says where it is.
      const viewer = viewers.get(viewerKey) ?? structureNative().legalSourceViewer(selected.documentArtifact, mode);
      viewers.set(viewerKey, viewer);
      const alternatives = viewer.slices.flatMap(({ primary, text }) => primary &&
        primary.kind === locator.kind
        ? [{ locator: { kind: primary.kind, label: primary.label }, text }] : []);
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
  return findAuthoritiesDiscrepancies(draft, supplied)
    .filter(({ id }) => !draft.discrepancyDecisions?.[id])
    .map(finding => draft.import.kind === "document" && draft.import.fileType === "docx"
      ? finding : { ...finding, actions: ["ignore" as const] });
}
