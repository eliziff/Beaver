import type { AuthoritiesDraft, AuthorityOccurrence } from "./authoritiesDomain";
import { a2ajLegalSourceProvider } from "./legalSources/a2aj";
import type { LegalSourceReference } from "./legalSources";
import { structureNative } from "./structureNative";
import { normalizeWhitespace } from "./text";

export type AuthoritiesSourcePassage = {
  locator: { kind: "paragraph" | "section" | "page"; label: string };
  text: string;
};

export type AuthoritiesOccurrenceSource = {
  occurrenceId: string;
  cited: AuthoritiesSourcePassage;
  alternatives?: readonly AuthoritiesSourcePassage[];
};

type FindingBase = {
  occurrenceId: string;
  authorityId: string;
  footnoteId: number;
  citation: string;
  proposition: string;
  authoredQuote: string;
  authoredPinpoint: AuthorityOccurrence["pinpoints"][number];
  cited: AuthoritiesSourcePassage;
};

export type AuthoritiesDiscrepancy = FindingBase & (
  | { kind: "quote_mismatch"; found: null }
  | { kind: "wrong_pinpoint"; found: AuthoritiesSourcePassage }
);

type ReviewDraft = Pick<AuthoritiesDraft, "units" | "occurrences">;

function footnotePropositions(units: ReviewDraft["units"]) {
  const body = [...units].filter(({ kind }) => kind === "body")
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const anchors: Array<{ footnoteId: number; position: number }> = [];
  let text = "";
  for (const unit of body) {
    for (const [footnoteId, offset] of unit.footnoteRefs) {
      if (Number.isSafeInteger(footnoteId) && footnoteId > 0 &&
          Number.isSafeInteger(offset) && offset >= 0 && offset <= unit.text.length) {
        anchors.push({ footnoteId, position: text.length + offset });
      }
    }
    text += `${unit.text}\n`;
  }
  anchors.sort((left, right) => left.position - right.position || left.footnoteId - right.footnoteId);
  const counts = new Map<number, number>();
  for (const { footnoteId } of anchors) counts.set(footnoteId, (counts.get(footnoteId) ?? 0) + 1);
  const propositions = new Map<number, string>();
  let previous = 0;
  for (const { footnoteId, position } of anchors) {
    const proposition = normalizeWhitespace(text.slice(previous, position));
    previous = position;
    if (counts.get(footnoteId) === 1 && proposition) propositions.set(footnoteId, proposition);
  }
  return propositions;
}

const sameLocator = (left: AuthoritiesSourcePassage, right: AuthoritiesSourcePassage) =>
  left.locator.kind === right.locator.kind && left.locator.label === right.locator.label;

function exactCount(text: string, quote: string) {
  let count = 0;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + quote.length)) {
    if (++count === 2) break;
  }
  return count;
}

const eligibleQuote = (quote: string) => normalizeWhitespace(quote).length >= 8 &&
  (quote.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 2;

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
    const linked = unit.occurrenceIds.map((id) => draft.occurrences[id])
      .filter((item): item is AuthorityOccurrence => Boolean(item?.authorityId));
    if (linked.length !== 1) continue;
    const occurrence = linked[0], source = sources.get(occurrence.id);
    const proposition = propositions.get(unit.footnoteId);
    if (occurrence.unitId !== unit.id ||
        occurrence.pinpoints.length !== 1 || !source?.cited.text.trim() || !proposition) continue;
    const seen = new Set<string>();
    for (const marked of native.markedQuoteSpans(proposition)) {
      const authoredQuote = normalizeWhitespace(marked.text);
      if (!eligibleQuote(authoredQuote) || seen.has(authoredQuote)) continue;
      seen.add(authoredQuote);
      const evidenceId = "authorities-source";
      if (!native.groundedProseErrors(`\u201c${authoredQuote}\u201d`, [evidenceId], [{
        evidenceId, text: source.cited.text, labels: [],
      }]).length) continue;
      let matchCount = 0, found: AuthoritiesSourcePassage | null = null;
      for (const candidate of source.alternatives ?? []) {
        const count = exactCount(candidate.text, authoredQuote);
        if (!count) continue;
        matchCount += count;
        if (matchCount === 1) found = candidate;
        else { found = null; break; }
      }
      const base: FindingBase = { occurrenceId: occurrence.id,
        authorityId: occurrence.authorityId!, footnoteId: unit.footnoteId,
        citation: occurrence.citation, proposition, authoredQuote,
        authoredPinpoint: { ...occurrence.pinpoints[0] }, cited: source.cited };
      if (matchCount === 1 && found && !sameLocator(source.cited, found)) {
        findings.push({ ...base, kind: "wrong_pinpoint", found });
      } else if (!matchCount) {
        findings.push({ ...base, kind: "quote_mismatch", found: null });
      }
    }
  }
  return findings;
}

function sourceLocator(pinpoint: AuthorityOccurrence["pinpoints"][number]): {
  kind: "paragraph" | "section" | "page"; value: string; endValue?: string;
} | null {
  const prefixes = pinpoint.kind === "paragraph" ? /^(?:at\s+)?(?:paras?|¶+)\.?\s*/iu
    : pinpoint.kind === "section" ? /^(?:at\s+)?(?:ss?|sections?)\.?\s*/iu
      : /^(?:at\s+)?(?:pp?|pages?)\.?\s*/iu;
  const label = pinpoint.text.trim().replace(prefixes, "");
  const range = label.split(/\s+(?:to|[-–—])\s+|\s*[-–—]\s*/u).filter(Boolean);
  return range[0] ? { kind: pinpoint.kind, value: range[0],
    ...(range[1] ? { endValue: range[1] } : {}) } : null;
}

/** Loads only exact, version-matched A2AJ passages; failures suppress optional findings. */
export async function reviewAuthoritiesDiscrepancies(
  draft: AuthoritiesDraft, signal?: AbortSignal,
) {
  const footnotes = new Set(draft.units.filter(({ kind }) => kind === "footnote").map(({ id }) => id));
  const candidates = Object.values(draft.occurrences).flatMap((occurrence) => {
    const authority = occurrence.authorityId ? draft.authorities[occurrence.authorityId] : null;
    const identity = authority?.sourceIdentity, pinpoint = occurrence.pinpoints[0];
    const locator = pinpoint && occurrence.pinpoints.length === 1 ? sourceLocator(pinpoint) : null;
    return footnotes.has(occurrence.unitId) && identity?.provider === "a2aj" &&
      (authority?.kind === "case" || authority?.kind === "legislation") && locator
      ? [{ occurrence, authority, identity, locator }] : [];
  });
  const supplied: AuthoritiesOccurrenceSource[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      const { occurrence, authority, identity, locator } = candidates[next++];
      signal?.throwIfAborted();
      try {
        const reference: LegalSourceReference = { provider: identity.provider,
          id: identity.stableSourceId, kind: authority.kind as "case" | "legislation",
          title: authority.name,
          citation: authority.citation, date: identity.version, url: identity.externalUrl };
        const values = await a2ajLegalSourceProvider.readPassage!({
          source: reference, locator, signal,
        });
        const selected = values.find(({ role }) => role === "selected") ?? values[0];
        if (!selected || structureNative().documentRevision(selected.documentArtifact) !==
            identity.sourceSha256) continue;
        const viewer = structureNative().legalSourceViewer(selected.documentArtifact,
          locator.kind === "section" ? "section" : "paragraph", 10_000);
        const alternatives = viewer.slices.flatMap(({ primary, text }) => primary &&
          (primary.kind === "paragraph" || primary.kind === "section" || primary.kind === "page")
          ? [{ locator: { kind: primary.kind, label: primary.label }, text }] : []);
        supplied.push({ occurrenceId: occurrence.id,
          cited: { locator: { kind: locator.kind, label: selected.locator.label },
            text: selected.text }, alternatives });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  }));
  return findAuthoritiesDiscrepancies(draft, supplied);
}
