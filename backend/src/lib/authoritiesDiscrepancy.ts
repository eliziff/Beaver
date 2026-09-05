import type { AuthoritiesDiscrepancyAction, AuthoritiesDraft,
  AuthorityOccurrence } from "./authoritiesDomain";
import { canonicalJsonSha256 } from "./hash";
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
  sourceVersion?: string;
};

type FindingBase = {
  id: string;
  actions: AuthoritiesDiscrepancyAction[];
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
  | { kind: "quote_mismatch"; found: AuthoritiesSourcePassage | null }
  | { kind: "wrong_pinpoint"; found: AuthoritiesSourcePassage }
);

export type AuthoritiesDiscrepancyCorrection = {
  unitId: string; start: number; end: number; expected: string; replacement: string;
};

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
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function verbatimRepair(authored: string, source: string) {
  const suggestion = structureNative().quoteRepairSuggestion(authored, [source]);
  const match = suggestion && /“([^”]+)”|"([^"]+)"/u.exec(suggestion);
  const anchor = match?.[1] ?? match?.[2] ?? "", at = source.indexOf(anchor);
  if (!anchor || at < 0) return null;
  const spans = [...source.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)]
    .map((word) => ({ start: word.index, end: word.index + word[0].length }));
  const authoredWords = authored.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  let first = spans.findIndex(({ end }) => end > at), last = spans.findIndex(
    ({ start }) => start >= at + anchor.length);
  if (first < 0) return anchor;
  if (last < 0) last = spans.length;
  const authoredAt = authored.indexOf(anchor), before = authoredAt < 0 ? 0
    : authored.slice(0, authoredAt).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  first = Math.max(0, first - before);
  last = Math.min(spans.length, Math.max(last, first + authoredWords));
  first = Math.max(0, Math.min(first, last - authoredWords));
  return source.slice(spans[first].start, spans[last - 1]?.end ?? at + anchor.length);
}

function quoteTarget(units: ReviewDraft["units"], footnoteId: number, quote: string) {
  const pattern = new RegExp(quote.trim().split(/\s+/u).map(escapePattern).join("\\s+"), "gu");
  const candidates: Array<AuthoritiesDiscrepancyCorrection & { distance: number }> = [];
  for (const unit of units.filter(({ kind }) => kind === "body")) {
    for (const match of unit.text.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      const anchors = unit.footnoteRefs.filter(([id]) => id === footnoteId).map(([, at]) => at);
      const preceding = anchors.filter((at) => end <= at).map((at) => at - end);
      const distance = preceding.length ? Math.min(...preceding)
        : anchors.length ? 1_000_000 + Math.min(...anchors.map((at) => Math.abs(at - end)))
          : 2_000_000 + unit.ordinal;
      candidates.push({ unitId: unit.id, start, end, expected: match[0], replacement: "", distance });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance ||
    left.unitId.localeCompare(right.unitId) || left.start - right.start);
  return candidates[0] ?? null;
}

function pinpointText(authored: string, label: string) {
  const value = label.match(/\d+(?:\.\d+)*(?:\([\p{L}\p{N}]+\))*/u)?.[0] ?? label.trim();
  const match = /\d+(?:\.\d+)*(?:\([\p{L}\p{N}]+\))*/u.exec(authored);
  return value && match ? authored.slice(0, match.index) + value + authored.slice(match.index + match[0].length)
    : value || null;
}

function findingId(draftVersion: string, occurrence: AuthorityOccurrence,
  source: AuthoritiesOccurrenceSource, kind: AuthoritiesDiscrepancy["kind"], quote: string) {
  return canonicalJsonSha256(["beaver.authorities-discrepancy.v1", draftVersion,
    occurrence.sourceTextSha256, source.sourceVersion ?? "", occurrence.id, kind, quote,
    source.cited.locator.kind, source.cited.locator.label]);
}

/** Returns only deterministic findings; source resolution and persistence stay with the caller. */
export function findAuthoritiesDiscrepancies(
  draft: ReviewDraft,
  supplied: readonly AuthoritiesOccurrenceSource[],
  draftVersion = "",
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
    if (occurrence.unitId !== unit.id || occurrence.pinpoints.length !== 1 ||
        !source?.cited.text.trim() || !proposition) continue;
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
        if (matchCount === 1) found = { ...candidate, text: authoredQuote };
        else { found = null; break; }
      }
      const base = { occurrenceId: occurrence.id, authorityId: occurrence.authorityId!,
        footnoteId: unit.footnoteId, citation: occurrence.citation, proposition,
        authoredQuote, authoredPinpoint: { ...occurrence.pinpoints[0] }, cited: source.cited };
      if (matchCount === 1 && found && !sameLocator(source.cited, found)) {
        const replacement = occurrence.pinpointSpan && pinpointText(
          occurrence.pinpointSpan.text, found.locator.label);
        const kind = "wrong_pinpoint" as const;
        findings.push({ ...base, kind, found,
          id: findingId(draftVersion, occurrence, source, kind, authoredQuote),
          actions: replacement ? ["ignore", "pinpoint"] : ["ignore"] });
      } else if (!matchCount) {
        const repair = verbatimRepair(authoredQuote, source.cited.text);
        const excerpt = repair ? { ...source.cited, text: repair } : null;
        const target = excerpt && quoteTarget(draft.units, unit.footnoteId, authoredQuote);
        const kind = "quote_mismatch" as const;
        findings.push({ ...base, kind, found: excerpt,
          id: findingId(draftVersion, occurrence, source, kind, authoredQuote),
          actions: target ? ["ignore", "quote_exact", "quote_editorial"] : ["ignore"] });
      }
    }
  }
  return findings;
}

type Opcode = ["equal" | "delete" | "insert" | "replace", number, number, number, number];

/** SequenceMatcher's no-junk matching rule, kept local because JS has no stdlib equivalent. */
function opcodes(left: string[], right: string[]): Opcode[] {
  const blocks: Array<[number, number, number]> = [], pending: Array<[number, number, number, number]> =
    [[0, left.length, 0, right.length]];
  while (pending.length) {
    const [a0, a1, b0, b1] = pending.pop()!;
    let best: [number, number, number] = [a0, b0, 0];
    let prior = new Map<number, number>();
    for (let i = a0; i < a1; i += 1) {
      const current = new Map<number, number>();
      for (let j = b0; j < b1; j += 1) if (left[i] === right[j]) {
        const size = (prior.get(j - 1) ?? 0) + 1;
        current.set(j, size);
        if (size > best[2]) best = [i - size + 1, j - size + 1, size];
      }
      prior = current;
    }
    const [i, j, size] = best;
    if (!size) continue;
    blocks.push(best);
    if (a0 < i && b0 < j) pending.push([a0, i, b0, j]);
    if (i + size < a1 && j + size < b1) pending.push([i + size, a1, j + size, b1]);
  }
  blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: typeof blocks = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    if (last && last[0] + last[2] === block[0] && last[1] + last[2] === block[1]) last[2] += block[2];
    else merged.push([...block]);
  }
  const result: Opcode[] = []; let i = 0, j = 0;
  for (const [nextI, nextJ, size] of [...merged, [left.length, right.length, 0] as const]) {
    if (i < nextI || j < nextJ) result.push([i < nextI && j < nextJ ? "replace"
      : i < nextI ? "delete" : "insert", i, nextI, j, nextJ]);
    if (size) result.push(["equal", nextI, nextI + size, nextJ, nextJ + size]);
    i = nextI + size; j = nextJ + size;
  }
  return result;
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
  const normalized = value.replace(/[‐‑‒–—―−]/gu, "-").replace(/[‘’]/gu, "'");
  const initial = /^\[([A-Za-z])\]([A-Za-z]+)$/u.exec(normalized);
  const plain = initial ? initial[1] + initial[2] : normalized;
  return word.test(plain) ? plain.toLowerCase() : plain;
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

export function authoritiesDiscrepancyCorrection(
  draft: ReviewDraft, finding: AuthoritiesDiscrepancy, action: AuthoritiesDiscrepancyAction,
): AuthoritiesDiscrepancyCorrection | null {
  if (action === "ignore" || !finding.actions.includes(action)) return null;
  if (action === "pinpoint" && finding.kind === "wrong_pinpoint") {
    const occurrence = draft.occurrences[finding.occurrenceId], span = occurrence?.pinpointSpan;
    const replacement = span && pinpointText(span.text, finding.found.locator.label);
    return span && replacement ? { unitId: occurrence.unitId, start: span.start, end: span.end,
      expected: span.text, replacement } : null;
  }
  if ((action === "quote_exact" || action === "quote_editorial") && finding.found) {
    const target = quoteTarget(draft.units, finding.footnoteId, finding.authoredQuote);
    return target ? { ...target, replacement: action === "quote_exact" ? finding.found.text
      : editorialQuote(finding.authoredQuote, finding.found.text) } : null;
  }
  return null;
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
          title: authority.name, citation: authority.citation, date: identity.version,
          url: identity.externalUrl };
        const values = await a2ajLegalSourceProvider.readPassage!({ source: reference,
          locator, signal });
        const selected = values.find(({ role }) => role === "selected") ?? values[0];
        if (!selected || structureNative().documentRevision(selected.documentArtifact) !==
            identity.sourceSha256) continue;
        const viewer = structureNative().legalSourceViewer(selected.documentArtifact,
          locator.kind === "section" ? "section" : "paragraph", 10_000);
        const alternatives = viewer.slices.flatMap(({ primary, text }) => primary &&
          (primary.kind === "paragraph" || primary.kind === "section" || primary.kind === "page")
          ? [{ locator: { kind: primary.kind, label: primary.label }, text }] : []);
        supplied.push({ occurrenceId: occurrence.id, sourceVersion: identity.sourceSha256,
          cited: { locator: { kind: locator.kind, label: selected.locator.label },
            text: selected.text }, alternatives });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  }));
  const draftVersion = draft.import.kind === "document" && draft.import.snapshot
    ? `${draft.import.snapshot.versionId}:${draft.import.snapshot.sha256}` : "manual";
  return findAuthoritiesDiscrepancies(draft, supplied, draftVersion)
    .filter(({ id }) => !draft.discrepancyDecisions?.[id]);
}
