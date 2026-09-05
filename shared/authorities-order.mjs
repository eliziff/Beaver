const groups = [["Cases", "case"], ["Legislation", "legislation"],
  ["Secondary sources", "commentary"], ["Other sources", "other"]];

function tabLabel(index, style) {
  if (style === "numeric") return `Tab ${index}`;
  let label = "";
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26))
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return `Tab ${label}`;
}

function deriveAuthorityProcedure(input) {
  const byId = new Map(input.authorities.map((item) => [item.id, item]));
  const alphabetical = (left, right) => left.sortLabel.normalize("NFKD")
    .toLocaleLowerCase("en-CA").localeCompare(right.sortLabel.normalize("NFKD")
      .toLocaleLowerCase("en-CA"), "en-CA") ||
    left.citation.localeCompare(right.citation, "en-CA");
  const grouped = groups.flatMap(([, kind]) => input.authorities
    .filter((item) => item.kind === kind).sort(alphabetical));
  const book = input.manual ? input.authorities : grouped;
  const tabs = new Map(); let number = 0;
  for (const item of book) {
    if (!item.excluded && item.reproduced) number += 1;
    tabs.set(item.id, !item.excluded && item.reproduced
      ? tabLabel(number, input.tabStyle) : "Not reproduced");
  }
  const seen = new Set(), referenced = [];
  for (const unit of [...input.units].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
    for (const occurrenceId of unit.occurrenceIds) {
      const id = input.occurrences[occurrenceId]?.authorityId;
      if (id && byId.has(id) && !seen.has(id)) { seen.add(id); referenced.push(byId.get(id)); }
    }
  }
  const table = input.tableOrder === "first-reference"
    ? [...referenced, ...input.authorities.filter(({ id }) => !seen.has(id))] : grouped;
  const ordered = input.purpose === "book" ? book : table;
  const oneGroup = input.manual && input.purpose === "book" ||
    input.purpose === "table" && input.tableOrder === "first-reference";
  return ordered.map((item) => ({ id: item.id, tab: tabs.get(item.id),
    group: oneGroup ? "Authorities" : groups.find(([, kind]) => kind === item.kind)[0] }));
}

export { deriveAuthorityProcedure, tabLabel };
