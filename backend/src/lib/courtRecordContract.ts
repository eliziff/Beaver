import values from "mike/shared/court-record-profiles.json";
import { decodeWorkProductBindings, type WorkProductState } from "./workProduct";

export type CourtRecordSlotContract = {
  id: string;
  label: string;
  requirement: "required" | "optional" | "conditional" | "forbidden";
  order: number;
  repeatable?: boolean;
  acceptedFormats?: Array<"pdf" | "docx">;
  generated?: string;
  descriptionOnly?: boolean;
  defaultDescription?: string;
  allowUnavailableNote?: boolean;
  separateFile?: boolean;
};
export type CourtRecordProfileContract = {
  id: string;
  label: string;
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

type ProfileSource = Omit<CourtRecordProfileContract, "partyStyles"> & {
  partyStyleIds?: string[];
};
const contract = values as { partyStyles: CourtRecordPartyStyleContract[];
  profiles: ProfileSource[] };
const styleById = new Map(contract.partyStyles.map((style) => [style.id, style]));
const requiredStyle = (id: string) => {
  const style = styleById.get(id);
  if (!style) throw new Error(`Missing Court Record party style ${id}`);
  return style;
};
export const COURT_RECORD_PROFILES: CourtRecordProfileContract[] = contract.profiles.map(
  ({ partyStyleIds, ...profile }) => ({ ...profile,
    ...(partyStyleIds && { partyStyles: partyStyleIds.map(requiredStyle) }) }),
);
export const COURT_RECORD_PROFILE_BY_ID = new Map(
  COURT_RECORD_PROFILES.map((profile) => [profile.id, profile]),
);
export function courtRecordProfileIsEffective(profile: CourtRecordProfileContract,
  date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton" }).format(new Date())) {
  return !profile.effectiveFrom || profile.effectiveFrom <= date;
}

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

function validCover(value: unknown, profile: CourtRecordProfileContract) {
  const cover = object(value);
  const partyFields = profile.partyStyles?.length
    ? ["partyStyleId", "partyGroups", "filingPartyId"] : [];
  if (!cover || Object.keys(cover).some((key) =>
    !profile.coverFields.includes(key) && !partyFields.includes(key))) {
    return false;
  }
  for (const [key, field] of Object.entries(cover)) {
    if (key !== "partyGroups" && !string(field)) return false;
  }
  const styles = profile.partyStyles;
  if (!styles?.length) return true;
  const styleId = String(cover.partyStyleId ?? "").trim();
  const style = styles.find(({ id }) => id === styleId) ?? (!styleId ? styles[0] : undefined);
  if (!style) return false;
  if (cover.partyGroups === undefined) return !String(cover.filingPartyId ?? "").trim();
  const definitions = new Map(style.groups.map((group) => [group.id, group]));
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
          const validParty = !!party && exactKeys(party, ["id", "name"]) &&
            id(party.id) && !partyIds.has(String(party.id)) &&
            !!partyIds.add(String(party.id)) && string(party.name, 5_000);
          if (validParty) partyGroupById.set(String(party!.id), String(group.id));
          return validParty;
        });
    });
  const filingPartyId = String(cover.filingPartyId ?? "").trim();
  return valid && (!filingPartyId || partyIds.has(filingPartyId) &&
    (!profile.filingGroupId || partyGroupById.get(filingPartyId) === profile.filingGroupId));
}

/** Decodes the durable, file-byte-free Court draft stored at the application boundary. */
export function decodeCourtRecordDraftState(value: unknown): WorkProductState | null {
  const state = object(value);
  if (!state || !exactKeys(state, ["profileId", "cover", "entries", "bindings"]) ||
      !id(state.profileId) || !Array.isArray(state.entries) ||
      state.entries.length > 500) return null;
  const profile = COURT_RECORD_PROFILE_BY_ID.get(String(state.profileId));
  const bindings = decodeWorkProductBindings(state.bindings);
  if (!profile || !validCover(state.cover, profile) || !bindings) return null;
  const entryIds = new Set<string>(), slotCounts = new Map<string, number>();
  for (const raw of state.entries) {
    const entry = object(raw), seen = object(entry?.lastSeen);
    const slot = profile.slots.find(({ id: slotId }) => slotId === entry?.kindId);
    if (!entry || !seen || !slot ||
        !exactKeys(entry, ["id", "kindId", "title", "lastSeen"],
          ["date", "exhibitLabel", "descriptionOnly"]) ||
        !exactKeys(seen, ["name", "size", "modified"], ["sha256"]) ||
        !id(entry.id) || entryIds.has(String(entry.id)) || !id(entry.kindId) ||
        !string(entry.title, 1_000) ||
        (entry.date !== undefined && !string(entry.date, 500)) ||
        (entry.exhibitLabel !== undefined && !string(entry.exhibitLabel, 500)) ||
        (entry.descriptionOnly !== undefined && typeof entry.descriptionOnly !== "boolean") ||
        !string(seen.name, 500) || !natural(seen.size) || !natural(seen.modified) ||
        (seen.sha256 !== undefined && !hash(seen.sha256)) ||
        Boolean(entry.descriptionOnly) !== Boolean(slot.descriptionOnly ||
          slot.allowUnavailableNote && entry.descriptionOnly) ||
        (!entry.descriptionOnly && !bindings[String(entry.id)]) ||
        (entry.descriptionOnly && bindings[String(entry.id)])) return null;
    entryIds.add(String(entry.id));
    const count = (slotCounts.get(slot.id) ?? 0) + 1;
    if (count > 1 && !slot.repeatable) return null;
    slotCounts.set(slot.id, count);
  }
  if (Object.keys(bindings).some((role) => !entryIds.has(role))) return null;
  return state as WorkProductState;
}
