import { COURT_PROFILE_BY_ID, COURT_RECORD_COVER_FIELD_IDS,
  type DocumentKind, type CourtProfile } from "mike/shared/court-record-profiles.mjs";
import { MAX_EXHIBIT_LABELS, exhibitName } from "mike/shared/court-record-exhibits.mjs";
import { matchesWorkProductRole } from "mike/shared/court-record-work-products.mjs";
import type { CaseParty, CasePartyGroup, CourtRecordDraft, CourtRecordDraftEntry,
  CourtRecordPartyContact, SourceDocumentFields,
  SourceExhibits } from "mike/shared/court-record-contract.d.ts";
import type { FileSnapshot } from "mike/shared/work-products.mjs";
import { closed, jsonRecord, maybe, type Check, type FieldTable } from "./value";
import { decodeWorkProductBindings } from "./workProduct";

const UNASSIGNED_SLOT: DocumentKind = {
  id: "unassigned", label: "Unassigned", requirement: "optional", order: 0, repeatable: true,
};
const string = (max = 5_000): Check => (value) =>
  typeof value === "string" && value.length <= max;
const identifier: Check = (value) => string(200)(value) && value !== "";
const natural: Check = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
const hash: Check = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const flag: Check = (value) => typeof value === "boolean";
const list = (max: number, item: Check): Check => (value) =>
  Array.isArray(value) && value.length <= max && value.every(item);

const partyContactFields = { name: maybe(string()), address: maybe(string()),
  phone: maybe(string()), fax: maybe(string()), email: maybe(string()),
} satisfies FieldTable<CourtRecordPartyContact>;
export const COURT_RECORD_PARTY_CONTACT_FIELDS =
  Object.keys(partyContactFields) as Array<keyof CourtRecordPartyContact>;
const partyContact = closed<CourtRecordPartyContact>(partyContactFields);
export const decodeCourtRecordPartyContact = (value: unknown): CourtRecordPartyContact | null =>
  partyContact(value) ? value : null;

const party = closed<CaseParty>({ id: identifier, name: string(),
  contact: maybe(partyContact) });
const partyGroup = closed<CasePartyGroup>({ id: identifier, role: string(500),
  roleBelow: maybe(string(500)), parties: list(100, party) });

const coverFieldIds = new Set(COURT_RECORD_COVER_FIELD_IDS);
const sourceCover: Check = (value) => {
  const cover = jsonRecord(value);
  return !!cover && Object.entries(cover)
    .every(([key, field]) => coverFieldIds.has(key) && string()(field));
};
const exhibitMentions: Check = (value) => {
  const mentions = jsonRecord(value);
  return !!mentions && Object.entries(mentions).every(([label, passages]) =>
    /^[A-Z]+$/u.test(label) && list(1_000, string())(passages));
};
const sourceFields = closed<SourceDocumentFields>({
  cover: sourceCover, exhibitLabels: list(MAX_EXHIBIT_LABELS, string(20)),
  exhibitMentions: maybe(exhibitMentions), explicitExhibitLabel: maybe(string()),
  entryTitle: maybe(string()), entryDate: maybe(string()),
});
const sourceExhibits = closed<SourceExhibits>({ sourceSha256: hash,
  labels: (value) => Array.isArray(value) && value.length > 0 &&
    value.length <= MAX_EXHIBIT_LABELS &&
    value.every((label, index) => label === exhibitName(index)) });

const snapshot = closed<FileSnapshot>({ name: string(500), size: natural,
  modified: natural, sha256: maybe(hash) });
const entry = closed<CourtRecordDraftEntry>({
  id: identifier, kindId: identifier, title: string(1_000), lastSeen: snapshot,
  date: maybe(string(500)),
  rule70CountedPages: maybe((value) => natural(value) && Number(value) >= 1),
  exhibitLabel: maybe(string(500)), sourceExhibits: maybe(sourceExhibits),
  sourceFields: maybe(sourceFields), descriptionOnly: maybe(flag),
  ocrAttemptedPages: maybe(list(2_000, natural)), nonTextPagesConfirmed: maybe(flag),
});
const draftShape = closed<CourtRecordDraft>({
  profileId: identifier, cover: (value) => !!jsonRecord(value),
  entries: list(500, entry), bindings: (value) => !!decodeWorkProductBindings(value),
});

/** The cover keys one profile admits: its own fields, plus party structure when it has styles. */
export const profileCoverKeys = (profile: CourtProfile) => new Set<string>([
  ...profile.cover.fields.map(({ id }) => id),
  ...(profile.cover.partyStyles?.length ? ["partyStyleId", "partyGroups", "filingPartyIds"] : []),
]);

function validCover(value: unknown, profile: CourtProfile) {
  const cover = jsonRecord(value), allowed = profileCoverKeys(profile);
  if (!cover || Object.keys(cover).some((key) => !allowed.has(key))) return false;
  for (const [key, field] of Object.entries(cover)) {
    if (key !== "partyGroups" && key !== "filingPartyIds" && !string()(field)) return false;
  }
  const styles = profile.cover.partyStyles;
  if (!styles?.length) return true;
  const styleId = String(cover.partyStyleId ?? "").trim();
  const style = styles.find(({ id }) => id === styleId) ??
    (!styleId && styles.length === 1 ? styles[0] : undefined);
  if (styleId && !style) return false;
  const common = styles[0].groups.flatMap((group) => {
    const matches = styles.map((candidate) => candidate.groups.find(({ id }) => id === group.id));
    if (matches.some((item) => !item || item.role !== group.role)) return [];
    return [{ ...group, roleBelow: matches.every((item) => item?.roleBelow === group.roleBelow)
      ? group.roleBelow : undefined }];
  });
  if (cover.partyGroups === undefined) {
    return cover.filingPartyIds === undefined ||
      Array.isArray(cover.filingPartyIds) && !cover.filingPartyIds.length;
  }
  const definitions = new Map((style?.groups ?? common).map((group) => [group.id, group]));
  const groupIds = new Set<string>(), partyIds = new Set<string>();
  const partyGroupById = new Map<string, string>();
  const valid = Array.isArray(cover.partyGroups) && cover.partyGroups.length <= 50 &&
    cover.partyGroups.every((raw) => {
      if (!partyGroup(raw)) return false;
      const definition = definitions.get(raw.id);
      if (!definition || raw.role !== definition.role ||
          raw.roleBelow !== definition.roleBelow || groupIds.has(raw.id)) return false;
      groupIds.add(raw.id);
      return raw.parties.every(({ id }) => !partyIds.has(id) &&
        !!partyIds.add(id) && !!partyGroupById.set(id, raw.id));
    });
  const filingPartyIds = cover.filingPartyIds;
  return valid && (filingPartyIds === undefined || Array.isArray(filingPartyIds) &&
    filingPartyIds.length <= 100 && new Set(filingPartyIds).size === filingPartyIds.length &&
    filingPartyIds.every((partyId) => identifier(partyId) && partyIds.has(partyId) &&
      (!profile.cover.filingGroupId || partyGroupById.get(partyId) === profile.cover.filingGroupId)));
}

/** Decodes the durable, file-byte-free Court draft stored at the application boundary. */
export function decodeCourtRecordDraftState(value: unknown): CourtRecordDraft | null {
  if (!draftShape(value)) return null;
  const profile = COURT_PROFILE_BY_ID.get(value.profileId);
  if (!profile || !validCover(value.cover, profile)) return null;
  const { bindings, entries } = value;
  const entryIds = new Set<string>(), slotCounts = new Map<string, number>();
  const assignedLabels = new Set<string>();
  let sourceLabels: string[] | undefined;
  for (const item of entries) {
    const slot = item.kindId === UNASSIGNED_SLOT.id ? UNASSIGNED_SLOT
      : profile.documentKinds.find(({ id }) => id === item.kindId);
    const binding = bindings[item.id];
    if (!slot || entryIds.has(item.id) ||
        item.rule70CountedPages !== undefined && !slot.rule70PageLimit ||
        Boolean(item.descriptionOnly) !== Boolean(slot.descriptionOnly ||
          slot.allowUnavailableNote && item.descriptionOnly) ||
        Boolean(item.descriptionOnly) === Boolean(binding)) return null;
    if (binding?.kind === "work-product-output" && (slot === UNASSIGNED_SLOT ||
        !slot.acceptedWorkProductOutputs?.some(({ role }) =>
          matchesWorkProductRole(binding.role, role)))) return null;
    if (item.sourceExhibits) {
      const source = item.sourceExhibits;
      if (slot.id !== "affidavit" || sourceLabels ||
          source.sourceSha256 !== item.lastSeen.sha256 ||
          binding?.kind === "local-file" && binding.lastSeen.sha256 !== source.sourceSha256 ||
          binding?.kind === "document" && binding.version !== "latest" &&
            binding.version.sha256 !== source.sourceSha256) return null;
      sourceLabels = source.labels;
    }
    if (item.exhibitLabel !== undefined) {
      if (slot.id !== "exhibit" || !/^[A-Z]+$/u.test(item.exhibitLabel) ||
          assignedLabels.has(item.exhibitLabel)) return null;
      assignedLabels.add(item.exhibitLabel);
    }
    entryIds.add(item.id);
    const count = (slotCounts.get(slot.id) ?? 0) + 1;
    if (count > 1 && !slot.repeatable) return null;
    slotCounts.set(slot.id, count);
  }
  if ([...assignedLabels].some((label) => !sourceLabels?.includes(label))) return null;
  if (Object.keys(bindings).some((role) => !entryIds.has(role))) return null;
  return value;
}
