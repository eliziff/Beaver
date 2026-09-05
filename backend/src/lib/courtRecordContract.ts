import values from "mike/shared/court-record-profiles.json";
import courtRegistry from "mike/shared/court-registry.json";
import { matchesWorkProductRole,
  type CourtRecordWorkProductOutput } from "mike/shared/court-record-work-products.mjs";
import { decodeWorkProductBindings, type WorkProductState } from "./workProduct";

export type CourtRecordSlotContract = {
  id: string;
  label: string;
  requirement: "required" | "optional" | "conditional" | "forbidden";
  order: number;
  repeatable?: boolean;
  group?: string;
  condition?: string;
  maximumPages?: number;
  rule70PageLimit?: "standard" | "combined-cross-appeal";
  acceptedFormats?: Array<"pdf" | "docx">;
  acceptedWorkProductOutputs?: CourtRecordWorkProductOutput[];
  generated?: string;
  descriptionOnly?: boolean;
  defaultDescription?: string;
  allowUnavailableNote?: boolean;
  separateFile?: boolean;
};
const UNASSIGNED_SLOT: CourtRecordSlotContract = {
  id: "unassigned", label: "Unassigned", requirement: "optional", order: 0, repeatable: true,
};
export type CourtRecordProfileContract = {
  id: string;
  label: string;
  selectable?: boolean;
  coverFields: string[];
  partyStyles?: CourtRecordPartyStyleContract[];
  filingGroupId?: string;
  effectiveFrom?: string;
  oneOf?: Array<{ slots: string[]; label: string }>;
  slots: CourtRecordSlotContract[];
};

export type CourtRecordPartyStyleContract = {
  id: string;
  label: string;
  groups: Array<{ id: string; role: string; roleBelow?: string; optional?: boolean }>;
};

type ProfileSource = Pick<CourtRecordProfileContract,
  "id" | "label" | "selectable" | "effectiveFrom" | "oneOf" | "slots"> & {
  courtId: string;
  cover: { fieldKeys: string[] };
  technical: string;
  partyStyleIds?: string[];
  filingGroupId?: string;
};
type Catalogue = {
  partyStyles: CourtRecordPartyStyleContract[];
  coverFieldDefinitions: Record<string, { id: string; partyStyleId?: string }>;
  technicalDefinitions: Record<string, unknown>;
  profiles: ProfileSource[];
};
const contract = values as unknown as Catalogue;
const styleById = new Map(contract.partyStyles.map((style) => [style.id, style]));
const courtIds = new Set(courtRegistry.courts.map(({ id }) => id));
if (styleById.size !== contract.partyStyles.length || contract.partyStyles.some((style) =>
  new Set(style.groups.map(({ id }) => id)).size !== style.groups.length)) {
  throw new Error("Duplicate Court Record party style or group id");
}
const requiredStyle = (id: string) => {
  const style = styleById.get(id);
  if (!style) throw new Error(`Missing Court Record party style ${id}`);
  return style;
};
const profileIds = new Set<string>();
export const COURT_RECORD_PROFILES: CourtRecordProfileContract[] = contract.profiles.map((source) => {
  if (profileIds.has(source.id)) throw new Error(`Duplicate Court Record profile ${source.id}`);
  profileIds.add(source.id);
  if (!courtIds.has(source.courtId)) throw new Error(`Missing Court Record court ${source.courtId}`);
  if (!Object.hasOwn(contract.technicalDefinitions, source.technical)) {
    throw new Error(`Missing Court Record technical definition ${source.technical}`);
  }
  const partyStyles = source.partyStyleIds?.map(requiredStyle);
  const coverFields = source.cover.fieldKeys.map((key) => {
    const field = contract.coverFieldDefinitions[key];
    if (!field) throw new Error(`Missing Court Record cover field ${key}`);
    if (field.partyStyleId && !partyStyles?.some(({ id }) => id === field.partyStyleId)) {
      throw new Error(`Invalid Court Record conditional field for ${source.id}`);
    }
    return field.id;
  });
  const slotIds = new Set(source.slots.map(({ id }) => id));
  if (slotIds.size !== source.slots.length || source.oneOf?.some((choice) =>
    choice.slots.some((id) => !slotIds.has(id)))) {
    throw new Error(`Invalid Court Record slots for ${source.id}`);
  }
  if (source.filingGroupId && (!partyStyles?.length || partyStyles.some((style) =>
    !style.groups.some(({ id }) => id === source.filingGroupId)))) {
    throw new Error(`Invalid Court Record filing group for ${source.id}`);
  }
  return {
    id: source.id,
    label: source.label,
    ...(source.selectable !== undefined && { selectable: source.selectable }),
    coverFields,
    ...(partyStyles && { partyStyles }),
    ...(source.filingGroupId && { filingGroupId: source.filingGroupId }),
    ...(source.effectiveFrom && { effectiveFrom: source.effectiveFrom }),
    ...(source.oneOf && { oneOf: source.oneOf }),
    slots: source.slots,
  };
});
export const COURT_RECORD_PROFILE_BY_ID = new Map(
  COURT_RECORD_PROFILES.map((profile) => [profile.id, profile]),
);
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const string = (value: unknown, max = 5_000) =>
  typeof value === "string" && value.length <= max;
const id = (value: unknown) => string(value, 200) && value !== "";
const natural = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
export const COURT_RECORD_PARTY_CONTACT_FIELDS =
  ["name", "address", "phone", "fax", "email"] as const;
export type CourtRecordPartyContact = Partial<Record<
  typeof COURT_RECORD_PARTY_CONTACT_FIELDS[number], string>>;
export function decodeCourtRecordPartyContact(value: unknown): CourtRecordPartyContact | null {
  const contact = object(value);
  return contact && exactKeys(contact, [], [...COURT_RECORD_PARTY_CONTACT_FIELDS]) &&
    Object.values(contact).every((field) => string(field))
    ? contact as CourtRecordPartyContact : null;
}
const sourceCoverFields = new Set(Object.values(contract.coverFieldDefinitions).map(({ id }) => id));

function validSourceFields(value: unknown) {
  const source = object(value), cover = object(source?.cover), groups = source?.partyGroups,
    labels = source?.exhibitLabels, mentions = source?.exhibitMentions,
    mentionMap = object(mentions);
  return !!source && !!cover && exactKeys(source, ["cover", "exhibitLabels"],
    ["partyStyleId", "partyGroups", "exhibitMentions", "explicitExhibitLabel", "entryTitle", "entryDate"]) &&
    Object.entries(cover).every(([key, value]) => sourceCoverFields.has(key) && string(value)) &&
    Array.isArray(labels) && labels.length <= 702 && labels.every((label) => string(label, 20)) &&
    (source.partyStyleId === undefined || id(source.partyStyleId)) &&
    (groups === undefined || Array.isArray(groups) && groups.length <= 50 && groups.every((raw) => {
      const group = object(raw);
      return !!group && exactKeys(group, ["role", "parties"], ["roleBelow"]) &&
        string(group.role, 500) && (group.roleBelow === undefined || string(group.roleBelow, 500)) &&
        Array.isArray(group.parties) && group.parties.length <= 100 &&
        group.parties.every((party) => string(party));
    })) && (mentions === undefined || !!mentionMap && Object.entries(mentionMap).every(
      ([label, passages]) => /^[A-Z]+$/u.test(label) && Array.isArray(passages) &&
        passages.length <= 1_000 && passages.every((passage) => string(passage)))) &&
    ["explicitExhibitLabel", "entryTitle", "entryDate"].every((key) =>
      source[key] === undefined || string(source[key]));
}

function validCover(value: unknown, profile: CourtRecordProfileContract) {
  const cover = object(value);
  const partyFields = profile.partyStyles?.length
    ? ["partyStyleId", "partyGroups", "filingPartyIds"] : [];
  if (!cover || Object.keys(cover).some((key) =>
    !profile.coverFields.includes(key) && !partyFields.includes(key))) {
    return false;
  }
  for (const [key, field] of Object.entries(cover)) {
    if (key !== "partyGroups" && key !== "filingPartyIds" && !string(field)) return false;
  }
  const styles = profile.partyStyles;
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
      const group = object(raw);
      const definition = group && definitions.get(String(group.id));
      return !!group && exactKeys(group, ["id", "role", "parties"], ["roleBelow"]) &&
        !!definition && group.role === definition.role &&
        group.roleBelow === definition.roleBelow &&
        id(group.id) && !groupIds.has(String(group.id)) && !!groupIds.add(String(group.id)) &&
        string(group.role, 500) &&
        (group.roleBelow === undefined || string(group.roleBelow, 500)) &&
        Array.isArray(group.parties) && group.parties.length <= 100 &&
        group.parties.every((rawParty) => {
          const party = object(rawParty);
          const validParty = !!party && exactKeys(party, ["id", "name"], ["contact"]) &&
            id(party.id) && !partyIds.has(String(party.id)) &&
            !!partyIds.add(String(party.id)) && string(party.name, 5_000) &&
            (party.contact === undefined || !!decodeCourtRecordPartyContact(party.contact));
          if (validParty) partyGroupById.set(String(party!.id), String(group.id));
          return validParty;
        });
    });
  const filingPartyIds = cover.filingPartyIds;
  return valid && (filingPartyIds === undefined || Array.isArray(filingPartyIds) &&
    filingPartyIds.length <= 100 && new Set(filingPartyIds).size === filingPartyIds.length &&
    filingPartyIds.every((partyId) => id(partyId) && partyIds.has(partyId) &&
      (!profile.filingGroupId || partyGroupById.get(partyId) === profile.filingGroupId)));
}

/** Decodes the durable, file-byte-free Court draft stored at the application boundary. */
export function decodeCourtRecordDraftState(value: unknown): WorkProductState | null {
  const state = object(value);
  if (!state || !exactKeys(state, ["profileId", "cover", "entries", "bindings"]) ||
      !id(state.profileId) || !Array.isArray(state.entries) ||
      state.entries.length > 500) return null;
  const profile = COURT_RECORD_PROFILE_BY_ID.get(String(state.profileId));
  const bindings = decodeWorkProductBindings(state.bindings);
  if (!bindings || !profile || !validCover(state.cover, profile)) return null;
  const entryIds = new Set<string>(), slotCounts = new Map<string, number>();
  const assignedLabels = new Set<string>();
  let sourceLabels: string[] | undefined;
  for (const raw of state.entries) {
    const entry = object(raw), seen = object(entry?.lastSeen);
    const isUnassigned = entry?.kindId === "unassigned";
    const slot = isUnassigned ? UNASSIGNED_SLOT
      : profile?.slots.find(({ id: slotId }) => slotId === entry?.kindId);
    if (!entry || !seen || !slot ||
        !exactKeys(entry, ["id", "kindId", "title", "lastSeen"],
          ["date", "rule70CountedPages", "exhibitLabel", "sourceExhibits", "sourceFields",
            "descriptionOnly"]) ||
        !exactKeys(seen, ["name", "size", "modified"], ["sha256"]) ||
        !id(entry.id) || entryIds.has(String(entry.id)) || !id(entry.kindId) ||
        !string(entry.title, 1_000) ||
        (entry.date !== undefined && !string(entry.date, 500)) ||
        (entry.rule70CountedPages !== undefined && (!slot.rule70PageLimit ||
          !natural(entry.rule70CountedPages) || Number(entry.rule70CountedPages) < 1)) ||
        (entry.exhibitLabel !== undefined && !string(entry.exhibitLabel, 500)) ||
        (entry.descriptionOnly !== undefined && typeof entry.descriptionOnly !== "boolean") ||
        (entry.sourceFields !== undefined && !validSourceFields(entry.sourceFields)) ||
        !string(seen.name, 500) || !natural(seen.size) || !natural(seen.modified) ||
        (seen.sha256 !== undefined && !hash(seen.sha256)) ||
        Boolean(entry.descriptionOnly) !== Boolean(slot.descriptionOnly ||
          slot.allowUnavailableNote && entry.descriptionOnly) ||
        (!entry.descriptionOnly && !bindings[String(entry.id)]) ||
        (entry.descriptionOnly && bindings[String(entry.id)])) return null;
    const binding = bindings[String(entry.id)];
    if (isUnassigned && binding?.kind === "work-product-output") return null;
    if (binding?.kind === "work-product-output" &&
        !slot.acceptedWorkProductOutputs?.some(({ role }) =>
          matchesWorkProductRole(binding.role, role))) return null;
    if (entry.sourceExhibits !== undefined) {
      const source = object(entry.sourceExhibits), labels = source?.labels;
      if (slot.id !== "affidavit" || sourceLabels || !source ||
          !exactKeys(source, ["sourceSha256", "labels"]) ||
          !hash(source.sourceSha256) || source.sourceSha256 !== seen.sha256 ||
          !Array.isArray(labels) || !labels.length || labels.length > 702 ||
          !labels.every((label, index) => label === exhibitName(index)) ||
          binding?.kind === "local-file" &&
            binding.lastSeen.sha256 !== source.sourceSha256 ||
          binding?.kind === "document" && binding.version !== "latest" &&
            binding.version.sha256 !== source.sourceSha256) return null;
      sourceLabels = labels as string[];
    }
    if (entry.exhibitLabel !== undefined) {
      const label = String(entry.exhibitLabel);
      if (slot.id !== "exhibit" || !/^[A-Z]+$/u.test(label) || assignedLabels.has(label)) {
        return null;
      }
      assignedLabels.add(label);
    }
    entryIds.add(String(entry.id));
    const count = (slotCounts.get(slot.id) ?? 0) + 1;
    if (count > 1 && !slot.repeatable) return null;
    slotCounts.set(slot.id, count);
  }
  if ([...assignedLabels].some((label) => !sourceLabels?.includes(label))) return null;
  if (Object.keys(bindings).some((role) => !entryIds.has(role))) return null;
  return state as WorkProductState;
}

function exhibitName(index: number) {
  let value = index + 1, label = "";
  while (value) { value -= 1; label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26); }
  return label;
}
