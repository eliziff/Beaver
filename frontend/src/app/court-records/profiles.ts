export { COURT_PROFILES, COURT_PROFILE_BY_ID } from "../../../../shared/court-record-profiles.mjs";
import type { CourtProfile, CoverValues } from "./types";
import { filingParty } from "./types";

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
