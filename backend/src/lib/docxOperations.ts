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
import {
  applyTrackedEdits,
  extractDocxBodyText,
  type AppliedChange,
} from "./docxTrackedChanges";
import { sha256 } from "./hash";

const BODY_PART = "word/document.xml" as const;
const BODY_COORDINATE = "accepted_body_text" as const;
const RECEIPT_SCHEMA = 1 as const;
const SHA256 = /^[0-9a-f]{64}$/u;

export type DocxVersionSource = {
  documentId: string;
  versionId: string;
  sourceSha256: string;
};

export type DocxBodyInspection = {
  source: DocxVersionSource;
  part: typeof BODY_PART;
  text: string;
  textSha256: string;
};

export type DocxBodyEditReceipt = {
  schemaVersion: typeof RECEIPT_SCHEMA;
  receiptId: string;
  source: DocxVersionSource;
  body: { beforeSha256: string; afterSha256: string };
  target: {
    part: typeof BODY_PART;
    coordinate: typeof BODY_COORDINATE;
    start: number;
    end: number;
    text: string;
    textSha256: string;
  };
  operation: { kind: "replace_text"; replacement: string; tracked: true };
};

export type DocxBodyEditResult = {
  status: "applied" | "unchanged";
  bytes: Buffer;
  receiptId: string;
  sourceSha256: string;
  changes: AppliedChange[];
};

export type DocxOperationErrorCode =
  | "invalid_receipt"
  | "stale_source"
  | "stale_target"
  | "unsupported_target";

class DocxOperationError extends Error {
  readonly name = "DocxOperationError";

  constructor(
    readonly code: DocxOperationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: DocxOperationErrorCode, message: string): never {
  throw new DocxOperationError(code, message);
}

function assertSource(bytes: Buffer, source: DocxVersionSource) {
  if (typeof source?.documentId !== "string" || !source.documentId ||
      typeof source.versionId !== "string" || !source.versionId ||
      typeof source.sourceSha256 !== "string" || !SHA256.test(source.sourceSha256) ||
      sha256(bytes) !== source.sourceSha256) {
    fail("stale_source", "DOCX bytes no longer match the pinned document version");
  }
}

function receiptDigest(receipt: Omit<DocxBodyEditReceipt, "receiptId">) {
  return sha256(JSON.stringify([
    receipt.schemaVersion,
    receipt.source.documentId,
    receipt.source.versionId,
    receipt.source.sourceSha256,
    receipt.body.beforeSha256,
    receipt.body.afterSha256,
    receipt.target.part,
    receipt.target.coordinate,
    receipt.target.start,
    receipt.target.end,
    receipt.target.text,
    receipt.target.textSha256,
    receipt.operation.kind,
    receipt.operation.replacement,
    receipt.operation.tracked,
  ]));
}

function assertReceipt(receipt: DocxBodyEditReceipt) {
  const valid = !!receipt && typeof receipt === "object" &&
    receipt.schemaVersion === RECEIPT_SCHEMA &&
    typeof receipt.receiptId === "string" && SHA256.test(receipt.receiptId) &&
    !!receipt.source && typeof receipt.source === "object" &&
    typeof receipt.source.documentId === "string" && !!receipt.source.documentId &&
    typeof receipt.source.versionId === "string" && !!receipt.source.versionId &&
    typeof receipt.source.sourceSha256 === "string" &&
    SHA256.test(receipt.source.sourceSha256) &&
    !!receipt.body && typeof receipt.body === "object" &&
    typeof receipt.body.beforeSha256 === "string" &&
    SHA256.test(receipt.body.beforeSha256) &&
    typeof receipt.body.afterSha256 === "string" &&
    SHA256.test(receipt.body.afterSha256) &&
    !!receipt.target && typeof receipt.target === "object" &&
    receipt.target.part === BODY_PART &&
    receipt.target.coordinate === BODY_COORDINATE &&
    typeof receipt.target.text === "string" &&
    typeof receipt.target.textSha256 === "string" &&
    SHA256.test(receipt.target.textSha256) &&
    !!receipt.operation && typeof receipt.operation === "object" &&
    receipt.operation.kind === "replace_text" &&
    typeof receipt.operation.replacement === "string" &&
    receipt.operation.tracked === true &&
    Number.isSafeInteger(receipt.target.start) &&
    Number.isSafeInteger(receipt.target.end) &&
    receipt.target.start >= 0 &&
    receipt.target.end > receipt.target.start &&
    receipt.target.text.length === receipt.target.end - receipt.target.start &&
    receipt.target.textSha256 === sha256(receipt.target.text) &&
    receipt.receiptId === receiptDigest(receipt);
  if (!valid) fail("invalid_receipt", "DOCX edit receipt is invalid or was modified");
}

export async function inspectDocxBody(
  bytes: Buffer,
  source: DocxVersionSource,
): Promise<DocxBodyInspection> {
  assertSource(bytes, source);
  const session = await openDocxSession(bytes);
  const text = (await session.document()).text;
  return { source: { ...source }, part: BODY_PART, text, textSha256: sha256(text) };
}

export function previewDocxBodyEdit(
  inspection: DocxBodyInspection,
  input: {
    target: { part: typeof BODY_PART; start: number; end: number };
    replacement: string;
    tracked?: boolean;
  },
): DocxBodyEditReceipt {
  const { start, end } = input.target;
  if (input.target.part !== BODY_PART || !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) || start < 0 || end <= start ||
      end > inspection.text.length) {
    fail("unsupported_target", "DOCX edit target must be one exact main-body span");
  }
  const before = inspection.text.slice(start, end);
  if (before.includes("\n") || input.replacement.includes("\n")) {
    fail("unsupported_target", "This first DOCX edit slice cannot cross a paragraph boundary");
  }
  if (input.tracked === false) {
    fail("unsupported_target", "Direct DOCX edits are not supported; tracked changes are required");
  }
  if (before === input.replacement) {
    fail("unsupported_target", "DOCX replacement must change the target text");
  }

  const after = inspection.text.slice(0, start) + input.replacement +
    inspection.text.slice(end);
  const unsigned: Omit<DocxBodyEditReceipt, "receiptId"> = {
    schemaVersion: RECEIPT_SCHEMA,
    source: { ...inspection.source },
    body: { beforeSha256: inspection.textSha256, afterSha256: sha256(after) },
    target: {
      part: BODY_PART,
      coordinate: BODY_COORDINATE,
      start,
      end,
      text: before,
      textSha256: sha256(before),
    },
    operation: {
      kind: "replace_text",
      replacement: input.replacement,
      tracked: true,
    },
  };
  return { ...unsigned, receiptId: receiptDigest(unsigned) };
}

export async function applyDocxBodyEdit(
  bytes: Buffer,
  source: DocxVersionSource,
  receipt: DocxBodyEditReceipt,
): Promise<DocxBodyEditResult> {
  assertReceipt(receipt);
  assertSource(bytes, source);
  if (source.documentId !== receipt.source.documentId) {
    fail("stale_source", "DOCX edit receipt belongs to another document");
  }

  const text = await extractDocxBodyText(bytes);
  const textSha256 = sha256(text);
  const replacement = receipt.operation.replacement;
  // ponytail: replay is recognized on the exact accepted-text result in a
  // later immutable version of the same document; add a durable operation key
  // only if independent package-only mutations make this test insufficient.
  if (textSha256 === receipt.body.afterSha256 &&
      text.slice(receipt.target.start, receipt.target.start + replacement.length) ===
        replacement) {
    return {
      status: "unchanged",
      bytes,
      receiptId: receipt.receiptId,
      sourceSha256: source.sourceSha256,
      changes: [],
    };
  }
  if (source.versionId !== receipt.source.versionId ||
      source.sourceSha256 !== receipt.source.sourceSha256) {
    fail("stale_source", "DOCX changed after this edit was previewed");
  }
  if (textSha256 !== receipt.body.beforeSha256 ||
      text.slice(receipt.target.start, receipt.target.end) !== receipt.target.text) {
    fail("stale_target", "DOCX target text no longer matches the preview receipt");
  }

  const applied = await applyTrackedEdits(bytes, [{
    find: receipt.target.text,
    replace: receipt.operation.replacement,
    context_before: "",
    context_after: "",
    exact_start: receipt.target.start,
    exact_end: receipt.target.end,
  }], { author: "Beaver" });
  if (applied.errors.length || applied.changes.length !== 1) {
    fail(
      "unsupported_target",
      applied.errors[0]?.reason ?? "DOCX tracked edit did not produce one reviewable change",
    );
  }
  if (sha256(await extractDocxBodyText(applied.bytes)) !== receipt.body.afterSha256) {
    fail("stale_target", "DOCX edit result did not match its preview receipt");
  }
  return {
    status: "applied",
    bytes: applied.bytes,
    receiptId: receipt.receiptId,
    sourceSha256: sha256(applied.bytes),
    changes: applied.changes,
  };
}

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

async function authorityUnitPackage(session: Awaited<ReturnType<typeof openDocxSession>>) {
  const document = await session.document(), footnotes = await session.readXml("word/footnotes.xml");
  const targets = new Map<string, XNode>();
  document.paragraphs.forEach(({ node }, ordinal) => targets.set(`body:${ordinal}`, node));
  if (footnotes) walk(footnotes, (node) => {
    if (elName(node) === "w:footnote") {
      const id = elAttrs(node)["@_w:id"];
      if (id && Number(id) > 0) targets.set(`footnote:${id}`, node);
    }
  });
  return { document, footnotes, targets };
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
  const session = await openDocxSession(bytes);
  const { document, footnotes, targets } = await authorityUnitPackage(session);
  for (const unit of units) if (visibleText(targets.get(unit.id) ?? {}) !== unit.text) {
    throw new Error(`Reviewed text no longer matches ${unit.id}.`);
  }
  const target = targets.get(correction.unitId);
  if (!target || correction.start < 0 || correction.end <= correction.start ||
      visibleText(target).slice(correction.start, correction.end) !== correction.expected ||
      !correction.replacement || !replaceVisibleSpan(target, correction.start,
        correction.end, correction.replacement)) {
    throw new Error("The accepted correction no longer matches the reviewed Word document.");
  }
  session.writeDocument(document.tree);
  if (footnotes) session.write("word/footnotes.xml",
    ensureXmlDeclaration(createBuilder().build(footnotes)));
  return session.save();
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
  const session = await openDocxSession(bytes);
  const { document, footnotes, targets } = await authorityUnitPackage(session);
  for (const unit of units) {
    if (visibleText(targets.get(unit.id) ?? {}) !== unit.text) {
      throw new Error(`Reviewed text no longer matches ${unit.id}.`);
    }
  }
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
  session.writeDocument(document.tree);
  if (footnotes) session.write("word/footnotes.xml",
    ensureXmlDeclaration(createBuilder().build(footnotes)));
  const settings = await session.readXml("word/settings.xml");
  const root = settings?.find((node) => elName(node) === "w:settings");
  if (root) {
    const update = elChildren(root).find((node) => elName(node) === "w:updateFields");
    if (update) update[ATTR_KEY] = { "@_w:val": "true" };
    else elChildren(root).push(makeEl("w:updateFields", [], { "w:val": "true" }));
    session.write("word/settings.xml", ensureXmlDeclaration(createBuilder().build(settings)));
  }
  return session.save();
}

/** Existing native-append primitive retained for direct callers. */
export const addNativeTableOfAuthorities = (
  bytes: Buffer,
  units: ReadonlyArray<{ id: string; text: string }>,
  marks: readonly DocxAuthorityMark[],
) => applyTableOfAuthorities(bytes, units, marks, "native-append");
