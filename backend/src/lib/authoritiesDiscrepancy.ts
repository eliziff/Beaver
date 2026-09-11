import { sequenceOpcodes as opcodes } from "mike/shared/sequence-diff.mjs";
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

const sameLocator = (left: AuthoritiesSourcePassage, right: AuthoritiesSourcePassage) =>
  left.locator.kind === right.locator.kind && JSON.stringify(sourceLocator({ kind: left.locator.kind, text: left.locator.label })) ===
    JSON.stringify(sourceLocator({ kind: right.locator.kind, text: right.locator.label }));

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
const comparisonWords = (text: string) => [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
const wordKey = foldForComparison;
function verbatimRepair(authored: string, source: string) {
  const before = comparisonWords(authored), after = comparisonWords(source);
  if (!before.length || !after.length) return null;
  const equal = opcodes(before.map(w => wordKey(w[0])), after.map(w => wordKey(w[0])))
    .filter(([kind]) => kind === "equal");
  if (!equal.length) return null;
  const [, a0, , b0] = equal[0], [, , a1, , b1] = equal[equal.length - 1];
  const first = Math.max(0, b0 - a0), last = Math.min(after.length, b1 + before.length - a1);
  const matched = equal.reduce((sum, [, a, b]) => sum + b - a, 0);
  // Compare BOTH lengths: a tiny common fragment in a long passage is not alignment.
  if (matched < Math.min(4, before.length) || matched / Math.max(before.length, last - first) < .7 ||
      Math.max(...equal.map(([, a, b]) => b - a)) < 2) return null;
  const start = after[first].index, end = after[last - 1].index + after[last - 1][0].length;
  const candidate = source.slice(start, end) + (source.slice(end).match(/^[.,;:!?]+/u)?.[0] ?? "");
  // Repeated candidate wording is ambiguous, even if the diff happens to prefer the first copy.
  return source.indexOf(candidate) === source.lastIndexOf(candidate) ? candidate : null;
}

function quoteTarget(units: ReviewDraft["units"], footnoteId: number, quote: string) {
  const context = footnotePropositions(units).get(footnoteId);
  const pattern = new RegExp(quote.trim().split(/\s+/u).map(escapePattern).join("\\s+"), "gu");
  const targets = context?.parts.flatMap(({ unit, start, end }) =>
    [...unit.text.slice(start, end).matchAll(pattern)].map(match => ({ unitId: unit.id,
      start: start + match.index, end: start + match.index + match[0].length,
      expected: match[0], replacement: "" }))) ?? [];
  return targets.length === 1 ? targets[0] : null;
}

function pinpointText(authored: string, label: string) {
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
    occurrence.pinpoints, kind, quote, source.cited.locator]);
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
        authoredQuote, authoredPinpoint: { ...occurrence.pinpoints[0] }, cited: source.cited,
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

const word = /^[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*$/u;
const tokenPattern = /\.\.\.|\[[^\]]+\]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|["“”‘’]|[^\p{L}\p{N}_\s]/gu;
const mergeable = (value: string) => word.test(value) || /^\[[^\]]+\]$/u.test(value);
function tokens(value: string) {
  const raw = [...value.matchAll(tokenPattern)].map((match) => ({ text: match[0],
    start: match.index, end: match.index + match[0].length }));
  const result: string[] = [];
  for (let i = 0; i < raw.length;) {
    let { text, end } = raw[i], next = i + 1;
    while (next < raw.length && end === raw[next].start && mergeable(text) &&
        mergeable(raw[next].text)) { text += raw[next].text; end = raw[next++].end; }
    result.push(text); i = next;
  }
  return result;
}
const equivalent = (value: string) => {
  if ('"“”«»„'.includes(value)) return '"';
  if ("'‘’‚".includes(value)) return "'";
  const normalized = foldForComparison(value);
  const initial = /^\[([a-z])\]([a-z]+)$/u.exec(normalized);
  return initial ? initial[1] + initial[2] : normalized;
};
function joinTokens(values: string[]) {
  let result = "", previous = "", openDouble = false, openSingle = false, priorRole = "";
  for (let value of values) {
    if (/^[‐‑‒–—―−]$/u.test(value)) value = "-";
    let role = "";
    if (value === '"') { role = openDouble ? "close" : "open"; openDouble = !openDouble; }
    else if (value === "'") { role = openSingle ? "close" : "open"; openSingle = !openSingle; }
    else if ('“«„‘‚'.includes(value)) role = "open";
    else if ('”»’'.includes(value)) role = "close";
    if (!result) result = value;
    else if (value === "-" || previous === "-") result = result.trimEnd() + value;
    else if (role === "close" || /^[)\]},.;:!?]$/u.test(value)) result += value;
    else if (/^[([{]$/u.test(previous) || priorRole === "open") result += value;
    else result += ` ${value}`;
    previous = value; priorRole = role;
  }
  return normalizeWhitespace(result);
}
function internalInsertion(authored: string, source: string) {
  if (!authored || !source || /[\[\]]/u.test(authored + source)) return "";
  const edits = opcodes([...source], [...authored]);
  const inserts = edits.filter(([tag]) => tag === "insert");
  if (inserts.length !== 1 || edits.some(([tag]) => tag !== "equal" && tag !== "insert")) return "";
  const equal = edits.filter(([tag]) => tag === "equal").reduce((sum, [, a, b]) => sum + b - a, 0);
  const inserted = inserts[0][4] - inserts[0][3];
  if (equal < Math.min(3, source.length) || inserted > Math.max(4, source.length / 2 + 1)) return "";
  return edits.map(([tag, a, b, c, d]) => tag === "equal"
    ? source.slice(a, b) : `[${authored.slice(c, d)}]`).join("");
}
function formatAuthored(authored: string[], source?: string[]) {
  if (!authored.length) return [];
  if (source?.length === 1 && authored.length === 1 && word.test(authored[0]) && word.test(source[0])) {
    const [a, s] = [authored[0], source[0]];
    if (a.length === s.length && a.slice(1) === s.slice(1) &&
        a[0].toLowerCase() === s[0].toLowerCase() && a[0] !== s[0]) return [`[${a[0]}]${a.slice(1)}`];
    const internal = internalInsertion(a, s); if (internal) return [internal];
  }
  if (authored.length === 1) return /\[[^\]]+\]/u.test(authored[0]) || !word.test(authored[0])
    ? authored : [`[${authored[0]}]`];
  return authored.some((item) => /\[[^\]]+\]/u.test(item)) ? authored
    : authored.some((item) => word.test(item)) ? [`[${joinTokens(authored)}]`] : authored;
}

/** Deterministic bracket/ellipsis rendering ported from the pinned Authorities oracle. */
export function editorialQuote(authoredQuote: string, sourceQuote: string) {
  const authored = tokens(authoredQuote.trim()), source = tokens(sourceQuote.trim());
  if (!authored.length) return sourceQuote.trim();
  if (!source.length) return authoredQuote.trim();
  const output: string[] = [];
  for (const [tag, i1, i2, j1, j2] of opcodes(source.map(equivalent), authored.map(equivalent))) {
    if (tag === "equal") output.push(...source.slice(i1, i2).map((item, index) => {
      const written = authored[j1 + index];
      return item === written || /^\[[A-Za-z]\][A-Za-z]+$/u.test(written) ? written
        : word.test(item) && word.test(written) && item.length === written.length &&
          item.slice(1) === written.slice(1) && item[0].toLowerCase() === written[0].toLowerCase()
          ? `[${written[0]}]${written.slice(1)}` : item;
    }));
    else if (tag === "delete") {
      if (source.slice(i1, i2).some((item) => word.test(item)) && output.length && j1 < authored.length) {
        if (output.at(-1) !== "...") output.push("...");
      } else output.push(...source.slice(i1, i2));
    } else output.push(...formatAuthored(authored.slice(j1, j2),
      tag === "replace" ? source.slice(i1, i2) : undefined));
  }
  return joinTokens(output);
}

/** Mechanical match locations and the same correction/diff used by Authorities review. */
export function quoteTextComparison(authored: string, source: string) {
  const plan = structureNative().textFragmentPlanStandalone(source, [authored], false, false, false);
  const matches = plan.sourceSafeComplete ? plan.sourceWordIntervals.map(({ start, end }) =>
    ({ start, end, text: source.slice(start, end) })) : [];
  const candidate = matches.length ? source.slice(Math.min(...matches.map(({ start }) => start)),
    Math.max(...matches.map(({ end }) => end))) : verbatimRepair(authored, source);
  const before = tokens(authored), after = tokens(candidate ?? "");
  return { matches, candidate, candidateOnly: !matches.length,
    editorial: candidate ? editorialQuote(authored, candidate) : null,
    changes: candidate ? opcodes(before.map(equivalent), after.map(equivalent))
      .filter(([kind]) => kind !== "equal").map(([kind, a0, a1, b0, b1]) => ({ kind,
        authored: joinTokens(before.slice(a0, a1)), source: joinTokens(after.slice(b0, b1)) })) : [] };
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
  const prefixes = pinpoint.kind === "paragraph" ? /^(?:at\s+)?(?:paragraphs?|paras?|par|¶+)\.?\s*/iu
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
      const viewer = structureNative().legalSourceViewer(selected.documentArtifact,
        locator.kind === "section" ? "section" : "paragraph", 10_000);
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
