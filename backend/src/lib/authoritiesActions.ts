import { randomUUID } from "node:crypto";
import { ApplicationError } from "./applicationError";
import { AuthoritiesDomainError, attachedAuthoritySources, authorityCitationForms, reduceAuthoritiesDraft, authoritiesDraftEditor,
  authoritiesProfile, unusedScanOnlyAuthority, type AuthoritiesAction, type AuthoritiesBuildSettings,
  type AuthoritiesDraft, type AuthoritiesFreshReview, type AuthorityIdentity,
  type AuthorityKind, type AuthorityOccurrence, type AuthoritySourceLanguage,
  type AuthoritiesOutputMode, type AuthoritiesProfileId } from "./authoritiesDomain";
import { nativeOccurrenceSpans, nativeReferenceSpans, pinpointValues } from "./authoritiesImport";
import { buildCanliiCaseUrlFromCitation } from "./canliiUrls";
import { authorityPdfText } from "./authorityPdfText";
import { citationAliasKeysBatch } from "./caselawCitator";
import { sha256 } from "./hash";
import { structureNative, type NativeCitationOccurrence } from "./structureNative";
import type { WorkProductInput } from "./workProduct";
import { authorityPdfRequired, type AuthoritiesBookSlot } from "mike/shared/authorities-sources.mjs";
import { matchFolderPdf } from "mike/shared/folder-pdf-match.mjs";

/** A PDF's name and its first pages' native text, line by line, as the page read it. */
export type PdfOpening = { filename: string; pages: string[] };

export const authorityCitationServices = {
  key: (value: string) => structureNative().citationLookupKey(value),
  occurrences: (value: string) => structureNative().citationOccurrencesInText(value),
  references: (value: string) => structureNative().authorityReferencesInText(value),
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

const asRequestError = <T>(operation: () => T) => {
  try { return operation(); }
  catch (error) {
    if (error instanceof AuthoritiesDomainError) throw new ApplicationError(400, error.message);
    throw error;
  }
};

export function updateAuthoritiesDraft(draft: AuthoritiesDraft, action: AuthoritiesAction) {
  return asRequestError(() => reduceAuthoritiesDraft(draft, action));
}

/** Many actions on one working copy, validated once; a rejection is a 400 as for one action. */
export function editAuthoritiesDraft(draft: AuthoritiesDraft) {
  const editor = asRequestError(() => authoritiesDraftEditor(draft));
  return { draft: editor.draft, apply: (action: AuthoritiesAction) => asRequestError(() => editor.apply(action)),
    result: () => asRequestError(() => editor.result()) };
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
      ?? unusedRole(draft, `authority:${sha256(authority.key).slice(0, 24)}:${language}`),
    binding, filename, sourceSha256, sourceUrl, language, origin });
}

/** A merged-away authority keeps its role inside the survivor, so the same key can recur. */
function unusedRole(draft: AuthoritiesDraft, role: string) {
  let candidate = role;
  for (let index = 2; Object.hasOwn(draft.bindings, candidate); index += 1) candidate = `${role}:${index}`;
  return candidate;
}

/** The style of cause a decision prints before its own citation, as a CanLII PDF opens:
 *  "Citation: Pell v Marlow Holdings, 2030 ABKB 12" gives "Pell v Marlow Holdings". `keys` name
 *  the decision. A caption that is not a plain "Name, citation" (a label such as "Neutral
 *  citation:" or a heading's bracket read into the name) names nothing. */
function captionStyleOfCause(text: string, keys: readonly string[]) {
  const native = structureNative();
  const balanced = (style: string, open: string, close: string) =>
    style.split(open).length === style.split(close).length;
  const own = native.citationOccurrencesInText(text).find(({ kind, styledCitation, coreCitation }) =>
    kind === "case" && styledCitation.start < coreCitation.start &&
    keys.includes(native.citationLookupKey(coreCitation.text)));
  const style = own && text.slice(own.styledCitation.start, own.coreCitation.start).replace(/[\s,]+$/u, "");
  return style && !style.endsWith(":") && balanced(style, "(", ")") && balanced(style, "[", "]") ? style : null;
}

/** The case still without a PDF that a PDF found in the watched folder is, when exactly one: by
 *  the citation its opening (`pages`, its first pages' native text) prints, else by exact agreement
 *  with A2AJ's text of the decision (`reference`); a scan by its file name alone. */
export async function folderPdfAuthority(draft: AuthoritiesDraft, { filename, pages }: PdfOpening,
  reference: (authority: AuthorityIdentity) => Promise<string>) {
  const requirements = authoritiesProfile(draft.settings.profileId).requirements;
  const records = Object.values(draft.authorities).filter((authority) => authority.kind === "case" &&
    !authority.excluded && authority.source.kind !== "attached" && authorityPdfRequired(draft, authority, requirements))
    .map((authority) => ({ authority, citation: authority.citation, aliases: authorityCitationForms(draft, authority.id) }));
  if (!records.length) return null;
  const native = structureNative(), opening = pages.map((page) => ({ lines: page.split("\n").map((text) => ({ text })) }));
  const match = await matchFolderPdf(filename, opening, records, (method, request) =>
    native.citationEngineCall(method, JSON.stringify(request)), ({ authority }) => reference(authority));
  return match?.record.authority.id ?? null;
}

/** A PDF auto-fetch found for an authority only fills one still without a PDF, and an authority
 *  with no style of cause takes the one the PDF's first page prints before its own citation. A
 *  PDF the user uploads is never checked. Returns the draft, named when it was nameless. */
export async function autoFetchedPdf(draft: AuthoritiesDraft, authorityId: string, bytes: Buffer) {
  const authority = draft.authorities[authorityId];
  if (authority?.source.kind === "attached")
    throw new ApplicationError(400, `${authority.citation} already has a PDF; it was not replaced.`);
  if (!authority || authority.name || authority.displayName) return draft;
  const text = (await authorityPdfText({ bytes, maxPages: 1 })).pageTextByPage[0] ?? "";
  const name = captionStyleOfCause(text, citationAliasKeysBatch(authorityCitationForms(draft, authorityId)).flat());
  return name ? updateAuthoritiesDraft(draft, { type: "rename-authority", authorityId, displayName: name }) : draft;
}

export function attachAuthoritiesBookPdf(draft: AuthoritiesDraft, input: {
  slot: AuthoritiesBookSlot; supplementId?: string;
}, binding: WorkProductInput, filename: string,
sourceSha256: string) {
  if (input.supplementId && input.slot !== "supplemental") {
    throw new ApplicationError(400, "Only another book PDF can have a supplemental ID");
  }
  if (input.slot === "brief" && (draft.import.kind !== "document" || draft.import.fileType !== "docx")) {
    throw new ApplicationError(400, "Only a Word brief takes a separate brief PDF");
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
  ? "legislation" : kind === "journal" || kind === "book" ? "commentary"
  : kind === "parliamentary" ? "other" : kind;
const lookupKey = (sources: CitationServices, text: string) => {
  try { return sources.key(text).trim(); } catch { return ""; }
};
/**
 * An authority is keyed by its core citation, as the scan keys it: "R. v. Grant,
 * 2009 SCC 32" and "2009 SCC 32" are one authority, not two. Any citation text a
 * user or the assistant supplies goes through the same core extraction the
 * detector uses, so manual and detected identities cannot drift apart.
 */
const citationKey = (sources: CitationServices, citation: string) => {
  const matches = sources.occurrences(citation);
  return lookupKey(sources, matches.length === 1 ? matches[0].coreCitation.text : citation);
};
/** The authority a citation key already names, whatever citation form listed it. */
const knownAuthority = (draft: AuthoritiesDraft, key: string, sources: CitationServices) => {
  if (!key) return null;
  const authorities = Object.values(draft.authorities);
  return authorities.find((item) => item.key === key) ??
    authorities.find((item) => citationKey(sources, item.citation) === key) ?? null;
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
  const authority = knownAuthority(draft, key, sources);
  const donorIds = donors.map(({ authorityId }) => authorityId);
  const parsed = sources.references(text);
  const selectedReference = !matches.length && parsed.length === 1 ? parsed[0] : null;
  const donorReferences = donors.map(({ reference }) => reference);
  const reference = selectedReference && sameValue(donorReferences) && donorReferences[0] &&
    donors.every((donor) => {
      const prior = sources.references(donor.text);
      return donor.authorityId === donor.reference?.targetAuthorityId && prior.length === 1 &&
        donor.start + prior[0].token.start === start + selectedReference.token.start &&
        prior[0].kind === selectedReference.kind && prior[0].token.text === selectedReference.token.text &&
        prior[0].noteNumber === selectedReference.noteNumber;
    }) ? structuredClone(donorReferences[0]) : null;
  // A supra, ibid or short form keeps only the target its donors resolved for it: split out of
  // another citation, it does not inherit that citation's authority.
  const authorityId = match ? authority?.id ?? (sameValue(donorIds) &&
      donors.every(({ citation }) => citation === match.coreCitation.text) ? donorIds[0] : null)
    : selectedReference || donors.some(({ kind }) => kind === "reference") ? reference?.targetAuthorityId ?? null
    : sameValue(donorIds) ? donorIds[0] : null;
  const occurrence: AuthorityOccurrence = {
    id: `${unit.id}:manual:${start}:${end}`, unitId: unit.id, start, end, text,
    ...(match ? nativeOccurrenceSpans(match, unit.text, start) : selectedReference
      ? nativeReferenceSpans(selectedReference, unit.text, start) : {
      authoritySpan: { start, end, text }, coreSpan: { start, end, text },
      pinpointSpan: null,
    }),
    kind: selectedReference ? "reference" : match ? parsedKind(match)
      : sameValue(donors.map(({ kind }) => kind)) ? donors[0].kind : "other",
    citation: match?.coreCitation.text ?? selectedReference?.token.text ??
      (sameValue(donors.map(({ citation }) => citation)) ? donors[0].citation : text.trim()),
    authorityId, reference, referenceKind: selectedReference?.kind,
    pinpoints: pinpointValues(match?.pinpoints ?? selectedReference?.pinpoints ?? [], start),
    evidenceIds: [...new Set(donors.flatMap(({ evidenceIds }) => evidenceIds))].sort(),
    // A unit's own text hash, except where donors carry the hash the import recorded.
    sourceTextSha256: donors[0]?.sourceTextSha256 ?? unit.occurrenceIds
      .map((id) => draft.occurrences[id]?.sourceTextSha256).find(Boolean) ?? sha256(unit.text),
    localOrdinal: start, reviewed: true,
  };
  const discovered = match && key && !authority ? parsedAuthority(match, key) : null;
  if (discovered) occurrence.authorityId = discovered.id;
  return { occurrence, discovered };
}

function trimmedRange(unit: AuthoritiesDraft["units"][number], start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start || end > unit.text.length) {
    throw new ApplicationError(400, "Select text inside this citation unit");
  }
  while (start < end && /\s/u.test(unit.text[start])) start += 1;
  while (end > start && /\s/u.test(unit.text[end - 1])) end -= 1;
  if (start === end) throw new ApplicationError(400, "Select citation text");
  return { start, end, text: unit.text.slice(start, end) };
}

function selectedRange(draft: AuthoritiesDraft, occurrenceId: string, start: number, end: number) {
  const occurrence = draft.occurrences[occurrenceId];
  const unit = occurrence && draft.units.find(({ id }) => id === occurrence.unitId);
  if (!occurrence || !unit) throw new ApplicationError(400, "Select text inside this citation unit");
  return { occurrence, unit, ...trimmedRange(unit, start, end) };
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
  if (action.type === "set-pinpoint-span") {
    // The pinpoints written in the selection replace the citation's; its range stays as it is.
    // Those the citation's own grammar reads after it come first, then any the words around give.
    if (intersects(selected.start, selected.end, occurrence.authoritySpan))
      throw new ApplicationError(400, "Select the pinpoint without the authority");
    const from = Math.min(occurrence.authoritySpan.start, selected.start);
    const stretch = selected.unit.text.slice(from, Math.max(occurrence.authoritySpan.end, selected.end));
    const match = sources.occurrences(stretch).find((item) => lookupKey(sources, item.coreCitation.text) ===
      draft.authorities[occurrence.authorityId ?? ""]?.key);
    const chosen = (item: { start: number; end: number }) => from + item.end > selected.start && from + item.start < selected.end;
    const owner = (match ? [match] : occurrence.kind === "reference" ? sources.references(stretch) : [])
      .find((item) => item.pinpoints.some(chosen));
    const pinpoints = owner ? pinpointValues(owner.pinpoints.filter(chosen), from)
      : pinpointsAt(selected.unit.text, selected.start, selected.end, sources, true);
    if (!pinpoints.length) throw new ApplicationError(400, "Select a complete pinpoint for this authority");
    return placePinpoints(draft, occurrence, selected.unit, pinpoints);
  }
  if (!intersects(selected.start, selected.end, occurrence)) {
    throw new ApplicationError(400, "Select the citation being corrected");
  }
  const { donors, absorbedIds } = correctionDonors(draft, selected);
  const evidenceIds = [...new Set(donors.flatMap((item) => item.evidenceIds))].sort();
  if (occurrence.pinpointSpan && intersects(selected.start, selected.end,
    occurrence.pinpointSpan)) throw new ApplicationError(400,
    "Select the authority without its pinpoint");
  const previousPinpoint = occurrence.pinpointSpan ? { span: occurrence.pinpointSpan,
    values: occurrence.pinpoints, phrase: occurrence.pinpointPhrase } : null;
  const match = chosenAuthorityMatch(sources.occurrences(selected.text), occurrence,
    draft, sources);
  const key = match ? lookupKey(sources, match.coreCitation.text) : "";
  let changed = draft;
  // The span the occurrence extends from: the selection itself for a parsed match,
  // but manualOccurrence's whitespace-trimmed bounds on the manual path.
  let basis = { start: selected.start, end: selected.end };
  if (match && key) {
    const known = knownAuthority(draft, key, sources);
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
  // The pinpoints stay the citation's wherever they lie; the range is the authority alone.
  occurrence.pinpointSpan = previousPinpoint?.span ?? null;
  occurrence.pinpoints = previousPinpoint?.values ?? [];
  if (previousPinpoint?.phrase) occurrence.pinpointPhrase = previousPinpoint.phrase;
  else delete occurrence.pinpointPhrase;
  Object.assign(occurrence, basis, { text: selected.unit.text.slice(basis.start, basis.end) });
  changed = updateAuthoritiesDraft(changed, { type: "replace-occurrences",
    occurrenceIds: [occurrence.id, ...absorbedIds], replacements: [occurrence] });
  return removeUnusedDetections(changed, donors, occurrence.authorityId);
}

const placed = (item: AuthorityOccurrence["pinpoints"][number]): item is Pinpoint =>
  item.start !== undefined && item.end !== undefined;
type Pinpoint = AuthorityOccurrence["pinpoints"][number] & { start: number; end: number };
/** The pinpoints written in [start, end) of a unit's text, each with its kind and place. The engine
 *  reads them as it reads an ibid's: the locator words before them ("at para", "s", "pp"), up to
 *  three words back, give their kind. Unless `strict`, a value with no such words is a page. */
function pinpointsAt(text: string, start: number, end: number, sources: CitationServices, strict = false): Pinpoint[] {
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  if (start >= end) return [];
  for (let from = start, words = 0; words <= 3; words += 1) {
    for (const lead of ["Ibid ", "Ibid, "]) {
      const found = sources.references(lead + text.slice(from, end)).flatMap(({ pinpoints }) => pinpoints)
        .filter((pin) => from + pin.end - lead.length > start);
      if (found.length) return pinpointValues(found, from - lead.length);
    }
    if (from === 0) break;
    from = text.lastIndexOf(" ", from - 2) + 1;
  }
  return strict ? [] : [{ kind: "page", text: text.slice(start, end).replace(/\s*[-–—]\s*/gu, "-"), start, end }];
}

/** The citation's pinpoints as given, its range untouched: they may lie anywhere in its unit. */
function placePinpoints(draft: AuthoritiesDraft, current: AuthorityOccurrence,
  unit: AuthoritiesDraft["units"][number], pinpoints: Pinpoint[]) {
  const ordered = [...pinpoints].sort((left, right) => left.start - right.start);
  if (ordered.some((pin, index) => index && pin.start < ordered[index - 1].end))
    throw new ApplicationError(400, "Pinpoints cannot overlap");
  if (ordered.some((pin) => intersects(pin.start, pin.end, current.authoritySpan)))
    throw new ApplicationError(400, "Select the pinpoint without the authority");
  const span = ordered.length ? { start: ordered[0].start, end: ordered.at(-1)!.end } : null;
  const { pinpointPhrase, ...rest } = structuredClone(current);
  const occurrence: AuthorityOccurrence = { ...rest, pinpoints: ordered, pinpointManual: true, reviewed: true,
    pinpointSpan: span && { ...span, text: unit.text.slice(span.start, span.end) },
    // The phrase as written stays while it still holds every pinpoint ("at paras 82, 91").
    ...(span && pinpointPhrase && pinpointPhrase.start <= span.start && pinpointPhrase.end >= span.end && { pinpointPhrase }) };
  return updateAuthoritiesDraft(draft, { type: "replace-occurrences", occurrenceIds: [current.id],
    replacements: [occurrence] });
}

/** The reviewer's pinpoints, at most three, each a place in the citation's unit: one already the
 *  citation's keeps its value, and a new one takes the value and kind written there. A kind given
 *  replaces the one found. */
function setPinpoints(draft: AuthoritiesDraft, action: Extract<AuthoritiesUserAction, { type: "set-pinpoints" }>,
  sources: CitationServices) {
  const current = draft.occurrences[action.occurrenceId];
  const unit = current && draft.units.find(({ id }) => id === current.unitId);
  if (!current || !unit) throw new ApplicationError(400, "Citation review item not found");
  const pinpoints = action.pinpoints.flatMap(({ start, end, kind }) => {
    if (start < 0 || end > unit.text.length || end <= start)
      throw new ApplicationError(400, "Select the pinpoint in this citation's paragraph or footnote");
    const known = current.pinpoints.filter(placed).find((pin) => pin.start === start && pin.end === end);
    const found = known ? [known] : pinpointsAt(unit.text, start, end, sources);
    return found.map((pin) => ({ ...pin, ...(kind && { kind }) }));
  });
  if (pinpoints.length > Math.max(3, current.pinpoints.length))
    throw new ApplicationError(400, "A citation takes at most three pinpoints");
  return placePinpoints(draft, current, unit, pinpoints);
}

/** A whole citation selection owns its range; partially overlapped neighbours keep
 * their outside text. All replacements are validated before the host saves once. Pinpoints are
 * the citation's wherever they lie: the new range's own replace those found before, and pinpoints
 * set by hand stay. */
function setCitationRange(draft: AuthoritiesDraft,
  action: Extract<AuthoritiesUserAction, { type: "set-citation-range" }>, sources: CitationServices) {
  const selected = selectedRange(draft, action.occurrenceId, action.start, action.end);
  if (!intersects(selected.start, selected.end, selected.occurrence))
    throw new ApplicationError(400, "Select the citation being corrected");
  const donors = selected.unit.occurrenceIds.map(id => draft.occurrences[id])
    .filter(item => item.id === action.occurrenceId || intersects(selected.start, selected.end, item));
  const replacement = manualOccurrence(draft, selected.unit, selected.start, selected.end, donors, sources);
  const { pinpointSpan, pinpointPhrase, pinpoints, pinpointManual } = selected.occurrence, next = replacement.occurrence;
  next.id = selected.occurrence.id;
  if ((pinpointManual || !next.pinpoints.length) && ![pinpointSpan, ...pinpoints.filter(placed)]
    .some((span) => span && intersects(span.start, span.end, next.authoritySpan))) {
    Object.assign(next, { pinpoints: structuredClone(pinpoints), pinpointSpan }, pinpointManual && { pinpointManual });
    if (pinpointPhrase) next.pinpointPhrase = pinpointPhrase; else delete next.pinpointPhrase;
  }
  const replacements = [replacement];
  for (const donor of donors) {
    if (donor.id === action.occurrenceId) continue;
    for (const [start, end] of [[donor.start, selected.start], [selected.end, donor.end]]) {
      if (start < end && selected.unit.text.slice(start, end).trim())
        replacements.push(manualOccurrence(draft, selected.unit, start, end, [donor], sources));
    }
  }
  let changed = draft;
  for (const { discovered } of replacements) {
    if (discovered && !changed.authorities[discovered.id]) changed = updateAuthoritiesDraft(changed,
      { type: "add-authority", authority: discovered });
  }
  changed = updateAuthoritiesDraft(changed, { type: "replace-occurrences",
    occurrenceIds: donors.map(({ id }) => id), replacements: replacements.map(({ occurrence }) => occurrence) });
  return removeUnusedDetections(changed, donors, replacement.occurrence.authorityId);
}

/** The counterpart of set-pinpoint-span: a pinpoint that belongs to another citation. The
 *  citation keeps its range. */
function clearPinpoint(draft: AuthoritiesDraft, occurrenceId: string) {
  const current = draft.occurrences[occurrenceId];
  const unit = current && draft.units.find(({ id }) => id === current.unitId);
  if (!current || !unit) throw new ApplicationError(400, "Citation review item not found");
  if (!current.pinpointSpan && !current.pinpoints.length) throw new ApplicationError(400, "This citation has no pinpoint");
  return placePinpoints(draft, current, unit, []);
}

/** "Use selection as citation" for a citation no detector found: a unit's free text. */
function addOccurrence(draft: AuthoritiesDraft,
  action: Extract<AuthoritiesUserAction, { type: "add-occurrence" }>, sources: CitationServices) {
  const unit = draft.units.find(({ id }) => id === action.unitId);
  if (!unit) throw new ApplicationError(400, "Select text inside this citation unit");
  const range = trimmedRange(unit, action.start, action.end);
  const { occurrence, discovered } = manualOccurrence(draft, unit, range.start, range.end,
    [], sources);
  if (!occurrence.pinpoints.length) Object.assign(occurrence, followingPinpoints(draft, unit, occurrence, sources));
  const changed = discovered && !draft.authorities[discovered.id]
    ? updateAuthoritiesDraft(draft, { type: "add-authority", authority: discovered }) : draft;
  return updateAuthoritiesDraft(changed, { type: "add-occurrence", occurrence });
}

/** The pinpoints a citation selected without them goes on to write ("R v Jordan, 2016 SCC 27"
 *  selected, then "at para 105"): the engine reads on to the next citation in the unit, and the
 *  pinpoints it finds there are the citation's, outside its range. */
function followingPinpoints(draft: AuthoritiesDraft, unit: AuthoritiesDraft["units"][number],
  occurrence: AuthorityOccurrence, sources: CitationServices) {
  const next = Math.min(unit.text.length, ...unit.occurrenceIds.map((id) => draft.occurrences[id]?.start ?? Infinity)
    .filter((start) => start >= occurrence.end));
  const stretch = unit.text.slice(occurrence.start, next), selected = occurrence.end - occurrence.start;
  const owner = [...sources.occurrences(stretch), ...sources.references(stretch)]
    .filter((item) => item.start < selected && item.pinpoints.length && item.pinpoints.every((pin) => pin.start >= selected))
    .sort((left, right) => left.start - right.start)[0];
  if (!owner) return {};
  const pinpoints = pinpointValues(owner.pinpoints, occurrence.start);
  const span = { start: pinpoints[0].start, end: pinpoints.at(-1)!.end };
  const phrase = owner.pinpointPhrase && { start: occurrence.start + owner.pinpointPhrase.start,
    end: occurrence.start + owner.pinpointPhrase.end };
  return { pinpoints, pinpointSpan: { ...span, text: unit.text.slice(span.start, span.end) },
    ...(phrase && { pinpointPhrase: { ...phrase, text: unit.text.slice(phrase.start, phrase.end) } }) };
}

/** The one citation, or failing that the one supra, ibid or short form, detected in a stretch of text. */
function detectedSpan(text: string, start: number, end: number, sources: CitationServices) {
  const stretch = text.slice(start, end), citations = sources.occurrences(stretch);
  const references = citations.length ? [] : sources.references(stretch);
  const [only] = citations.length === 1 ? citations : references.length === 1 ? references : [];
  return only && { start: start + only.start, end: start + only.end };
}

function editOccurrences(draft: AuthoritiesDraft,
  action: Extract<AuthoritiesUserAction,
    { type: "split-occurrence" | "merge-occurrence" }>, sources: CitationServices) {
  const occurrence = draft.occurrences[action.occurrenceId];
  // Body sentences hold several citations as often as footnotes do: same rules, either unit.
  const unit = occurrence && draft.units.find(({ id }) => id === occurrence.unitId);
  if (!occurrence || !unit) throw new ApplicationError(400, "Citation review item not found");
  let replacements: ReturnType<typeof manualOccurrence>[], ids: [string, string];
  if (action.type === "split-occurrence") {
    if (!Number.isSafeInteger(action.cursor) || action.cursor <= occurrence.start ||
        action.cursor >= occurrence.end) throw new ApplicationError(400,
      "Place the cursor inside this citation");
    // Each side meets the cut where the citation detected in it ends or starts, so the separator
    // and any signal between two citations belong to neither; the outer ends stay, so merging the
    // two sides gives back the citation that was split.
    const { cursor } = action, left = detectedSpan(unit.text, occurrence.start, cursor, sources);
    const right = detectedSpan(unit.text, cursor, occurrence.end, sources);
    replacements = [manualOccurrence(draft, unit, occurrence.start, left?.end ?? cursor,
      [occurrence], sources), manualOccurrence(draft, unit, right?.start ?? cursor, occurrence.end,
      [occurrence], sources)];
    ids = [occurrence.id, occurrence.id];
  } else {
    const position = unit.occurrenceIds.indexOf(occurrence.id);
    const previous = position > 0 ? draft.occurrences[unit.occurrenceIds[position - 1]] : null;
    if (!previous) throw new ApplicationError(400,
      "This is the first citation in the unit");
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
    const parsed = citationKey(sources, citation);
    // One authority per citation: a styled re-add of a citation already listed is
    // that authority, not a second, unresolved copy of it.
    if (knownAuthority(draft, parsed, sources)) return draft;
    const base = parsed || `manual:${sha256(
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
  if (action.type === "set-citation-range") return setCitationRange(draft, action, sources);
  if (action.type === "clear-pinpoint") return clearPinpoint(draft, action.occurrenceId);
  if (action.type === "set-pinpoints") return setPinpoints(draft, action, sources);
  if (action.type === "add-occurrence") return addOccurrence(draft, action, sources);
  if (action.type === "remove-occurrence") {
    const occurrence = draft.occurrences[action.occurrenceId];
    if (!occurrence) throw new ApplicationError(400, "Citation review item not found");
    return removeUnusedDetections(updateAuthoritiesDraft(draft, action), [occurrence], null);
  }
  return action.type === "split-occurrence" || action.type === "merge-occurrence"
    ? editOccurrences(draft, action, sources) : updateAuthoritiesDraft(draft, action);
}
