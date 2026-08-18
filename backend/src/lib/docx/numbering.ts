/**
 * Auto-numbering resolver: computes the labels ("2.1", "(a)", "Article III")
 * that Word renders from `w:numPr` at display time and that no extractor —
 * mammoth or pandoc — synthesizes (probe: scripts/probe-numbering-fidelity.ts).
 *
 * Indexes are 0-based positions in the SAME body-paragraph order that
 * `extractDocxBodyText` produces, so `labels.get(i)` addresses
 * `extractDocxBodyText(bytes).split("\n")[i]`. The walk below mirrors that
 * flattening exactly; changing one without the other breaks the contract.
 */

import {
  elAttrs,
  elChildren,
  elName,
  type XNode,
} from "./core";
import { openDocxSession } from "./session";

const SUPPORTED_FORMATS = new Set([
  "decimal",
  "decimalZero",
  "lowerLetter",
  "upperLetter",
  "lowerRoman",
  "upperRoman",
]);

const SILENT_FORMATS = new Set(["bullet"]);

const MAX_LEVEL = 8;
const MAX_STYLE_HOPS = 16;

export interface ResolvedNumbering {
  /** Body-paragraph index (0-based) → rendered label. Absent = no label. */
  labels: Map<number, string>;
  /** What could not be resolved, one line per distinct cause. */
  notes: string[];
}

interface LevelDef {
  start: number;
  numFmt: string;
  lvlText: string;
  /** w:isLgl — render every placeholder as decimal whatever its own format. */
  isLgl: boolean;
  /** w:lvlRestart; non-null means this level does not use the default rule. */
  lvlRestart: number | null;
}

interface AbstractNum {
  levels: Map<number, LevelDef>;
  /** Delegates the whole definition to the numbering of a paragraph style. */
  numStyleLink: string | null;
}

interface ConcreteNum {
  abstractNumId: string;
  startOverrides: Map<number, number>;
  /** A w:lvlOverride may carry a whole replacement w:lvl, not just a start. */
  levelOverrides: Map<number, LevelDef>;
}

interface StyleNum {
  numId: string | null;
  ilvl: number | null;
  basedOn: string | null;
}

function attrOf(node: unknown, name: string): string | undefined {
  return elAttrs(node)[`@_${name}`];
}

function childNamed(node: unknown, name: string): XNode | null {
  for (const c of elChildren(node as XNode)) {
    if (elName(c) === name) return c;
  }
  return null;
}

/** `<w:x w:val="…"/>` — the shape almost every numbering element uses. */
function valOf(node: unknown, name: string): string | undefined {
  const found = childNamed(node, name);
  return found ? attrOf(found, "w:val") : undefined;
}

function intOf(raw: string | undefined): number | null {
  if (raw == null) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toggleOn(node: unknown, name: string): boolean {
  const found = childNamed(node, name);
  if (!found) return false;
  const raw = attrOf(found, "w:val");
  return raw !== "0" && raw !== "false";
}

/** Bijective base-26: 1→a, 26→z, 27→aa, 28→ab. Word repeats the letter past
 *  z (aa, bb, cc); this positional form is what cross-references expect. */
function toLetters(value: number): string {
  let n = value;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function toRoman(value: number): string {
  let n = value;
  let out = "";
  for (const [weight, glyph] of ROMAN) {
    while (n >= weight) {
      out += glyph;
      n -= weight;
    }
  }
  return out;
}

export function formatNumberingValue(
  value: number,
  numFmt: string,
): string | null {
  switch (numFmt) {
    case "decimal":
      return String(value);
    case "decimalZero":
      return value >= 0 && value < 10 ? `0${value}` : String(value);
    case "lowerLetter":
      return value > 0 ? toLetters(value) : String(value);
    case "upperLetter":
      return value > 0 ? toLetters(value).toUpperCase() : String(value);
    case "lowerRoman":
      return value > 0 && value < 4000 ? toRoman(value) : String(value);
    case "upperRoman":
      return value > 0 && value < 4000
        ? toRoman(value).toUpperCase()
        : String(value);
    default:
      return null;
  }
}

function parseLevel(lvl: XNode): [number, LevelDef] | null {
  const ilvl = intOf(attrOf(lvl, "w:ilvl"));
  if (ilvl == null || ilvl < 0 || ilvl > MAX_LEVEL) return null;
  return [
    ilvl,
    {
      start: intOf(valOf(lvl, "w:start")) ?? 1,
      numFmt: valOf(lvl, "w:numFmt") ?? "decimal",
      lvlText: valOf(lvl, "w:lvlText") ?? "",
      isLgl: toggleOn(lvl, "w:isLgl"),
      lvlRestart: intOf(valOf(lvl, "w:lvlRestart")),
    },
  ];
}

function numberingRoot(tree: XNode[]): XNode | null {
  return tree.find((n) => elName(n) === "w:numbering") ?? null;
}

function parseAbstractNums(tree: XNode[]): Map<string, AbstractNum> {
  const out = new Map<string, AbstractNum>();
  const root = numberingRoot(tree);
  if (!root) return out;
  for (const node of elChildren(root)) {
    if (elName(node) !== "w:abstractNum") continue;
    const id = attrOf(node, "w:abstractNumId");
    if (id == null) continue;
    const levels = new Map<number, LevelDef>();
    for (const lvl of elChildren(node)) {
      if (elName(lvl) !== "w:lvl") continue;
      const parsed = parseLevel(lvl);
      if (parsed) levels.set(parsed[0], parsed[1]);
    }
    out.set(id, { levels, numStyleLink: valOf(node, "w:numStyleLink") ?? null });
  }
  return out;
}

function parseConcreteNums(tree: XNode[]): Map<string, ConcreteNum> {
  const out = new Map<string, ConcreteNum>();
  const root = numberingRoot(tree);
  if (!root) return out;
  for (const node of elChildren(root)) {
    if (elName(node) !== "w:num") continue;
    const numId = attrOf(node, "w:numId");
    const abstractNumId = valOf(node, "w:abstractNumId");
    if (numId == null || abstractNumId == null) continue;
    const startOverrides = new Map<number, number>();
    const levelOverrides = new Map<number, LevelDef>();
    for (const override of elChildren(node)) {
      if (elName(override) !== "w:lvlOverride") continue;
      const ilvl = intOf(attrOf(override, "w:ilvl"));
      if (ilvl == null || ilvl < 0 || ilvl > MAX_LEVEL) continue;
      const start = intOf(valOf(override, "w:startOverride"));
      if (start != null) startOverrides.set(ilvl, start);
      const lvl = childNamed(override, "w:lvl");
      const parsed = lvl ? parseLevel(lvl) : null;
      if (parsed) levelOverrides.set(ilvl, parsed[1]);
    }
    out.set(numId, { abstractNumId, startOverrides, levelOverrides });
  }
  return out;
}

function parseStyleNums(tree: XNode[]): Map<string, StyleNum> {
  const out = new Map<string, StyleNum>();
  const root = tree.find((n) => elName(n) === "w:styles");
  if (!root) return out;
  for (const style of elChildren(root)) {
    if (elName(style) !== "w:style") continue;
    const id = attrOf(style, "w:styleId");
    if (id == null) continue;
    const pPr = childNamed(style, "w:pPr");
    const numPr = pPr ? childNamed(pPr, "w:numPr") : null;
    out.set(id, {
      numId: numPr ? (valOf(numPr, "w:numId") ?? null) : null,
      ilvl: numPr ? intOf(valOf(numPr, "w:ilvl")) : null,
      basedOn: valOf(style, "w:basedOn") ?? null,
    });
  }
  return out;
}

function styleNumbering(
  styles: Map<string, StyleNum>,
  styleId: string | null,
): { numId: string; ilvl: number | null } | null {
  let current = styleId;
  const seen = new Set<string>();
  for (let hop = 0; current != null && hop < MAX_STYLE_HOPS; hop += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    const style = styles.get(current);
    if (!style) return null;
    if (style.numId != null) return { numId: style.numId, ilvl: style.ilvl };
    current = style.basedOn;
  }
  return null;
}

function resolveAbstract(
  abstracts: Map<string, AbstractNum>,
  concretes: Map<string, ConcreteNum>,
  styles: Map<string, StyleNum>,
  abstractNumId: string,
): AbstractNum | null {
  let id: string | null = abstractNumId;
  const seen = new Set<string>();
  for (let hop = 0; id != null && hop < MAX_STYLE_HOPS; hop += 1) {
    if (seen.has(id)) return null;
    seen.add(id);
    const abstract: AbstractNum | undefined = abstracts.get(id);
    if (!abstract) return null;
    if (abstract.levels.size > 0 || abstract.numStyleLink == null) {
      return abstract;
    }
    const linked = styleNumbering(styles, abstract.numStyleLink);
    const concrete = linked ? concretes.get(linked.numId) : undefined;
    id = concrete ? concrete.abstractNumId : null;
  }
  return null;
}

function renderLabel(
  lvlText: string,
  levels: Map<number, LevelDef>,
  counters: Map<number, number>,
  isLgl: boolean,
): { label: string } | { unresolvedFormat: string } {
  let unresolvedFormat: string | null = null;
  const label = lvlText.replace(/%([1-9])/gu, (_match, digit: string) => {
    const level = Number(digit) - 1;
    const def = levels.get(level);
    const value = counters.get(level) ?? def?.start ?? 1;
    const numFmt = isLgl ? "decimal" : (def?.numFmt ?? "decimal");
    const rendered = formatNumberingValue(value, numFmt);
    if (rendered == null) {
      unresolvedFormat = numFmt;
      return "";
    }
    return rendered;
  });
  return unresolvedFormat != null ? { unresolvedFormat } : { label };
}

function message(error: unknown) {
  return String((error as { message?: unknown })?.message ?? error)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Computes the rendered numbering label for every body paragraph that
 * references numbering. Never throws: an unreadable package degrades to an
 * empty label map plus a note.
 */
export async function resolveDocxNumbering(
  bytes: Buffer,
): Promise<ResolvedNumbering> {
  const labels = new Map<number, string>();
  const notes: string[] = [];
  const unsupported = new Set<string>();
  const undefinedNums = new Set<string>();
  let sawLvlRestart = false;

  try {
    const session = await openDocxSession(bytes);
    const document = await session.document("Numbering");
    const numberingTree = await session.readXml("word/numbering.xml");
    const stylesTree = await session.readXml("word/styles.xml");
    const abstracts = numberingTree
      ? parseAbstractNums(numberingTree)
      : new Map<string, AbstractNum>();
    const concretes = numberingTree
      ? parseConcreteNums(numberingTree)
      : new Map<string, ConcreteNum>();
    const styles = stylesTree
      ? parseStyleNums(stylesTree)
      : new Map<string, StyleNum>();

    const effective = new Map<string, Map<number, LevelDef> | null>();
    const levelsFor = (numId: string) => {
      const cached = effective.get(numId);
      if (cached !== undefined) return cached;
      const concrete = concretes.get(numId);
      const abstract = concrete
        ? resolveAbstract(abstracts, concretes, styles, concrete.abstractNumId)
        : null;
      let merged: Map<number, LevelDef> | null = null;
      if (abstract) {
        merged = new Map(abstract.levels);
        for (const [ilvl, def] of concrete!.levelOverrides) merged.set(ilvl, def);
      }
      effective.set(numId, merged);
      return merged;
    };

    const counters = new Map<string, Map<number, number>>();

    const paragraph = (node: XNode, index: number) => {
      const pPr = childNamed(node, "w:pPr");
      if (!pPr) return;
      const numPr = childNamed(pPr, "w:numPr");
      const direct = numPr ? (valOf(numPr, "w:numId") ?? null) : null;
      const directLevel = numPr ? intOf(valOf(numPr, "w:ilvl")) : null;
      const viaStyle = styleNumbering(styles, valOf(pPr, "w:pStyle") ?? null);
      const numId = direct ?? viaStyle?.numId ?? null;
      if (numId == null || numId === "0") return;

      const levels = levelsFor(numId);
      const level = Math.min(
        Math.max(directLevel ?? viaStyle?.ilvl ?? 0, 0),
        MAX_LEVEL,
      );
      const def = levels?.get(level);
      if (!levels || !def) {
        undefinedNums.add(numId);
        return;
      }
      if (def.lvlRestart != null) sawLvlRestart = true;

      let byLevel = counters.get(numId);
      if (!byLevel) {
        byLevel = new Map<number, number>();
        counters.set(numId, byLevel);
      }
      const current = byLevel.get(level);
      const start = concretes.get(numId)?.startOverrides.get(level) ?? def.start;
      byLevel.set(level, current == null ? start : current + 1);
      for (let deeper = level + 1; deeper <= MAX_LEVEL; deeper += 1) {
        byLevel.delete(deeper);
      }

      if (SILENT_FORMATS.has(def.numFmt)) return;
      if (!SUPPORTED_FORMATS.has(def.numFmt)) {
        unsupported.add(def.numFmt);
        return;
      }
      const rendered = renderLabel(def.lvlText, levels, byLevel, def.isLgl);
      if ("unresolvedFormat" in rendered) {
        unsupported.add(rendered.unresolvedFormat);
        return;
      }
      if (rendered.label) labels.set(index, rendered.label);
    };

    document.paragraphs.forEach(({ node }, index) => paragraph(node, index));

    for (const numFmt of [...unsupported].sort()) {
      notes.push(
        `Numbering format "${numFmt}" is not rendered here; those paragraphs carry no label.`,
      );
    }
    for (const numId of [...undefinedNums].sort()) {
      notes.push(
        `Numbering ${numId} is referenced but this package does not define the level it uses; those labels cannot be reconstructed.`,
      );
    }
    if (sawLvlRestart) {
      notes.push(
        "A level sets w:lvlRestart; the default restart-on-any-higher-level rule was applied instead.",
      );
    }
    return { labels, notes };
  } catch (error) {
    return {
      labels: new Map<number, string>(),
      notes: [`Numbering could not be resolved: ${message(error)}.`],
    };
  }
}

/**
 * Prefixes each labelled paragraph of `extractDocxBodyText` output with its
 * label. `text` must be that exact string — the indexes address its
 * newline-separated paragraphs and nothing else.
 */
export function applyNumberingToText(
  text: string,
  labels: Map<number, string>,
): string {
  if (labels.size === 0) return text;
  const lines = text.split("\n");
  for (const [index, label] of labels) {
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) continue;
    lines[index] = lines[index] ? `${label} ${lines[index]}` : label;
  }
  return lines.join("\n");
}
