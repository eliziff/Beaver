import values from "../../../../shared/authorities-profiles.json";
import { registeredCourt, registeredJurisdiction } from "@/app/lib/courtRegistry";
import type { AuthoritiesBuildSettings, AuthoritiesOutputMode,
  AuthoritiesProfileId } from "./types";

export type AuthoritiesProfile = {
  id: AuthoritiesProfileId;
  label: string;
  courtId: string;
  defaults: { outputMode: AuthoritiesOutputMode; settings: AuthoritiesBuildSettings };
  locked?: { outputMode?: AuthoritiesOutputMode; settings?: Partial<AuthoritiesBuildSettings> };
  options?: {
    filingMedium?: Array<{ value: "electronic" | "paper"; label: string }>;
    bookRole?: Array<{ value: NonNullable<AuthoritiesBuildSettings["bookRole"]>; label: string }>;
    missingSourcePolicy?: boolean;
  };
  requirements?: { completeBookSources?: boolean; documentOutputDefault?: boolean;
    unlinkedPdfTableSources?: boolean };
};

export const AUTHORITIES_PROFILES = (values as AuthoritiesProfile[]).map((profile) => {
  const court = registeredCourt(profile.courtId);
  return { ...profile, court, jurisdiction: registeredJurisdiction(court.jurisdictionId) };
});
export const AUTHORITY_PROFILE_BY_ID = new Map(
  AUTHORITIES_PROFILES.map((profile) => [profile.id, profile]),
);
export function authoritiesProfile(id: AuthoritiesProfileId) {
  const profile = AUTHORITY_PROFILE_BY_ID.get(id);
  if (!profile) throw new Error(`Missing Authorities profile ${id}`);
  return profile;
}
