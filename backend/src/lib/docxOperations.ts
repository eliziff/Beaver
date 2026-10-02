import { openDocxSession } from "./docx/session";
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
  shortName: string;
  category: 1 | 2 | 3 | 5;
  suffix?: string;
  mark?: boolean;
  tabUrl?: string;
  pinpointLink?: { start: number; end: number; url: string };
};
export type DocxTableDelivery = "native-marks" | "native-append" | "linked-append";
export type DocxLinkedAuthority = { label: string; url: string | null };

function walk(root: XNode | XNode[], visit: (node: XNode) => boolean | void) {
  const pending = (Array.isArray(root) ? root : [root]).slice().reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (visit(node) === false) continue;
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
  const targets = new Map<string, XNode>();
  document.paragraphs.forEach(({ node }, ordinal) => targets.set(`body:${ordinal}`, node));
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

/** A TA mark as Word itself writes it: no result, and not hidden text, or Word's table leaves it out. */
function fieldRuns(instruction: string) {
  const run = (child: XNode) => makeEl("w:r", [child]);
  return [
    run(makeEl("w:fldChar", [], { "w:fldCharType": "begin" })),
    run(makeEl("w:instrText", [makeText(instruction)], { "xml:space": "preserve" })),
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
    if (after || elName(node) === "w:del") return;
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
const insertField = (root: XNode, offset: number, instruction: string) =>
  insertAtOffset(root, offset, fieldRuns(instruction));

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
const fieldText = (value: string) => entryText(value).replace(/["“”]/gu, "\\$&");
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
/** Word's own names for its first seven citation categories. */
const CATEGORY_NAMES: Record<number, string> = { 1: "Cases", 2: "Statutes", 3: "Other Authorities", 4: "Rules",
  5: "Treatises", 6: "Regulations", 7: "Constitutional Provisions" };
/** Word's sort of a table's entries: case and accents second, spaces and punctuation before digits
 *  and digits before letters. */
const entryOrder = new Intl.Collator("en", { numeric: false }).compare;
/** The styles Word gives a table of authorities, added when the brief has none of its own. */
const TABLE_STYLES = [
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
    makeEl("w:pPr", [makeEl("w:ind", [], { "w:left": "220", "w:hanging": "220" })])],
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

/** One TOA field per category, each with the table Word would show for it already in its result,
 *  so the table reads as soon as the brief opens: the category's heading, then each entry on its
 *  own line, sorted as Word sorts them. Page numbers are Word's own layout, so they come when Word
 *  updates the field. */
function tableFields(entries: ReadonlyMap<number, ReadonlySet<string>>, width: number) {
  const tabs = makeEl("w:tabs", [makeEl("w:tab", [], { "w:val": "right", "w:leader": "dot", "w:pos": String(width) })]);
  const paragraph = (style: string, runs: XNode[]) => makeEl("w:p", [
    makeEl("w:pPr", [makeEl("w:pStyle", [], { "w:val": style }), cloneNode(tabs)]), ...runs]);
  const text = (value: string) => makeEl("w:r", [makeEl("w:rPr", [makeEl("w:noProof", [])]),
    makeEl("w:t", [makeText(value)], /^\s|\s$/u.test(value) ? { "xml:space": "preserve" } : {})]);
  const char = (type: string) => makeEl("w:r", [makeEl("w:fldChar", [], { "w:fldCharType": type })]);
  return [...entries].sort(([left], [right]) => left - right).flatMap(([category, names]) => [
    paragraph("TOAHeading", [char("begin"), makeEl("w:r", [makeEl("w:instrText", [makeText(` TOA \\h \\c "${category}" `)],
      { "xml:space": "preserve" })]), char("separate"), text(CATEGORY_NAMES[category] ?? String(category))]),
    ...[...names].sort(entryOrder).map((name) => paragraph("TableofAuthorities", [text(name)])),
    makeEl("w:p", [char("end")]),
  ]);
}

function linkedTable(entries: readonly DocxLinkedAuthority[]) {
  const run = (value: string, linked = false) => makeEl("w:r", [
    ...(linked ? [makeEl("w:rPr", [makeEl("w:color", [], { "w:val": "0563C1" }),
      makeEl("w:u", [], { "w:val": "single" })])] : []),
    makeEl("w:t", [makeText(value)], /^\s|\s$/u.test(value)
      ? { "xml:space": "preserve" } : {}),
  ]);
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
    ...entries.map(({ label, url }, index) => {
      const href = link(url), children = [run(`${index + 1}. `)];
      children.push(href ? makeEl("w:fldSimple", [run(label, true)], {
        "w:instr": ` HYPERLINK "${href}" `,
      }) : run(label));
      return makeEl("w:p", children);
    }),
  ];
}

/** Where the author's links lie in a unit's text. */
function linkedRanges(root: XNode) {
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  const visit = (node: XNode): void => {
    const name = elName(node);
    if (name === "w:del") return;
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
  // A citation the author already marked keeps that mark, and the table lists the author's categories too.
  const existing = new Map([...targets].map(([id, node]) => [id, existingMarks(node)]));
  // Each entry is marked in full once, at its first citation, and by its short name after that, as
  // Word's Mark Citation does. A short name two entries share would join them, so those keep their
  // full name as their short name too.
  const placed = marks.filter((mark) => delivery !== "linked-append" && mark.mark !== false &&
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
  for (const mark of [...marks].sort((left, right) =>
      right.unitId.localeCompare(left.unitId) || right.offset - left.offset)) {
      const target = targets.get(mark.unitId);
      if (!target) throw new Error(`Reviewed Word location is missing: ${mark.unitId}.`);
      if (mark.suffix) {
        const run = makeEl("w:r", [makeEl("w:t", [makeText(mark.suffix)], { "xml:space": "preserve" })]);
        insertAtOffset(target, mark.offset, [mark.tabUrl ? makeEl("w:fldSimple", [run], {
          "w:instr": ` HYPERLINK "${mark.tabUrl}" `,
        }) : run]);
      }
      if (placed.includes(mark)) insertField(target, mark.offset, firsts.has(mark)
        ? ` TA \\l "${fieldText(mark.longName)}" \\s "${fieldText(shortOf(mark))}" \\c ${mark.category} `
        : ` TA \\s "${fieldText(shortOf(mark))}" `);
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
  const section = children.findIndex((node) => elName(node) === "w:sectPr");
  // Word's table lists one category per field, under that category's heading, as Word does for "All";
  // the brief's own marks are listed with ours.
  const entries = new Map<number, Set<string>>();
  for (const { category, long } of [...[...firsts].map(({ category, longName }) => ({ category, long: longName })),
    ...[...existing.values()].flat()]) {
    const names = entries.get(category) ?? entries.set(category, new Set()).get(category)!;
    if (long) names.add(entryText(long));
  }
  const appended = delivery === "native-append" ? [
    makeEl("w:p", [makeEl("w:r", [makeEl("w:br", [], { "w:type": "page" })])]),
    makeEl("w:p", [makeEl("w:pPr", [makeEl("w:pStyle", [], { "w:val": "Heading1" })]),
      makeEl("w:r", [makeEl("w:t", [makeText("Table of Authorities")])])]),
    ...tableFields(entries.size ? entries : new Map([[1, new Set<string>()]]), textWidth(children[section])),
  ] : delivery === "linked-append" ? linkedTable(linked) : [];
  children.splice(section < 0 ? children.length : section, 0, ...appended);
  if (delivery === "native-append") {
    const styles = await session.readXml("word/styles.xml");
    const styleRoot = styles?.find((node) => elName(node) === "w:styles");
    if (styles && styleRoot) {
      const present = new Set(elChildren(styleRoot).map((node) => elAttrs(node)["@_w:styleId"]));
      elChildren(styleRoot).push(...TABLE_STYLES.filter((style) => !present.has(elAttrs(style)["@_w:styleId"]))
        .map(cloneNode));
      session.write("word/styles.xml", ensureXmlDeclaration(createBuilder().build(styles)));
    }
  }
  // The table's page numbers are Word's own layout, so Word is asked to update the table on opening.
  const settings = delivery === "native-append" ? await session.readXml("word/settings.xml") : undefined;
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
