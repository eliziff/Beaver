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

function fieldRuns(instruction: string, hidden: boolean) {
  const run = (child: XNode) => makeEl("w:r", [
    ...(hidden ? [makeEl("w:rPr", [makeEl("w:vanish")])] : []), child,
  ]);
  return [
    run(makeEl("w:fldChar", [], { "w:fldCharType": "begin", "w:dirty": "true" })),
    run(makeEl("w:instrText", [makeText(instruction)], { "xml:space": "preserve" })),
    run(makeEl("w:fldChar", [], { "w:fldCharType": "separate" })),
    run(makeEl("w:fldChar", [], { "w:fldCharType": "end" })),
  ];
}

function insertField(root: XNode, offset: number, instruction: string) {
  let cursor = 0;
  let target: { node: XNode; run: XNode; parent: XNode } | null = null;
  const descend = (node: XNode, parent: XNode | null, run: XNode | null,
    runParent: XNode | null): void => {
    if (target || elName(node) === "w:del") return;
    const name = elName(node);
    const nextRun = name === "w:r" ? node : run;
    const nextRunParent = name === "w:r" ? parent : runParent;
    if (name === "w:t") {
      const value = getTextContent(node), end = cursor + value.length;
      if (cursor <= offset && offset <= end && nextRun && nextRunParent) {
        target = { node, run: nextRun, parent: nextRunParent };
      }
      cursor = end;
      return;
    }
    if (name === "w:tab" || name === "w:br" || name === "w:cr") cursor += 1;
    for (const child of elChildren(node)) descend(child, node, nextRun, nextRunParent);
  };
  descend(root, null, null, null);
  if (!target) throw new Error("A reviewed citation no longer matches the Word document.");
  const { node, run, parent } = target;
  const runChildren = elChildren(run), textIndex = runChildren.indexOf(node);
  const parentChildren = elChildren(parent), runIndex = parentChildren.indexOf(run);
  if (textIndex < 0 || runIndex < 0) {
    throw new Error("A reviewed citation is inside unsupported Word markup.");
  }
  const value = getTextContent(node), local = offset - (cursor - value.length);
  const rightRun = cloneNode(run), rightChildren = elChildren(rightRun);
  setText(node, value.slice(0, local));
  setChildren(run, runChildren.slice(0, textIndex + 1));
  setText(rightChildren[textIndex], value.slice(local));
  const tail = [
    ...rightChildren.slice(0, textIndex).filter((child) => elName(child) === "w:rPr"),
    rightChildren[textIndex], ...rightChildren.slice(textIndex + 1),
  ];
  setChildren(rightRun, tail);
  parentChildren.splice(runIndex + 1, 0, ...fieldRuns(instruction, true),
    ...(visibleText(rightRun) || tail.some((child) => elName(child) !== "w:rPr")
      ? [rightRun] : []));
}

const fieldText = (value: string) => value.replace(/\s+/gu, " ").trim()
  .replace(/["\\]/gu, "'");

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

/** Applies the selected Word-native or static linked Authorities delivery. */
export async function applyTableOfAuthorities(
  bytes: Buffer,
  units: ReadonlyArray<{ id: string; text: string }>,
  marks: readonly DocxAuthorityMark[],
  delivery: DocxTableDelivery,
  linked: readonly DocxLinkedAuthority[] = [],
) {
  const { session, document, targets, save } = await authorityUnitPackage(bytes, units);
  if (delivery !== "linked-append") {
    for (const mark of [...marks].sort((left, right) =>
      right.unitId.localeCompare(left.unitId) || right.offset - left.offset)) {
      const target = targets.get(mark.unitId);
      if (!target) throw new Error(`Reviewed Word location is missing: ${mark.unitId}.`);
      insertField(target, mark.offset,
        ` TA \\l "${fieldText(mark.longName)}" \\s "${fieldText(mark.shortName)}" \\c ${mark.category} `);
    }
  }
  const body = document.body, children = elChildren(body);
  const section = children.findIndex((node) => elName(node) === "w:sectPr");
  const appended = delivery === "native-append" ? [
    makeEl("w:p", [makeEl("w:r", [makeEl("w:br", [], { "w:type": "page" })])]),
    makeEl("w:p", [makeEl("w:pPr", [makeEl("w:pStyle", [], { "w:val": "Heading1" })]),
      makeEl("w:r", [makeEl("w:t", [makeText("Table of Authorities")])])]),
    makeEl("w:p", fieldRuns(' TOA \\h \\e "\\t" ', false)),
  ] : delivery === "linked-append" ? linkedTable(linked) : [];
  children.splice(section < 0 ? children.length : section, 0, ...appended);
  const settings = await session.readXml("word/settings.xml");
  const root = settings?.find((node) => elName(node) === "w:settings");
  if (root) {
    const update = elChildren(root).find((node) => elName(node) === "w:updateFields");
    if (update) update[ATTR_KEY] = { "@_w:val": "true" };
    else elChildren(root).push(makeEl("w:updateFields", [], { "w:val": "true" }));
    session.write("word/settings.xml", ensureXmlDeclaration(createBuilder().build(settings)));
  }
  return save();
}
