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
};
export type CourtRecordProfileContract = {
  id: string;
  label: string;
  coverFields: string[];
  slots: CourtRecordSlotContract[];
};

export const COURT_RECORD_PROFILES = values as CourtRecordProfileContract[];
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

const coverFields = new Set(COURT_RECORD_PROFILES.flatMap(({ coverFields: fields }) => fields));

function validCover(value: unknown) {
  const cover = object(value);
  if (!cover || Object.keys(cover).some((key) =>
    !coverFields.has(key) && !["partyStyleId", "partyGroups", "filingPartyId"].includes(key))) {
    return false;
  }
  for (const [key, field] of Object.entries(cover)) {
    if (key !== "partyGroups" && !string(field)) return false;
  }
  if (cover.partyGroups === undefined) return true;
  const groupIds = new Set<string>(), partyIds = new Set<string>();
  const valid = Array.isArray(cover.partyGroups) && cover.partyGroups.length <= 50 &&
    cover.partyGroups.every((raw) => {
      const group = object(raw);
      return !!group && exactKeys(group, ["id", "role", "parties"], ["roleBelow"]) &&
        id(group.id) && !groupIds.has(String(group.id)) && !!groupIds.add(String(group.id)) &&
        string(group.role, 500) &&
        (group.roleBelow === undefined || string(group.roleBelow, 500)) &&
        Array.isArray(group.parties) && group.parties.length <= 100 &&
        group.parties.every((rawParty) => {
          const party = object(rawParty);
          return !!party && exactKeys(party, ["id", "name"]) &&
            id(party.id) && !partyIds.has(String(party.id)) &&
            !!partyIds.add(String(party.id)) && string(party.name, 5_000);
        });
    });
  return valid && (cover.filingPartyId === undefined || partyIds.has(String(cover.filingPartyId)));
}

/** Decodes the durable, file-byte-free Court draft stored at the application boundary. */
export function decodeCourtRecordDraftState(value: unknown): WorkProductState | null {
  const state = object(value);
  if (!state || !exactKeys(state, ["profileId", "cover", "entries", "bindings"]) ||
      !id(state.profileId) || !validCover(state.cover) || !Array.isArray(state.entries) ||
      state.entries.length > 500) return null;
  const profile = COURT_RECORD_PROFILE_BY_ID.get(String(state.profileId));
  const bindings = decodeWorkProductBindings(state.bindings);
  if (!profile || !bindings) return null;
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
        Boolean(entry.descriptionOnly) !== Boolean(slot.descriptionOnly) ||
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
