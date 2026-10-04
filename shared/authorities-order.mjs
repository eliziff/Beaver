import { authorityReproducedInBook, authorityTabbed } from "./authorities-sources.mjs";

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
  // A decision printed with the case it follows has no tab or index line of its own.
  const listed = state.authorityOrder.filter((id) => state.authorities[id].excluded || authorityTabbed(state, state.authorities[id]));
  return {
    authorities: listed.map((id) => {
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

/** An authority as every output cites it (the index and its bookmarks, the tables, Word's citation
 *  fields): as the brief first cites it in full, led by the style of cause or title (the name its source
 *  gives it where the brief cites it by its citation alone), then each other citation of it the brief or
 *  its source gives, a parallel report or a CanLII ID. A case's style of cause and a statute's title are
 *  italic: `italic` is the length of that lead, read from where the brief's citation span begins and its
 *  core citation starts. */
function authorityCitation(draft, authority) {
  const cites = draft.units.flatMap((unit) => unit.occurrenceIds.map((id) => draft.occurrences[id]))
    .filter((occurrence) => occurrence?.authorityId === authority.id && occurrence.kind !== "reference");
  // "R. v. Oakes" (a source's title) and "R v Oakes" (the brief) are one name, and "(2016) ABQB 16"
  // and "2016 ABQB 16" one citation.
  const lower = (value) => value.toLocaleLowerCase("en-CA").replace(/[.()]/gu, "").replace(/\s+/gu, " ").trim();
  // A form that differs from another only by letters and digits a recognizer confuses (G and C, O and 0,
  // l and 1, S and 5, B and 8) is that form misread, not another citation of it.
  const unconfused = (value) => lower(value).replace(/g/gu, "c").replace(/[oq]/gu, "0").replace(/[il]/gu, "1")
    .replace(/s/gu, "5").replace(/b/gu, "8");
  // An earlier citation a recognizer misread ("c. G-36" for "c C-36") does not lead.
  const misread = (occurrence) => occurrence.coreSpan.text !== authority.citation
    && unconfused(occurrence.coreSpan.text) === unconfused(authority.citation);
  const known = misread(cites[0] ?? { coreSpan: { text: authority.citation } })
    ? cites.findIndex((occurrence) => !misread(occurrence)) : -1;
  const [first, ...rest] = known > 0 ? [cites[known], ...cites.filter((_, at) => at !== known)] : cites;
  const line = (value) => value.replace(/\s+/gu, " ").trim();
  const name = line(authority.displayName ?? authority.name ?? "");
  const citation = line(authority.citation);
  // A brief that cites an authority only by a word of its name has not cited it in full.
  let text = first && !(name && lower(name).includes(lower(first.authoritySpan.text))) ? line(first.authoritySpan.text)
    : citation, lead = "";
  if (first) {
    const unit = draft.units.find(({ id }) => id === first.unitId)?.text ?? "";
    // A link the brief writes in square brackets keeps its closing bracket; one it writes in
    // angle brackets is cited without either ("online: <example.org/a>" cites "online:
    // example.org/a").
    const closer = unit[first.authoritySpan.end];
    if (closer === "]" && text.split("[").length > text.split("]").length) text += closer;
    const opener = text.lastIndexOf("<");
    if (opener >= 0 && !text.slice(opener).includes(">") && !/\s/u.test(text.slice(opener + 1)))
      text = text.slice(0, opener) + text.slice(opener + 1);
    // The court a CanLII ID is cited with belongs to its citation ("1954 CanLII 3 (SCC)"), though the
    // brief may write it after a pinpoint.
    const core = line(first.coreSpan.text);
    if (citation !== core && citation.startsWith(core) && text.includes(core) && !lower(text).includes(lower(citation)))
      text = text.replace(core, citation);
    if (first.authoritySpan.start < first.coreSpan.start)
      lead = line(unit.slice(first.authoritySpan.start, first.coreSpan.start)).replace(/,$/u, "");
  }
  // Where the brief's citation opens with the source's name ("R v Grant" for "R. v. Grant"), that is its lead.
  if (!lead && name) {
    let at = 0;
    const same = [...name].every((character) => {
      if (character === ".") { if (text[at] === ".") at += 1; return true; }
      while (text[at] === ".") at += 1;
      return text[at++]?.toLocaleLowerCase("en-CA") === character.toLocaleLowerCase("en-CA");
    });
    if (same && !/[\p{L}\p{N}]/u.test(text[at] ?? "")) lead = text.slice(0, at);
  }
  if (!lead && name && !lower(text).includes(lower(name))) { text = `${name}, ${text}`; lead = name; }
  // A decision of subsequent history printed with this case follows its citation as the brief
  // writes it: "…, 2010 ABQB 242, aff'd 2010 ABCA 191".
  if (draft.settings?.subsequentHistory === "with-case") for (const id of draft.authorityOrder) {
    const history = draft.authorities[id];
    if (history?.historyOf === authority.id && !history.excluded)
      text += `, ${[history.historyRelation, line(history.citation)].filter(Boolean).join(" ")}`;
  }
  const cited = text.length;
  for (const form of [...rest.map(({ coreSpan }) => coreSpan.text), citation,
    ...authority.sourceIdentity?.citationForms ?? []].map(line))
    if (form && !unconfused(text).includes(unconfused(form)) && !(lead && lower(form).includes(lower(lead)))) text += `, ${form}`;
  const led = text.startsWith(lead) ? lead.length : 0;
  // `cited` ends the citation as the brief writes it, before the other citations of it.
  return { text, italic: ["case", "legislation"].includes(authority.kind) ? led : 0, lead: led, cited };
}

export { authorityCitation, authorityGrouping, authorityProcedureInput, currentTabReference, deriveAuthorityProcedure, tabLabel, tabReference };
