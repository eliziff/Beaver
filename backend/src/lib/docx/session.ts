/**
 * Canonical bounded DOCX package and paragraph index. Package consumers read,
 * parse, traverse, and write parts through this module so ZIP and accepted-text
 * semantics are defined once while format-specific algorithms stay separate.
 */

import type JSZip from "jszip";
import { assertBoundedZip, loadZip, readZipEntry, zipReadBudget } from "../zip";
import {
  type XNode,
  MAX_DRAFTING_DOCX_BYTES,
  MAX_DRAFTING_XML_ENTRY_BYTES,
  createBuilder,
  createParser,
  elAttrs,
  elChildren,
  elName,
  ensureXmlDeclaration,
  findBody,
  getTextContent,
} from "./core";

const MAX_ZIP_ENTRIES = 2_048;
const MAX_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_MARKUP_DEPTH = 256;

const BLOCK_CONTAINER = /^w:(?:tbl|tr|tc|sdt|sdtContent)$/u;
const INLINE_SKIP = /^(?:w:(?:pPr|rPr|sectPr|tblPr|trPr|tcPr|tblGrid|sdtPr|sdtEndPr|bookmarkStart|bookmarkEnd|proofErr|commentReference)|mc:Fallback)$/u;
const REWRITE_KEEP = /^w:(?:bookmarkStart|bookmarkEnd|proofErr|commentRangeStart|commentRangeEnd)$/u;
const REWRITE_ATOMIC = /^w:(?:footnoteReference|endnoteReference|commentReference|drawing)$/u;
const OBJECT_ELEMENT = /^w:(?:footnoteReference|endnoteReference|drawing|object|pict|fldChar|fldSimple)$/u;

interface DocxEditRun {
  childIndex: number;
  rPr: XNode | null;
  protectedByContentControl: boolean;
  textNodes: Array<{ paraStart: number; paraEnd: number }>;
}

export type DocxRewriteAtom =
  | { kind: "chars"; text: string; rPr: XNode | null }
  | { kind: "tab" | "br"; rPr: XNode | null }
  | { kind: "keep"; node: XNode };
type DocxRewrite =
  | { ok: true; atoms: DocxRewriteAtom[]; text: string }
  | { ok: false; reason: string };

interface DocxIndexedRun {
  text: string;
  ins: boolean;
  del: boolean;
  strike: boolean;
  color: string | null;
  hyperlinkId: string | null;
  story: boolean;
}

type DocxInlineEvent =
  | { kind: "run"; run: DocxIndexedRun }
  | { kind: "revision"; revision: "ins" | "del" }
  | { kind: "commentEnd"; id: string | null }
  | { kind: "move" };

export interface DocxParagraphIndex {
  node: XNode;
  children: XNode[];
  bodyIndex: number;
  globalStart: number;
  acceptedText: string;
  compareText: string;
  visibleText: string;
  events: DocxInlineEvent[];
  editRuns: DocxEditRun[];
  charRun: Int32Array;
  charTextNode: Int32Array;
  rewrite: DocxRewrite;
  containsObjects: boolean;
  truncated: boolean;
}

type DocxDocumentIndex = ReturnType<typeof indexDocxBody> & {
  tree: XNode[];
  trackedChanges: Array<{ kind: "ins" | "del"; w_id: string }>;
  maxTrackedId: number;
};

interface InlineState {
  ins: boolean;
  del: boolean;
  protected: boolean;
  hyperlinkId: string | null;
  edit: boolean;
  compare: boolean;
  story: boolean;
}

const CLEAN_INLINE_STATE: InlineState = {
  ins: false,
  del: false,
  protected: false,
  hyperlinkId: null,
  edit: true,
  compare: true,
  story: true,
};

function readRun(run: XNode, inDeletion: boolean) {
  const children = elChildren(run);
  const rPr = children.find((child) => elName(child) === "w:rPr") ?? null;
  let strike = false;
  let color: string | null = null;
  let text = "";
  let rendered = "";
  let visible = "";
  let rewriteText = "";
  let atomic = false;
  let unsupported: string | null = null;
  const texts: string[] = [];
  const atoms: DocxRewriteAtom[] = [];
  if (rPr) {
    for (const property of elChildren(rPr)) {
        const propertyName = elName(property);
        const value = elAttrs(property)["@_w:val"];
        if (propertyName === "w:strike") {
          strike = value == null || !/^(?:false|0)$/iu.test(String(value));
        } else if (propertyName === "w:color" && value != null && String(value).toLowerCase() !== "auto") {
          color = String(value);
        }
    }
  }
  for (const child of children) {
    const name = elName(child);
    if (name === "w:rPr") continue;
    if (name === "w:t") {
      const value = getTextContent(child);
      texts.push(value);
      text += value;
      rendered += value;
      visible += value;
      atoms.push({ kind: "chars", text: value, rPr });
      rewriteText += value;
    } else if (name === "w:delText" && inDeletion) {
      text += getTextContent(child);
      unsupported ??= `contains run content <${name}>`;
    } else if (name === "w:tab") {
      rendered += "\t";
      visible += "\t";
      atoms.push({ kind: "tab", rPr });
      rewriteText += "\t";
    } else if (name === "w:cr") {
      rendered += "\n";
      atoms.push({ kind: "br", rPr });
      rewriteText += "\n";
    } else if (name === "w:br") {
      visible += "\n";
      if (Object.keys(elAttrs(child)).length) atomic = true;
      else {
        rendered += "\n";
        atoms.push({ kind: "br", rPr });
        rewriteText += "\n";
      }
    } else if (name === "w:lastRenderedPageBreak") continue;
    else if (name && REWRITE_ATOMIC.test(name)) {
      atomic = true;
    } else if (name) unsupported ??= `contains run content <${name}>`;
  }
  const rewrite: DocxRewrite = unsupported
    ? { ok: false, reason: unsupported }
    : atomic && rewriteText
      ? { ok: false, reason: "a run mixes text with non-text content" }
      : { ok: true, atoms: atomic ? [{ kind: "keep", node: run }] : atoms, text: atomic ? "" : rewriteText };
  return { rPr, strike, color, text, texts, rendered, visible, rewrite };
}

export function indexDocxParagraph(node: XNode): DocxParagraphIndex {
  const children = elChildren(node);
  const events: DocxInlineEvent[] = [];
  const editRuns: DocxEditRun[] = [];
  const runRewrites = new WeakMap<XNode, DocxRewrite>();
  const charRuns: number[] = [];
  const charTextNodes: number[] = [];
  let acceptedText = "";
  let compareText = "";
  let visibleText = "";
  let containsObjects = false;
  let truncated = false;

  const visit = (
    current: XNode,
    topChildIndex: number,
    state: InlineState,
    depth: number,
  ): void => {
    if (depth > MAX_MARKUP_DEPTH) {
      truncated = true;
      return;
    }
    const name = elName(current);
    if (!name || INLINE_SKIP.test(name)) return;
    if (OBJECT_ELEMENT.test(name)) containsObjects = true;
    if (name === "w:commentRangeStart") return;
    if (name === "w:commentRangeEnd") {
      const id = elAttrs(current)["@_w:id"];
      events.push({ kind: "commentEnd", id: id == null ? null : String(id) });
      return;
    }
    if (name === "w:moveFrom" || name === "w:moveTo") {
      events.push({ kind: "move" });
    }
    if (name === "w:r") {
      const run = readRun(current, state.del);
      runRewrites.set(current, run.rewrite);
      const textNodes: DocxEditRun["textNodes"] = [];
      for (const value of state.edit && !state.del ? run.texts : []) {
        const start = acceptedText.length;
        textNodes.push({ paraStart: start, paraEnd: start + value.length });
        acceptedText += value;
        for (let index = 0; index < value.length; index += 1) {
          charRuns.push(editRuns.length);
          charTextNodes.push(textNodes.length - 1);
        }
      }
      if (state.compare && !state.del) compareText += run.rendered;
      if (!state.del) visibleText += run.visible;
      if (state.edit && !state.del) {
        editRuns.push({
          childIndex: topChildIndex,
          rPr: run.rPr,
          protectedByContentControl: state.protected,
          textNodes,
        });
      }
      events.push({
        kind: "run",
        run: {
          text: run.text,
          ins: state.ins,
          del: state.del,
          strike: run.strike,
          color: run.color,
          hyperlinkId: state.hyperlinkId,
          story: state.story,
        },
      });
      return;
    }

    if (name === "w:ins" || name === "w:del") {
      const revision = name === "w:ins" ? "ins" : "del";
      events.push({ kind: "revision", revision });
      const next = name === "w:ins"
        ? { ...state, ins: true }
        : {
            ...state,
            del: true,
            edit: false,
            compare: false,
          };
      for (const child of elChildren(current)) {
        visit(child, topChildIndex, next, depth + 1);
      }
      return;
    }

    if (name === "w:sdt") {
      for (const child of elChildren(current)) {
        const content = elName(child) === "w:sdtContent";
        visit(child, topChildIndex, {
          ...state,
          protected: content || state.protected,
          edit: content && state.edit,
          compare: content && state.compare,
          story: content && state.story,
        }, depth + 1);
      }
      return;
    }

    let next = state;
    if (name === "w:hyperlink") {
      const id = elAttrs(current)["@_r:id"];
      next = {
        ...state,
        edit: false,
        hyperlinkId: id == null ? null : String(id),
      };
    } else if (name === "w:smartTag") {
      next = { ...state, edit: false };
    } else if (name === "w:customXml") {
      next = { ...state, edit: false, story: false };
    } else if (name !== "w:sdtContent") {
      next = { ...state, edit: false, compare: false, story: false };
    }
    for (const child of elChildren(current)) {
      visit(child, topChildIndex, next, depth + 1);
    }
  };

  children.forEach((child, index) =>
    visit(child, index, CLEAN_INLINE_STATE, 0),
  );

  const rewriteAtoms: DocxRewriteAtom[] = [];
  let rewriteText = "";
  let rewriteReason: string | null = null;
  for (const child of children) {
    const name = elName(child);
    if (!name || name === "w:pPr") continue;
    if (REWRITE_KEEP.test(name)) {
      rewriteAtoms.push({ kind: "keep", node: child });
    } else if (name === "w:r") {
      const run = runRewrites.get(child)!;
      if (!run.ok) {
        rewriteReason = run.reason;
        break;
      }
      rewriteAtoms.push(...run.atoms);
      rewriteText += run.text;
    } else {
      rewriteReason = `contains <${name}>`;
      break;
    }
  }

  return {
    node,
    children,
    bodyIndex: -1,
    globalStart: 0,
    acceptedText,
    compareText,
    visibleText,
    events,
    editRuns,
    charRun: Int32Array.from(charRuns),
    charTextNode: Int32Array.from(charTextNodes),
    rewrite: rewriteReason
      ? { ok: false, reason: rewriteReason }
      : { ok: true, atoms: rewriteAtoms, text: rewriteText },
    containsObjects,
    truncated,
  };
}

function directChild(node: XNode, name: string) {
  return elChildren(node).find((child) => elName(child) === name);
}

function positiveWordInt(node: XNode | undefined, name: string) {
  const child = node && directChild(node, name);
  const value = Number(child && elAttrs(child)["@_w:val"]);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function indexDocxBody(body: XNode) {
  const bodyChildren = elChildren(body);
  const paragraphs: DocxParagraphIndex[] = [];
  const byNode = new Map<XNode, DocxParagraphIndex>();
  const entryCursor = new Map<XNode, number>();
  let cursor = 0;
  let truncated = false;

  const collect = (node: XNode, bodyIndex: number, depth: number): void => {
    entryCursor.set(node, cursor);
    if (depth > MAX_MARKUP_DEPTH) return void (truncated = true);
    const name = elName(node);
    if (name === "w:p") {
      if (paragraphs.length) cursor += 1;
      const paragraph = indexDocxParagraph(node);
      Object.assign(paragraph, { bodyIndex, globalStart: cursor });
      cursor += paragraph.acceptedText.length;
      paragraphs.push(paragraph);
      byNode.set(node, paragraph);
      truncated ||= paragraph.truncated;
    } else if (name && BLOCK_CONTAINER.test(name)) {
      elChildren(node).forEach((child) => collect(child, bodyIndex, depth + 1));
    }
  };
  bodyChildren.forEach((node, bodyIndex) => collect(node, bodyIndex, 0));

  const paragraphsUnder = (node: XNode) => {
    const found: DocxParagraphIndex[] = [];
    const pending = [node];
    while (pending.length) {
      const current = pending.pop()!;
      const indexed = byNode.get(current);
      if (indexed) found.push(indexed);
      else pending.push(...[...elChildren(current)].reverse());
    }
    return found;
  };

  const wrappers = new Set(["w:sdt", "w:sdtContent"]);
  const nested = (node: XNode, wanted: string) => {
    const found: XNode[] = [];
    const visit = (children: XNode[], depth: number): void => {
      if (depth > MAX_MARKUP_DEPTH) return void (truncated = true);
      for (const child of children) {
        const name = elName(child);
        if (name === wanted) found.push(child);
        else if (name && wrappers.has(name)) visit(elChildren(child), depth + 1);
      }
    };
    visit(elChildren(node), 0);
    return found;
  };
  const tableCells: Array<{ table: number; row: number; column: number; columnSpan: number; start: number; end: number }> = [];
  nested(body, "w:tbl").forEach((table, tableIndex) => {
    nested(table, "w:tr").forEach((row, rowIndex) => {
      const trPr = directChild(row, "w:trPr");
      const skipped = Number(elAttrs(directChild(trPr!, "w:gridBefore"))["@_w:val"]);
      let column = Number.isSafeInteger(skipped) && skipped >= 0 ? skipped + 1 : 1;
      nested(row, "w:tc").forEach((cell) => {
        const tcPr = directChild(cell, "w:tcPr");
        const columnSpan = positiveWordInt(tcPr, "w:gridSpan");
        const merge = ["w:vMerge", "w:hMerge"].some((name) => {
          const node = tcPr && directChild(tcPr, name);
          return node && String(elAttrs(node)["@_w:val"] ?? "").toLowerCase() !== "restart";
        });
        const contents = paragraphsUnder(cell);
        if (!merge) tableCells.push({
          table: tableIndex + 1,
          row: rowIndex + 1,
          column,
          columnSpan,
          start: contents[0]?.globalStart ?? entryCursor.get(cell) ?? cursor,
          end: contents.length
            ? contents.at(-1)!.globalStart + contents.at(-1)!.acceptedText.length
            : entryCursor.get(cell) ?? cursor,
        });
        column += columnSpan;
      });
    });
  });

  const blocks = bodyChildren.flatMap((node, bodyIndex) => {
    const name = elName(node);
    const kind: "p" | "tbl" | "sdt" | null = name === "w:p"
      ? "p"
      : name === "w:tbl"
        ? "tbl"
        : name === "w:sdt"
          ? "sdt"
          : null;
    if (!kind) return [];
    const contents = paragraphsUnder(node);
    return [{
      kind,
      node,
      bodyIndex,
      text: kind === "p"
        ? (contents[0]?.compareText ?? "")
        : contents.map((paragraph) => `${paragraph.compareText}\n`).join(""),
    }];
  });

  return {
    body,
    paragraphs,
    text: paragraphs.map((paragraph) => paragraph.acceptedText).join("\n"),
    tableCells,
    blocks,
    truncated,
  };
}

function trackedChanges(tree: XNode[]) {
  const changes: Array<{ kind: "ins" | "del"; w_id: string }> = [];
  let maximum = 0;
  const pending = [...tree].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    const name = elName(node);
    if (!name) continue;
    if (name === "w:ins" || name === "w:del") {
      const raw = elAttrs(node)["@_w:id"];
      if (raw != null) {
        const w_id = String(raw);
        changes.push({ kind: name === "w:ins" ? "ins" : "del", w_id });
        const value = parseInt(w_id, 10);
        if (Number.isFinite(value) && value > maximum) maximum = value;
      }
    }
    pending.push(...[...elChildren(node)].reverse());
  }
  return { changes, maximum };
}

function assertBoundedPackage(zip: JSZip) {
  assertBoundedZip(zip, "DOCX", {
    maxEntries: MAX_ZIP_ENTRIES, maxExpandedBytes: MAX_EXPANDED_BYTES,
    selected: { test: /\.xml(?:\.rels)?$/iu, maxEntryBytes: MAX_DRAFTING_XML_ENTRY_BYTES,
      maxBytes: MAX_XML_BYTES, name: "XML part" },
  });
}

class DocxSessionImpl {
  readonly paths: string[];
  private readonly names = new Map<string, string>();
  private readonly text = new Map<string, Promise<string>>();
  private readonly readBudget = zipReadBudget(MAX_XML_BYTES);

  constructor(private readonly zip: JSZip) {
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const canonical = entry.name.replace(/\\/gu, "/");
      const prior = this.names.get(canonical);
      if (prior && prior !== entry.name) {
        throw new Error(`DOCX contains duplicate package part ${canonical}`);
      }
      this.names.set(canonical, entry.name);
    }
    this.paths = [...this.names.keys()].sort();
  }

  has(path: string) {
    return this.names.has(path.replace(/\\/gu, "/"));
  }

  async readText(path: string): Promise<string | null> {
    const canonical = path.replace(/\\/gu, "/");
    const actual = this.names.get(canonical);
    if (!actual) return null;
    let pending = this.text.get(actual);
    if (!pending) {
      pending = readZipEntry(this.zip.file(actual)!, MAX_DRAFTING_XML_ENTRY_BYTES,
        this.readBudget, `DOCX part ${canonical}`).then((bytes) => bytes.toString("utf8"));
      this.text.set(actual, pending);
    }
    return pending;
  }

  async readXml(path: string): Promise<XNode[] | null> {
    const xml = await this.readText(path);
    if (xml == null) return null;
    if (/<!DOCTYPE(?:\s|>)/iu.test(xml)) {
      throw new Error("DOCX XML must not contain a DOCTYPE declaration");
    }
    return createParser().parse(xml) as XNode[];
  }

  async document(label = "docx"): Promise<DocxDocumentIndex> {
    const tree = await this.readXml("word/document.xml");
    if (!tree) throw new Error(`document.xml missing from ${label}`);
    const body = findBody(tree);
    if (!body) throw new Error(`w:body missing from ${label}`);
    const index = indexDocxBody(body);
    if (index.truncated) throw new Error("DOCX markup nests beyond the read limit");
    const revisions = trackedChanges(tree);
    return {
      tree,
      ...index,
      trackedChanges: revisions.changes,
      maxTrackedId: revisions.maximum,
    };
  }

  async revisions(): Promise<ReturnType<typeof trackedChanges>> {
    const tree = await this.readXml("word/document.xml");
    return tree ? trackedChanges(tree) : { changes: [], maximum: 0 };
  }

  write(path: string, content: string | Buffer) {
    const canonical = path.replace(/\\/gu, "/");
    const actual = this.names.get(canonical) ?? canonical;
    this.zip.file(actual, content);
    if (typeof content === "string") this.text.set(actual, Promise.resolve(content));
    else this.text.delete(actual);
    if (!this.names.has(canonical)) {
      this.names.set(canonical, actual);
      this.paths.push(canonical);
      this.paths.sort();
    }
  }

  writeDocument(tree: XNode[]) {
    this.write(
      "word/document.xml",
      ensureXmlDeclaration(createBuilder().build(tree)),
    );
  }

  save() {
    return this.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }
}

export type DocxSession = DocxSessionImpl;

export async function openDocxSession(
  bytes: Buffer | Uint8Array | ArrayBuffer,
): Promise<DocxSession> {
  if (!bytes.byteLength || bytes.byteLength > MAX_DRAFTING_DOCX_BYTES) {
    throw new Error("DOCX is empty or exceeds the read limit");
  }
  const zip = await loadZip(bytes).catch((error: unknown) => {
    const detail = String((error as { message?: unknown })?.message ?? error)
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 200);
    throw new Error(
      `DOCX is corrupted or truncated (not a readable ZIP archive): ${detail}`,
    );
  });
  assertBoundedPackage(zip);
  return new DocxSessionImpl(zip);
}
