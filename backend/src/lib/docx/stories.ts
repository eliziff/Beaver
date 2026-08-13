/**
 * STORIES layer: every text-bearing story a .docx holds — body, footnotes,
 * endnotes, headers, footers, text boxes — read in one pass, with each
 * run's redline state attached.
 *
 * The body walk reproduces docxTrackedChanges' `collectParagraphs` /
 * `flattenParagraph` exactly, then adds the descents that path is missing
 * (`w:hyperlink`, `w:smartTag` — hyperlink text is invisible to body
 * extraction today) and the parts it never opens. So for any document
 * without hyperlinks or smart tags in the body,
 * `storiesBodyText(extractDocxStories(b))` equals `extractDocxBodyText(b)`
 * byte for byte; the tests pin that contract on generated fixtures and on
 * real documents.
 *
 * Bounds discipline follows docx/pathology.ts: never throws, degrades to
 * whatever it could read plus a typed note.
 */

import {
  type XNode,
  assertBoundedDocxPackage,
  MAX_DRAFTING_DOCX_BYTES,
  createParser,
  elAttrs,
  elChildren,
  elName,
  findBody,
  getTextContent,
  getZipEntry,
  loadDocxPackage,
} from "./core";

/** Markup nested past this is malformed or hostile; stop rather than recurse. */
const MAX_DEPTH = 256;

/** Notes are for the reader, not a log; a runaway package must not flood them. */
const MAX_NOTES = 32;

export interface StoryRun {
  text: string;
  /** Inside a w:ins wrapper. */
  ins: boolean;
  /** Inside a w:del wrapper — carries w:delText, absent from the accepted view. */
  del: boolean;
  /** w:rPr w:strike, honouring w:val="false"/"0". */
  strike: boolean;
  /** w:rPr w:color w:val, or null when absent or "auto". */
  color: string | null;
  /** Target URL of the enclosing w:hyperlink, or null when there is none
   *  or its r:id resolves to nothing. */
  hyperlink: string | null;
}

export interface StoryParagraph {
  /** Accepted view: insertions in, deletions out. Equal to the non-deleted
   *  runs concatenated — `runs` keeps the deleted text the view drops. */
  text: string;
  runs: StoryRun[];
}

export interface DocxStories {
  body: StoryParagraph[];
  /** Keyed by w:id; separator and continuation notes are not content. */
  footnotes: Map<string, StoryParagraph[]>;
  endnotes: Map<string, StoryParagraph[]>;
  /** One entry per header/footer part, in package path order. */
  headers: StoryParagraph[][];
  footers: StoryParagraph[][];
  /** One entry per w:txbxContent, from every part scanned. */
  textBoxes: StoryParagraph[][];
  /** What could not be read, in the reader's words. */
  notes: string[];
}

/** Notes that are not content in any package that ships them. */
const NON_CONTENT_NOTE_TYPES = new Set([
  "separator",
  "continuationSeparator",
  "continuationNotice",
]);

interface RunState {
  ins: boolean;
  del: boolean;
  hyperlink: string | null;
}

const CLEAN_STATE: RunState = { ins: false, del: false, hyperlink: null };

interface Ctx {
  /** r:id -> Target, from the part's own _rels. */
  rels: Map<string, string>;
  notes: string[];
  /** Set once when a walk hits MAX_DEPTH, so the note is emitted once. */
  truncated: boolean;
}

function note(ctx: Ctx, text: string): void {
  if (ctx.notes.length >= MAX_NOTES) return;
  if (ctx.notes.includes(text)) return;
  ctx.notes.push(text);
}

function message(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function emptyStories(): DocxStories {
  return {
    body: [],
    footnotes: new Map(),
    endnotes: new Map(),
    headers: [],
    footers: [],
    textBoxes: [],
    notes: [],
  };
}

/** `word/header2.xml` -> `word/_rels/header2.xml.rels`. */
function relsPathFor(partPath: string): string {
  const cut = partPath.lastIndexOf("/");
  const dir = cut === -1 ? "" : partPath.slice(0, cut);
  const base = cut === -1 ? partPath : partPath.slice(cut + 1);
  return `${dir ? `${dir}/` : ""}_rels/${base}.rels`;
}

async function readRels(
  zip: JSZip,
  partPath: string,
  ctx: Ctx,
): Promise<Map<string, string>> {
  const rels = new Map<string, string>();
  const path = relsPathFor(partPath);
  const entry = getZipEntry(zip, path);
  if (!entry) return rels;
  try {
    const tree = createParser().parse(await entry.async("string")) as XNode[];
    for (const top of tree) {
      if (elName(top) !== "Relationships") continue;
      for (const child of elChildren(top)) {
        if (elName(child) !== "Relationship") continue;
        const attrs = elAttrs(child);
        const id = attrs["@_Id"];
        const target = attrs["@_Target"];
        if (id != null && target != null) rels.set(String(id), String(target));
      }
    }
  } catch (error) {
    note(ctx, `${path} could not be read (${message(error)}).`);
  }
  return rels;
}

/** w:rPr redline formatting. Read once per run. */
function readRunProps(rEl: XNode): { strike: boolean; color: string | null } {
  let strike = false;
  let color: string | null = null;
  for (const child of elChildren(rEl)) {
    if (elName(child) !== "w:rPr") continue;
    for (const prop of elChildren(child)) {
      const name = elName(prop);
      if (name === "w:strike") {
        const val = elAttrs(prop)["@_w:val"];
        strike = val == null || !/^(?:false|0)$/iu.test(String(val));
      } else if (name === "w:color") {
        const val = elAttrs(prop)["@_w:val"];
        if (val != null && String(val) && String(val).toLowerCase() !== "auto") {
          color = String(val);
        }
      }
    }
  }
  return { strike, color };
}

/**
 * Reads one paragraph's runs. The descent is `flattenParagraph`'s, plus
 * w:del (recorded, not dropped) and the two elements it never opens.
 */
function readParagraph(pEl: XNode, ctx: Ctx): StoryParagraph {
  const runs: StoryRun[] = [];

  const emit = (rEl: XNode, state: RunState) => {
    let text = "";
    for (const child of elChildren(rEl)) {
      const name = elName(child);
      if (name === "w:t") text += getTextContent(child);
      // w:delText outside a w:del wrapper is not deleted text; body
      // extraction ignores it, so reading it here would break parity.
      else if (name === "w:delText" && state.del) text += getTextContent(child);
    }
    if (!text) return; // w:footnoteRef, bookmarks, field chars carry no text
    const { strike, color } = readRunProps(rEl);
    runs.push({ text, ins: state.ins, del: state.del, strike, color, hyperlink: state.hyperlink });
  };

  const visit = (node: XNode, state: RunState, depth: number) => {
    if (depth > MAX_DEPTH) {
      ctx.truncated = true;
      return;
    }
    const name = elName(node);
    if (!name) return;
    if (name === "w:r") {
      emit(node, state);
    } else if (name === "w:ins") {
      for (const c of elChildren(node)) visit(c, { ...state, ins: true }, depth + 1);
    } else if (name === "w:del") {
      for (const c of elChildren(node)) visit(c, { ...state, del: true }, depth + 1);
    } else if (name === "w:sdt") {
      for (const c of elChildren(node)) {
        if (elName(c) === "w:sdtContent") visit(c, state, depth + 1);
      }
    } else if (name === "w:sdtContent" || name === "w:smartTag") {
      for (const c of elChildren(node)) visit(c, state, depth + 1);
    } else if (name === "w:hyperlink") {
      const rid = elAttrs(node)["@_r:id"];
      const target = rid == null ? null : (ctx.rels.get(String(rid)) ?? null);
      if (rid != null && target == null) {
        note(ctx, `A hyperlink points at relationship ${String(rid)}, which this package does not define; its target is unknown.`);
      }
      for (const c of elChildren(node)) visit(c, { ...state, hyperlink: target }, depth + 1);
    }
    // w:moveFrom / w:moveTo / w:pict / w:drawing and the rest contribute
    // nothing to paragraph text — the same set flattenParagraph drops.
  };

  for (const child of elChildren(pEl)) visit(child, CLEAN_STATE, 0);

  let text = "";
  for (const run of runs) if (!run.del) text += run.text;
  return { text, runs };
}

/** Block descent: exactly `collectParagraphs`' element set. */
function collectStory(nodes: XNode[], ctx: Ctx, out: StoryParagraph[], depth = 0): void {
  if (depth > MAX_DEPTH) {
    ctx.truncated = true;
    return;
  }
  for (const node of nodes) {
    const name = elName(node);
    if (!name) continue;
    if (name === "w:p") {
      out.push(readParagraph(node, ctx));
    } else if (
      name === "w:tbl" ||
      name === "w:tr" ||
      name === "w:tc" ||
      name === "w:sdt" ||
      name === "w:sdtContent"
    ) {
      collectStory(elChildren(node), ctx, out, depth + 1);
    }
  }
}

/**
 * Text boxes hang off w:pict / w:drawing, which no paragraph walk enters,
 * so they need their own scan. A DrawingML text box is written twice — an
 * mc:Choice and an identical mc:Fallback; take the choice only.
 */
function collectTextBoxes(
  node: XNode,
  ctx: Ctx,
  out: StoryParagraph[][],
  depth = 0,
): void {
  if (depth > MAX_DEPTH) {
    ctx.truncated = true;
    return;
  }
  const name = elName(node);
  if (name === "mc:Fallback") return;
  if (name === "w:txbxContent") {
    const paragraphs: StoryParagraph[] = [];
    collectStory(elChildren(node), ctx, paragraphs);
    if (paragraphs.length === 0) {
      // Some packagers put bare runs under w:txbxContent, with no w:p.
      const loose = readParagraph(node, ctx);
      if (loose.runs.length > 0) paragraphs.push(loose);
    }
    if (paragraphs.length > 0) out.push(paragraphs);
  }
  for (const child of elChildren(node)) {
    collectTextBoxes(child, ctx, out, depth + 1);
  }
}

/** The single root element of a part, by name. */
function findRoot(tree: XNode[], name: string): XNode | null {
  for (const top of tree) if (elName(top) === name) return top;
  return null;
}

async function parsePart(
  zip: JSZip,
  path: string,
  ctx: Ctx,
): Promise<XNode[] | null> {
  const entry = getZipEntry(zip, path);
  if (!entry) return null;
  try {
    return createParser().parse(await entry.async("string")) as XNode[];
  } catch (error) {
    note(ctx, `${path} could not be read (${message(error)}).`);
    return null;
  }
}

/**
 * Reads every story in a .docx. Never throws: an unreadable package
 * degrades to empty stories plus a note saying so.
 */
export async function extractDocxStories(bytes: Buffer): Promise<DocxStories> {
  const stories = emptyStories();
  const ctx: Ctx = { rels: new Map(), notes: stories.notes, truncated: false };
  try {
    if (!bytes.length || bytes.length > MAX_DRAFTING_DOCX_BYTES) {
      throw new Error("DOCX is empty or exceeds the read limit");
    }
    const zip = await loadDocxPackage(bytes);
    assertBoundedDocxPackage(zip);

    // Body. Its rels resolve the hyperlinks the body walk now descends.
    ctx.rels = await readRels(zip, "word/document.xml", ctx);
    const documentTree = await parsePart(zip, "word/document.xml", ctx);
    if (!documentTree) {
      note(ctx, "Package has no readable word/document.xml; the body story is empty.");
    } else {
      const body = findBody(documentTree);
      if (!body) {
        note(ctx, "word/document.xml has no w:body; the body story is empty.");
      } else {
        collectStory(elChildren(body), ctx, stories.body);
        collectTextBoxes(body, ctx, stories.textBoxes);
      }
    }

    // Headers and footers, in package path order so the arrays are stable.
    const paths = Object.keys(zip.files)
      .map((path) => path.replace(/\\/gu, "/"))
      .sort();
    for (const path of paths) {
      const header = /^word\/header\d*\.xml$/iu.test(path);
      const footer = /^word\/footer\d*\.xml$/iu.test(path);
      if (!header && !footer) continue;
      const tree = await parsePart(zip, path, ctx);
      if (!tree) continue;
      const root = findRoot(tree, header ? "w:hdr" : "w:ftr");
      if (!root) continue;
      // Each part resolves r:id against its own _rels; parts are read in
      // sequence, so swapping the map on ctx is enough.
      ctx.rels = await readRels(zip, path, ctx);
      const paragraphs: StoryParagraph[] = [];
      collectStory(elChildren(root), ctx, paragraphs);
      collectTextBoxes(root, ctx, stories.textBoxes);
      (header ? stories.headers : stories.footers).push(paragraphs);
    }

    // Footnotes and endnotes. Separator and continuation notes ship with
    // every package and are not content.
    for (const [path, tag, target] of [
      ["word/footnotes.xml", "footnote", stories.footnotes],
      ["word/endnotes.xml", "endnote", stories.endnotes],
    ] as const) {
      const tree = await parsePart(zip, path, ctx);
      if (!tree) continue;
      const root = findRoot(tree, `w:${tag}s`);
      if (!root) continue;
      ctx.rels = await readRels(zip, path, ctx);
      let anonymous = 0;
      for (const child of elChildren(root)) {
        if (elName(child) !== `w:${tag}`) continue;
        const attrs = elAttrs(child);
        const type = attrs["@_w:type"];
        if (type != null && NON_CONTENT_NOTE_TYPES.has(String(type))) continue;
        const rawId = attrs["@_w:id"];
        const id = rawId == null ? `#${anonymous++}` : String(rawId);
        const paragraphs: StoryParagraph[] = [];
        collectStory(elChildren(child), ctx, paragraphs);
        collectTextBoxes(child, ctx, stories.textBoxes);
        target.set(id, paragraphs);
      }
    }

    if (ctx.truncated) {
      note(ctx, `Markup nests deeper than ${MAX_DEPTH} levels; the deepest content was not read.`);
    }
    return stories;
  } catch (error) {
    const degraded = emptyStories();
    degraded.notes = [
      `Package could not be read: ${message(error)}.`,
      ...stories.notes,
    ].slice(0, MAX_NOTES);
    return degraded;
  }
}

/**
 * The accepted-view body text: insertions in, deletions out, paragraphs
 * joined by a single newline. Byte-identical to `extractDocxBodyText` for
 * any document whose body carries no hyperlink or smart tag.
 */
export function storiesBodyText(stories: DocxStories): string {
  return stories.body.map((paragraph) => paragraph.text).join("\n");
}
