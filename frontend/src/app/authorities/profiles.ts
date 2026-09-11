import values from "../../../../shared/authorities-profiles.json";
import { registeredCourt, registeredJurisdiction } from "@/app/lib/courtRegistry";
import type { AuthoritiesProfile, AuthoritiesProfileId } from "./types";
export type { AuthoritiesProfile };

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
