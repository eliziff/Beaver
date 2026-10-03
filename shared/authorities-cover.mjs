import profiles from "./authorities-profiles.json" with { type: "json" };

const ROLES = new Map(profiles.map(({ id, coverRoles }) => [id, coverRoles ?? []]));

/** The cover as a draft has it once it goes to the court `to` from the court `from`: where no party
 *  has been named and the roles are still the outgoing court's own, they become the new court's. */
export function courtCover(cover, from, to) {
  const unnamed = cover.partyGroups.every(({ parties }) => !parties.some((party) => party.trim()));
  const roles = cover.partyGroups.map(({ role }) => role.trim());
  const outgoing = ROLES.get(from) ?? [];
  if (!unnamed || roles.length && JSON.stringify(roles) !== JSON.stringify(outgoing)) return cover;
  return { ...cover, partyGroups: (ROLES.get(to) ?? []).map((role) => ({ role, parties: [] })) };
}
