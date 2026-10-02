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

/** A field as Word itself writes it. A TA mark has no result and is not hidden text, or Word's
 *  table leaves it out; a table has a result, which Word fills in when it updates the field. */
function fieldRuns(instruction: string, result: boolean) {
  const run = (child: XNode) => makeEl("w:r", [child]);
  return [
    run(makeEl("w:fldChar", [], { "w:fldCharType": "begin", ...(result && { "w:dirty": "true" }) })),
    run(makeEl("w:instrText", [makeText(instruction)], { "xml:space": "preserve" })),
    ...(result ? [run(makeEl("w:fldChar", [], { "w:fldCharType": "separate" }))] : []),
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
  insertAtOffset(root, offset, fieldRuns(instruction, false));

/** Settings Word writes after updateFields (CT_Settings order); extension settings come last. */
const SETTINGS_AFTER_UPDATE_FIELDS = new Set(["w:hdrShapeDefaults", "w:footnotePr", "w:endnotePr",
  "w:compat", "w:docVars", "w:rsids", "w:attachedSchema", "w:themeFontLang", "w:clrSchemeMapping",
  "w:doNotIncludeSubdocsInStats", "w:doNotAutoCompressPictures", "w:forceUpgrade", "w:captions",
  "w:readModeInkLockDown", "w:smartTagType", "w:shapeDefaults", "w:doNotEmbedSmartTags",
  "w:decimalSymbol", "w:listSeparator"]);
/** A field argument's text. Word ends the argument at a straight or curly double quote, so each
 *  is escaped with a backslash, as Word's own Mark Citation escapes a straight one. */
const fieldText = (value: string) => value.replace(/\s+/gu, " ").trim()
  .replace(/\\/gu, "'").replace(/["“”]/gu, "\\$&");

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

/** The TA fields a reviewed unit already holds: where each begins in its text, and its category. */
function existingMarks(root: XNode) {
  const found: Array<{ offset: number; category: number }> = [], open: Array<{ offset: number; code: string }> = [];
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
      if (field && category) found.push({ offset: field.offset, category: Number(category) });
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
      if (delivery !== "linked-append" && mark.mark !== false &&
        !existing.get(mark.unitId)?.some(({ offset }) => offset === mark.offset)) insertField(target, mark.offset,
        ` TA \\l "${fieldText(mark.longName)}" \\s "${fieldText(mark.shortName)}" \\c ${mark.category} `);
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
  // Word's table lists one category per field, under that category's heading, as Word does for "All".
  const categories = [...new Set([...marks.filter((mark) => mark.mark !== false).map(({ category }) => category),
    ...[...existing.values()].flat().map(({ category }) => category)])].sort((left, right) => left - right);
  const appended = delivery === "native-append" ? [
    makeEl("w:p", [makeEl("w:r", [makeEl("w:br", [], { "w:type": "page" })])]),
    makeEl("w:p", [makeEl("w:pPr", [makeEl("w:pStyle", [], { "w:val": "Heading1" })]),
      makeEl("w:r", [makeEl("w:t", [makeText("Table of Authorities")])])]),
    ...(categories.length ? categories : [1]).map((category) =>
      makeEl("w:p", fieldRuns(` TOA \\h \\c "${category}" `, true))),
  ] : delivery === "linked-append" ? linkedTable(linked) : [];
  children.splice(section < 0 ? children.length : section, 0, ...appended);
  // Word refreshes the fields it is given; a copy with only tab references has none to refresh.
  const fields = delivery !== "native-marks" || marks.some((mark) => mark.mark !== false);
  const settings = fields ? await session.readXml("word/settings.xml") : undefined;
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
