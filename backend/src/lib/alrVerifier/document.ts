// ALR's document model: body text with footnote markers, footnote text, author hyperlinks,
// footnote order and display numbers, the proposition before each note and its quotations.
// Ported from ALR-Quote-Verifier alr_quote_verifier.py (_load_parsed_document,
// extract_doc_stream_with_styles, build_global_text, extract_footnotes,
// build_clean_text_and_index_map, find_inline_quotes, build_anchor_propositions,
// _compute_footnote_display_ids, compute_footnote_order, build_audit_data).
import JSZip from "jszip";
import { decodeXmlText } from "../text";
import type { PropositionMode } from "./settings";

export type AuthorLink = { start: number; end: number; target: string; text: string; source: "hyperlink" | "literal" };
type Paragraph = { text: string; anchors: Array<{ footnoteId: number; offset: number }> };
type Anchor = { footnoteId: number; globalPos: number };
export type InlineQuote = { raw: string; inner: string; type: string; style: "SMART" | "STRAIGHT" | "MIXED" };

type XmlEvent = { kind: "open" | "close" | "empty"; name: string; attributes: Record<string, string> } | { kind: "text"; text: string };
const XML_TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>]*)>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gu;
function* xmlEvents(xml: string): Generator<XmlEvent> {
  for (const match of xml.matchAll(XML_TOKEN)) {
    if (match[1] !== undefined) { yield { kind: "text", text: match[1] }; continue; }
    if (match[6] !== undefined) { yield { kind: "text", text: decodeXmlText(match[6]) }; continue; }
    if (!match[3]) continue;
    const attributes: Record<string, string> = {};
    for (const [, key, quoted, single] of (match[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu))
      attributes[key] = decodeXmlText(quoted ?? single ?? "");
    yield { kind: match[2] ? "close" : match[5] ? "empty" : "open", name: match[3], attributes };
  }
}
const local = (name: string) => name.slice(name.indexOf(":") + 1);
const attribute = (attributes: Record<string, string>, name: string) =>
  Object.entries(attributes).find(([key]) => local(key) === name)?.[1];

/** One character run each element of a paragraph or note contributes, as Word lays them out. */
function runText(name: string) {
  return name === "tab" ? "\t" : name === "br" || name === "cr" ? "\n" : null;
}

function bodyParagraphs(xml: string): Paragraph[] {
  const paragraphs: Paragraph[] = [], stack: string[] = [];
  let current: Paragraph | null = null, depth = -1, inText = false;
  for (const event of xmlEvents(xml)) {
    if (event.kind === "text") { if (current && inText) current.text += event.text; continue; }
    const name = local(event.name);
    if (event.kind === "close") {
      stack.pop();
      if (name === "t") inText = false;
      if (current && stack.length === depth) { paragraphs.push(current); current = null; depth = -1; }
      continue;
    }
    // Only the body's own paragraphs are read; tables and other containers are not.
    if (!current && name === "p" && stack.length >= 1 && local(stack.at(-1)!) === "body") {
      current = { text: "", anchors: [] };
      depth = stack.length;
      if (event.kind === "empty") { paragraphs.push(current); current = null; depth = -1; }
      else stack.push(event.name);
      continue;
    }
    if (current) {
      const value = runText(name);
      if (value) current.text += value;
      else if (name === "footnoteReference") {
        const id = Number(attribute(event.attributes, "id"));
        if (Number.isInteger(id)) {
          current.anchors.push({ footnoteId: id, offset: current.text.length });
          current.text += `⟦FN:${id}⟧`;
        }
      } else if (name === "t" && event.kind === "open") inText = true;
    }
    if (event.kind === "open") stack.push(event.name);
  }
  return paragraphs;
}

const HYPERLINK_FIELD = /\bHYPERLINK\s+["']([^"']+)["']/iu;
const EXPLICIT_URL = /(?<![\p{L}\p{N}_@])(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)[^\s<>"']+/giu;
const trimUrlTail = (url: string) => {
  let value = (url ?? "").replace(/[.,;:!?\]}>"]+$/u, "");
  while (value.endsWith(")") && (value.match(/\(/gu)?.length ?? 0) < (value.match(/\)/gu)?.length ?? 0))
    value = value.slice(0, -1).replace(/[.,;:!?\]}>"]+$/u, "");
  return value;
};

function footnotes(xml: string, relationships: Map<string, string>) {
  const notes = new Map<number, string>(), links = new Map<number, AuthorLink[]>();
  const stack: XmlEvent[] = [];
  let id: number | null = null, depth = -1, raw = "", runs: Array<[number, number, string]> = [], inText = false;
  const target = () => {
    for (let index = stack.length - 1; index > depth; index--) {
      const event = stack[index] as Extract<XmlEvent, { name: string }>, name = local(event.name);
      if (name === "hyperlink") return relationships.get(attribute(event.attributes, "id") ?? "") ?? "";
      if (name === "fldSimple") {
        const field = HYPERLINK_FIELD.exec(attribute(event.attributes, "instr") ?? "");
        if (field) return field[1];
      }
    }
    return "";
  };
  const add = (value: string) => {
    if (!value) return;
    const href = target();
    if (href) runs.push([raw.length, raw.length + value.length, href]);
    raw += value;
  };
  const finish = (noteId: number) => {
    const text = raw.replace(/\s+/gu, " ").trim();
    notes.set(noteId, text);
    const found: AuthorLink[] = [];
    let from = 0;
    for (const [start, end, href] of runs) {
      const anchor = raw.slice(start, end).replace(/\s+/gu, " ").trim();
      if (!anchor) continue;
      let at = text.indexOf(anchor, from);
      if (at < 0) at = text.indexOf(anchor);
      if (at < 0) continue;
      from = at + anchor.length;
      found.push({ start: at, end: at + anchor.length, target: href, text: anchor, source: "hyperlink" });
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
    if (found.length) links.set(noteId, found.sort((a, b) => a.start - b.start || a.end - b.end));
  };
  for (const event of xmlEvents(xml)) {
    if (event.kind === "text") { if (id !== null && inText) add(event.text); continue; }
    const name = local(event.name);
    if (event.kind === "close") {
      stack.pop();
      if (name === "t") inText = false;
      if (id !== null && stack.length === depth) { finish(id); id = null; depth = -1; }
      continue;
    }
    if (id === null && name === "footnote") {
      const noteId = Number(attribute(event.attributes, "id"));
      // Separator and continuation notes carry a type; real notes have positive ids.
      if (attribute(event.attributes, "type") === undefined && Number.isInteger(noteId) && noteId > 0) {
        id = noteId; depth = stack.length; raw = ""; runs = [];
        if (event.kind === "empty") { finish(id); id = null; depth = -1; continue; }
      }
    } else if (id !== null) {
      const value = runText(name);
      if (value) add(value);
      else if (name === "t" && event.kind === "open") inText = true;
    }
    if (event.kind === "open") stack.push(event);
  }
  return { notes, links };
}

export type ParsedDocument = { paragraphs: Paragraph[]; footnotes: Map<number, string>; authorLinks: Map<number, AuthorLink[]> };

/** Reads a .docx the way ALR reads one: body paragraphs, real footnotes, and their hyperlinks. */
export async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  const zip = await JSZip.loadAsync(bytes);
  const read = (name: string) => zip.file(name)?.async("string") ?? Promise.resolve(null);
  const [document, notes, rels] = await Promise.all([read("word/document.xml"),
    read("word/footnotes.xml"), read("word/_rels/footnotes.xml.rels")]);
  if (!document) throw new Error("This Word file has no document body.");
  const relationships = new Map<string, string>();
  for (const event of xmlEvents(rels ?? "")) if (event.kind !== "text" && local(event.name) === "Relationship" &&
      event.attributes.Id && event.attributes.Target) relationships.set(event.attributes.Id, event.attributes.Target);
  const read2 = notes ? footnotes(notes, relationships) : { notes: new Map<number, string>(), links: new Map<number, AuthorLink[]>() };
  return { paragraphs: bodyParagraphs(document), footnotes: read2.notes, authorLinks: read2.links };
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
