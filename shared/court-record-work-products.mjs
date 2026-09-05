const volumeRole = /^(.*?)(?:-([1-9][0-9]*))?$/u;

function matchesWorkProductRole(role, family) {
  const match = volumeRole.exec(role);
  return !!match && match[1] === family && (!match[2] || Number(match[2]) >= 2);
}

function acceptsWorkProductOutput(slot, source) {
  return (slot.acceptedWorkProductOutputs ?? []).some((rule) =>
    rule.kind === source.kind && (!rule.profileId || rule.profileId === source.profileId) &&
    matchesWorkProductRole(source.role, rule.role));
}

export { acceptsWorkProductOutput, matchesWorkProductRole };
