/**
 * Cross-document defined-term drift detection.
 *
 * A deal stack defines the same terms in several instruments, and the
 * definitions quietly diverge — "Material Adverse Effect" grown a carve-out
 * in the guarantee, "Business Day" naming different cities in the credit
 * agreement and the intercreditor. Single-document checkers (Contract
 * Companion, Definely) never see this; it is a pure composition of things
 * we already parse, and a genuine diligence trap.
 *
 * Deterministic: extract definition bodies per document, normalize
 * conservatively (whitespace + quote glyphs only), diff across documents.
 */
import { compileAgreementSkeleton } from "./legalTextSkeleton";

export interface TermDriftDoc {
  name: string;
  text: string;
}

export interface TermDefinition {
  document: string;
  /** skeleton label of the containing provision, if resolvable */
  sectionLabel: string | null;
  body: string;
  /** additional definitions of the same term in the same document */
  duplicatesInDocument: number;
}

export interface TermDriftRow {
  term: string;
  status: "consistent" | "divergent";
  definitions: TermDefinition[];
  /** for divergent rows: where the normalized bodies first differ */
  divergence?: {
    documents: [string, string];
    excerpts: [string, string];
  };
}

export interface TermUseGap {
  term: string;
  definedIn: string[];
  usedIn: string;
  occurrences: number;
}

export interface TermDriftReport {
  /** terms defined in 2+ documents, divergent first */
  shared: TermDriftRow[];
  /** term used in a document that neither defines nor apparently imports it */
  importedUses: TermUseGap[];
  /** per-document count of definition-list terms found */
  definitionCounts: Record<string, number>;
  truncated: boolean;
}

/** "Term" means / shall mean / has the meaning …, straight or typographic. */
const DEFINITION_RE =
  /(?:“([A-Z][^”\n]{0,79})”|"([A-Z][^"\n]{0,79})")\s+(means|shall mean|has the meaning|shall have the meaning|is defined as|includes)\b/gu;

interface RawDefinition {
  term: string;
  start: number;
  body: string;
}

function extractDefinitions(text: string): RawDefinition[] {
  const out: RawDefinition[] = [];
  for (const match of text.matchAll(DEFINITION_RE)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (!term) continue;
    const start = match.index ?? 0;
    // Body: from the verb to the end of the paragraph or the next
    // definition entry, capped so a runaway match cannot swallow pages.
    const rest = text.slice(start, start + 2000);
    const paragraphEnd = rest.search(/\n\s*\n/u);
    let end = paragraphEnd === -1 ? rest.length : paragraphEnd;
    const nextDef = rest.slice(1).search(/(?:“[A-Z][^”\n]{0,79}”|"[A-Z][^"\n]{0,79}")\s+(?:means|shall mean)\b/u);
    if (nextDef !== -1 && nextDef + 1 < end) end = nextDef + 1;
    out.push({ term, start, body: rest.slice(0, end).trim() });
  }
  return out;
}

/** Conservative normalization: glyphs and whitespace, never wording. */
function normalizeBody(body: string): string {
  return body
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/[—–]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/[.;,]\s*$/u, "")
    .trim();
}

function excerptAt(a: string, b: string): [string, string] {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 40);
  const cut = (s: string) =>
    `${from > 0 ? "…" : ""}${s.slice(from, i + 80)}${i + 80 < s.length ? "…" : ""}`;
  return [cut(a), cut(b)];
}

function sectionLabelAt(
  nodes: Array<{ label: string; start: number; end: number }>,
  offset: number,
): string | null {
  let best: { label: string; span: number } | null = null;
  for (const node of nodes) {
    if (offset >= node.start && offset < node.end) {
      const span = node.end - node.start;
      if (!best || span < best.span) best = { label: node.label, span };
    }
  }
  return best?.label ?? null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function termDriftReport(
  docs: TermDriftDoc[],
  opts: { maxRows?: number } = {},
): TermDriftReport {
  const maxRows = opts.maxRows ?? 40;
  const byTerm = new Map<string, TermDefinition[]>();
  const definitionCounts: Record<string, number> = {};
  const perDocTerms = new Map<string, Set<string>>();

  for (const doc of docs) {
    const definitions = extractDefinitions(doc.text);
    definitionCounts[doc.name] = definitions.length;
    const nodes = definitions.length
      ? compileAgreementSkeleton(doc.text).nodes
      : [];
    const seen = new Map<string, TermDefinition>();
    for (const def of definitions) {
      const existing = seen.get(def.term);
      if (existing) {
        existing.duplicatesInDocument += 1;
        continue;
      }
      seen.set(def.term, {
        document: doc.name,
        sectionLabel: sectionLabelAt(nodes, def.start),
        body: def.body,
        duplicatesInDocument: 0,
      });
    }
    perDocTerms.set(doc.name, new Set(seen.keys()));
    for (const [term, entry] of seen) {
      const list = byTerm.get(term) ?? [];
      list.push(entry);
      byTerm.set(term, list);
    }
  }

  const shared: TermDriftRow[] = [];
  for (const [term, definitions] of byTerm) {
    if (definitions.length < 2) continue;
    const normalized = definitions.map((def) => normalizeBody(def.body));
    let divergence: TermDriftRow["divergence"];
    for (let i = 1; i < normalized.length && !divergence; i += 1) {
      if (normalized[i] !== normalized[0]) {
        divergence = {
          documents: [definitions[0].document, definitions[i].document],
          excerpts: excerptAt(normalized[0], normalized[i]),
        };
      }
    }
    shared.push({
      term,
      status: divergence ? "divergent" : "consistent",
      definitions,
      divergence,
    });
  }
  shared.sort((a, b) =>
    a.status === b.status
      ? a.term.localeCompare(b.term)
      : a.status === "divergent"
        ? -1
        : 1,
  );

  // Imported uses: a term defined only elsewhere in the stack, used here.
  const importedUses: TermUseGap[] = [];
  if (docs.length > 1) {
    for (const [term, definitions] of byTerm) {
      if (term.length < 4) continue;
      const definedIn = definitions.map((def) => def.document);
      const pattern = new RegExp(`\\b${escapeRe(term)}\\b`, "gu");
      for (const doc of docs) {
        if (perDocTerms.get(doc.name)?.has(term)) continue;
        const occurrences = [...doc.text.matchAll(pattern)].length;
        if (occurrences > 0) {
          importedUses.push({ term, definedIn, usedIn: doc.name, occurrences });
        }
      }
    }
  }
  importedUses.sort((a, b) => b.occurrences - a.occurrences);

  const truncated = shared.length > maxRows || importedUses.length > maxRows;
  return {
    shared: shared.slice(0, maxRows),
    importedUses: importedUses.slice(0, maxRows),
    definitionCounts,
    truncated,
  };
}
