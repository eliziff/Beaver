import registryJson from "../../../../shared/court-registry.json";

export type CourtJurisdiction = {
  id: string; label: string; preferenceKey?: string; order: number;
};
export type CourtLevel = { id: string; label: string; order: number };
export type RegisteredCourt = {
  id: string; jurisdictionId: string; levelId: string; label: string;
  abbreviation: string; language: "en" | "fr";
};

const registry = registryJson as {
  jurisdictions: CourtJurisdiction[]; levels: CourtLevel[]; courts: RegisteredCourt[];
};
export const COURT_JURISDICTIONS = registry.jurisdictions.toSorted((a, b) => a.order - b.order);
export const COURT_LEVELS = registry.levels.toSorted((a, b) => a.order - b.order);
export const COURTS = registry.courts;

export function registeredCourt(id: string) {
  const court = COURTS.find((item) => item.id === id);
  if (!court) throw new Error(`Missing court registry entry ${id}`);
  return court;
}

export function registeredJurisdiction(id: string) {
  const jurisdiction = COURT_JURISDICTIONS.find((item) => item.id === id);
  if (!jurisdiction) throw new Error(`Missing jurisdiction registry entry ${id}`);
  return jurisdiction;
}

export function registeredLevel(id: string) {
  const level = COURT_LEVELS.find((item) => item.id === id);
  if (!level) throw new Error(`Missing court level registry entry ${id}`);
  return level;
}
