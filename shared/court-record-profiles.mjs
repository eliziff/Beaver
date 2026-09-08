// @ts-check
import catalogue from "./court-record-profiles.json" with { type: "json" };
import registry from "./court-registry.json" with { type: "json" };

/** @template T @param {T | undefined} value @param {string} kind @param {string} id */
const required = (value, kind, id) => {
  if (value === undefined) throw new Error(`Missing Court Record ${kind} ${id}`);
  return value;
};

/** @template T @param {Record<string, T>} values @param {string} kind @param {string} id */
const definition = (values, kind, id) =>
  required(Object.hasOwn(values, id) ? values[id] : undefined, kind, id);

/** One compiler for the checked-in catalogue. User draft validation stays at its boundary.
 * @param {import("./court-record-profiles.mjs").CourtRecordCatalogue} catalogue
 * @param {readonly import("./court-record-profiles.mjs").RegisteredCourt[]} courts
 * @returns {import("./court-record-profiles.mjs").CourtProfile[]}
 */
export function compileCourtRecordProfiles(catalogue, courts) {
  const styleById = new Map(catalogue.partyStyles.map((style) => [style.id, style]));
  if (styleById.size !== catalogue.partyStyles.length || catalogue.partyStyles.some((style) =>
    new Set(style.groups.map(({ id }) => id)).size !== style.groups.length)) {
    throw new Error("Duplicate Court Record party style or group id");
  }
  const profileIds = new Set();
  return catalogue.profiles.map((row) => {
    if (profileIds.has(row.id)) throw new Error(`Duplicate Court Record profile ${row.id}`);
    profileIds.add(row.id);
    const court = required(courts.find(({ id }) => id === row.courtId), "court", row.courtId);
    const fields = row.cover.fieldKeys.map((key) => definition(
      catalogue.coverFieldDefinitions, "cover field", key)).map((field) =>
      row.cover.template !== "abca-ap5" ? field
        : field.id === "counselFax" ? { ...field, label: "Fax (or N/A)", required: true }
          : field.id === "counselEmail" ? { ...field, required: false } : field);
    const technical = definition(catalogue.technicalDefinitions,
      "technical definition", row.technical);
    const partyStyles = row.partyStyleIds?.map((id) => required(styleById.get(id), "party style", id));
    // Slots remain independent per profile, including nested accepted-output/format arrays.
    // References name whole rules: no inheritance, overrides, or implicit common slots.
    const slots = row.slots.map((slot) => typeof slot === "string"
      ? structuredClone(definition(catalogue.slotDefinitions, "slot definition", slot)) : slot);
    const slotIds = new Set(slots.map(({ id }) => id));
    if (slotIds.size !== slots.length || row.oneOf?.some((choice) =>
      choice.slots.some((id) => !slotIds.has(id)))) {
      throw new Error(`Invalid Court Record slots for ${row.id}`);
    }
    if (row.filingGroupId && (!partyStyles?.length || partyStyles.some((style) =>
      !style.groups.some(({ id }) => id === row.filingGroupId)))) {
      throw new Error(`Invalid Court Record filing group for ${row.id}`);
    }
    if (fields.some(({ partyStyleId }) => partyStyleId &&
      !partyStyles?.some(({ id }) => id === partyStyleId))) {
      throw new Error(`Invalid Court Record conditional field for ${row.id}`);
    }
    const { effectiveFrom, partyStyleIds: _partyStyleIds, filingGroupId,
      cover: { fieldKeys: _fieldKeys, ...cover }, slots: _slots,
      technical: _technical, selectable, ...profile } = row;
    return {
      ...profile,
      selectable: selectable !== false,
      jurisdiction: court.jurisdictionId,
      courtId: court.id,
      court: court.label,
      courtAbbreviation: court.abbreviation,
      language: court.language,
      effective: { from: effectiveFrom },
      cover: { ...cover, fields, ...(partyStyles && { partyStyles }),
        ...(filingGroupId && { filingGroupId }) },
      documentKinds: slots,
      technical,
    };
  });
}

export const COURT_PROFILES = compileCourtRecordProfiles(
  /** @type {import("./court-record-profiles.mjs").CourtRecordCatalogue} */ (catalogue),
  /** @type {import("./court-record-profiles.mjs").RegisteredCourt[]} */ (registry.courts));
export const COURT_PROFILE_BY_ID = new Map(COURT_PROFILES.map((profile) => [profile.id, profile]));
export const COURT_RECORD_COVER_FIELD_IDS = Object.values(catalogue.coverFieldDefinitions)
  .map(({ id }) => id);
