/** Reads body, note, header/footer, and text-box stories with run state. */

import {
  type XNode,
  elAttrs,
  elChildren,
  elName,
  findBody,
} from "../../src/lib/docx/core";
import {
  type DocxParagraphIndex,
  type DocxSession,
  indexDocxBody,
  indexDocxParagraph,
  indexDocxParagraphs,
  openDocxSession,
} from "../../src/lib/docx/session";

const MAX_DEPTH = 256;

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

const NON_CONTENT_NOTE_TYPES = new Set([
  "separator",
  "continuationSeparator",
  "continuationNotice",
]);

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
  session: DocxSession,
  partPath: string,
  ctx: Ctx,
): Promise<Map<string, string>> {
  const rels = new Map<string, string>();
  const path = relsPathFor(partPath);
  try {
    const tree = await session.readXml(path);
    if (!tree) return rels;
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

function storyParagraph(paragraph: DocxParagraphIndex, ctx: Ctx): StoryParagraph {
  const runs: StoryRun[] = [];
  for (const event of paragraph.events) {
    if (event.kind !== "run" || !event.run.story || !event.run.text) continue;
    const relationshipId = event.run.hyperlinkId;
    const hyperlink = relationshipId == null
      ? null
      : (ctx.rels.get(relationshipId) ?? null);
    if (relationshipId != null && hyperlink == null) {
      note(
        ctx,
        `A hyperlink points at relationship ${relationshipId}, which this package does not define; its target is unknown.`,
      );
    }
    runs.push({
      text: event.run.text,
      ins: event.run.ins,
      del: event.run.del,
      strike: event.run.strike,
      color: event.run.color,
      hyperlink,
    });
  }
  return {
    text: runs.filter((run) => !run.del).map((run) => run.text).join(""),
    runs,
  };
}

function collectStory(nodes: XNode[], ctx: Ctx, out: StoryParagraph[]): void {
  const indexed = indexDocxParagraphs(nodes);
  ctx.truncated ||= indexed.truncated;
  out.push(...indexed.paragraphs.map((paragraph) => storyParagraph(paragraph, ctx)));
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
      const indexed = indexDocxParagraph(node);
      ctx.truncated ||= indexed.truncated;
      const loose = storyParagraph(indexed, ctx);
      if (loose.runs.length > 0) paragraphs.push(loose);
    }
    if (paragraphs.length > 0) out.push(paragraphs);
  }
  for (const child of elChildren(node)) {
    collectTextBoxes(child, ctx, out, depth + 1);
  }
}

function findRoot(tree: XNode[], name: string): XNode | null {
  for (const top of tree) if (elName(top) === name) return top;
  return null;
}

async function parsePart(
  session: DocxSession,
  path: string,
  ctx: Ctx,
): Promise<XNode[] | null> {
  try {
    return await session.readXml(path);
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
    const session = await openDocxSession(bytes);

    ctx.rels = await readRels(session, "word/document.xml", ctx);
    const documentTree = await parsePart(session, "word/document.xml", ctx);
    if (!documentTree) {
      note(ctx, "Package has no readable word/document.xml; the body story is empty.");
    } else {
      const body = findBody(documentTree);
      if (!body) {
        note(ctx, "word/document.xml has no w:body; the body story is empty.");
      } else {
        const indexed = indexDocxBody(body);
        ctx.truncated ||= indexed.truncated;
        stories.body.push(...indexed.paragraphs.map((paragraph) => storyParagraph(paragraph, ctx)));
        collectTextBoxes(body, ctx, stories.textBoxes);
      }
    }

    for (const path of session.paths) {
      const header = /^word\/header\d*\.xml$/iu.test(path);
      const footer = /^word\/footer\d*\.xml$/iu.test(path);
      if (!header && !footer) continue;
      const tree = await parsePart(session, path, ctx);
      if (!tree) continue;
      const root = findRoot(tree, header ? "w:hdr" : "w:ftr");
      if (!root) continue;
      ctx.rels = await readRels(session, path, ctx);
      const paragraphs: StoryParagraph[] = [];
      collectStory(elChildren(root), ctx, paragraphs);
      collectTextBoxes(root, ctx, stories.textBoxes);
      (header ? stories.headers : stories.footers).push(paragraphs);
    }

    for (const [path, tag, target] of [
      ["word/footnotes.xml", "footnote", stories.footnotes],
      ["word/endnotes.xml", "endnote", stories.endnotes],
    ] as const) {
      const tree = await parsePart(session, path, ctx);
      if (!tree) continue;
      const root = findRoot(tree, `w:${tag}s`);
      if (!root) continue;
      ctx.rels = await readRels(session, path, ctx);
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
