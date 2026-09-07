const groups = [["Cases", "case"], ["Legislation", "legislation"],
  ["Secondary sources", "commentary"], ["Other sources", "other"]];

/** Labels belong to fixed book slots, never to PDFs or authority identities. */
function tabLabel(index, style = "numeric", format = {}) {
  if (!Number.isSafeInteger(index) || index < 1) throw new RangeError("Invalid tab slot");
  const custom = format.tabLabels?.[index - 1];
  if (custom?.trim()) return custom.trim();
  const number = index + (format.tabStart ?? 1) - 1;
  let label = String(number);
  if (style === "alpha" || style === "lower-alpha") {
    label = "";
    for (let value = number; value > 0; value = Math.floor((value - 1) / 26))
      label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  } else if (style === "roman" || style === "lower-roman") {
    label = "";
    let remainder = number;
    for (const [value, letters] of [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
      [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"],
      [5, "V"], [4, "IV"], [1, "I"]]) {
      while (remainder >= value) { label += letters; remainder -= value; }
    }
  }
  if (style.startsWith("lower-")) label = label.toLowerCase();
  return `${format.tabPrefix ?? "Tab "}${label}`;
}

function deriveAuthorityProcedure(input) {
  const byId = new Map(input.authorities.map((item) => [item.id, item]));
  const alphabetical = (left, right) => left.sortLabel.normalize("NFKD")
    .toLocaleLowerCase("en-CA").localeCompare(right.sortLabel.normalize("NFKD")
      .toLocaleLowerCase("en-CA"), "en-CA") ||
    left.citation.localeCompare(right.citation, "en-CA");
  const grouped = groups.flatMap(([, kind]) => input.authorities
    .filter((item) => item.kind === kind).sort(alphabetical));
  // authorityOrder is the user's book order in both automatic and manual mode.
  // Grouping and alphabetical sorting are table-only operations.
  const book = input.authorities;
  const tabs = new Map(); let number = 0;
  for (const item of book) {
    if (!item.excluded) number += 1;
    tabs.set(item.id, !item.excluded
      ? tabLabel(number, input.tabStyle, input) : "Not reproduced");
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
  const oneGroup = input.purpose === "book" ||
    input.purpose === "table" && input.tableOrder === "first-reference";
  return ordered.map((item) => ({ id: item.id, tab: tabs.get(item.id),
    group: oneGroup ? "Authorities" : groups.find(([, kind]) => kind === item.kind)[0] }));
}

/** Shapes a draft's stored state into `deriveAuthorityProcedure` input; the caller
 *  supplies the purpose and its own reproduced-in-book rule. */
function authorityProcedureInput(state, { purpose, reproduced }) {
  return {
    authorities: state.authorityOrder.map((id) => {
      const authority = state.authorities[id];
      return { id, kind: authority.kind, citation: authority.citation,
        sortLabel: authority.displayName || authority.name || authority.citation,
        excluded: authority.excluded, reproduced: reproduced(authority) };
    }),
    units: state.units, occurrences: state.occurrences,
    manual: state.import.kind === "manual", purpose,
    tableOrder: state.settings.tableOrder, tabStyle: state.settings.tabStyle,
    tabStart: state.settings.tabStart, tabPrefix: state.settings.tabPrefix,
    tabLabels: state.settings.tabLabels,
  };
}

export { authorityProcedureInput, deriveAuthorityProcedure, tabLabel };
