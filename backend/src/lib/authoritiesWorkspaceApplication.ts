import { ApplicationError, type ApplicationScope } from "./applicationError";
import { authorityPassageTargets, authoritiesTextRoles, buildAuthorities, renderAuthoritySourcePdf,
  type AuthoritiesBuildResult } from "./authoritiesBuild";
import {
  AuthoritiesDomainError,
  authorityCitationForms,
  authoritiesProfile,
  authoritiesBookPdfs,
  decodeAuthoritiesDraft,
  reduceAuthoritiesDraft,
  type AuthoritiesAction,
  type AuthoritiesBuildSettings,
  type AuthoritiesDraft,
  type AuthoritiesFreshReview,
  type AuthorityIdentity,
  type AuthorityKind,
  type AuthorityOccurrence,
  type AuthoritiesOutputMode,
  type AuthoritiesProfileId,
} from "./authoritiesDomain";
import {
  createAuthoritiesImporter,
  type AuthoritiesImporter,
  type AuthoritiesImportSource,
  type GroundedReceiptSeed,
  nativeOccurrenceSpans,
} from "./authoritiesImport";
import { buildCanliiCaseUrlFromCitation } from "./canliiUrls";
import { authorityPdfText } from "./authorityPdfText";
import { reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import type { DocumentFile, DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import {
  a2ajLegalSourceProvider,
  stableA2AJSourceId,
} from "./legalSources/a2aj";
import { downloadProviderOriginalPdf } from "./providerPdfLibraryBridge";
import { structureNative, type NativeCitationOccurrence } from "./structureNative";
import type { ResolvedWorkProductInput, WorkProduct, WorkProductInput,
  WorkProductOutputRef, WorkProductState } from "./workProduct";
import type { WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";

type AuthoritiesProduct = Extract<WorkProduct, { kind: "authorities" }>;
type PublicDomainAction = Exclude<AuthoritiesAction, {
  type: "ingest-ledger" | "add-seed" | "add-authority" | "resolve-authority" |
    "attach-source" | "begin-canlii-handoff" | "split-occurrence" |
    "merge-occurrences" | "replace-occurrence" | "refresh";
}>;
export type AuthoritiesUserAction = PublicDomainAction |
  { type: "add-authority"; kind: AuthorityKind; citation: string; name?: string | null } |
  { type: "begin-canlii-handoff"; authorityId: string } |
  { type: "split-occurrence"; occurrenceId: string; cursor: number } |
  { type: "merge-occurrence"; occurrenceId: string } |
  { type: "set-authority-span"; occurrenceId: string; start: number; end: number } |
  { type: "set-pinpoint-span"; occurrenceId: string; start: number; end: number };

export type AuthoritiesInitialSettings = Partial<AuthoritiesBuildSettings> & {
  profileId?: AuthoritiesProfileId;
  outputMode?: AuthoritiesOutputMode;
  insertIntoDocument?: boolean;
};

const sourceServices = {
  resolve: (citation: string, kind: "case" | "legislation", signal?: AbortSignal) =>
    a2ajLegalSourceProvider.document({ citation,
    docType: kind === "case" ? "cases" : "laws", signal }),
  download: downloadProviderOriginalPdf,
  key: (value: string) => structureNative().citationLookupKey(value),
  occurrences: (value: string) => structureNative().citationOccurrencesInText(value),
  revision: (document: Parameters<ReturnType<typeof structureNative>["documentRevision"]>[0]) =>
    structureNative().documentRevision(document),
};
type SourceServices = typeof sourceServices;
type CitationServices = Pick<SourceServices, "key" | "occurrences">;

function draftState(state: WorkProductState): AuthoritiesDraft {
  const draft = decodeAuthoritiesDraft(state);
  if (!draft) throw new ApplicationError(409, "Authorities draft state is invalid");
  return draft;
}

const review = (draft: AuthoritiesDraft): AuthoritiesFreshReview => ({
  import: draft.import, bindings: draft.bindings, units: draft.units,
  occurrences: draft.occurrences, authorities: draft.authorities,
  authorityOrder: draft.authorityOrder,
});

function update(draft: AuthoritiesDraft, action: AuthoritiesAction) {
  try { return reduceAuthoritiesDraft(draft, action); }
  catch (error) {
    if (error instanceof AuthoritiesDomainError) throw new ApplicationError(400, error.message);
    throw error;
  }
}

export function applyAuthoritiesInitialSettings(
  draft: AuthoritiesDraft, settings?: AuthoritiesInitialSettings,
) {
  if (!settings) return draft;
  let changed = settings.profileId
    ? update(draft, { type: "set-profile", profileId: settings.profileId }) : draft;
  const { profileId: _profile, outputMode, insertIntoDocument, ...raw } = settings;
  const build = Object.fromEntries(Object.entries(raw).filter(([, value]) =>
    value !== undefined)) as Partial<AuthoritiesBuildSettings>;
  if (Object.keys(build).length) changed = update(changed, { type: "set-settings", settings: build });
  if (outputMode) changed = update(changed, { type: "set-output-mode", outputMode });
  if (insertIntoDocument !== undefined) changed = update(changed,
    { type: "set-document-output", enabled: insertIntoDocument });
  return changed;
}

function attachableAuthority(draft: AuthoritiesDraft, authorityId: string) {
  const authority = draft.authorities[authorityId];
  if (!authority) {
    throw new ApplicationError(409, "This authority cannot accept that PDF");
  }
  return authority;
}

function attachSource(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  binding: Extract<WorkProductInput, { kind: "document" }>, filename: string,
  sourceSha256: string, origin: "manual" | "original" | "reconstructed" = "manual",
  sourceUrl = authority.source.kind === "pending-canlii" ? authority.source.pdfUrl
    : authority.sourceIdentity?.externalUrl ?? null) {
  return update(draft, { type: "attach-source", authorityId: authority.id, bindingRole:
    `authority:${sha256(authority.key).slice(0, 24)}`, binding, filename, sourceSha256,
    sourceUrl, origin });
}

const pdfFilename = (value: string) => `${value.trim().replace(
  /[<>:"/\\|?*\u0000-\u001f]/gu, "-",
).replace(/[. ]+$/u, "").slice(0, 180) || "Authority"}.pdf`;

function isCanliiUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.+$/u, "");
    return ["canlii.ca", "canlii.org"].some((domain) =>
      host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

const federalProfile = (draft: AuthoritiesDraft) =>
  !!authoritiesProfile(draft.settings.profileId).options?.filingMedium;
const federalEnactment = (citation: string) =>
  /\b(?:R\.?S\.?C\.?|S\.?C\.?|C\.?R\.?C\.?|SOR|SI|DORS|TR)\b/iu.test(citation);

async function concurrentMap<T, R>(items: T[], operation: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
}

export type PreparedAuthoritySource = {
  authorityId: string;
  filename: string;
  bytes: Buffer;
  sourceSha256: string;
  sourceUrl: string | null;
  origin: "original" | "reconstructed";
};

/** Resolves canonical identities and prepares source bytes without choosing a persistence adapter. */
export async function resolveAuthoritiesSources(
  initial: AuthoritiesDraft, sources: SourceServices = sourceServices,
  signal?: AbortSignal,
) {
  let draft = initial;
  const attachments: PreparedAuthoritySource[] = [];
  const reconstruct = draft.settings.sourceMode !== "manual-originals";
  const originals = draft.settings.sourceMode !== "render";
  const needsPdf = draft.outputMode !== "table";
  const candidates = draft.authorityOrder.flatMap((id) => {
    const authority = draft.authorities[id];
    return authority && ["case", "legislation"].includes(authority.kind) &&
      ["unresolved", "resolved"].includes(authority.source.kind) &&
      !(authority.sourceIdentity && authority.sourceIdentity.provider !== "a2aj")
      ? [{ id, authority }] : [];
  });
  const resolutions = await concurrentMap(candidates, async ({ id, authority }) => {
    signal?.throwIfAborted();
    let unavailable = false;
    for (const citation of authorityCitationForms(initial, id)) try {
      const source = await sources.resolve(citation,
        authority.kind as "case" | "legislation", signal);
      if (!source) continue;
      const revision = sources.revision(source.native);
      if (authority.sourceIdentity &&
          authority.sourceIdentity.sourceSha256 !== revision) return { mismatch: true as const };
      return { source, revision };
    } catch { signal?.throwIfAborted(); unavailable = true; }
    return unavailable ? { unavailable: true as const } : { source: null };
  });
  type ResolvedSource = NonNullable<Awaited<ReturnType<SourceServices["resolve"]>>>;
  const resolvedSources = new Map<string, ResolvedSource>();
  for (let index = 0; index < candidates.length; index += 1) {
    signal?.throwIfAborted();
    const { id } = candidates[index], resolved = resolutions[index];
    if ("mismatch" in resolved || "unavailable" in resolved || !resolved.source) continue;
    const source = resolved.source;
    resolvedSources.set(stableA2AJSourceId(source), source);
    draft = update(draft, { type: "resolve-authority", authorityId: id,
      citation: source.citation, name: source.name,
      source: { provider: "a2aj", stableSourceId: stableA2AJSourceId(source),
        sourceSha256: resolved.revision, version: source.date, externalUrl: source.url } });
  }
  if (!needsPdf) return { draft, attachments };
  for (let index = 0; index < candidates.length; index += 1) {
    const { id, authority } = candidates[index], current = draft.authorities[id],
      resolution = resolutions[index];
    if (!current || !("source" in resolution) || resolution.source !== null ||
        current.source.kind !== "unresolved") continue;
    const pageUrl = authority.kind === "case"
      ? buildCanliiCaseUrlFromCitation(authorityCitationForms(draft, id)) : null;
    if (pageUrl) draft = update(draft,
      { type: "begin-canlii-handoff", authorityId: id, pageUrl });
  }
  const unique = new Map<string, { authorityId: string; authority: AuthorityIdentity;
    source: ResolvedSource }>();
  for (const id of draft.authorityOrder) {
    const authority = draft.authorities[id], identity = authority?.sourceIdentity;
    const source = identity?.provider === "a2aj"
      ? resolvedSources.get(identity.stableSourceId) : undefined;
    if (authority?.source.kind === "resolved" && source && !unique.has(identity!.stableSourceId)) {
      unique.set(identity!.stableSourceId, { authorityId: id, authority, source });
    }
  }
  const prepared = await concurrentMap([...unique.values()], async (item) => {
    signal?.throwIfAborted();
    const { authority, source } = item;
    const pdfUrl = source.verifiedPdf && !isCanliiUrl(source.verifiedPdf.url)
      ? source.verifiedPdf.url : null;
    const sourceUrl = source.url && !isCanliiUrl(source.url) ? source.url : null;
    let original: Awaited<ReturnType<SourceServices["download"]>> | undefined;
    let retryable = false;
    if (originals && (pdfUrl || sourceUrl)) try {
      original = await sources.download({ provider: "a2aj",
        identity: stableA2AJSourceId(source), sourceUrl, pdfUrl,
        filename: pdfFilename(source.name ?? source.citation), title: source.name,
        version: source.date }, signal) ?? undefined;
      if (original && sha256(original.bytes) !== original.sourceSha256) {
        original = undefined; retryable = true;
      }
    } catch { signal?.throwIfAborted(); retryable = true; }
    // Federal enactments must be reproduced in both official languages. Never turn a
    // single-language source-text record into something that looks filing-ready.
    const reconstructed = reconstruct && !original && source.searchText.trim() &&
      !(federalProfile(draft) && authority.kind === "legislation" &&
        federalEnactment(source.citation || authority.citation))
      ? await renderAuthoritySourcePdf({ kind: authority.kind,
        name: source.name, citation: source.citation, date: source.date,
        sourceUrl: source.url, text: source.searchText }) : null;
    return { ...item, original, bytes: original?.bytes ?? reconstructed,
      retryable: retryable && !reconstructed };
  });
  for (const { authorityId, authority, source, original, bytes, retryable } of prepared) {
    if (!bytes) {
      if (retryable) continue;
      const pageUrl = authority.kind === "case" ? buildCanliiCaseUrlFromCitation([
        source.citation, source.alternateCitation,
        ...authorityCitationForms(draft, authorityId),
      ], source.language) : null;
      if (pageUrl) draft = update(draft,
        { type: "begin-canlii-handoff", authorityId, pageUrl });
      continue;
    }
    attachments.push({ authorityId,
      filename: pdfFilename(source.name ?? source.citation), bytes,
      sourceSha256: sha256(bytes), sourceUrl: original
        ? original.url ?? source.verifiedPdf?.url ?? source.url : source.url ?? null,
      origin: original ? "original" : "reconstructed" });
  }
  return { draft, attachments };
}

const sameValue = (values: unknown[]) => values.length > 0 &&
  values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]));
const parsedKind = ({ kind }: NativeCitationOccurrence): AuthorityKind => kind === "statute"
  ? "legislation" : kind === "journal" ? "commentary" : kind;
const lookupKey = (sources: CitationServices, text: string) => {
  try { return sources.key(text).trim(); } catch { return ""; }
};
const parsedAuthority = (match: NativeCitationOccurrence, key: string): AuthorityIdentity => ({
  id: key, key, kind: parsedKind(match), citation: match.coreCitation.text,
  name: match.reasons.includes("same_text_style") ? match.shortForm?.trim() || null : null,
  displayName: null, excluded: false, evidenceIds: [], locators: [],
  sourceIdentity: null,
  source: { kind: "unresolved" },
});

function manualOccurrence(draft: AuthoritiesDraft, unit: AuthoritiesDraft["units"][number],
  start: number, end: number, donors: AuthorityOccurrence[], sources: CitationServices) {
  while (start < end && /\s/u.test(unit.text[start])) start += 1;
  while (end > start && /\s/u.test(unit.text[end - 1])) end -= 1;
  if (start >= end) throw new ApplicationError(400,
    "The edit must leave citation text on both sides");
  const text = unit.text.slice(start, end);
  const matches = sources.occurrences(text), match = matches.length === 1 ? matches[0] : null;
  const key = match ? lookupKey(sources, match.coreCitation.text) : "";
  const authority = key ? Object.values(draft.authorities).find((item) => item.key === key) : null;
  const donorIds = donors.map(({ authorityId }) => authorityId);
  const authorityId = authority?.id ?? (sameValue(donorIds) ? donorIds[0] : null);
  const donorReferences = donors.map(({ reference }) => reference);
  const reference = sameValue(donorReferences) && /\b(?:ibid|supra)\b/iu.test(text)
    ? structuredClone(donorReferences[0]) : null;
  const occurrence: AuthorityOccurrence = {
    id: `${unit.id}:manual:${start}:${end}`, unitId: unit.id, start, end, text,
    ...(match ? nativeOccurrenceSpans(match, unit.text, start) : {
      authoritySpan: { start, end, text }, coreSpan: { start, end, text },
      pinpointSpan: null,
    }),
    kind: reference ? "reference" : match ? parsedKind(match)
      : sameValue(donors.map(({ kind }) => kind)) ? donors[0].kind : "other",
    citation: match?.coreCitation.text ??
      (sameValue(donors.map(({ citation }) => citation)) ? donors[0].citation : text.trim()),
    authorityId, reference,
    pinpoints: match?.pinpoints.map(({ kind, text }) => ({ kind, text })) ?? [],
    evidenceIds: [...new Set(donors.flatMap(({ evidenceIds }) => evidenceIds))].sort(),
    sourceTextSha256: donors[0].sourceTextSha256, localOrdinal: start, reviewed: true,
  };
  const discovered = match && key && !authority ? parsedAuthority(match, key) : null;
  if (discovered) occurrence.authorityId = discovered.id;
  return { occurrence, discovered };
}

function selectedRange(draft: AuthoritiesDraft, occurrenceId: string, start: number, end: number) {
  const occurrence = draft.occurrences[occurrenceId];
  const unit = occurrence && draft.units.find(({ id }) => id === occurrence.unitId);
  if (!occurrence || !unit || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start || end > unit.text.length) {
    throw new ApplicationError(400, "Select text inside this citation unit");
  }
  while (start < end && /\s/u.test(unit.text[start])) start += 1;
  while (end > start && /\s/u.test(unit.text[end - 1])) end -= 1;
  if (start === end) throw new ApplicationError(400, "Select citation text");
  return { occurrence, unit, start, end, text: unit.text.slice(start, end) };
}

const intersects = (start: number, end: number, span: { start: number; end: number }) =>
  start < span.end && span.start < end;

function correctionDonors(draft: AuthoritiesDraft,
  selected: ReturnType<typeof selectedRange>) {
  const siblings = selected.unit.occurrenceIds.flatMap((id) => {
    const item = draft.occurrences[id];
    return item && id !== selected.occurrence.id &&
      intersects(selected.start, selected.end, item) ? [item] : [];
  });
  if (siblings.some(({ start, end }) => start < selected.start || end > selected.end)) {
    throw new ApplicationError(400, "Select the complete overlapping citation");
  }
  return { donors: [selected.occurrence, ...siblings],
    absorbedIds: siblings.map(({ id }) => id) };
}

function chosenAuthorityMatch(matches: NativeCitationOccurrence[], occurrence: AuthorityOccurrence,
  draft: AuthoritiesDraft, sources: CitationServices) {
  const routed = matches.filter(({ kind, reasons }) =>
    kind === "case" && reasons.includes("provider_routing"));
  if (routed.length > 1) throw new ApplicationError(400,
    "Select one complete authority citation");
  if (routed.length === 1) return routed[0];
  if (matches.length === 1) return matches[0];
  if (!matches.length) return null;
  const current = draft.authorities[occurrence.authorityId ?? ""];
  const matching = matches.filter((match) => match.coreCitation.text === occurrence.citation ||
    !!current && lookupKey(sources, match.coreCitation.text) === current.key);
  const keys = new Set(matches.map((match) => lookupKey(sources, match.coreCitation.text))
    .filter(Boolean));
  if (matching.length === 1) return matching[0];
  if (keys.size === 1) return matches.find((match) =>
    lookupKey(sources, match.coreCitation.text) === [...keys][0])!;
  throw new ApplicationError(400, "Select one complete authority citation");
}

function removeUnusedDetections(draft: AuthoritiesDraft, donors: AuthorityOccurrence[],
  retainedId: string | null) {
  let changed = draft;
  for (const id of new Set(donors.flatMap(({ authorityId }) => authorityId ? [authorityId] : []))) {
    const authority = changed.authorities[id];
    if (!authority || id === retainedId ||
      !["unresolved", "pending-canlii"].includes(authority.source.kind) ||
      authority.sourceIdentity || authority.evidenceIds.length || authority.displayName ||
      authority.excluded || authority.locators.length ||
      Object.values(changed.occurrences)
        .some(({ authorityId }) => authorityId === id)) continue;
    changed = update(changed, { type: "remove-authority", authorityId: id });
  }
  return changed;
}

function correctOccurrenceSpan(draft: AuthoritiesDraft,
  action: Extract<AuthoritiesUserAction, { type: "set-authority-span" | "set-pinpoint-span" }>,
  sources: CitationServices) {
  const selected = selectedRange(draft, action.occurrenceId, action.start, action.end);
  const occurrence = structuredClone(selected.occurrence);
  if (action.type === "set-authority-span" &&
      !intersects(selected.start, selected.end, occurrence)) {
    throw new ApplicationError(400, "Select the citation being corrected");
  }
  const { donors, absorbedIds } = correctionDonors(draft, selected);
  const evidenceIds = [...new Set(donors.flatMap((item) => item.evidenceIds))].sort();
  if (action.type === "set-authority-span") {
    if (occurrence.pinpointSpan && intersects(selected.start, selected.end,
      occurrence.pinpointSpan)) throw new ApplicationError(400,
      "Select the authority without its pinpoint");
    const previousPinpoint = occurrence.pinpointSpan
      ? { span: occurrence.pinpointSpan, values: occurrence.pinpoints } : null;
    const matches = sources.occurrences(selected.text);
    const match = chosenAuthorityMatch(matches, occurrence, draft, sources);
    const key = match ? lookupKey(sources, match.coreCitation.text) : "";
    if (!match || !key) {
      const manual = manualOccurrence(draft, selected.unit, selected.start,
        selected.end, donors, sources).occurrence;
      if (manual.pinpointSpan && intersects(selected.start, selected.end,
        manual.pinpointSpan)) throw new ApplicationError(400,
        "Select the authority without its pinpoint");
      Object.assign(occurrence, manual, { id: occurrence.id,
        localOrdinal: occurrence.localOrdinal, evidenceIds });
      occurrence.authoritySpan = { start: selected.start, end: selected.end,
        text: selected.text };
      occurrence.pinpointSpan = null;
      occurrence.pinpoints = [];
      if (previousPinpoint) {
        occurrence.pinpointSpan = previousPinpoint.span;
        occurrence.pinpoints = previousPinpoint.values;
        occurrence.start = Math.min(occurrence.start, previousPinpoint.span.start);
        occurrence.end = Math.max(occurrence.end, previousPinpoint.span.end);
        occurrence.text = selected.unit.text.slice(occurrence.start, occurrence.end);
      }
      const changed = update(draft, { type: "replace-occurrence",
        occurrenceId: occurrence.id, replacement: occurrence,
        absorbed: { ids: absorbedIds, start: selected.start, end: selected.end } });
      return removeUnusedDetections(changed, donors, occurrence.authorityId);
    }
    const known = Object.values(draft.authorities).find((authority) => authority.key === key);
    const discovered = known ?? parsedAuthority(match, key);
    let changed = known ? draft : update(draft,
      { type: "add-authority", authority: discovered });
    const selectedName = match.reasons.includes("same_text_style")
      ? match.shortForm?.trim() : "";
    if (known && selectedName && !known.name && !known.displayName) changed = update(changed,
      { type: "rename-authority", authorityId: known.id, displayName: selectedName });
    const spans = nativeOccurrenceSpans(match, selected.unit.text, selected.start);
    if (spans.pinpointSpan && intersects(selected.start, selected.end,
      spans.pinpointSpan)) throw new ApplicationError(400,
      "Select the authority without its pinpoint");
    Object.assign(occurrence, spans, {
      authoritySpan: { start: selected.start, end: selected.end, text: selected.text },
      kind: parsedKind(match), citation: match.coreCitation.text,
      authorityId: discovered.id, reference: null,
      evidenceIds, pinpoints: [], reviewed: true,
    });
    occurrence.pinpointSpan = null;
    if (previousPinpoint) {
      occurrence.pinpointSpan = previousPinpoint.span;
      occurrence.pinpoints = previousPinpoint.values;
    }
    const pinpoint = occurrence.pinpointSpan;
    occurrence.start = Math.min(occurrence.authoritySpan.start, pinpoint?.start ?? Infinity);
    occurrence.end = Math.max(occurrence.authoritySpan.end, pinpoint?.end ?? -Infinity);
    occurrence.text = selected.unit.text.slice(occurrence.start, occurrence.end);
    changed = update(changed, { type: "replace-occurrence", occurrenceId: occurrence.id,
      replacement: occurrence,
      absorbed: { ids: absorbedIds, start: selected.start, end: selected.end } });
    return removeUnusedDetections(changed, donors, discovered.id);
  }
  if (intersects(selected.start, selected.end, occurrence.authoritySpan)) {
    throw new ApplicationError(400, "Select the pinpoint without the authority");
  }
  const from = Math.min(occurrence.authoritySpan.start, selected.start);
  const to = Math.max(occurrence.authoritySpan.end, selected.end);
  const matches = sources.occurrences(selected.unit.text.slice(from, to));
  const match = matches.find((item) => lookupKey(sources, item.coreCitation.text) ===
    draft.authorities[occurrence.authorityId ?? ""]?.key);
  const pinpoints = match?.pinpoints.filter((item) =>
    from + item.end > selected.start && from + item.start < selected.end) ?? [];
  if (!pinpoints.length) throw new ApplicationError(400,
    "Select a complete pinpoint for this authority");
  occurrence.pinpointSpan = { start: selected.start, end: selected.end, text: selected.text };
  occurrence.pinpoints = pinpoints.map(({ kind, text }) => ({ kind, text }));
  occurrence.start = Math.min(occurrence.authoritySpan.start, selected.start);
  occurrence.end = Math.max(occurrence.authoritySpan.end, selected.end);
  occurrence.text = selected.unit.text.slice(occurrence.start, occurrence.end);
  occurrence.evidenceIds = evidenceIds;
  occurrence.reviewed = true;
  const changed = update(draft, { type: "replace-occurrence", occurrenceId: occurrence.id,
    replacement: occurrence,
    absorbed: { ids: absorbedIds, start: selected.start, end: selected.end } });
  return removeUnusedDetections(changed, donors, occurrence.authorityId);
}

function editOccurrences(draft: AuthoritiesDraft,
  action: Extract<AuthoritiesUserAction,
    { type: "split-occurrence" | "merge-occurrence" }>, sources: CitationServices) {
  const occurrence = draft.occurrences[action.occurrenceId];
  const unit = occurrence && draft.units.find(({ id }) => id === occurrence.unitId);
  if (!occurrence || !unit || unit.kind !== "footnote") {
    throw new ApplicationError(400, "Only a footnote citation can be split or merged");
  }
  let replacements: ReturnType<typeof manualOccurrence>[], ids: [string, string];
  if (action.type === "split-occurrence") {
    if (!Number.isSafeInteger(action.cursor) || action.cursor <= occurrence.start ||
        action.cursor >= occurrence.end) throw new ApplicationError(400,
      "Place the cursor inside this footnote citation");
    replacements = [manualOccurrence(draft, unit, occurrence.start, action.cursor,
      [occurrence], sources), manualOccurrence(draft, unit, action.cursor, occurrence.end,
      [occurrence], sources)];
    ids = [occurrence.id, occurrence.id];
  } else {
    const position = unit.occurrenceIds.indexOf(occurrence.id);
    const previous = position > 0 ? draft.occurrences[unit.occurrenceIds[position - 1]] : null;
    if (!previous) throw new ApplicationError(400,
      "This is the first citation in the footnote");
    replacements = [manualOccurrence(draft, unit, previous.start, occurrence.end,
      [previous, occurrence], sources)];
    ids = [previous.id, occurrence.id];
  }
  let changed = draft;
  for (const { discovered } of replacements) {
    if (discovered && !changed.authorities[discovered.id]) changed = update(changed,
      { type: "add-authority", authority: discovered });
  }
  return action.type === "split-occurrence"
    ? update(changed, { type: "split-occurrence", occurrenceId: action.occurrenceId,
      replacements: [replacements[0].occurrence, replacements[1].occurrence] })
    : update(changed, { type: "merge-occurrences", occurrenceIds: ids,
      replacement: replacements[0].occurrence });
}

export function applyAuthoritiesUserAction(
  draft: AuthoritiesDraft,
  action: AuthoritiesUserAction,
  sources: CitationServices = sourceServices,
) {
  if (action.type === "add-authority") {
    const citation = action.citation.trim();
    const base = lookupKey(sources, citation) || `manual:${sha256(
      `${action.kind}\0${citation}`).slice(0, 24)}`;
    let key = base;
    for (let suffix = 2; draft.authorities[key]; suffix += 1) key = `${base}:${suffix}`;
    let changed = update(draft, { type: action.type, authority: { id: key, key,
      kind: action.kind, citation, name: action.name?.trim() || null,
      displayName: null, excluded: false, evidenceIds: [], locators: [],
      sourceIdentity: null, source: { kind: "unresolved" } } });
    const pageUrl = draft.settings.sourceMode === "manual-originals" && action.kind === "case"
      ? buildCanliiCaseUrlFromCitation([citation]) : null;
    if (pageUrl) changed = update(changed,
      { type: "begin-canlii-handoff", authorityId: key, pageUrl });
    return changed;
  }
  if (action.type === "begin-canlii-handoff") {
    const authority = draft.authorities[action.authorityId];
    const pageUrl = authority && buildCanliiCaseUrlFromCitation(
      authorityCitationForms(draft, authority.id));
    if (!authority || !pageUrl) throw new ApplicationError(409,
      "A canonical CanLII link is not available for this authority");
    return update(draft, { ...action, pageUrl });
  }
  if (action.type === "set-authority-span" || action.type === "set-pinpoint-span") {
    return correctOccurrenceSpan(draft, action, sources);
  }
  if (action.type === "remove-occurrence") {
    const occurrence = draft.occurrences[action.occurrenceId];
    if (!occurrence) throw new ApplicationError(400, "Citation review item not found");
    return removeUnusedDetections(update(draft, action), [occurrence], null);
  }
  return action.type === "split-occurrence" || action.type === "merge-occurrence"
    ? editOccurrences(draft, action, sources) : update(draft, action);
}

export function createAuthoritiesWorkspaceApplication(
  documents: DocumentStore,
  workProducts: WorkProductApplication,
  files: WorkflowFiles,
  builder: typeof buildAuthorities = buildAuthorities,
  importer: AuthoritiesImporter = createAuthoritiesImporter(documents),
  sources: SourceServices = sourceServices,
) {
  async function open(scope: ApplicationScope, id: string) {
    const found = await workProducts.get(scope, id);
    if (found.kind !== "authorities") throw new ApplicationError(404,
      "Authorities draft not found");
    return { product: found, draft: draftState(found.state) };
  }

  async function edit(scope: ApplicationScope, id: string, revision: number) {
    const current = await open(scope, id);
    if (current.product.revision !== revision) throw new ApplicationError(409,
      "This draft changed. Reload it before saving.", {
        current_revision: String(current.product.revision),
      });
    return current;
  }

  async function withRollback<T>(scope: ApplicationScope, ids: string[], save: () => Promise<T>,
    message = "Authorities changes could not be saved or rolled back") {
    try { return await save(); }
    catch (error) {
      const cleanup = await Promise.allSettled(ids.map(async (id) => {
        if (!await documents.deleteDocument(scope, id)) throw new Error(
          `Created document could not be removed: ${id}`);
      }));
      const failures = cleanup.flatMap((item) => item.status === "rejected" ? [item.reason] : []);
      if (failures.length) throw new AggregateError([error, ...failures], message);
      throw error;
    }
  }

  async function resolveSources(scope: ApplicationScope, initial: AuthoritiesDraft,
    projectId?: string | null, signal?: AbortSignal) {
    let { draft, attachments } = await resolveAuthoritiesSources(initial, sources, signal);
    const created: string[] = [];
    return withRollback(scope, created, async () => {
      for (const attachment of attachments) {
        signal?.throwIfAborted();
        const saved = await files.create(scope, "authorities",
          { filename: attachment.filename, fileType: "pdf", bytes: attachment.bytes },
          { projectId });
        created.push(saved.id);
        if (saved.source_sha256 !== attachment.sourceSha256) {
          throw new Error("Saved authority PDF hash does not match its prepared source");
        }
        draft = attachSource(draft, draft.authorities[attachment.authorityId],
          { kind: "document", documentId: saved.id,
            version: { versionId: saved.current_version_id, sha256: saved.source_sha256 } },
          saved.filename, saved.source_sha256, attachment.origin, attachment.sourceUrl);
      }
      return { draft, created };
    }, "Authority sources could not be saved or rolled back");
  }

  async function saveRefresh(scope: ApplicationScope, product: AuthoritiesProduct,
    draft: AuthoritiesDraft, revision: number, source: AuthoritiesImportSource) {
    const fresh = await importer.draft(scope, source);
    return workProducts.save(scope, product.id, { revision,
      state: update(draft, { type: "refresh", review: review(fresh) }) });
  }

  async function currentLibraryVersion(scope: ApplicationScope, draft: AuthoritiesDraft,
    role: string, expected: "pdf" | "source") {
    const binding = draft.bindings[role];
    if (binding?.kind !== "document") {
      throw new ApplicationError(409, "This source is not a Library document");
    }
    const history = await documents.versions(scope, binding.documentId);
    const version = history?.versions.find(({ id }) => id === history.current_version_id);
    if (!version) throw new ApplicationError(409,
      "This Library file is no longer available. Add it again.");
    const fileType = version.file_type.toLowerCase();
    if (expected === "pdf" ? fileType !== "pdf" : !["pdf", "docx"].includes(fileType)) {
      throw new ApplicationError(409, expected === "pdf"
        ? "The current Library file is not a PDF"
        : "The current Library file is not a PDF or Word document");
    }
    return { binding, version };
  }

  async function buildSources(scope: ApplicationScope, draft: AuthoritiesDraft,
    signal?: AbortSignal) {
    const result: Record<string, { bytes?: Uint8Array; pageTextByPage?: string[];
      ocrTextByPage?: string[]; passageGeometry?: Awaited<ReturnType<typeof authorityPdfText>>["passageGeometry"];
      resolved?: ResolvedWorkProductInput }> = {};
    if (draft.import.kind === "document" && draft.import.snapshot) {
      const { bindingRole, snapshot, filename } = draft.import;
      const binding = draft.bindings[bindingRole];
      if (binding?.kind !== "document") {
        throw new ApplicationError(409, "Imported document binding is invalid");
      }
      const requested = binding.version === "latest" ? null : binding.version.versionId;
      const [source, history] = await Promise.all([
        documents.projectionSource(scope, binding.documentId, requested),
        documents.versions(scope, binding.documentId),
      ]);
      const version = history?.versions.find(({ id }) => id === source?.versionId);
      if (!source || !version || source.documentId !== snapshot.documentId ||
          source.versionId !== snapshot.versionId || source.sourceSha256 !== snapshot.sha256 ||
          version.source_sha256 !== snapshot.sha256) {
        throw new ApplicationError(409, "The imported document changed. Refresh before building.");
      }
      result[bindingRole] = { resolved: { kind: "document",
        documentId: source.documentId, versionId: source.versionId,
        filename: version.filename || filename, sha256: source.sourceSha256 } };
      if (draft.insertIntoDocument) {
        const file = await documents.read(scope, binding.documentId, source.versionId, false);
        if (!file || file.fileType.toLowerCase() !== draft.import.fileType ||
            file.version.source_sha256 !== snapshot.sha256 ||
            sha256(file.bytes) !== snapshot.sha256) {
          throw new ApplicationError(409, "The imported document changed. Refresh before building.");
        }
        result[bindingRole].bytes = file.bytes;
      }
    }
    const attached = Object.values(draft.authorities).flatMap((authority) =>
      authority.source.kind === "attached" ? [{ authority, source: authority.source }] : []);
    const needsBook = draft.outputMode !== "table";
    const needsFilingPdfs = draft.insertIntoDocument &&
      !!authoritiesProfile(draft.settings.profileId).requirements?.unlinkedPdfTableSources &&
      draft.import.kind === "document" && draft.import.fileType === "pdf";
    const bookRoles = new Set(Object.values(draft.authorities).flatMap(({ excluded, source }) =>
      needsBook && !excluded && source.kind === "attached" ? [source.bindingRole] : []));
    const filingRoles = new Set(Object.values(draft.authorities).flatMap(({ excluded, source }) =>
      needsFilingPdfs && !excluded && source.kind === "attached" ? [source.bindingRole] : []));
    const textRoles = authoritiesTextRoles(draft);
    const preparedRoles = new Set([...bookRoles, ...textRoles]);
    const preparation = new Map(preparedRoles.size
      ? (await documents.parseStates(scope, [...preparedRoles].flatMap((role) => {
        const binding = draft.bindings[role];
        return binding?.kind === "document" ? [binding.documentId] : [];
      }))).map((state) => [state.id, state.parse_state])
      : []);
    const readPdf = async (source: { bindingRole: string; filename: string;
      sourceSha256: string }, label: string) => {
      const binding = draft.bindings[source.bindingRole];
      if (binding?.kind !== "document") throw new ApplicationError(409,
        `${label} is unavailable: ${source.filename}`);
      const file = await documents.read(scope, binding.documentId,
        binding.version === "latest" ? null : binding.version.versionId, false);
      if (!file || file.fileType.toLowerCase() !== "pdf" ||
          file.version.source_sha256 !== source.sourceSha256 ||
          sha256(file.bytes) !== source.sourceSha256) throw new ApplicationError(409,
        `${label} changed: ${source.filename}`);
      return { binding, file, resolved: { kind: "document" as const,
        documentId: binding.documentId, versionId: file.version.id,
        filename: file.filename, sha256: file.version.source_sha256 } };
    };
    await Promise.all(attached.map(async ({ authority, source }) => {
      signal?.throwIfAborted();
      const { binding, file, resolved } = await readPdf(source, "Attached PDF");
      const forBook = bookRoles.has(source.bindingRole);
      const forFiling = filingRoles.has(source.bindingRole);
      const needsText = textRoles.has(source.bindingRole);
      if (forBook && !file.pdfProfile) {
        const state = preparation.get(binding.documentId);
        const pending = state?.status === "queued" || state?.status === "parsing";
        throw new ApplicationError(409, pending
          ? `${source.filename} is still being prepared.`
          : state?.error?.includes("password-protected")
            ? `${source.filename}: ${state.error}`
            : `${source.filename} could not be prepared. Remove any password or usage restrictions, then add it again.`,
        { document_id: binding.documentId,
          pdf_status: state?.status ?? "unprepared",
          pdf_phase: state?.phase,
          pdf_pages: state?.pages?.join(",") });
      }
      const text = needsText ? await authorityPdfText({ bytes: file.bytes,
        documentId: binding.documentId, versionId: file.version.id,
        sourceSha256: file.version.source_sha256, pdfProfile: file.pdfProfile, signal,
        passageTargets: draft.settings.passageMarking === "none"
          ? [] : authorityPassageTargets(draft, authority.id) }) : null;
      result[source.bindingRole] = { ...(forBook || forFiling ? { bytes: file.bytes } : {}),
        ...(text ? { pageTextByPage: text.pageTextByPage } : {}),
        ...(text?.ocrTextByPage.some(Boolean) ? { ocrTextByPage: text.ocrTextByPage } : {}),
        ...(text?.passageGeometry ? { passageGeometry: text.passageGeometry } : {}),
        resolved };
    }));
    await Promise.all(authoritiesBookPdfs(draft).map(async (source) => {
      signal?.throwIfAborted();
      const { file, resolved } = await readPdf(source, "Book PDF");
      result[source.bindingRole] = { bytes: file.bytes, resolved };
    }));
    return result;
  }

  return Object.freeze({
    list: (scope: ApplicationScope, options: { projectId?: string; limit?: number } = {}) =>
      workProducts.list(scope, { kind: "authorities", ...options }),
    async get(scope: ApplicationScope, id: string) {
      return (await open(scope, id)).product;
    },
    async discrepancies(scope: ApplicationScope, id: string, signal?: AbortSignal) {
      return reviewAuthoritiesDiscrepancies((await open(scope, id)).draft, signal);
    },
    async saveFile(scope: ApplicationScope, file: DocumentFile, projectId?: string | null) {
      if (!["pdf", "docx"].includes(file.fileType.toLowerCase())) {
        throw new ApplicationError(400, "Add a PDF or Word document");
      }
      return files.create(scope, "authorities", file, { projectId });
    },
    async importDraft(scope: ApplicationScope, input: {
      source: AuthoritiesImportSource; title?: string; projectId?: string | null;
      settings?: AuthoritiesInitialSettings;
    }) {
      const initial = applyAuthoritiesInitialSettings(
        await importer.draft(scope, input.source), input.settings);
      const title = input.title ?? (initial.import.kind === "document"
        ? initial.import.filename.replace(/\.[^.]+$/u, "") || "Authorities"
        : "Authorities");
      return workProducts.create(scope,
        { kind: "authorities", title, projectId: input.projectId, state: initial });
    },
    async addReceipts(scope: ApplicationScope, id: string, revision: number,
      seeds: readonly GroundedReceiptSeed[]) {
      const { draft } = await edit(scope, id, revision);
      const incoming = review(await importer.draft(scope, { kind: "receipts", seeds }));
      const current = review(draft);
      const changed = update(draft, { type: "refresh", review: {
        ...current,
        authorities: { ...current.authorities, ...incoming.authorities },
        authorityOrder: [...current.authorityOrder, ...incoming.authorityOrder.filter(
          (authorityId) => !current.authorities[authorityId],
        )],
      } });
      return workProducts.save(scope, id, { revision, state: changed });
    },
    async act(scope: ApplicationScope, id: string, revision: number,
      action: AuthoritiesUserAction) {
      const { draft } = await edit(scope, id, revision);
      const changed = applyAuthoritiesUserAction(draft, action, sources);
      return workProducts.save(scope, id, { revision, state: changed });
    },
    async prepareSources(scope: ApplicationScope, id: string, revision: number,
      signal?: AbortSignal) {
      const { product, draft } = await edit(scope, id, revision);
      const resolved = await resolveSources(scope, draft, product.projectId, signal);
      if (resolved.draft === draft && !resolved.created.length) return product;
      return withRollback(scope, resolved.created, () =>
        workProducts.save(scope, id, { revision, state: resolved.draft }));
    },
    async refresh(scope: ApplicationScope, id: string, revision: number,
      receiptSeeds?: readonly GroundedReceiptSeed[]) {
      const { product, draft } = await edit(scope, id, revision);
      const binding = draft.import.kind === "document"
        ? draft.bindings[draft.import.bindingRole] : null;
      if (binding && binding.kind !== "document") {
        throw new ApplicationError(409, "Imported document binding is invalid");
      }
      if (!binding && !receiptSeeds?.length) return product;
      const source: AuthoritiesImportSource = binding ??
        { kind: "receipts", seeds: receiptSeeds! };
      return saveRefresh(scope, product, draft, revision, source);
    },
    async refreshInput(scope: ApplicationScope, id: string, input: {
      revision: number; role: string;
    }) {
      const { product, draft } = await edit(scope, id, input.revision);
      if (draft.import.kind === "document" && draft.import.bindingRole === input.role) {
        const { binding, version } = await currentLibraryVersion(
          scope, draft, input.role, "source");
        if (version.file_type.toLowerCase() !== draft.import.fileType) {
          throw new ApplicationError(409,
            `The current Library file is not a ${draft.import.fileType === "pdf" ? "PDF" : "Word document"}`);
        }
        return saveRefresh(scope, product, draft, input.revision,
          { ...binding, version: "latest" });
      }
      const authority = Object.values(draft.authorities).find(({ source }) =>
        source.kind === "attached" && source.bindingRole === input.role);
      const cover = draft.bookParts.cover?.bindingRole === input.role
        ? draft.bookParts.cover : null;
      const index = draft.bookParts.index?.bindingRole === input.role
        ? draft.bookParts.index : null;
      const boundPdf = authority?.source.kind === "attached" ? authority.source
        : cover ?? index;
      if (!boundPdf) throw new ApplicationError(409, "This source is no longer in the draft");
      const { binding, version } = await currentLibraryVersion(scope, draft, input.role, "pdf");
      const nextBinding = { ...binding, version: "latest" as const };
      const pdf = { ...boundPdf, filename: version.filename,
        sourceSha256: version.source_sha256 };
      const state = authority?.source.kind === "attached"
        ? update(draft, { type: "attach-source", authorityId: authority.id,
          bindingRole: input.role, binding: nextBinding, filename: pdf.filename,
          sourceSha256: pdf.sourceSha256, sourceUrl: authority.source.sourceUrl,
          origin: authority.source.origin })
        : update(draft, { type: "set-book-part", slot: cover ? "cover" : "index",
          pdf, binding: nextBinding });
      return workProducts.save(scope, id, { revision: input.revision, state });
    },
    async replaceSource(scope: ApplicationScope, id: string, input: {
      revision: number; file: DocumentFile;
    }) {
      const fileType = input.file.fileType.toLowerCase();
      if (!["pdf", "docx"].includes(fileType)) {
        throw new ApplicationError(400, "Add a PDF or Word document");
      }
      const { product, draft } = await edit(scope, id, input.revision);
      if (draft.import.kind !== "document") {
        throw new ApplicationError(409, "Only an imported document can be replaced");
      }
      const created = await files.create(scope, "authorities", input.file,
        { projectId: product.projectId });
      return withRollback(scope, [created.id], async () => {
        const fresh = await importer.draft(scope, { kind: "document",
          documentId: created.id, version: "latest" });
        return workProducts.save(scope, id, { revision: input.revision,
          state: update(draft, { type: "refresh", review: review(fresh) }) });
      }, "Replacing the source could not be completed");
    },
    async attachPdf(scope: ApplicationScope, id: string, input: {
      revision: number; authorityId: string; file: DocumentFile;
    }) {
      if (input.file.fileType.toLowerCase() !== "pdf") {
        throw new ApplicationError(400, "Attach a PDF file");
      }
      const { product, draft } = await edit(scope, id, input.revision);
      const authority = attachableAuthority(draft, input.authorityId);
      const created = await files.create(scope, "authorities", input.file,
        { projectId: product.projectId });
      return withRollback(scope, [created.id], async () => {
        const state = attachSource(draft, authority,
          { kind: "document", documentId: created.id,
            version: { versionId: created.current_version_id,
              sha256: created.source_sha256 } }, created.filename, created.source_sha256);
        return workProducts.save(scope, id, { revision: input.revision, state });
      }, "Attaching the PDF could not be completed");
    },
    async attachBookPdf(scope: ApplicationScope, id: string, input: {
      revision: number; slot: "cover" | "index"; file: DocumentFile;
    }) {
      if (input.file.fileType.toLowerCase() !== "pdf") {
        throw new ApplicationError(400, "Attach a PDF file");
      }
      const { product, draft } = await edit(scope, id, input.revision);
      const created = await files.create(scope, "authorities", input.file,
        { projectId: product.projectId });
      return withRollback(scope, [created.id], async () => {
        const binding = { kind: "document" as const, documentId: created.id,
          version: { versionId: created.current_version_id, sha256: created.source_sha256 } };
        const pdf = { bindingRole: `book:${input.slot}:${input.slot}`, filename: created.filename,
          sourceSha256: created.source_sha256 };
        const state = update(draft, { type: "set-book-part", slot: input.slot, pdf, binding });
        return workProducts.save(scope, id, { revision: input.revision, state });
      }, "Attaching the book PDF could not be completed");
    },
    async attachLibraryPdf(scope: ApplicationScope, id: string, input: {
      revision: number; authorityId: string; documentId: string; versionId: string;
    }) {
      const { draft } = await edit(scope, id, input.revision);
      const authority = attachableAuthority(draft, input.authorityId);
      const history = await documents.versions(scope, input.documentId);
      const version = history?.versions.find(({ id }) => id === input.versionId);
      if (!version || history?.current_version_id !== version.id ||
          version.file_type.toLowerCase() !== "pdf") {
        throw new ApplicationError(409, "Select the current PDF version from Library");
      }
      return workProducts.save(scope, id, { revision: input.revision,
        state: attachSource(draft, authority,
          { kind: "document", documentId: input.documentId, version: "latest" },
          version.filename, version.source_sha256) });
    },
    async build(scope: ApplicationScope, id: string, revision: number, signal?: AbortSignal):
      Promise<{ product: AuthoritiesProduct; receipt: AuthoritiesBuildResult["receipt"] }> {
      const { product, draft } = await edit(scope, id, revision);
      let built: AuthoritiesBuildResult;
      try {
        built = await builder({ draft, title: product.title,
          workProduct: { id, revision }, sources: await buildSources(scope, draft, signal), signal });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(409,
          error instanceof Error ? error.message : "Authorities could not be built");
      }
      const refs: Record<string, WorkProductOutputRef> = {};
      const rollback: Array<{ documentId: string; versionId?: string }> = [];
      try {
        for (const artifact of Object.values(built.artifacts).filter(
          (item): item is NonNullable<typeof item> => Boolean(item))) {
          signal?.throwIfAborted();
          const file = { filename: artifact.filename,
            fileType: artifact.mimeType === "application/pdf" ? "pdf" : "docx",
            bytes: artifact.bytes,
            provenance: { schemaVersion: 1 as const, actor: "work-product" as const,
              action: "built" as const, receipt: artifact.receipt } };
          const existing = product.outputs[artifact.role];
          const version = existing
            ? await documents.addVersion(scope, existing.documentId, {
              ...file, expectedCurrentVersionId: existing.versionId,
            }) : null;
          if (version) {
            rollback.push({ documentId: existing!.documentId, versionId: version.id });
            if (version.source_sha256 !== artifact.sha256) {
              throw new Error("Saved Authorities output hash does not match its build");
            }
            refs[artifact.role] = { documentId: existing!.documentId, versionId: version.id };
          } else {
            if (existing && await documents.metadata(scope, existing.documentId)) {
              throw new ApplicationError(409,
                "An Authorities output changed while the new build was being saved");
            }
            const created = await files.create(scope, "authorities", file,
              { projectId: product.projectId });
            rollback.push({ documentId: created.id });
            if (created.source_sha256 !== artifact.sha256) {
              throw new Error("Saved Authorities output hash does not match its build");
            }
            refs[artifact.role] = { documentId: created.id,
              versionId: created.current_version_id };
          }
        }
        signal?.throwIfAborted();
        const saved = await workProducts.save(scope, id, { revision, outputs: refs });
        if (saved.kind !== "authorities") throw new ApplicationError(409,
          "Authorities draft state is invalid");
        return { product: saved, receipt: built.receipt };
      } catch (error) {
        const failures: unknown[] = [];
        for (const item of rollback.reverse()) {
          try {
            if (item.versionId) await documents.deleteVersion(scope,
              item.documentId, item.versionId);
            else await documents.deleteDocument(scope, item.documentId);
          } catch (cleanup) { failures.push(cleanup); }
        }
        if (failures.length) throw new AggregateError([error, ...failures],
          "Authorities output could not be saved or rolled back");
        throw error;
      }
    },
  });
}

export type AuthoritiesWorkspaceApplication =
  ReturnType<typeof createAuthoritiesWorkspaceApplication>;
