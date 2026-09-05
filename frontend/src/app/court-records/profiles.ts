import catalogueJson from "../../../../shared/court-record-profiles.json";
import { registeredCourt } from "@/app/lib/courtRegistry";
import type {
  CourtProfile,
  CoverDefinition,
  CoverField,
  CoverValues,
  DocumentKind,
  PartyStyle,
  TechnicalRequirements,
} from "./types";
import { filingParty } from "./types";

type ProfileRow = Omit<CourtProfile,
  "selectable" | "jurisdiction" | "court" | "courtAbbreviation" | "language" |
  "effective" | "cover" | "documentKinds" | "technical"> & {
  selectable?: boolean;
  effectiveFrom: string;
  partyStyleIds?: string[];
  filingGroupId?: string;
  cover: Omit<CoverDefinition, "fields" | "partyStyles" | "filingGroupId"> & {
    fieldKeys: string[];
  };
  slots: DocumentKind[];
  technical: string;
};
type Catalogue = {
  partyStyles: PartyStyle[];
  coverFieldDefinitions: Record<string, CoverField>;
  technicalDefinitions: Record<string, TechnicalRequirements>;
  profiles: ProfileRow[];
};
const catalogue = catalogueJson as unknown as Catalogue;

const required = <T>(value: T | undefined, kind: string, id: string): T => {
  if (value === undefined) throw new Error(`Missing Court Record ${kind} ${id}`);
  return value;
};
const styleById = new Map(catalogue.partyStyles.map((style) => [style.id, style]));
if (styleById.size !== catalogue.partyStyles.length || catalogue.partyStyles.some((style) =>
  new Set(style.groups.map(({ id }) => id)).size !== style.groups.length)) {
  throw new Error("Duplicate Court Record party style or group id");
}

const profileIds = new Set<string>();
export const COURT_PROFILES = catalogue.profiles.map((row): CourtProfile => {
  if (profileIds.has(row.id)) throw new Error(`Duplicate Court Record profile ${row.id}`);
  profileIds.add(row.id);
  const court = registeredCourt(row.courtId);
  const fields = row.cover.fieldKeys.map((key) => required(
    catalogue.coverFieldDefinitions[key], "cover field", key)).map((field) =>
    row.cover.template !== "abca-ap5" ? field
      : field.id === "counselFax" ? { ...field, label: "Fax (or N/A)", required: true }
        : field.id === "counselEmail" ? { ...field, required: false } : field);
  const technical = required(catalogue.technicalDefinitions[row.technical],
    "technical definition", row.technical);
  const partyStyles = row.partyStyleIds?.map((id) => required(styleById.get(id), "party style", id));
  const slotIds = new Set(row.slots.map(({ id }) => id));
  if (slotIds.size !== row.slots.length || row.oneOf?.some((choice) =>
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
  const { effectiveFrom, partyStyleIds: _partyStyleIds,
    filingGroupId, cover: { fieldKeys: _fieldKeys, ...cover }, slots, technical: _technical,
    selectable, ...profile } = row;
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

export const COURT_PROFILE_BY_ID = new Map(
  COURT_PROFILES.map((profile) => [profile.id, profile]),
);

const ABCA_FACTUM_COVERS: Record<string, [string, string]> = {
  Appellant: ["beige", "#F5F5DC"], Respondent: ["green", "#A9D18E"],
  Intervener: ["blue", "#9FC5DC"],
};
export function courtProfileForCover(profile: CourtProfile, cover: CoverValues) {
  if (profile.id !== "ab-ca-condensed-book") return profile;
  const colour = ABCA_FACTUM_COVERS[filingParty(profile, cover)?.group.role ?? "Appellant"];
  return { ...profile, cover: { ...profile.cover,
    colourName: colour[0], colourHex: colour[1] } };
}
