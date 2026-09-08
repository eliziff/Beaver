import { randomUUID } from "node:crypto";
import { ApplicationError } from "./applicationError";
import { AuthoritiesDomainError, attachedAuthoritySources, authorityCitationForms, reduceAuthoritiesDraft,
  unusedScanOnlyAuthority, type AuthoritiesAction, type AuthoritiesBuildSettings,
  type AuthoritiesDraft, type AuthoritiesFreshReview, type AuthorityIdentity,
  type AuthorityKind, type AuthorityOccurrence, type AuthoritySourceLanguage,
  type AuthoritiesOutputMode, type AuthoritiesProfileId } from "./authoritiesDomain";
import { nativeOccurrenceSpans } from "./authoritiesImport";
import { buildCanliiCaseUrlFromCitation } from "./canliiUrls";
import { authorityPdfText } from "./authorityPdfText";
import { citationAliasKeysBatch } from "./caselawCitator";
import { sha256 } from "./hash";
import { structureNative, type NativeCitationOccurrence } from "./structureNative";
import type { WorkProductInput } from "./workProduct";

export const authorityCitationServices = {
  key: (value: string) => structureNative().citationLookupKey(value),
  occurrences: (value: string) => structureNative().citationOccurrencesInText(value),
};
type CitationServices = typeof authorityCitationServices;

import type { AuthoritiesUserAction } from "../../../shared/authorities-contract.d.ts";
export type { AuthoritiesUserAction } from "../../../shared/authorities-contract.d.ts";

export type AuthoritiesInitialSettings = Partial<AuthoritiesBuildSettings> & {
  profileId?: AuthoritiesProfileId;
  outputMode?: AuthoritiesOutputMode;
  insertIntoDocument?: boolean;
};

/** Import data only: never overwrite user settings, book parts, or accepted decisions. */
export const authoritiesReview = (draft: AuthoritiesDraft): AuthoritiesFreshReview => ({
  import: draft.import, bindings: draft.bindings, cover: draft.cover, units: draft.units,
  occurrences: draft.occurrences, authorities: draft.authorities,
  authorityOrder: draft.authorityOrder,
});

export function updateAuthoritiesDraft(draft: AuthoritiesDraft, action: AuthoritiesAction) {
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
    ? applyAuthoritiesUserAction(draft, { type: "set-profile", profileId: settings.profileId })
    : draft;
  const { profileId: _profile, outputMode, insertIntoDocument, ...raw } = settings;
  const build = Object.fromEntries(Object.entries(raw).filter(([, value]) =>
    value !== undefined)) as Partial<AuthoritiesBuildSettings>;
  if (Object.keys(build).length) changed = updateAuthoritiesDraft(changed, { type: "set-settings", settings: build });
  if (outputMode) changed = applyAuthoritiesUserAction(changed,
    { type: "set-output-mode", outputMode });
  if (insertIntoDocument !== undefined) changed = updateAuthoritiesDraft(changed,
    { type: "set-document-output", enabled: insertIntoDocument });
  return changed;
}

export function attachAuthorityPdf(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  binding: WorkProductInput, filename: string,
  sourceSha256: string, language: AuthoritySourceLanguage,
  origin: "manual" | "original" | "reconstructed" = "manual",
  sourceUrl = authority.source.kind === "pending-canlii" ? authority.source.pdfUrl
    : attachedAuthoritySources(authority.source).find(source => source.language === language)?.sourceUrl
      ?? authority.sourceIdentity?.externalUrl ?? null) {
  return updateAuthoritiesDraft(draft, { type: "attach-source", authorityId: authority.id, bindingRole:
    attachedAuthoritySources(authority.source).find(source => source.language === language)?.bindingRole
      ?? `authority:${sha256(authority.key).slice(0, 24)}:${language}`, binding, filename, sourceSha256,
    sourceUrl, language, origin });
}

export async function checkCanliiPdf(draft: AuthoritiesDraft, authorityId: string, bytes: Buffer) {
  const authority = draft.authorities[authorityId];
  if (authority?.source.kind !== "pending-canlii") return;
  const { pageTextByPage } = await authorityPdfText({ bytes, maxPages: 1 });
  // Use the opening citation, never a matching case cited later in the reasons.
  const citation = structureNative().citationOccurrencesInText(pageTextByPage[0] ?? "")
    .find(({ kind }) => kind === "case")?.coreCitation.text;
  if (!citation) throw new ApplicationError(400, "The PDF’s citation could not be verified; it was not attached.");
  const keys = citationAliasKeysBatch(authorityCitationForms(draft, authorityId)).flat();
  if (!keys.includes(structureNative().citationLookupKey(citation)))
    throw new ApplicationError(400, `This PDF is ${citation}, not ${authority.citation}; it was not attached.`);
}

export function attachAuthoritiesBookPdf(draft: AuthoritiesDraft, input: {
  slot: "cover" | "index" | "supplemental"; supplementId?: string;
}, binding: WorkProductInput, filename: string,
sourceSha256: string) {
  if (input.supplementId && input.slot !== "supplemental") {
    throw new ApplicationError(400, "Only another book PDF can have a supplemental ID");
  }
  const existing = input.slot === "supplemental"
    ? draft.bookParts.supplements.find(({ id }) => id === input.supplementId)
    : draft.bookParts[input.slot];
  if (input.supplementId && !existing) {
    throw new ApplicationError(409, "This book PDF is no longer in the draft");
  }
  const partId = input.slot === "supplemental" ? input.supplementId ?? randomUUID() : input.slot;
  const pdf = { bindingRole: existing?.bindingRole ?? `book:${input.slot}:${partId}`, filename,
    sourceSha256 };
  return input.slot === "supplemental"
    ? updateAuthoritiesDraft(draft, { type: "set-book-supplement", supplement: { ...pdf, id: partId }, binding })
    : updateAuthoritiesDraft(draft, { type: "set-book-part", slot: input.slot, pdf, binding });
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
  source: { kind: "unresolved" }, scanOnly: true,
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
    if (id === retainedId || !unusedScanOnlyAuthority(changed, id)) continue;
    changed = updateAuthoritiesDraft(changed, { type: "remove-authority", authorityId: id });
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
    const match = chosenAuthorityMatch(sources.occurrences(selected.text), occurrence,
      draft, sources);
    const key = match ? lookupKey(sources, match.coreCitation.text) : "";
    let changed = draft;
    // The span the occurrence extends from: the selection itself for a parsed match,
    // but manualOccurrence's whitespace-trimmed bounds on the manual path.
    let basis = { start: selected.start, end: selected.end };
    if (match && key) {
      const known = Object.values(draft.authorities).find((authority) => authority.key === key);
      const discovered = known ?? parsedAuthority(match, key);
      if (!known) changed = updateAuthoritiesDraft(draft,
        { type: "add-authority", authority: discovered });
      const selectedName = match.reasons.includes("same_text_style")
        ? match.shortForm?.trim() : "";
      if (known && selectedName && !known.name && !known.displayName) changed = updateAuthoritiesDraft(changed,
        { type: "rename-authority", authorityId: known.id, displayName: selectedName });
      Object.assign(occurrence, nativeOccurrenceSpans(match, selected.unit.text, selected.start), {
        kind: parsedKind(match), citation: match.coreCitation.text,
        authorityId: discovered.id, reference: null, pinpoints: [], reviewed: true });
    } else {
      const manual = manualOccurrence(draft, selected.unit, selected.start,
        selected.end, donors, sources).occurrence;
      Object.assign(occurrence, manual,
        { id: occurrence.id, localOrdinal: occurrence.localOrdinal });
      basis = { start: manual.start, end: manual.end };
    }
    if (occurrence.pinpointSpan && intersects(selected.start, selected.end,
      occurrence.pinpointSpan)) throw new ApplicationError(400,
      "Select the authority without its pinpoint");
    occurrence.evidenceIds = evidenceIds;
    occurrence.authoritySpan = { start: selected.start, end: selected.end, text: selected.text };
    occurrence.pinpointSpan = previousPinpoint?.span ?? null;
    occurrence.pinpoints = previousPinpoint?.values ?? [];
    occurrence.start = Math.min(basis.start, occurrence.pinpointSpan?.start ?? Infinity);
    occurrence.end = Math.max(basis.end, occurrence.pinpointSpan?.end ?? -Infinity);
    occurrence.text = selected.unit.text.slice(occurrence.start, occurrence.end);
    changed = updateAuthoritiesDraft(changed, { type: "replace-occurrence",
      occurrenceId: occurrence.id, replacement: occurrence,
      absorbed: { ids: absorbedIds, start: selected.start, end: selected.end } });
    return removeUnusedDetections(changed, donors, occurrence.authorityId);
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
  const changed = updateAuthoritiesDraft(draft, { type: "replace-occurrence", occurrenceId: occurrence.id,
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
    if (discovered && !changed.authorities[discovered.id]) changed = updateAuthoritiesDraft(changed,
      { type: "add-authority", authority: discovered });
  }
  return action.type === "split-occurrence"
    ? updateAuthoritiesDraft(changed, { type: "split-occurrence", occurrenceId: action.occurrenceId,
      replacements: [replacements[0].occurrence, replacements[1].occurrence] })
    : updateAuthoritiesDraft(changed, { type: "merge-occurrences", occurrenceIds: ids,
      replacement: replacements[0].occurrence });
}

export function applyAuthoritiesUserAction(
  draft: AuthoritiesDraft,
  action: AuthoritiesUserAction,
  sources: CitationServices = authorityCitationServices,
) {
  if (action.type === "add-authority") {
    const citation = action.citation.trim();
    const base = lookupKey(sources, citation) || `manual:${sha256(
      `${action.kind}\0${citation}`).slice(0, 24)}`;
    let key = base;
    for (let suffix = 2; draft.authorities[key]; suffix += 1) key = `${base}:${suffix}`;
    return updateAuthoritiesDraft(draft, { type: action.type, authority: { id: key, key,
      kind: action.kind, citation, name: action.name?.trim() || null,
      displayName: null, excluded: false, evidenceIds: [], locators: [],
      sourceIdentity: null, source: { kind: "unresolved" }, userAdded: true } });
  }
  if (action.type === "begin-canlii-handoff") {
    const authority = draft.authorities[action.authorityId];
    const pageUrl = authority && buildCanliiCaseUrlFromCitation(
      authorityCitationForms(draft, authority.id));
    if (!authority || !pageUrl) throw new ApplicationError(409,
      "A canonical CanLII link is not available for this authority");
    return updateAuthoritiesDraft(draft, { ...action, pageUrl });
  }
  if (action.type === "set-authority-span" || action.type === "set-pinpoint-span") {
    return correctOccurrenceSpan(draft, action, sources);
  }
  if (action.type === "remove-occurrence") {
    const occurrence = draft.occurrences[action.occurrenceId];
    if (!occurrence) throw new ApplicationError(400, "Citation review item not found");
    return removeUnusedDetections(updateAuthoritiesDraft(draft, action), [occurrence], null);
  }
  return action.type === "split-occurrence" || action.type === "merge-occurrence"
    ? editOccurrences(draft, action, sources) : updateAuthoritiesDraft(draft, action);
}
