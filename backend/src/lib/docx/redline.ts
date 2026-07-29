/**
 * Redline projection: the body text with every editorial mark left visible
 * inline, in the CriticMarkup-style vocabulary mike-redline uses.
 *
 *   {++inserted++}        w:ins
 *   {--deleted--}         w:del (w:delText restored)
 *   {>>author: text<<}    comments.xml body, at the w:commentRangeEnd
 *   {++text++}[ink]       red run with no tracked-change markup
 *   {--text--}[ink]       struck run with no tracked-change markup
 *
 * The `[ink]` suffix is attribution, not decoration: a manual redline is a
 * human's formatting, not a revision the package records, and the reader
 * must not be able to confuse the two.
 *
 * This exists because every text extractor we measured (mammoth raw text,
 * mammoth HTML-to-text, pandoc plain) reads a struck-through deleted clause
 * back as operative text — see scripts/probe-manual-redline.ts. It is a read
 * mode, deliberately not wired into any extraction default.
 */

import { MAX_DRAFTING_DOCX_BYTES } from "../docxDraftingSource";
import {
  type XNode,
  createParser,
  elAttrs,
  elChildren,
  elName,
  findBodyChildren,
  getTextContent,
  getZipEntry,
  loadDocxPackage,
} from "./core";

export interface RedlineProjection {
  text: string;
  counts: {
    tracked_insertions: number;
    tracked_deletions: number;
    comments: number;
    ink_insertions: number;
    ink_deletions: number;
  };
  notes: string[];
}

type MarkKind = "plain" | "ins" | "del" | "ink_ins" | "ink_del" | "comment";

interface Segment {
  kind: MarkKind;
  text: string;
}

const WRAP: Record<Exclude<MarkKind, "plain" | "comment">, [string, string]> = {
  ins: ["{++", "++}"],
  del: ["{--", "--}"],
  ink_ins: ["{++", "++}[ink]"],
  ink_del: ["{--", "--}[ink]"],
};

/** Sequences whose presence in the document's own text makes markers ambiguous. */
const MARKER_SEQUENCES = ["{++", "++}", "{--", "--}", "{>>", "<<}"];

/** Children that carry no visible text, or that duplicate text carried elsewhere. */
const SKIP = new Set([
  "w:pPr",
  "w:rPr",
  "w:sectPr",
  "w:tblPr",
  "w:trPr",
  "w:tcPr",
  "w:tblGrid",
  "w:sdtPr",
  "w:sdtEndPr",
  "w:bookmarkStart",
  "w:bookmarkEnd",
  "w:proofErr",
  "w:commentReference",
  // Word writes a drawing twice, as an mc:Choice and an identical fallback.
  "mc:Fallback",
]);

/** Block containers the paragraph collector descends, mirroring extractDocxBodyText. */
const BLOCK_CONTAINERS = new Set([
  "w:tbl",
  "w:tr",
  "w:tc",
  "w:sdt",
  "w:sdtContent",
]);

/** Red family, byte-identical to the pathology sniffer's threshold. */
function isRedFamily(value: string) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(
    value.trim(),
  );
  if (!match) return false;
  const [red, green, blue] = match.slice(1, 4).map((c) => parseInt(c, 16));
  return red >= 0xb0 && green <= 0x60 && blue <= 0x60;
}

function message(error: unknown) {
  return String((error as { message?: unknown })?.message ?? error)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Only w:t counts, and w:delText only under w:del — the accepted-view rule
 *  extractDocxBodyText already applies, so a clean document projects identically. */
function runText(run: XNode, inDel: boolean) {
  let out = "";
  for (const kid of elChildren(run)) {
    const name = elName(kid);
    if (name === "w:t" || (inDel && name === "w:delText")) {
      out += getTextContent(kid);
    }
  }
  return out;
}

function runInk(run: XNode) {
  let struck = false;
  let red = false;
  for (const kid of elChildren(run)) {
    if (elName(kid) !== "w:rPr") continue;
    for (const property of elChildren(kid)) {
      const name = elName(property);
      if (name === "w:strike") {
        const value = elAttrs(property)["@_w:val"];
        struck = value == null || !/^(?:false|0)$/iu.test(String(value));
      } else if (name === "w:color") {
        const value = elAttrs(property)["@_w:val"];
        red = value != null && isRedFamily(String(value));
      }
    }
  }
  return { struck, red };
}

/** All visible text under a node, paragraph-separated — used for comment bodies. */
function subtreeText(node: unknown): string {
  const name = elName(node);
  if (!name) return "";
  if (name === "w:t" || name === "w:delText") return getTextContent(node as XNode);
  let out = "";
  for (const kid of elChildren(node as XNode)) out += subtreeText(kid);
  return name === "w:p" ? `${out} ` : out;
}

interface CommentBody {
  author: string;
  text: string;
}

function readComments(xml: string): Map<string, CommentBody> {
  const bodies = new Map<string, CommentBody>();
  const tree = createParser().parse(xml) as XNode[];
  const visit = (node: unknown) => {
    const name = elName(node);
    if (!name) return;
    if (name === "w:comment") {
      const attrs = elAttrs(node);
      const id = attrs["@_w:id"];
      if (id != null) {
        bodies.set(String(id), {
          author: String(attrs["@_w:author"] ?? "").trim(),
          text: subtreeText(node).replace(/\s+/gu, " ").trim(),
        });
      }
      return;
    }
    for (const kid of elChildren(node as XNode)) visit(kid);
  };
  for (const top of tree) visit(top);
  return bodies;
}

function renderComment(body: CommentBody) {
  return `{>>${body.author || "unattributed"}: ${body.text}<<}`;
}

/** Adjacent runs of one kind read as one edit; per-run markers are confetti. */
function render(segments: Segment[]) {
  let out = "";
  let index = 0;
  while (index < segments.length) {
    const kind = segments[index].kind;
    if (kind === "comment") {
      out += segments[index].text;
      index += 1;
      continue;
    }
    let text = "";
    while (index < segments.length && segments[index].kind === kind) {
      text += segments[index].text;
      index += 1;
    }
    if (kind === "plain") {
      out += text;
    } else {
      const [open, close] = WRAP[kind];
      out += `${open}${text}${close}`;
    }
  }
  return out;
}

/**
 * Projects a .docx body with all editorial content visible. Never throws: an
 * unreadable package degrades to empty text, zero counts and a note.
 */
export async function projectDocxRedline(
  bytes: Buffer,
): Promise<RedlineProjection> {
  const counts = {
    tracked_insertions: 0,
    tracked_deletions: 0,
    comments: 0,
    ink_insertions: 0,
    ink_deletions: 0,
  };
  const notes: string[] = [];

  try {
    if (!bytes?.length || bytes.length > MAX_DRAFTING_DOCX_BYTES) {
      throw new Error("DOCX is empty or exceeds the read limit");
    }
    const zip = await loadDocxPackage(bytes);
    const documentEntry = getZipEntry(zip, "word/document.xml");
    if (!documentEntry) throw new Error("Package has no word/document.xml");
    const tree = createParser().parse(
      await documentEntry.async("string"),
    ) as XNode[];
    const bodyChildren = findBodyChildren(tree);
    if (!bodyChildren) throw new Error("document.xml has no w:body");

    let comments = new Map<string, CommentBody>();
    const commentsEntry = getZipEntry(zip, "word/comments.xml");
    if (commentsEntry) {
      try {
        comments = readComments(await commentsEntry.async("string"));
      } catch (error) {
        notes.push(`Comment bodies could not be read (${message(error)}).`);
      }
    }

    const anchored = new Set<string>();
    const danglingRanges = new Set<string>();
    let sawMove = false;
    /** Every character the document itself holds, markers excluded. */
    let literal = "";
    const lines: string[] = [];

    const walkParagraph = (
      nodes: XNode[],
      segments: Segment[],
      insDepth: number,
      delDepth: number,
    ) => {
      for (const node of nodes) {
        const name = elName(node);
        if (!name || SKIP.has(name)) continue;

        if (name === "w:r") {
          const inDel = delDepth > 0;
          const text = runText(node, inDel);
          if (!text) continue;
          literal += text;
          if (inDel) {
            segments.push({ kind: "del", text });
          } else if (insDepth > 0) {
            segments.push({ kind: "ins", text });
          } else {
            const { struck, red } = runInk(node);
            // Struck wins over red: a run that is both is a manual deletion.
            if (struck) {
              counts.ink_deletions += 1;
              segments.push({ kind: "ink_del", text });
            } else if (red) {
              counts.ink_insertions += 1;
              segments.push({ kind: "ink_ins", text });
            } else {
              segments.push({ kind: "plain", text });
            }
          }
          continue;
        }

        if (name === "w:ins") {
          counts.tracked_insertions += 1;
          walkParagraph(elChildren(node), segments, insDepth + 1, delDepth);
          continue;
        }
        if (name === "w:del") {
          counts.tracked_deletions += 1;
          walkParagraph(elChildren(node), segments, insDepth, delDepth + 1);
          continue;
        }
        if (name === "w:commentRangeStart") continue;
        if (name === "w:commentRangeEnd") {
          const id = elAttrs(node)["@_w:id"];
          if (id == null) continue;
          const body = comments.get(String(id));
          if (!body) {
            danglingRanges.add(String(id));
            continue;
          }
          anchored.add(String(id));
          counts.comments += 1;
          literal += body.text;
          segments.push({ kind: "comment", text: renderComment(body) });
          continue;
        }
        if (name === "w:moveFrom" || name === "w:moveTo") sawMove = true;

        // w:hyperlink, w:smartTag, inline w:sdt, w:fldSimple, moves and any
        // container this list has not met: descend rather than lose the text.
        walkParagraph(elChildren(node), segments, insDepth, delDepth);
      }
    };

    const collect = (nodes: XNode[]) => {
      for (const node of nodes) {
        const name = elName(node);
        if (!name) continue;
        if (name === "w:p") {
          const segments: Segment[] = [];
          walkParagraph(elChildren(node), segments, 0, 0);
          lines.push(render(segments));
        } else if (BLOCK_CONTAINERS.has(name)) {
          collect(elChildren(node));
        }
      }
    };
    collect(bodyChildren);

    const collided = MARKER_SEQUENCES.filter((seq) => literal.includes(seq));
    if (collided.length) {
      notes.push(
        `Document text already contains ${plural(collided.length, "marker sequence", "marker sequences")} (${collided.join(", ")}); markers are not escaped, so those positions are ambiguous.`,
      );
    }
    if (danglingRanges.size) {
      notes.push(
        `${plural(danglingRanges.size, "comment range points", "comment ranges point")} at a comment this package does not define; ${danglingRanges.size === 1 ? "it is" : "they are"} not shown.`,
      );
    }
    const orphaned = comments.size - anchored.size;
    if (orphaned > 0) {
      notes.push(
        `${plural(orphaned, "comment is", "comments are")} not anchored to a range in the body; ${orphaned === 1 ? "its" : "their"} text is not shown.`,
      );
    }
    if (sawMove) {
      notes.push(
        "Tracked moves are present; moved text is projected in accepted view without a move marker.",
      );
    }

    return { text: lines.join("\n"), counts, notes };
  } catch (error) {
    return {
      text: "",
      counts: {
        tracked_insertions: 0,
        tracked_deletions: 0,
        comments: 0,
        ink_insertions: 0,
        ink_deletions: 0,
      },
      notes: [`Package could not be projected: ${message(error)}.`, ...notes],
    };
  }
}
