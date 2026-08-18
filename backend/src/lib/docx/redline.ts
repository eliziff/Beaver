/** Projects tracked edits, comments, and manual ink marks inline. */

import {
  type XNode,
  elAttrs,
  elChildren,
  elName,
  getTextContent,
} from "./core";
import { openDocxSession } from "./session";

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

const MARKER_SEQUENCES = ["{++", "++}", "{--", "--}", "{>>", "<<}"];

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

function readComments(tree: XNode[]): Map<string, CommentBody> {
  const bodies = new Map<string, CommentBody>();
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
    const session = await openDocxSession(bytes);
    const document = await session.document("Redline projection");

    let comments = new Map<string, CommentBody>();
    if (session.has("word/comments.xml")) {
      try {
        comments = readComments((await session.readXml("word/comments.xml")) ?? []);
      } catch (error) {
        notes.push(`Comment bodies could not be read (${message(error)}).`);
      }
    }

    const anchored = new Set<string>();
    const danglingRanges = new Set<string>();
    let sawMove = false;
    let literal = "";
    const lines: string[] = [];

    for (const paragraph of document.paragraphs) {
      const segments: Segment[] = [];
      for (const event of paragraph.events) {
        if (event.kind === "revision") {
          counts[event.revision === "ins" ? "tracked_insertions" : "tracked_deletions"] += 1;
          continue;
        }
        if (event.kind === "move") {
          sawMove = true;
          continue;
        }
        if (event.kind === "commentEnd") {
          if (event.id == null) continue;
          const body = comments.get(event.id);
          if (!body) {
            danglingRanges.add(event.id);
            continue;
          }
          anchored.add(event.id);
          counts.comments += 1;
          literal += body.text;
          segments.push({ kind: "comment", text: renderComment(body) });
          continue;
        }
        const run = event.run;
        if (!run.text) continue;
        literal += run.text;
        if (run.del) {
          segments.push({ kind: "del", text: run.text });
        } else if (run.ins) {
          segments.push({ kind: "ins", text: run.text });
        } else if (run.strike) {
          counts.ink_deletions += 1;
          segments.push({ kind: "ink_del", text: run.text });
        } else if (run.color != null && isRedFamily(run.color)) {
          counts.ink_insertions += 1;
          segments.push({ kind: "ink_ins", text: run.text });
        } else {
          segments.push({ kind: "plain", text: run.text });
        }
      }
      lines.push(render(segments));
    }

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
