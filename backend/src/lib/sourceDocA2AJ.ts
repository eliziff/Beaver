import { sha256 } from "./hash";
import {
  createSourceDoc,
  createTextSourceDoc,
  sourceDocPhraseSpans,
  tokenizeSourceText,
  type SourceDoc,
  type SourceDocBlock,
} from "./sourceDoc";
import type { SourceStructureInput } from "./sourceStructureAdapter";

export type CompileInput = {
  citation: string;
  docType: "cases" | "laws";
  text: string;
  id?: string;
  structureDocumentId?: string;
  url?: string | null;
  dataset?: string | null;
  name?: string | null;
  alternateCitation?: string | null;
  sectionMap?: Record<string, string> | null;
};

const PROVIDER_PROVISION_LABEL_RE =
  /^(?:\d{1,8}[A-Za-z]{0,3}(?:[.-]\d{1,8}[A-Za-z]{0,3}){0,3}|[A-Za-z]{1,3}(?:[.-][0-9A-Za-z]{1,8}){1,3})$/u;
const REPORT_PAGE_RE = /\b(?:S\.?C\.?R\.?|R\.?C\.?S\.?)\s+(\d{1,4})\b/iu;
type DottedOrder = "component" | "fraction";

function labelParts(label: string) {
  let separator = "";
  return label.split(/([.-])/u).flatMap((value) => {
    if (value === "." || value === "-") { separator = value; return []; }
    if (!value) return [];
    const numeric = value.match(/^(\d+)([A-Za-z]*)$/u);
    return [{ separator, value, digits: numeric?.[1], suffix: [...(numeric?.[2] ?? "").toUpperCase()]
      .reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0) }];
  });
}

/** Provider-map rendering only; structural selection lives in the shared engine. */
function compareProviderLabels(left: string, right: string, order: DottedOrder) {
  const [first, second] = [left, right].map(labelParts);
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    const a = first[index], b = second[index];
    if (!a || !b) return a ? 1 : b ? -1 : 0;
    if (a.separator !== b.separator) return a.separator < b.separator ? -1 : 1;
    if (a.digits !== undefined && b.digits !== undefined) {
      const width = Math.max(a.digits.length, b.digits.length);
      const digits = (value: string) => a.separator === "." && order === "fraction"
        ? value.padEnd(width, "0") : value.replace(/^0+(?=\d)/u, "").padStart(width, "0");
      const [aDigits, bDigits] = [digits(a.digits), digits(b.digits)];
      if (aDigits !== bDigits) return aDigits < bDigits ? -1 : 1;
      if (a.digits.length !== b.digits.length) return a.digits.length < b.digits.length ? -1 : 1;
      if (a.suffix !== b.suffix) return a.suffix < b.suffix ? -1 : 1;
    } else if (a.digits !== undefined || b.digits !== undefined) {
      return a.digits !== undefined ? -1 : 1;
    } else {
      const [aText, bText] = [a.value.toUpperCase(), b.value.toUpperCase()];
      if (aText !== bText) return aText < bText ? -1 : 1;
    }
  }
  return 0;
}

function dottedOrder(labels: string[]): DottedOrder | null {
  const dotted = labels.filter((label) => label.includes(".") && !label.includes("-"));
  const inversions = (order: DottedOrder) => dotted.slice(1).filter((label, index) =>
    compareProviderLabels(dotted[index], label, order) > 0).length;
  const component = inversions("component"), fraction = inversions("fraction");
  if (component !== fraction) return fraction < component ? "fraction" : "component";
  return dotted.slice(1).some((label, index) =>
    Math.sign(compareProviderLabels(dotted[index], label, "component")) !==
    Math.sign(compareProviderLabels(dotted[index], label, "fraction"))) ? null : "component";
}

function sectionMapBlocks(sectionMap: Record<string, string>) {
  const source = Object.entries(sectionMap);
  const order = dottedOrder(source.map(([label]) => label));
  const position = new Map(source.map(([label], index) => [label, index]));
  const entries = [...source].sort(([left], [right]) => {
    const [a, b] = [left.trim(), right.trim()];
    const [aPreamble, bPreamble] = [a, b].map((value) => /^(?:preamble|pr\u00e9ambule)$/iu.test(value));
    if (aPreamble !== bPreamble) return aPreamble ? -1 : 1;
    const [aSection, bSection] = [a, b].map((value) => PROVIDER_PROVISION_LABEL_RE.test(value));
    if (aSection !== bSection) return aSection ? -1 : 1;
    if (!aSection) return 0;
    if (order) return compareProviderLabels(a, b, order);
    const component = compareProviderLabels(a, b, "component");
    const fraction = compareProviderLabels(a, b, "fraction");
    return Math.sign(component) === Math.sign(fraction) ? component : position.get(left)! - position.get(right)!;
  });
  const pieces: string[] = [], blocks: SourceDocBlock[] = [];
  let at = 0;
  for (const [rawLabel, value] of entries) {
    const label = rawLabel.trim();
    if (!value.trim() || /^\[blank\]$/iu.test(value.trim())) continue;
    if (pieces.length) { pieces.push("\n"); at += 1; }
    pieces.push(value);
    blocks.push({ kind: "section", label: `sec${label}`, start: at,
      end: at + value.length, origin: "native" });
    at += value.length;
  }
  return { text: pieces.join(""), blocks };
}

/** Preserve provider token-aligned promotion without doing structure detection in TS. */
function promoteSectionMap(text: string, blocks: SourceDocBlock[], sectionMap: Record<string, string>) {
  const search = createTextSourceDoc(text);
  const counts = new Map<string, number>();
  for (const label of Object.keys(sectionMap)) {
    const key = label.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const promoted = [...blocks];
  for (const [rawLabel, providerText] of Object.entries(sectionMap)) {
    const label = rawLabel.trim(), key = `sec${label}`.toLowerCase();
    if (!label || counts.get(label.toLowerCase()) !== 1 || !providerText.trim() ||
      /^\[blank\]$/iu.test(providerText.trim())) continue;
    const tokens = tokenizeSourceText(providerText);
    if (!tokens.length) continue;
    const matches = sourceDocPhraseSpans(search, tokens.map(({ word }) => word), { limit: 2 });
    if (matches.length !== 1) continue;
    const candidates = promoted.map((block, index) => ({ block, index })).filter(({ block }) =>
      block.kind === "section" && !block.parentLabel &&
      [block.label, ...(block.aliases ?? [])].some((value) => value.toLowerCase() === key));
    if (candidates.length !== 1 || matches[0].start < candidates[0].block.start ||
      matches[0].end > candidates[0].block.end) continue;
    promoted[candidates[0].index] = { ...candidates[0].block, origin: "native" };
  }
  return promoted.sort((left, right) => left.start - right.start ||
    Number(!!left.parentLabel) - Number(!!right.parentLabel));
}

export function reporterStartPage(...citations: Array<string | null | undefined>) {
  for (const citation of citations) {
    const match = REPORT_PAGE_RE.exec(citation ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

export type A2AJStructureSummary = {
  status: "usable" | "unavailable";
  source: "flat_text" | "section_map";
  counts: { paragraph: number; page: number; section: number };
};

export function summarizeA2AJSourceDoc(doc: SourceDoc): A2AJStructureSummary {
  return { status: doc.status,
    source: doc.blocks.some(({ origin }) => origin === "native") ? "section_map" : "flat_text",
    counts: { paragraph: doc.ranges.paragraph.count, page: doc.ranges.page.count,
      section: doc.ranges.section.count } };
}

/** Provider integration only: render map-only text or align exact native outer claims. */
function a2ajProviderSource(input: CompileInput) {
  if (!input.text.trim() && input.sectionMap && Object.keys(input.sectionMap).length) {
    return sectionMapBlocks(input.sectionMap);
  }
  const blocks: SourceDocBlock[] = [];
  for (const [rawLabel, value] of Object.entries(input.sectionMap ?? {})) {
    const label = rawLabel.trim();
    if (!label || !value.trim() || /^\[blank\]$/iu.test(value.trim())) continue;
    const start = input.text.indexOf(value);
    if (start < 0 || input.text.indexOf(value, start + 1) >= 0) continue;
    const lineStart = input.text.lastIndexOf("\n", start - 1) + 1;
    const prefix = input.text.slice(lineStart, start);
    const printed = prefix.trim().match(/^([^\s.)]+)[.)]?$/u)?.[1];
    if (printed && PROVIDER_PROVISION_LABEL_RE.test(printed) &&
      printed.toLowerCase() !== label.toLowerCase()) continue;
    // Let the shared engine own ordinary printed sections, then promote its
    // full inferred bounds below. Exact native claims are only the fallback
    // for provider sections the printed-section grammar cannot recover.
    if (printed) continue;
    const claimStart = printed ? lineStart + prefix.search(/\S/u) : start;
    blocks.push({ kind: "section", label: `sec${label}`, start: claimStart,
      end: start + value.length, origin: "native" });
  }
  return { text: input.text, blocks };
}

export function prepareA2AJSourceStructure(
  input: CompileInput,
  scope: { kind: "complete" | "excerpt"; excerptOf?: string } = { kind: "complete" },
) {
  const native = a2ajProviderSource(input);
  const sourceSha256 = sha256(JSON.stringify([input.text, input.sectionMap ?? null]));
  const reportStart = reporterStartPage(input.citation, input.alternateCitation);
  const structure: SourceStructureInput = {
    provider: "a2aj", id: input.id ?? input.citation,
    documentId: input.structureDocumentId, url: input.url, docType: input.docType,
    text: native.text, providerRevision: "a2aj-adapter-v1", sourceSha256,
    representationRevision: sha256(input.text || JSON.stringify(input.sectionMap ?? null)),
    scope, profile: input.docType === "cases" ? "case_rooted_complete" : "legislation",
    ...(reportStart === null ? {} : { reportStartPage: reportStart }),
    requireReportStart: input.docType === "cases" && (input.dataset ?? "").toUpperCase() === "SCC",
    allowHyphenatedSections: input.docType === "laws" &&
      /\b(?:rules?|regulations?|r[e\u00e8]glements?)\b/iu.test(input.name ?? ""),
    nativeBlocks: native.blocks, order: input.docType === "cases" ? "case" : "legislation",
  };
  return { input, structure };
}

export function finalizeA2AJSourceStructure(
  prepared: ReturnType<typeof prepareA2AJSourceStructure>,
  derived: SourceDoc,
) {
  const { input } = prepared;
  return input.docType === "laws" && input.text.trim() && input.sectionMap
    ? createSourceDoc({ provider: "a2aj", id: derived.id, url: derived.url, docType: "laws",
      text: derived.text, blocks: promoteSectionMap(derived.text, derived.blocks, input.sectionMap) })
    : derived;
}
