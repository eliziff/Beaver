import { authorityReproducedInBook } from "./authorities-sources.mjs";

const GROUPS = { case: "Cases", legislation: "Legislation", commentary: "Secondary sources", other: "Other sources" };
const KIND_ORDER = { "cases-first": ["case", "legislation", "commentary", "other"],
  "legislation-first": ["legislation", "case", "commentary", "other"] };

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

/** The one order of a filing's authorities, the book's tabs and the table's entries alike: grouped by
 *  kind (cases or legislation first) or not at all, and within each group alphabetical, in the order
 *  the brief first cites them (the rest after, as listed), or as the user arranged them (`custom`). */
function deriveAuthorityProcedure(input) {
  const collator = new Intl.Collator("en-CA"), folded = new Map(input.authorities.map((item) =>
    [item, item.sortLabel.normalize("NFKD").toLocaleLowerCase("en-CA")]));
  const cited = new Map();
  for (const unit of [...input.units].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
    for (const occurrenceId of unit.occurrenceIds) {
      const id = input.occurrences[occurrenceId]?.authorityId;
      if (id && !cited.has(id)) cited.set(id, cited.size);
    }
  }
  const kinds = KIND_ORDER[input.grouping], within = {
    alphabetical: (left, right) => collator.compare(folded.get(left), folded.get(right)) ||
      collator.compare(left.citation, right.citation),
    "first-reference": (left, right) => (cited.get(left.id) ?? Infinity) - (cited.get(right.id) ?? Infinity),
  }[input.tableOrder];
  // A stable sort: what no rule tells apart stays as listed.
  const ordered = [...input.authorities].sort((left, right) =>
    (kinds ? kinds.indexOf(left.kind) - kinds.indexOf(right.kind) : 0) || (within?.(left, right) ?? 0));
  let number = 0;
  return ordered.map((item) => ({ id: item.id,
    tab: item.excluded ? "Not reproduced" : tabLabel(number += 1, input.tabStyle, input),
    group: kinds ? GROUPS[item.kind] : "Authorities" }));
}

/** Shapes a draft's stored state into `deriveAuthorityProcedure` input; the caller
 *  supplies only the purpose, so server and browser plan the same book. */
function authorityProcedureInput(state, { purpose }) {
  return {
    authorities: state.authorityOrder.map((id) => {
      const authority = state.authorities[id];
      return { id, kind: authority.kind, citation: authority.citation,
        sortLabel: authority.displayName || authority.name || authority.citation,
        excluded: authority.excluded,
        reproduced: authorityReproducedInBook(state, authority) };
    }),
    units: state.units, occurrences: state.occurrences,
    manual: state.import.kind === "manual", purpose,
    tableOrder: state.settings.tableOrder, grouping: authorityGrouping(state.settings),
    tabStyle: state.settings.tabStyle,
    tabStart: state.settings.tabStart, tabPrefix: state.settings.tabPrefix,
    tabLabels: state.settings.tabLabels,
  };
}

/** How a draft groups its authorities: as chosen, else (a draft saved before the choice) by kind
 *  unless they are listed in the order first cited. */
const authorityGrouping = (settings) =>
  settings.grouping ?? (settings.tableOrder === "first-reference" ? "none" : "cases-first");

/** What a citation's tab reference inserts after it, or null for none: the tab, "[Tab 4]", or the
 *  user's words before the tab's number, "[Appellant's Book of Authorities, Tab 4]". */
function tabReference(settings, tab) {
  if (settings.citationSuffix === "tab") return `[${tab}]`;
  if (settings.citationSuffix !== "custom") return null;
  const prefix = settings.tabPrefix ?? "Tab ";
  return `[${settings.citationSuffixLabel} ${tab.startsWith(prefix) ? tab.slice(prefix.length) : tab}]`;
}

/** Drafts saved with the fixed "[Book of authorities Tab 4]" read it as those words. */
function currentTabReference(settings) {
  return settings.citationSuffix === "book-tab" ? { ...settings, citationSuffix: "custom",
    citationSuffixLabel: `Book of authorities ${settings.tabPrefix ?? "Tab "}`.trim() } : settings;
}

export { authorityGrouping, authorityProcedureInput, currentTabReference, deriveAuthorityProcedure, tabLabel, tabReference };
