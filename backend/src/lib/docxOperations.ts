import { openDocxSession } from "./docx/session";
import { structureNative } from "./structureNative";
import {
  ATTR_KEY,
  cloneNode,
  createBuilder,
  elAttrs,
  elChildren,
  elName,
  ensureXmlDeclaration,
  getTextContent,
  makeEl,
  makeText,
  setChildren,
  type XNode,
} from "./docx/core";
export type DocxAuthorityMark = {
  unitId: string;
  offset: number;
  longName: string;
  /** How many of longName's first characters are italic: its style of cause or title. */
  italic?: number;
  shortName: string;
  category: 1 | 2 | 3 | 5;
  suffix?: string;
  mark?: boolean;
  tabUrl?: string;
  pinpointLink?: { start: number; end: number; url: string };
  /** The authority cited, for the ruled table's "cited at" column. */
  authorityId?: string;
};
export type DocxTableDelivery = "native-marks" | "native-append" | "linked-append" | "ruled-append";
export type DocxLinkedAuthority = { label: string; italic: number; url: string | null;
  /** For the ruled table: the authority, its group's heading and its tab in the book. */
  authorityId?: string; group?: string; tab?: string };

/** A text box's paragraphs are units of their own, read once (not again from the fallback kept for
 *  older readers): a paragraph's own text never holds them. */
const ownUnit = (node: XNode) => !["w:txbxContent", "mc:Fallback"].includes(elName(node) ?? "");

function walk(root: XNode | XNode[], visit: (node: XNode) => boolean | void) {
  const pending = (Array.isArray(root) ? root : [root]).slice().reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (!ownUnit(node) || visit(node) === false) continue;
    pending.push(...elChildren(node).slice().reverse());
  }
}

function visibleText(root: XNode) {
  let text = "";
  walk(root, (node) => {
    const name = elName(node);
    if (name === "w:del") return false;
    if (name === "w:t") text += getTextContent(node);
    else if (name === "w:tab") text += "\t";
    else if (name === "w:br" || name === "w:cr") text += "\n";
  });
  return text;
}

function setText(node: XNode, value: string) {
  setChildren(node, value ? [makeText(value)] : []);
  const attrs = { ...(node[ATTR_KEY] as Record<string, string> | undefined) };
  if (/^\s|\s$/u.test(value)) attrs["@_xml:space"] = "preserve";
  else delete attrs["@_xml:space"];
  if (Object.keys(attrs).length) node[ATTR_KEY] = attrs;
  else delete node[ATTR_KEY];
}

/** Opens the package, indexes body/footnote units, and refuses stale reviewed text. */
async function authorityUnitPackage(bytes: Buffer,
  units: ReadonlyArray<{ id: string; text: string }>) {
  const session = await openDocxSession(bytes);
  const document = await session.document(), footnotes = await session.readXml("word/footnotes.xml");
  // The body's paragraphs as citation review numbered them, each found by the engine's path to it.
  const targets = new Map<string, XNode>();
  const elements = (node: XNode) => elChildren(node).filter((child) => !(elName(child) ?? "#").startsWith("#"));
  for (const { key, path } of await structureNative().docxAuthorityTextUnits(bytes))
    if (path) targets.set(key, path.reduce<XNode>((node, index) => elements(node)[index] ?? {}, document.body));
  if (footnotes) walk(footnotes, (node) => {
    if (elName(node) === "w:footnote") {
      const id = elAttrs(node)["@_w:id"];
      if (id && Number(id) > 0) targets.set(`footnote:${id}`, node);
    }
  });
  for (const unit of units) if (visibleText(targets.get(unit.id) ?? {}) !== unit.text) {
    throw new Error(`Reviewed text no longer matches ${unit.id}.`);
  }
  return { session, document, targets, save: () => {
    session.writeDocument(document.tree);
    if (footnotes) session.write("word/footnotes.xml",
      ensureXmlDeclaration(createBuilder().build(footnotes)));
    return session.save();
  } };
}

function replaceVisibleSpan(root: XNode, start: number, end: number, replacement: string) {
  const texts: Array<{ node: XNode; start: number; end: number; value: string }> = [];
  let cursor = 0, unsupported = false;
  walk(root, (node) => {
    const name = elName(node);
    if (name === "w:del") return false;
    if (name === "w:t") {
      const value = getTextContent(node);
      texts.push({ node, start: cursor, end: cursor + value.length, value });
      cursor += value.length;
    } else if (name === "w:tab" || name === "w:br" || name === "w:cr") {
      if (start < cursor + 1 && end > cursor) unsupported = true;
      cursor += 1;
    }
  });
  const first = texts.find((item) => item.start <= start && start <= item.end);
  const last = texts.find((item) => item.start <= end && end <= item.end);
  if (unsupported || !first || !last) return false;
  if (first === last) {
    setText(first.node, first.value.slice(0, start - first.start) + replacement +
      first.value.slice(end - first.start));
    return true;
  }
  const from = texts.indexOf(first), to = texts.indexOf(last);
  setText(first.node, first.value.slice(0, start - first.start) + replacement);
  for (let index = from + 1; index < to; index += 1) setText(texts[index].node, "");
  setText(last.node, last.value.slice(end - last.start));
  return true;
}

/** Applies one server-reviewed Authorities correction to an exact body or footnote unit span. */
export async function applyAuthorityDiscrepancyCorrection(bytes: Buffer,
  units: ReadonlyArray<{ id: string; text: string }>, correction: {
    unitId: string; start: number; end: number; expected: string; replacement: string;
  }) {
  const { targets, save } = await authorityUnitPackage(bytes, units);
  const target = targets.get(correction.unitId);
  if (!target || correction.start < 0 || correction.end <= correction.start ||
      visibleText(target).slice(correction.start, correction.end) !== correction.expected ||
      !correction.replacement || !replaceVisibleSpan(target, correction.start,
        correction.end, correction.replacement)) {
    throw new Error("The accepted correction no longer matches the reviewed Word document.");
  }
  return save();
}

/** A TA mark as Word itself writes it: no result, and not hidden text, or Word's table leaves it out.
 *  Its code is in parts, an italic part as the citation's style of cause, which Word's table keeps. */
function fieldRuns(...instruction: Array<string | { italic: string }>) {
  const run = (child: XNode, italic = false) => makeEl("w:r", [...italic ? [makeEl("w:rPr", [makeEl("w:i", [])])] : [], child]);
  return [
    run(makeEl("w:fldChar", [], { "w:fldCharType": "begin" })),
    ...instruction.map((part) => run(makeEl("w:instrText", [makeText(typeof part === "string" ? part : part.italic)],
      { "xml:space": "preserve" }), typeof part !== "string")),
    run(makeEl("w:fldChar", [], { "w:fldCharType": "end" })),
  ];
}

/** Inserts nodes at a text offset. Text inside a field's result is Word's to replace when it updates
 *  the field (a cross-reference's note number, say), so an offset there inserts after the field.
 *  The author's own link keeps only its own text, so an offset in it inserts after the link. */
function insertAtOffset(root: XNode, offset: number, nodes: XNode[]) {
  let cursor = 0, local = 0, open = 0;
  let target: { node: XNode; run: XNode; parent: XNode } | null = null;
  let after: { node: XNode; parent: XNode } | null = null, link: { node: XNode; parent: XNode } | null = null;
  const descend = (node: XNode, parent: XNode | null, run: XNode | null,
    runParent: XNode | null, hyperlink: { node: XNode; parent: XNode } | null = null): void => {
    if (after || elName(node) === "w:del" || !ownUnit(node)) return;
    const name = elName(node);
    if (name === "w:hyperlink" && parent) hyperlink = { node, parent };
    const nextRun = name === "w:r" ? node : run;
    const nextRunParent = name === "w:r" ? parent : runParent;
    if (name === "w:fldChar") {
      const type = (node[ATTR_KEY] as Record<string, string> | undefined)?.["@_w:fldCharType"];
      open = Math.max(0, open + (type === "begin" ? 1 : type === "end" ? -1 : 0));
      if (target && open === 0 && run && runParent) after = { node: run, parent: runParent };
    }
    if (name === "w:t" && !target) {
      const value = getTextContent(node), end = cursor + value.length;
      if (cursor <= offset && offset <= end && nextRun && nextRunParent) {
        target = { node, run: nextRun, parent: nextRunParent }; link = hyperlink;
        local = offset - cursor;
        if (!open && elName(nextRunParent) !== "w:fldSimple") after = target;
      }
      cursor = end;
      return;
    }
    if (name === "w:tab" || name === "w:br" || name === "w:cr") cursor += 1;
    for (const child of elChildren(node)) descend(child, node, nextRun, nextRunParent, hyperlink);
    if (name === "w:fldSimple" && target && !after && parent) after = { node, parent };
  };
  descend(root, null, null, null);
  if (!target) throw new Error("A reviewed citation no longer matches the Word document.");
  // Assigned inside descend, which TypeScript does not follow.
  const field = (link && after === target ? link : after) as { node: XNode; parent: XNode } | null;
  if (field && field !== target) {
    const siblings = elChildren(field.parent);
    siblings.splice(siblings.indexOf(field.node) + 1, 0, ...nodes);
    return;
  }
  const { node, run, parent } = target as { node: XNode; run: XNode; parent: XNode };
  const runChildren = elChildren(run), textIndex = runChildren.indexOf(node);
  const parentChildren = elChildren(parent), runIndex = parentChildren.indexOf(run);
  if (textIndex < 0 || runIndex < 0) {
    throw new Error("A reviewed citation is inside unsupported Word markup.");
  }
  const value = getTextContent(node);
  const rightRun = cloneNode(run), rightChildren = elChildren(rightRun);
  setText(node, value.slice(0, local));
  setChildren(run, runChildren.slice(0, textIndex + 1));
  setText(rightChildren[textIndex], value.slice(local));
  const tail = [
    ...rightChildren.slice(0, textIndex).filter((child) => elName(child) === "w:rPr"),
    rightChildren[textIndex], ...rightChildren.slice(textIndex + 1),
  ];
  setChildren(rightRun, tail);
  parentChildren.splice(runIndex + 1, 0, ...nodes,
    // The run's remainder, unless an insertion at the end of its text left it nothing.
    ...(tail.some((child) => elName(child) !== "w:rPr" && (child !== rightChildren[textIndex] || value.slice(local)))
      ? [rightRun] : []));
}

/** Settings Word writes after updateFields (CT_Settings order); extension settings come last. */
const SETTINGS_AFTER_UPDATE_FIELDS = new Set(["w:hdrShapeDefaults", "w:footnotePr", "w:endnotePr",
  "w:compat", "w:docVars", "w:rsids", "w:attachedSchema", "w:themeFontLang", "w:clrSchemeMapping",
  "w:doNotIncludeSubdocsInStats", "w:doNotAutoCompressPictures", "w:forceUpgrade", "w:captions",
  "w:readModeInkLockDown", "w:smartTagType", "w:shapeDefaults", "w:doNotEmbedSmartTags",
  "w:decimalSymbol", "w:listSeparator"]);
/** What a TA field gives Word's table: the text on one line, as the field holds it. */
const entryText = (value: string) => value.replace(/\s+/gu, " ").trim();
/** A field argument. Word ends a quoted argument at a straight or a curly double quote, so each is
 *  escaped with a backslash; Word shows any other backslash as it stands. */
const fieldText = (value: string) => value.replace(/["“”]/gu, "\\$&");
/** The text of a field's quoted or bare argument after `switch`, with its escapes read. */
function fieldArgument(code: string, name: string) {
  const at = code.search(new RegExp(`\\\\${name}\\s`, "u"));
  if (at < 0) return undefined;
  const rest = code.slice(at + 2).trimStart();
  if (!/^["“]/u.test(rest)) return /^\S+/u.exec(rest)?.[0];
  let value = "";
  for (let index = 1; index < rest.length; index += 1) {
    if (rest[index] === "\\" && /["“”]/u.test(rest[index + 1] ?? "")) value += rest[++index];
    else if (/["“”]/u.test(rest[index])) return value;
    else value += rest[index];
  }
  return value;
}
/** The heading over each citation category: the table's own groups for ours (cases, legislation,
 *  secondary and other sources), and Word's names for the categories only an author's marks use. */
const CATEGORY_NAMES: Record<number, string> = { 1: "Cases", 2: "Legislation", 3: "Other sources", 4: "Rules",
  5: "Secondary sources", 6: "Regulations", 7: "Constitutional Provisions" };
/** Word's sort of a table's entries: case and accents second, spaces and punctuation before digits
 *  and digits before letters. */
export const entryOrder = new Intl.Collator("en", { numeric: false }).compare;
/** The styles Word gives a table of authorities, added when the brief has none of its own: each
 *  entry's pages at the margin, after a dotted leader. */
const tableStyles = (width: number) => [
  makeEl("w:style", [makeEl("w:name", [], { "w:val": "toa heading" }), makeEl("w:basedOn", [], { "w:val": "Normal" }),
    makeEl("w:next", [], { "w:val": "Normal" }), makeEl("w:uiPriority", [], { "w:val": "99" }), makeEl("w:semiHidden", []),
    makeEl("w:unhideWhenUsed", []),
    makeEl("w:pPr", [makeEl("w:spacing", [], { "w:before": "120" })]),
    makeEl("w:rPr", [makeEl("w:rFonts", [], { "w:asciiTheme": "majorHAnsi", "w:eastAsiaTheme": "majorEastAsia",
      "w:hAnsiTheme": "majorHAnsi", "w:cstheme": "majorBidi" }), makeEl("w:b", []), makeEl("w:bCs", []),
    makeEl("w:sz", [], { "w:val": "24" }), makeEl("w:szCs", [], { "w:val": "24" })])],
  { "w:type": "paragraph", "w:styleId": "TOAHeading" }),
  makeEl("w:style", [makeEl("w:name", [], { "w:val": "table of authorities" }), makeEl("w:basedOn", [], { "w:val": "Normal" }),
    makeEl("w:next", [], { "w:val": "Normal" }), makeEl("w:uiPriority", [], { "w:val": "99" }), makeEl("w:semiHidden", []),
    makeEl("w:unhideWhenUsed", []),
    makeEl("w:pPr", [makeEl("w:tabs", [makeEl("w:tab", [], { "w:val": "right", "w:leader": "dot", "w:pos": String(width) })]),
      makeEl("w:ind", [], { "w:left": "220", "w:right": "720", "w:hanging": "220" })])],
  { "w:type": "paragraph", "w:styleId": "TableofAuthorities" }),
];

/** The width of the page's text, in twentieths of a point: where Word's table sets its page numbers. */
function textWidth(section: XNode | undefined) {
  const child = (name: string) => elChildren(section ?? {}).find((node) => elName(node) === name);
  const size = (node: XNode | undefined, name: string) => Number(elAttrs(node ?? {})[`@_w:${name}`] ?? 0);
  const page = child("w:pgSz"), margins = child("w:pgMar");
  const width = (size(page, "w") || 12240) - (margins ? size(margins, "left") + size(margins, "right") +
    size(margins, "gutter") : 2880);
  return width > 0 ? width : 9360;
}

type TableEntry = { italic: number; pages: Set<number> };
/** Under each category's heading, a TOA field holding the table Word would show for it already in its
 *  result, so the table reads as a table as soon as the brief opens: each entry on its own line, sorted
 *  as Word sorts them, its style of cause in italics, and after a dotted leader the pages it is cited
 *  on as Word last laid the brief out. Word's update of the field puts its own. */
function tableFields(entries: ReadonlyMap<number, ReadonlyMap<string, TableEntry>>, width: number) {
  const tabs = makeEl("w:tabs", [makeEl("w:tab", [], { "w:val": "right", "w:leader": "dot", "w:pos": String(width) })]);
  const paragraph = (style: string, runs: XNode[], extra: XNode[] = []) => makeEl("w:p", [
    makeEl("w:pPr", [makeEl("w:pStyle", [], { "w:val": style }), ...extra]), ...runs]);
  const text = (value: string, format: XNode[] = []) => makeEl("w:r", [makeEl("w:rPr", [...format, makeEl("w:noProof", [])]),
    makeEl(value === "\t" ? "w:tab" : "w:t", value === "\t" ? [] : [makeText(value)],
      /^\s|\s$/u.test(value) && value !== "\t" ? { "xml:space": "preserve" } : {})]);
  const char = (type: string) => makeEl("w:r", [makeEl("w:fldChar", [], { "w:fldCharType": type })]);
  return [...entries].sort(([left], [right]) => left - right).flatMap(([category, names]) => [
    paragraph("TOAHeading", [text(CATEGORY_NAMES[category] ?? String(category), [makeEl("w:b", [])])],
      [makeEl("w:keepNext", []), makeEl("w:spacing", [], { "w:before": "240", "w:after": "120" })]),
    ...[...names].sort(([left], [right]) => entryOrder(left, right)).map(([name, { italic, pages }], index, all) =>
      paragraph("TableofAuthorities", [
        ...index ? [] : [char("begin"), makeEl("w:r", [makeEl("w:instrText", [makeText(` TOA \\c "${category}" `)],
          { "xml:space": "preserve" })]), char("separate")],
        ...italic ? [text(name.slice(0, italic), [makeEl("w:i", [])])] : [], text(name.slice(italic)),
        ...pages.size ? [text("\t"), text([...pages].sort((left, right) => left - right).join(", "))] : [],
        ...index === all.length - 1 ? [char("end")] : [],
      ], [cloneNode(tabs), makeEl("w:ind", [], { "w:left": "220", "w:right": "720", "w:hanging": "220" })])),
  ]);
}

/** The page each place in the brief was on when Word last laid it out: Word marks where each page
 *  began whenever it saves (lastRenderedPageBreak); a brief Word never laid out has only its hard page
 *  breaks. A note is on the page of its reference. */
function renderedPages(body: XNode, targets: ReadonlyMap<string, XNode>) {
  const units = new Map([...targets].map(([id, node]) => [node, id]));
  let laidOut = false, page = 1, cursor = 0, starts: Array<[number, number]> = [];
  walk(body, (node) => { if (elName(node) === "w:lastRenderedPageBreak") laidOut = true; });
  const pages = new Map<string, Array<[number, number]>>(), notes = new Map<string, number>();
  walk(body, (node) => {
    const name = elName(node), attrs = elAttrs(node);
    if (name === "w:del") return false;
    if (name === "w:p") {
      starts = [[0, page]]; cursor = 0;
      const id = units.get(node);
      if (id) pages.set(id, starts);
    } else if (name === "w:t") cursor += getTextContent(node).length;
    else if (name === "w:tab" || name === "w:cr" || name === "w:br") cursor += 1;
    else if (name === "w:footnoteReference") notes.set(`footnote:${attrs["@_w:id"]}`, page);
    if (laidOut ? name === "w:lastRenderedPageBreak" : name === "w:br" && attrs["@_w:type"] === "page" ||
      name === "w:pageBreakBefore" && !["0", "false"].includes(attrs["@_w:val"] ?? "")) starts.push([cursor, ++page]);
  });
  return (unitId: string, offset: number) => notes.get(unitId) ??
    (pages.get(unitId) ?? [[0, 1]]).filter(([at]) => at <= offset).at(-1)![1];
}

function linkedTable(entries: readonly DocxLinkedAuthority[]) {
  const run = (value: string, linked = false, italic = false) => makeEl("w:r", [
    ...(linked || italic ? [makeEl("w:rPr", [...italic ? [makeEl("w:i", [])] : [],
      ...linked ? [makeEl("w:color", [], { "w:val": "0563C1" }), makeEl("w:u", [], { "w:val": "single" })] : []])] : []),
    makeEl("w:t", [makeText(value)], /^\s|\s$/u.test(value)
      ? { "xml:space": "preserve" } : {}),
  ]);
  const citation = (value: string, italic: number) => [value.slice(0, italic), value.slice(italic)]
    .flatMap((part, index) => part ? [run(part, false, !index)] : []);
  const link = (value: string | null) => {
    try {
      const parsed = new URL(value ?? "");
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
    } catch { return null; }
  };
  return [
    makeEl("w:p", [makeEl("w:r", [makeEl("w:br", [], { "w:type": "page" })])]),
    makeEl("w:p", [makeEl("w:pPr", [makeEl("w:pStyle", [], { "w:val": "Heading1" })]),
      run("TABLE OF AUTHORITIES")]),
    // Each authority with its hyperlink, printed too for a reader on paper: the citation in black, the
    // link in link blue.
    ...entries.map(({ label, italic, url }, index) => {
      const href = link(url), hyperlink = (runs: XNode[]) => makeEl("w:fldSimple", runs, { "w:instr": ` HYPERLINK "${href}" ` });
      return makeEl("w:p", [run(`${index + 1}. `), ...href ? [hyperlink(citation(label, italic)),
        makeEl("w:r", [makeEl("w:br", [])]), hyperlink([run(href, true)])] : citation(label, italic)]);
    }),
  ];
}

/** The number Word prints before each numbered paragraph of the body, as its REF field's \n switch
 *  gives it (the level's own text, without trailing periods), and a number typed at a paragraph's
 *  start ("12.", then a tab). A heading's number is no paragraph number, nor is a subparagraph's
 *  ("(a)"): the paragraphs are those at the list level most numbered paragraphs are at. */
function paragraphNumbers(paragraphs: readonly XNode[], styles: XNode[] | null, numbering: XNode[] | null) {
  const child = (node: XNode | undefined, name: string) => elChildren(node ?? {}).find((item) => elName(item) === name);
  const value = (node: XNode | undefined) => elAttrs(node ?? {})["@_w:val"];
  const roots = (tree: XNode[] | null, name: string) => elChildren(tree?.find((node) => elName(node) === name) ?? {});
  const styleOf = new Map(roots(styles, "w:styles").map((style) => [elAttrs(style)["@_w:styleId"], style]));
  const numberedBy = (pPr: XNode | undefined, depth = 0): { numId?: string; ilvl?: string; heading: boolean } => {
    const style = styleOf.get(value(child(pPr, "w:pStyle")) ?? "Normal");
    const own = child(pPr, "w:numPr"), inherited = depth < 10 && style ? numberedBy(child(style, "w:pPr"), depth + 1) : undefined;
    const name = value(child(style, "w:name")) ?? "";
    return { numId: value(child(own, "w:numId")) ?? inherited?.numId, ilvl: value(child(own, "w:ilvl")) ?? inherited?.ilvl,
      heading: /^(?:heading|title)/iu.test(name) || (value(child(pPr, "w:outlineLvl")) ?? "9") !== "9" || !!inherited?.heading };
  };
  const nums = new Map(roots(numbering, "w:numbering").filter((node) => elName(node) === "w:num").map((num) =>
    [elAttrs(num)["@_w:numId"], num]));
  const abstracts = new Map(roots(numbering, "w:numbering").filter((node) => elName(node) === "w:abstractNum").map((node) =>
    [elAttrs(node)["@_w:abstractNumId"], node]));
  const format = (count: number, kind = "decimal") => {
    if (/letter/iu.test(kind)) {
      const letter = String.fromCharCode(65 + (count - 1) % 26).repeat(Math.floor((count - 1) / 26) + 1);
      return kind.startsWith("lower") ? letter.toLowerCase() : letter;
    }
    if (/roman/iu.test(kind)) {
      let roman = "", rest = count;
      for (const [size, letters] of [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
        [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]] as const)
        while (rest >= size) { roman += letters; rest -= size; }
      return kind.startsWith("lower") ? roman.toLowerCase() : roman;
    }
    return String(count);
  };
  const counts = new Map<string, number[]>(), begun = new Set<string>();
  const found = new Map<XNode, { text: string; auto: boolean; level: number }>();
  for (const paragraph of paragraphs) {
    const { numId, ilvl, heading } = numberedBy(child(paragraph, "w:pPr")), num = numId ? nums.get(numId) : undefined;
    const abstractId = value(child(num, "w:abstractNumId")), abstract = abstracts.get(abstractId);
    if (num && abstract && abstractId) {
      const level = Number(ilvl ?? 0), levels = elChildren(abstract).filter((node) => elName(node) === "w:lvl");
      const lvl = (at: number) => levels.find((node) => Number(elAttrs(node)["@_w:ilvl"]) === at);
      const start = (at: number) => Number(value(child(elChildren(num).find((node) => elName(node) === "w:lvlOverride" &&
        Number(elAttrs(node)["@_w:ilvl"]) === at), "w:startOverride")) ?? value(child(lvl(at), "w:start")) ?? 1);
      const count = counts.get(abstractId) ?? counts.set(abstractId, []).get(abstractId)!;
      // A list whose numbering restarts starts again where it is first used.
      if (!begun.has(numId!)) {
        begun.add(numId!);
        elChildren(num).forEach((node) => { if (elName(node) === "w:lvlOverride") delete count[Number(elAttrs(node)["@_w:ilvl"])]; });
      }
      count[level] = (count[level] ?? start(level) - 1) + 1;
      count.length = level + 1;
      const kind = value(child(lvl(level), "w:numFmt")) ?? "decimal";
      if (!heading && kind !== "bullet" && kind !== "none") found.set(paragraph, { auto: true, level,
        text: (value(child(lvl(level), "w:lvlText")) ?? `%${level + 1}.`).replace(/%(\d)/gu, (_, at: string) =>
          format(count[Number(at) - 1] ?? start(Number(at) - 1), value(child(lvl(Number(at) - 1), "w:numFmt")))).replace(/[.\s]+$/u, "") });
    } else if (!heading) {
      const typed = /^\s*(\d{1,4})(?:\.[\t ]+|\t+)\S/u.exec(visibleText(paragraph))?.[1];
      if (typed) found.set(paragraph, { text: typed, auto: false, level: 0 });
    }
  }
  // A paragraph number is a number; a list's "(a)" is part of the paragraph before it.
  const numbered = [...found].filter(([, { text }]) => /^\d+$/u.test(text)), levels = new Map<number, number>();
  for (const [, { level }] of numbered) levels.set(level, (levels.get(level) ?? 0) + 1);
  const level = [...levels].sort(([, left], [, right]) => right - left)[0]?.[0];
  return new Map(numbered.filter(([, number]) => number.level === level));
}

/** The authorities as a ruled table, as court filings set them out: the tab each is behind in the
 *  book, the authority (its style of cause in italics) and where the brief cites it, under a header
 *  row Word repeats on each page the table runs onto, each group under a row of its own. */
function ruledTable(entries: ReadonlyArray<DocxLinkedAuthority & { citedAt: XNode[][] }>, width: number,
  citedAt: "paragraph" | "page") {
  const tabs = entries.some(({ tab }) => tab), columns = [...tabs ? [864] : [], width - (tabs ? 864 : 0) - 1872, 1872];
  const border = (side: string) => makeEl(`w:${side}`, [], { "w:val": "single", "w:sz": "4", "w:space": "0", "w:color": "auto" });
  const run = (text: string, format: XNode[] = []) => makeEl("w:r", [...format.length ? [makeEl("w:rPr", format)] : [],
    makeEl("w:t", [makeText(text)], /^\s|\s$/u.test(text) ? { "xml:space": "preserve" } : {})]);
  // Single-spaced and unindented whatever the brief's own paragraphs are.
  const paragraph = (runs: XNode[], align = "left", keep = false) => makeEl("w:p", [makeEl("w:pPr", [
    ...keep ? [makeEl("w:keepNext", [])] : [],
    makeEl("w:spacing", [], { "w:before": "40", "w:after": "40", "w:line": "240", "w:lineRule": "auto" }),
    makeEl("w:ind", [], { "w:left": "0", "w:right": "0", "w:firstLine": "0" }), makeEl("w:jc", [], { "w:val": align })]), ...runs]);
  const cell = (content: XNode[], width: number, extra: XNode[] = []) => makeEl("w:tc", [makeEl("w:tcPr", [
    makeEl("w:tcW", [], { "w:w": String(width), "w:type": "dxa" }), ...extra]), ...content]);
  const row = (cells: XNode[], properties: XNode[] = []) => makeEl("w:tr", [makeEl("w:trPr", [makeEl("w:cantSplit", []),
    ...properties]), ...cells]);
  const shade = () => makeEl("w:shd", [], { "w:val": "clear", "w:color": "auto", "w:fill": "D9D9D9" });
  const bold = () => [makeEl("w:b", [])];
  const header = row([...tabs ? ["Tab"] : [], "Authority", citedAt === "paragraph" ? "Cited at paragraph(s)" : "Cited at page(s)"]
    .map((text, index) => cell([paragraph([run(text, bold())], tabs && !index ? "center" : "left")], columns[index], [shade()])),
  [makeEl("w:tblHeader", [])]);
  const groups = new Set(entries.map(({ group }) => group)).size > 1;
  const rows = entries.flatMap((entry, index) => [
    // A group's heading row stays with its first authority.
    ...groups && entry.group !== entries[index - 1]?.group ? [row([cell([paragraph([run(entry.group ?? "", bold())], "left", true)],
      width, [makeEl("w:gridSpan", [], { "w:val": String(columns.length) })])])] : [],
    row([...tabs ? [cell([paragraph(entry.tab ? [run(entry.tab)] : [], "center")], columns[0])] : [],
      cell([paragraph([entry.label.slice(0, entry.italic), entry.label.slice(entry.italic)]
        .flatMap((text, part) => text ? [run(text, part ? [] : [makeEl("w:i", [])])] : []))], columns.at(-2)!),
      cell([paragraph(entry.citedAt.flatMap((place, at) => [...at ? [run(", ")] : [], ...place]))], columns.at(-1)!)]),
  ]);
  return makeEl("w:tbl", [makeEl("w:tblPr", [makeEl("w:tblW", [], { "w:w": String(width), "w:type": "dxa" }),
    makeEl("w:tblBorders", ["top", "left", "bottom", "right", "insideH", "insideV"].map(border)),
    makeEl("w:tblLayout", [], { "w:type": "fixed" }),
    makeEl("w:tblCellMar", [makeEl("w:top", [], { "w:w": "29", "w:type": "dxa" }), makeEl("w:left", [], { "w:w": "108", "w:type": "dxa" }),
      makeEl("w:bottom", [], { "w:w": "29", "w:type": "dxa" }), makeEl("w:right", [], { "w:w": "108", "w:type": "dxa" })])]),
  makeEl("w:tblGrid", columns.map((column) => makeEl("w:gridCol", [], { "w:w": String(column) }))), header, ...rows]);
}

/** Where the author's links lie in a unit's text. */
function linkedRanges(root: XNode) {
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  const visit = (node: XNode): void => {
    const name = elName(node);
    if (name === "w:del" || !ownUnit(node)) return;
    if (name === "w:t") cursor += getTextContent(node).length;
    else if (name === "w:tab" || name === "w:br" || name === "w:cr") cursor += 1;
    const start = cursor;
    for (const child of elChildren(node)) visit(child);
    if (name === "w:hyperlink") ranges.push([start, cursor]);
  };
  visit(root);
  return ranges;
}

/** The TA fields a reviewed unit already holds: where each begins in its text, its category and
 *  the entry it gives the table. */
function existingMarks(root: XNode) {
  const found: Array<{ offset: number; category: number; long?: string }> = [];
  const open: Array<{ offset: number; code: string }> = [];
  let cursor = 0;
  walk(root, (node) => {
    const name = elName(node);
    if (name === "w:del") return false;
    if (name === "w:t") cursor += getTextContent(node).length;
    else if (name === "w:tab" || name === "w:br" || name === "w:cr") cursor += 1;
    else if (name === "w:instrText" && open.length) open[open.length - 1].code += getTextContent(node);
    else if (name === "w:fldChar") {
      const type = (node[ATTR_KEY] as Record<string, string> | undefined)?.["@_w:fldCharType"];
      if (type === "begin") open.push({ offset: cursor, code: "" });
      const field = type === "end" ? open.pop() : undefined;
      const category = field && /^\s*TA\b/u.test(field.code) ? /\\c\s+"?(\d+)/u.exec(field.code)?.[1] : undefined;
      if (field && category) found.push({ offset: field.offset, category: Number(category),
        long: fieldArgument(field.code, "l") });
    }
  });
  return found;
}

/** Applies the selected Word-native or static linked Authorities delivery. */
export async function applyTableOfAuthorities(
  bytes: Buffer,
  units: ReadonlyArray<{ id: string; text: string }>,
  marks: readonly DocxAuthorityMark[],
  delivery: DocxTableDelivery,
  linked: readonly DocxLinkedAuthority[] = [],
) {
  const { session, document, targets, save } = await authorityUnitPackage(bytes, units);
  const pageAt = renderedPages(document.body, targets);
  // A citation the author already marked keeps that mark, and the table lists the author's categories too.
  const existing = new Map([...targets].map(([id, node]) => [id, existingMarks(node)]));
  // Each entry is marked in full once, at its first citation, and by its short name after that, as
  // Word's Mark Citation does. A short name two entries share would join them, so those keep their
  // full name as their short name too.
  const placed = marks.filter((mark) => delivery.startsWith("native-") && mark.mark !== false &&
    !existing.get(mark.unitId)?.some(({ offset }) => offset === mark.offset));
  const shortOwners = new Map<string, Set<string>>();
  for (const { longName, shortName } of placed) {
    const key = entryText(shortName).toLocaleLowerCase("en-CA");
    shortOwners.set(key, (shortOwners.get(key) ?? new Set()).add(entryText(longName)));
  }
  const shortOf = ({ longName, shortName }: DocxAuthorityMark) =>
    shortOwners.get(entryText(shortName).toLocaleLowerCase("en-CA"))!.size > 1 ? longName : shortName;
  const firsts = new Set<DocxAuthorityMark>(), seenLong = new Set<string>();
  for (const mark of placed) if (!seenLong.has(entryText(mark.longName))) {
    seenLong.add(entryText(mark.longName)); firsts.add(mark);
  }
  // A ruled table says where each authority is cited: at the brief's numbered paragraphs where it
  // numbers the paragraphs that cite them, as court filings do, or else at its pages. Each place is a
  // field Word updates (REF to a paragraph's number, PAGEREF to a citation's page) to a bookmark.
  const ruled = delivery === "ruled-append" ? marks.filter(({ authorityId }) => authorityId) : [];
  const paragraphs = document.paragraphs.map(({ node }) => node);
  const numbers = ruled.length ? paragraphNumbers(paragraphs, await session.readXml("word/styles.xml"),
    await session.readXml("word/numbering.xml")) : new Map<XNode, { text: string; auto: boolean; level: number }>();
  // A note's citation is in the paragraph that calls the note; a citation in an unnumbered paragraph
  // (a block quote, a list) is in the numbered paragraph before it.
  const noteAt = new Map<string, number>(), numberedAt: Array<XNode | undefined> = [];
  paragraphs.forEach((node, index) => {
    walk(node, (item) => { if (elName(item) === "w:footnoteReference") noteAt.set(`footnote:${elAttrs(item)["@_w:id"]}`, index); });
    numberedAt[index] = numbers.has(node) ? node : numberedAt[index - 1];
  });
  // A citation after the last numbered paragraph (in a schedule, or the brief's own table) is at none.
  for (let index = paragraphs.length - 1; index >= 0 && !numbers.has(paragraphs[index]); index -= 1) numberedAt[index] = undefined;
  const paragraphOf = ({ unitId }: DocxAuthorityMark) => unitId.startsWith("body:")
    ? paragraphs.indexOf(targets.get(unitId) ?? {}) : noteAt.get(unitId);
  const byParagraph = ruled.length > 0 && ruled.filter((mark) => numberedAt[paragraphOf(mark) ?? -1]).length * 2 >= ruled.length;
  const bookmarks = { id: 0, names: new Set<string>() };
  for (const root of [document.body, ...targets.values()]) walk(root, (node) => {
    if (elName(node) !== "w:bookmarkStart") return;
    bookmarks.id = Math.max(bookmarks.id, Number(elAttrs(node)["@_w:id"]) || 0);
    bookmarks.names.add(elAttrs(node)["@_w:name"]);
  });
  const bookmark = () => {
    let name: string;
    do name = `_Toa${(bookmarks.id += 1)}`; while (bookmarks.names.has(name));
    return { name, start: makeEl("w:bookmarkStart", [], { "w:id": String(bookmarks.id), "w:name": name }),
      end: makeEl("w:bookmarkEnd", [], { "w:id": String(bookmarks.id) }) };
  };
  const field = (code: string, result: string) => [makeEl("w:r", [makeEl("w:fldChar", [], { "w:fldCharType": "begin" })]),
    makeEl("w:r", [makeEl("w:instrText", [makeText(` ${code} `)], { "xml:space": "preserve" })]),
    makeEl("w:r", [makeEl("w:fldChar", [], { "w:fldCharType": "separate" })]),
    makeEl("w:r", [makeEl("w:rPr", [makeEl("w:noProof", [])]), makeEl("w:t", [makeText(result)])]),
    makeEl("w:r", [makeEl("w:fldChar", [], { "w:fldCharType": "end" })])];
  const citedAt = new Map<string, XNode[][]>(), pageMarks = new Map<DocxAuthorityMark, ReturnType<typeof bookmark>>();
  const paragraphMarks = new Map<XNode, ReturnType<typeof bookmark>>();
  for (const authorityId of new Set(ruled.map((mark) => mark.authorityId!))) {
    const cited = ruled.filter((mark) => mark.authorityId === authorityId);
    if (byParagraph) {
      const at = [...new Set(cited.flatMap((mark): XNode[] => { const node = numberedAt[paragraphOf(mark) ?? -1]; return node ? [node] : []; }))]
        .sort((left, right) => paragraphs.indexOf(left) - paragraphs.indexOf(right));
      citedAt.set(authorityId, at.map((node) => {
        const { text, auto } = numbers.get(node)!;
        if (!auto) return [makeEl("w:r", [makeEl("w:t", [makeText(text)])])];
        const target = paragraphMarks.get(node) ?? paragraphMarks.set(node, bookmark()).get(node)!;
        return field(`REF ${target.name} \\n \\h`, text);
      }));
    } else {
      const pages = new Map<number, DocxAuthorityMark>();
      for (const mark of cited) {
        const page = pageAt(mark.unitId, mark.offset);
        if (!pages.has(page)) pages.set(page, mark);
      }
      citedAt.set(authorityId, [...pages].sort(([left], [right]) => left - right).map(([page, mark]) => {
        const target = pageMarks.set(mark, bookmark()).get(mark)!;
        return field(`PAGEREF ${target.name} \\h`, String(page));
      }));
    }
  }
  for (const [node, { start, end }] of paragraphMarks) {
    const children = elChildren(node), first = elName(children[0]) === "w:pPr" ? 1 : 0;
    children.splice(first, 0, start);
    children.push(end);
  }
  for (const mark of [...marks].sort((left, right) =>
      right.unitId.localeCompare(left.unitId) || right.offset - left.offset)) {
      const target = targets.get(mark.unitId);
      if (!target) throw new Error(`Reviewed Word location is missing: ${mark.unitId}.`);
      const page = pageMarks.get(mark);
      if (page) insertAtOffset(target, mark.offset, [page.start, page.end]);
      if (mark.suffix) {
        const run = makeEl("w:r", [makeEl("w:t", [makeText(mark.suffix)], { "xml:space": "preserve" })]);
        insertAtOffset(target, mark.offset, [mark.tabUrl ? makeEl("w:fldSimple", [run], {
          "w:instr": ` HYPERLINK "${mark.tabUrl}" `,
        }) : run]);
      }
      if (placed.includes(mark)) {
        const long = entryText(mark.longName), lead = fieldText(long.slice(0, mark.italic ?? 0));
        const short = fieldText(entryText(shortOf(mark)));
        const rest = `${fieldText(long.slice(mark.italic ?? 0))}" \\s "${short}" \\c ${mark.category} `;
        insertAtOffset(target, mark.offset, !firsts.has(mark) ? fieldRuns(` TA \\s "${short}" `)
          : lead ? fieldRuns(" TA \\l \"", { italic: lead }, rest) : fieldRuns(` TA \\l "${rest}`));
      }
      // A pinpoint the author already linked keeps that link.
      if (mark.pinpointLink && !linkedRanges(target).some(([from, to]) =>
        mark.pinpointLink!.start < to && from < mark.pinpointLink!.end)) {
        const { start, end, url } = mark.pinpointLink;
        insertAtOffset(target, end, [makeEl("w:r", [makeEl("w:fldChar", [], { "w:fldCharType": "end" })])]);
        insertAtOffset(target, start, [
          makeEl("w:r", [makeEl("w:fldChar", [], { "w:fldCharType": "begin" })]),
          makeEl("w:r", [makeEl("w:instrText", [makeText(` HYPERLINK "${url}" `)], { "xml:space": "preserve" })]),
          makeEl("w:r", [makeEl("w:fldChar", [], { "w:fldCharType": "separate" })]),
        ]);
      }
    }
  const body = document.body, children = elChildren(body);
  const section = children.findIndex((node) => elName(node) === "w:sectPr"), width = textWidth(children[section]);
  // Word's table lists one category per field, under that category's heading, as Word does for "All";
  // the brief's own marks are listed with ours, each entry with the pages its citations are on.
  const entries = new Map<number, Map<string, TableEntry>>(), longOf = new Map<string, number>();
  for (const { category, longName } of firsts) longOf.set(entryText(longName), category);
  const add = (category: number, long: string, italic: number, page?: number) => {
    const names = entries.get(category) ?? entries.set(category, new Map()).get(category)!;
    const entry = names.get(long) ?? names.set(long, { italic, pages: new Set() }).get(long)!;
    if (page) entry.pages.add(page);
  };
  for (const mark of placed) add(longOf.get(entryText(mark.longName))!, entryText(mark.longName), mark.italic ?? 0,
    pageAt(mark.unitId, mark.offset));
  for (const [unitId, marks] of existing) for (const { category, long, offset } of marks)
    if (long) add(category, entryText(long), 0, pageAt(unitId, offset));
  const heading = [
    makeEl("w:p", [makeEl("w:r", [makeEl("w:br", [], { "w:type": "page" })])]),
    // A heading of the brief's own look, without the number its headings may carry ("V.") or the
    // indent that number takes.
    makeEl("w:p", [makeEl("w:pPr", [makeEl("w:pStyle", [], { "w:val": "Heading1" }),
      makeEl("w:numPr", [makeEl("w:ilvl", [], { "w:val": "0" }), makeEl("w:numId", [], { "w:val": "0" })]),
      makeEl("w:ind", [], { "w:left": "0", "w:right": "0", "w:firstLine": "0" })]),
    makeEl("w:r", [makeEl("w:rPr", [makeEl("w:b", [])]), makeEl("w:t", [makeText("Table of Authorities")])])]),
  ];
  const appended = delivery === "native-append" ? [...heading, ...tableFields(entries, width)]
    : delivery === "linked-append" ? linkedTable(linked)
      // Word ends the body with a paragraph, never a table.
      : delivery === "ruled-append" ? [...heading, ruledTable(linked.map((entry) => ({ ...entry,
        citedAt: citedAt.get(entry.authorityId ?? "") ?? [] })), width, byParagraph ? "paragraph" : "page"), makeEl("w:p", [])]
        : [];
  children.splice(section < 0 ? children.length : section, 0, ...appended);
  if (delivery === "native-append") {
    const styles = await session.readXml("word/styles.xml");
    const styleRoot = styles?.find((node) => elName(node) === "w:styles");
    if (styles && styleRoot) {
      const present = new Set(elChildren(styleRoot).map((node) => elAttrs(node)["@_w:styleId"]));
      elChildren(styleRoot).push(...tableStyles(width).filter((style) => !present.has(elAttrs(style)["@_w:styleId"]))
        .map(cloneNode));
      session.write("word/styles.xml", ensureXmlDeclaration(createBuilder().build(styles)));
    }
  }
  // The table's page numbers are Word's own layout, so Word is asked to update the table on opening.
  const settings = delivery === "native-append" || ruled.length ? await session.readXml("word/settings.xml") : undefined;
  const root = settings?.find((node) => elName(node) === "w:settings");
  if (settings && root) {
    const settingsChildren = elChildren(root);
    const update = settingsChildren.find((node) => elName(node) === "w:updateFields");
    if (update) update[ATTR_KEY] = { "@_w:val": "true" };
    else {
      const after = settingsChildren.findIndex((node) => {
        const name = elName(node);
        return name !== null && (SETTINGS_AFTER_UPDATE_FIELDS.has(name) || !name.startsWith("w:"));
      });
      settingsChildren.splice(after < 0 ? settingsChildren.length : after, 0,
        makeEl("w:updateFields", [], { "w:val": "true" }));
    }
    session.write("word/settings.xml", ensureXmlDeclaration(createBuilder().build(settings)));
  }
  return save();
}
