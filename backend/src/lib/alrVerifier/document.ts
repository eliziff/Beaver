// ALR's document model, read with Beaver's native .docx units: body text with footnote markers,
// footnote text, author hyperlinks,
// footnote order and display numbers, the proposition before each note and its quotations.
// Ported from ALR-Quote-Verifier alr_quote_verifier.py (_load_parsed_document,
// extract_doc_stream_with_styles, build_global_text, extract_footnotes,
// build_clean_text_and_index_map, find_inline_quotes, build_anchor_propositions,
// _compute_footnote_display_ids, compute_footnote_order, build_audit_data).
import JSZip from "jszip";
import { createParser, elAttrs, elChildren, elName, getTextContent, type XNode } from "../docx/core";
import { structureNative } from "../structureNative";
import type { PropositionMode } from "./settings";

export type AuthorLink = { start: number; end: number; target: string; text: string; source: "hyperlink" | "literal" };
type Paragraph = { text: string; anchors: Array<{ footnoteId: number; offset: number }> };
type Anchor = { footnoteId: number; globalPos: number };
export type InlineQuote = { raw: string; inner: string; type: string; style: "SMART" | "STRAIGHT" | "MIXED" };

const HYPERLINK_FIELD = /\bHYPERLINK\s+["']([^"']+)["']/iu;
const EXPLICIT_URL = /(?<![\p{L}\p{N}_@])(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)[^\s<>"']+/giu;
const trimUrlTail = (url: string) => {
  let value = (url ?? "").replace(/[.,;:!?\]}>"]+$/u, "");
  while (value.endsWith(")") && (value.match(/\(/gu)?.length ?? 0) < (value.match(/\)/gu)?.length ?? 0))
    value = value.slice(0, -1).replace(/[.,;:!?\]}>"]+$/u, "");
  return value;
};
const attribute = (node: XNode, name: string) => Object.entries(elAttrs(node)).find(([key]) => key.endsWith(`:${name}`))?.[1];

/** Each note's linked runs (text and target), from Word's hyperlinks and HYPERLINK fields. */
function footnoteHyperlinks(xml: string, relationships: Map<string, string>) {
  const runs = new Map<number, Array<{ text: string; target: string }>>();
  const root = createParser().parse(xml) as XNode[];
  const notes = root.flatMap((node) => elName(node) === "w:footnotes" ? elChildren(node) : [])
    .filter((node) => elName(node) === "w:footnote" && attribute(node, "type") === undefined);
  for (const note of notes) {
    const id = Number(attribute(note, "id"));
    if (!Number.isInteger(id) || id <= 0) continue;
    const found: Array<{ text: string; target: string }> = [];
    const walk = (node: XNode, target: string) => {
      const name = elName(node);
      if (name === "w:hyperlink") target = relationships.get(attribute(node, "id") ?? "") ?? "";
      else if (name === "w:fldSimple") target = HYPERLINK_FIELD.exec(attribute(node, "instr") ?? "")?.[1] ?? target;
      if (name === "w:t" && target) found.push({ text: getTextContent(node), target });
      for (const child of elChildren(node)) walk(child, target);
    };
    walk(note, "");
    if (found.length) runs.set(id, found);
  }
  return runs;
}

/** Author links in a note's text: its hyperlinked runs, then any URL it writes out. */
function authorLinks(text: string, runs: Array<{ text: string; target: string }>) {
  const found: AuthorLink[] = [];
  let from = 0;
  for (const run of runs) {
    const anchor = run.text.replace(/\s+/gu, " ").trim();
    if (!anchor) continue;
    let at = text.indexOf(anchor, from);
    if (at < 0) at = text.indexOf(anchor);
    if (at < 0) continue;
    from = at + anchor.length;
    found.push({ start: at, end: at + anchor.length, target: run.target, text: anchor, source: "hyperlink" });
  }
  for (const match of text.matchAll(EXPLICIT_URL)) {
    let href = trimUrlTail(match[0]);
    if (!href) continue;
    const start = match.index, end = start + href.length;
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(href)) href = `https://${href}`;
    if (found.some((item) => item.start === start && item.end === end &&
        item.target.replace(/\/+$/u, "") === href.replace(/\/+$/u, ""))) continue;
    found.push({ start, end, target: href, text: text.slice(start, end), source: "literal" });
  }
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

export type ParsedDocument = { paragraphs: Paragraph[]; footnotes: Map<number, string>; authorLinks: Map<number, AuthorLink[]> };

/** A .docx as ALR reads it: Beaver's native body and note units, with each note's author links. */
export async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  const units = await structureNative().docxAuthorityTextUnits(Buffer.from(bytes));
  const paragraphs = units.filter((unit) => unit.kind === "body").map((unit): Paragraph => {
    let text = "", cursor = 0;
    const anchors: Paragraph["anchors"] = [];
    for (const [footnoteId, offset] of [...unit.footnote_refs].sort((a, b) => a[1] - b[1])) {
      text += unit.text.slice(cursor, offset);
      anchors.push({ footnoteId, offset: text.length });
      text += `⟦FN:${footnoteId}⟧`;
      cursor = offset;
    }
    return { text: text + unit.text.slice(cursor), anchors };
  });
  const footnotes = new Map(units.filter((unit) => unit.kind === "footnote" && unit.footnote_id !== null)
    .map((unit) => [unit.footnote_id!, unit.text.replace(/\s+/gu, " ").trim()]));
  const zip = await JSZip.loadAsync(bytes);
  const [notes, rels] = await Promise.all(["word/footnotes.xml", "word/_rels/footnotes.xml.rels"]
    .map((name) => zip.file(name)?.async("string") ?? Promise.resolve(null)));
  const relationships = new Map<string, string>();
  for (const node of rels ? (createParser().parse(rels) as XNode[]).flatMap(elChildren) : [])
    if (elName(node) === "Relationship") {
      const { "@_Id": id, "@_Target": target } = elAttrs(node);
      if (id && target) relationships.set(id, target);
    }
  const hyperlinks = notes ? footnoteHyperlinks(notes, relationships) : new Map();
  const links = new Map<number, AuthorLink[]>();
  for (const [id, text] of footnotes) {
    const found = authorLinks(text, hyperlinks.get(id) ?? []);
    if (found.length) links.set(id, found);
  }
  return { paragraphs, footnotes, authorLinks: links };
}

/** Inline double-quoted passages in order: smart or straight marks, pairing the next closer. */
export function findInlineQuotes(text: string): InlineQuote[] {
  const quotes: InlineQuote[] = [];
  let open = -1, openMark = "";
  for (let index = 0; index < text.length; index++) {
    const mark = text[index];
    if (open < 0) {
      if (mark === "“" || mark === '"') { open = index; openMark = mark; }
      continue;
    }
    if (mark !== "”" && mark !== '"') continue;
    const inner = text.slice(open + 1, index);
    if (inner.trim()) {
      const style = openMark === "“" && mark === "”" ? "SMART" : openMark === '"' && mark === '"' ? "STRAIGHT" : "MIXED";
      quotes.push({ raw: text.slice(open, index + 1), inner, style,
        type: style === "SMART" ? "inline_smart_quotes" : style === "STRAIGHT" ? "inline_straight_quotes" : "inline_mixed_quotes" });
    }
    open = -1; openMark = "";
  }
  return quotes;
}

const CLOSE_DOUBLE = new Set(['"', "”", "»"]);
const ABBREVIATION = /\b(?:Dr|Mr|Mrs|Ms|Jr|Sr|Hon|Prof|Rev|St|No|Nos|pp|para|paras|vol|vols|art|arts|pt|ch|cl|sch|sec|ss|ed|eds|e\.g|i\.e|etc|cf|viz|seq|vs|al|Ltd|Inc|Co|Corp|Bros|Assn|Dept|Univ|Intl|Natl|Ct|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|[A-Za-z])\.?$/iu;
const isSpace = (value: string | undefined) => !!value && /\s/u.test(value);

/** The sentence around a position; numbers, ellipses and common abbreviations do not end one. */
function sentenceBounds(text: string, position: number, window = 1200): [number, number] {
  const realEnd = (segment: string, at: number) => {
    if (at > 0 && /\d/u.test(segment[at - 1]) && /\d/u.test(segment[at + 1] ?? "")) return false;
    if (segment[at - 1] === "." || segment[at + 1] === ".") return false;
    return !ABBREVIATION.test(segment.slice(0, at + 1));
  };
  const pos = Math.max(0, Math.min(text.length, Math.trunc(position)));
  const left = Math.max(0, pos - window), right = Math.min(text.length, pos + window);
  const segment = text.slice(left, right), rel = pos - left;
  let leftIndex = -1;
  for (let i = rel - 1; i >= 0; i--) if (".!?".includes(segment[i]) && (segment[i] !== "." || realEnd(segment, i))) { leftIndex = i; break; }
  const leftNewline = rel > 0 ? segment.lastIndexOf("\n", rel - 1) : -1;
  if (leftNewline > leftIndex) leftIndex = leftNewline;
  let start = left + (leftIndex === -1 ? 0 : leftIndex + 1);
  if (start > 0 && start < text.length && ".!?".includes(text[start - 1]) && CLOSE_DOUBLE.has(text[start])) start++;
  while (start < right && isSpace(text[start])) start++;
  let rightIndex = -1;
  for (let i = rel; i < segment.length; i++) if (".!?".includes(segment[i]) && (segment[i] !== "." || realEnd(segment, i))) { rightIndex = i; break; }
  const newline = segment.indexOf("\n", rel);
  if (newline >= 0 && (rightIndex < 0 || newline < rightIndex)) rightIndex = newline;
  let end = left + (rightIndex >= 0 ? rightIndex + 1 : segment.length);
  while (end > 0 && end < text.length && ".!?".includes(text[end - 1]) && CLOSE_DOUBLE.has(text[end])) end++;
  return [start, end];
}
function anchorSentencePosition(text: string, anchor: number) {
  if (!text) return 0;
  let j = Math.min(Math.max(anchor - 1, 0), text.length - 1);
  while (j > 0 && isSpace(text[j])) j--;
  if (".!?".includes(text[j])) return j;
  const closers = ')"\']}]”’';
  if (closers.includes(text[j])) {
    let k = j;
    while (k > 0 && closers.includes(text[k])) k--;
    while (k > 0 && isSpace(text[k])) k--;
    if (".!?".includes(text[k])) return k;
  }
  return anchor;
}

export type AlrDocument = {
  /** Display-order footnote ids 1..N, each mapped to its text. */
  order: number[];
  footnotes: Map<number, string>;
  authorLinks: Map<number, AuthorLink[]>;
  displayIds: Map<number, string>;
  displayNumberToId: Map<number, number>;
  propositions: Map<number, string>;
  quotes: Map<number, InlineQuote[]>;
};

/** Numbers notes in order of first appearance, then builds each note's proposition and quotations. */
export function alrDocument(parsed: ParsedDocument, mode: PropositionMode): AlrDocument {
  const parts: string[] = [], anchors: Anchor[] = [];
  let position = 0;
  parsed.paragraphs.forEach((paragraph, index) => {
    parts.push(paragraph.text);
    for (const anchor of paragraph.anchors) anchors.push({ footnoteId: anchor.footnoteId, globalPos: position + anchor.offset });
    position += paragraph.text.length;
    if (index !== parsed.paragraphs.length - 1) { parts.push("\n\n"); position += 2; }
  });
  const global = parts.join("");
  const rawOrder: number[] = [], seen = new Set<number>();
  for (const anchor of [...anchors].sort((a, b) => a.globalPos - b.globalPos))
    if (anchor.footnoteId > 0 && parsed.footnotes.has(anchor.footnoteId) && !seen.has(anchor.footnoteId)) {
      seen.add(anchor.footnoteId); rawOrder.push(anchor.footnoteId);
    }
  for (const id of [...parsed.footnotes.keys()].sort((a, b) => a - b)) if (!seen.has(id)) rawOrder.push(id);
  const toDisplay = new Map(rawOrder.map((raw, index) => [raw, index + 1]));
  const remapped = anchors.filter(({ footnoteId }) => toDisplay.has(footnoteId))
    .map((anchor) => ({ ...anchor, footnoteId: toDisplay.get(anchor.footnoteId)! }));
  const footnotes = new Map(rawOrder.map((raw) => [toDisplay.get(raw)!, parsed.footnotes.get(raw) ?? ""]));
  const authorLinks = new Map(rawOrder.filter((raw) => parsed.authorLinks.has(raw))
    .map((raw) => [toDisplay.get(raw)!, parsed.authorLinks.get(raw)!]));
  const order = rawOrder.map((_, index) => index + 1);

  const displayIds = new Map<number, string>(), displayNumberToId = new Map<number, number>();
  let next = 1;
  for (const id of order) {
    const symbol = /^\s*([*†‡§#]+)/u.exec(footnotes.get(id) ?? "");
    if (symbol) displayIds.set(id, symbol[1]);
    else { displayIds.set(id, String(next)); displayNumberToId.set(next, id); next++; }
  }

  // Footnote markers leave the text the propositions are cut from.
  const rawToClean = new Array<number>(global.length + 1);
  let clean = "", cursor = 0;
  for (let index = 0; index < global.length;) {
    const marker = global.startsWith("⟦FN:", index) ? /^⟦FN:\d+⟧/u.exec(global.slice(index, index + 32)) : null;
    if (marker) {
      for (let j = 0; j < marker[0].length; j++) rawToClean[index + j] = cursor;
      index += marker[0].length;
      continue;
    }
    clean += global[index]; rawToClean[index++] = cursor++;
  }
  rawToClean[global.length] = cursor;
  const introduction = /\bIntroduction\b/iu.exec(clean);
  let introCut = 0;
  if (introduction) {
    introCut = introduction.index + introduction[0].length;
    while (introCut < clean.length && isSpace(clean[introCut])) introCut++;
  }
  const sorted = [...remapped].sort((a, b) => a.globalPos - b.globalPos);
  const propositions = new Map<number, string>();
  if (mode === "passage_since_prior_note") {
    const ordered: Array<[number, number]> = [], done = new Set<number>();
    for (const anchor of sorted) {
      if (done.has(anchor.footnoteId)) continue;
      done.add(anchor.footnoteId); ordered.push([anchor.footnoteId, rawToClean[anchor.globalPos]]);
    }
    ordered.forEach(([id, end], index) => {
      let start = index === 0 ? 0 : ordered[index - 1][1];
      if (id === 1 && introCut) start = Math.max(start, introCut);
      if (start >= end) return;
      propositions.set(id, clean.slice(start, end).replace(/\s+/gu, " ").trim());
    });
  } else {
    let previousEnd = 0;
    for (const anchor of sorted) {
      if (propositions.has(anchor.footnoteId)) continue;
      const at = rawToClean[anchor.globalPos];
      let [start, end] = sentenceBounds(clean, anchorSentencePosition(clean, at));
      for (const [open, close] of [["“", "”"], ['"', '"']]) {
        const openAt = clean.lastIndexOf(open, start - 1);
        if (openAt < previousEnd || openAt < 0 || openAt >= start) continue;
        const closedBefore = clean.indexOf(close, openAt + 1);
        if (closedBefore >= 0 && closedBefore < start) continue;
        const closedAfter = clean.indexOf(close, start);
        if (closedAfter >= 0 && closedAfter < start + 200) { [start] = sentenceBounds(clean, Math.max(0, openAt - 1)); break; }
      }
      if (anchor.footnoteId === 1 && introCut) start = Math.max(start, introCut);
      if (start >= end) continue;
      propositions.set(anchor.footnoteId, clean.slice(start, end).replace(/\s+/gu, " ").trim());
      previousEnd = end;
    }
  }
  const quotes = new Map<number, InlineQuote[]>();
  for (const id of order) {
    const found = findInlineQuotes(propositions.get(id) ?? "");
    if (found.length) quotes.set(id, found);
  }
  return { order, footnotes, authorLinks, displayIds, displayNumberToId, propositions, quotes };
}
