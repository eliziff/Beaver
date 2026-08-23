/**
 * Parses US, Canadian, and contract amendment prose into addressed edits,
 * then applies and verifies every edit against Rust-derived structure.
 */
import { normalizeSourceDocLocator } from "./sourceDoc";
import type { SourceDoc, SourceDocBlock } from "./sourceDoc";
import { grammarRegExp, grammarSource } from "./grammarCorpus";
import { analyzeDocumentNative } from "./structureNative";

type InstrumentStructure = {
    diagnostics: { code: string }[];
    nodes: Array<{
      label?: string; locator_kind?: string; parent_id?: string;
      range: { start: number; end: number };
      marker_range?: { start: number; end: number };
    }>;
    cross_references: { edges: Array<{
      sourceStart: number; sourceEnd: number; raw: string; rawLabel: string;
      normalizedLocator: string; targetLabel: string | null;
      status: string; reason?: string;
    }> };
};

async function analyzeInstrument(text: string, reconstructLineation?: boolean) {
  const result = await analyzeDocumentNative<InstrumentStructure>({
    kind: "instrument",
    text,
    id: "",
    table_cells: [],
    reconstruct_lineation: reconstructLineation !== false,
    source_doc: true,
  });
  if (!result.source_doc) throw new Error("Rust omitted SourceDoc");
  return result;
}

export type AmendOpKind =
  | "strike_text"
  | "insert_text"
  | "substitute_text"
  | "append_text"
  | "strike_provision"
  | "replace_provision"
  | "add_provision"
  | "add_at_end"
  | "repeal_provision"
  | "redesignate";

export interface AmendOp {
  kind: AmendOpKind;
  /** Locator in the shared `sec8.01(a)` dialect; "" when no target parsed. */
  target: string;
  oldText?: string;
  newText?: string;
  /** insert_text placement relative to `anchorText`. */
  position?: "after" | "before";
  anchorText?: string;
  /** For add_provision: insert after this child of `target`. */
  afterChild?: string;
  newLabel?: string;
  /** "each place it appears" — apply to every occurrence in the target. */
  everyOccurrence?: boolean;
  /** "the period at the end" — match the LAST occurrence, no ambiguity. */
  anchorLast?: boolean;
  /** Bare-token ops ("or", "and") match whole words only. */
  wholeWord?: boolean;
  /** Sentence excerpt the op was compiled from. */
  raw: string;
}

export interface AmendParseResult {
  ops: AmendOp[];
  /** Instruction-looking sentences the grammar could not compile. */
  unparsed: Array<{ excerpt: string; reason: string }>;
}

/* ------------------------------------------------------------------ */
/* Quoting: typographic “”, GPO ``…'', and straight "" all appear.     */
/* ------------------------------------------------------------------ */

// GPO plain text quotes with double backticks; “ ” is the USLM/typeset
// form; ‘ ’ is the one-level-nested form (amendments to quoted text).
const QUOTED =
  "(?:“([^”]*)”|``((?:[^']|'(?!'))*)''|‘([^’]*)’|\"([^\"]*)\")";

const PROVISION_REF = grammarSource("provisions", "provision.ref.en.anchored");
const FR_PROVISION_REF = grammarSource("provisions", "provision.ref.fr.anchored");
const FR_UNCLOSED_LABEL = grammarRegExp(
  "provisions", "provision.label.fr-unclosed", "gu",
);

function compactLabel(raw: string): string {
  return raw.replace(/\s+/gu, "");
}

function compactLabelFr(raw: string): string {
  return compactLabel(raw).replace(FR_UNCLOSED_LABEL, "($1)");
}

export function joinLocator(head: string, sub?: string): string {
  const headCompact = compactLabel(head);
  const subCompact = sub ? compactLabel(sub) : "";
  const joined = subCompact.startsWith("(")
    ? `${headCompact}${subCompact}`
    : subCompact || headCompact;
  return joined
    ? normalizeSourceDocLocator("section", joined) || `sec${joined.toLowerCase()}`
    : "";
}

// The static patterns below are compiled once; per-call recompilation of the
// same constant source buys nothing (PROVISION_REF/QUOTED never vary).
const QUOTED_G = new RegExp(QUOTED, "gu");
const QUOTED_U = new RegExp(QUOTED, "u");
const PROVISION_REF_U = new RegExp(PROVISION_REF, "iu");
const LEAD_PROVISION_REF_U = new RegExp(`^(?:the\\s+)?${PROVISION_REF}`, "iu");
const AT_END_OF_PROVISION_REF_U = new RegExp(
  String.raw`^\s*at\s+the\s+end\s+of\s+(?:the\s+)?${PROVISION_REF}`,
  "iu",
);
const AFTER_BEFORE_PROVISION_REF_U = new RegExp(
  String.raw`(after|before)\s+${PROVISION_REF}`,
  "iu",
);
const ADDING_QUOTED_AT_END_U = new RegExp(
  String.raw`adding\s+${QUOTED}\s+at\s+the\s+end\s+of\s+(?:the\s+)?${PROVISION_REF}`,
  "iu",
);
const LEAD_ANCHORED_PROVISION_REF_U = new RegExp(`^${PROVISION_REF}`, "iu");
const REDESIGNATE_REF_U = new RegExp(
  String.raw`redesignat(?:ing|ed)\s+${PROVISION_REF}[\s\S]{0,40}?\bas\s+${PROVISION_REF}`,
  "iu",
);
const AS_PROVISION_REF_U = new RegExp(String.raw`as\s+${PROVISION_REF}`, "iu");
const LEAD_TOKEN_U =
  /^(\s*)(\(([^\s()]{1,12})\)|\d+[A-Za-z]?(?:\.\d+)*\.?)/u;

function quotedValue(...groups: Array<string | undefined>): string | undefined {
  for (const group of groups) if (group !== undefined) return group;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

interface Head {
  label: string;
  verbTail: string;
  raw: string;
  lang?: "fr";
}

const HEAD_RE = new RegExp(
  String.raw`(?:The\s+)?${PROVISION_REF}\s+of\s+(?:the\s+)?.{0,200}?\s+is\s+` +
    String.raw`(amended|repealed|replaced|redesignated|renumbered)` +
    String.raw`|(?:The\s+)?${PROVISION_REF}\s+is\s+(amended|repealed|replaced|redesignated|renumbered)`,
  "giu",
);

// "Le paragraphe 193(2) de la même loi est remplacé par ce qui suit :" /
// "L'article 5 est abrogé." Leading articles include au/aux/du so scoped
// heads ("…, au paragraphe 35(1)…") still MATCH and can then be refused.
const FR_HEAD_RE = new RegExp(
  String.raw`(?:les?\s+|la\s+|l['’]\s?|aux?\s+|du\s+|de\s+la\s+|de\s+l['’]\s?)${FR_PROVISION_REF}` +
    String.raw`(?:\s+(?:de|du|des|de\s+la|de\s+l['’])\s?.{0,200}?)?,?\s+(?:est|sont)\s+` +
    String.raw`(remplacée?s?|abrogée?s?|modifiée?s?)`,
  "giu",
);

const FR_VERB_TAIL: Array<[RegExp, string]> = [
  [/^remplac/iu, "replaced"],
  [/^abrog/iu, "repealed"],
  [/^modifi/iu, "amended"],
];

/**
 * Scoped amendments the applier cannot honour yet ("The portion of
 * subsection 5(1) before paragraph (a)…", "The heading of section 5…",
 * "The definition general holiday in section 166…" — which would
 * otherwise compile as a replace of the WHOLE section). They parse as if
 * they addressed the whole provision, so they must be refused at the
 * head, not guessed at. Verified against S.C. 2021, c. 11 ss. 3-4.
 */
const SCOPED_HEAD_RE =
  /\b(?:portion|heading|marginal\s+note|description|title)\s+of\s*$|\bdefinitions?\s+[\w'’\s-]{0,60}in\s*$/iu;

/**
 * French scoped heads: "Le passage de … précédant l'alinéa a), au
 * paragraphe 35(1) …" and "La définition de X, à l'article 166 …" both
 * parse as if they addressed the whole provision, so — exactly like the
 * English SCOPED_HEAD_RE — they are refused from the prefix, never
 * guessed at. Verified against L.C. 2021, ch. 11, art. 3-4 (fr).
 */
const FR_SCOPED_PREFIX_RE =
  /(?:\bpassage\s+d[eu]\b|\bdéfinitions?\s+d(?:e|u|es)\b)[\s\S]{0,80}$/iu;

/** "in subsection (b)(1)" / "in section 4(a)" clause context. */
const IN_CONTEXT_RE = new RegExp(String.raw`\bin\s+${PROVISION_REF}\s*[,:]?`, "giu");

const EVERY_RE = /each\s+place\s+(?:it|such\s+term)\s+appears|wherever\s+appearing/iu;

interface Clause {
  text: string;
  context?: string;
}

const CLAUSE_VERB_RE =
  /^(?:strik|insert|add|redesignat|renumber|repeal|substitut|replac|delet)/iu;

function lastContext(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  const all = [...segment.matchAll(IN_CONTEXT_RE)];
  return all.length ? all[all.length - 1][0] : undefined;
}

/**
 * Split the body of one instruction sentence into "by …" clauses. In the
 * dominant list style — "(1) in subsection (a), by striking …; (2) in
 * subsection (b), by inserting …" — the scoping "in <provision>" segment
 * precedes each "by", so a trailing context in one part scopes the NEXT
 * clause. Split boundaries and context scanning run on the MASKED body
 * (quoted-run interiors blanked) so a " by " or "in section …" inside a
 * quoted block can neither fragment the block nor leak scope; clause
 * text is always sliced from the original. Parts that do not start with
 * an amendment verb are quoted-block content, not clauses, skipped
 * without noise.
 */
function splitClauses(body: string): Clause[] {
  const masked = maskQuotedRuns(body);
  const boundaries = [...masked.matchAll(/\bby\b\s+/giu)];
  const clauses: Clause[] = [];
  let pending = boundaries.length
    ? lastContext(masked.slice(0, boundaries[0].index ?? 0))
    : undefined;
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = (boundaries[i].index ?? 0) + boundaries[i][0].length;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index ?? masked.length : masked.length;
    const part = body.slice(start, end);
    if (CLAUSE_VERB_RE.test(part.trimStart())) {
      clauses.push({ text: part, context: pending });
    }
    const trailing = lastContext(masked.slice(start, end));
    if (trailing) pending = trailing;
  }
  if (
    !clauses.length &&
    /striking|inserting|adding|repeal|replaced|renumber|redesignat|substitut/iu.test(body)
  ) {
    clauses.push({ text: body });
  }
  return clauses;
}

function opFromClause(
  clause: Clause,
  head: Head,
  raw: string,
): AmendOp | { reason: string } {
  const text = clause.text;
  const contextMatch = clause.context && PROVISION_REF_U.exec(clause.context);
  const target = joinLocator(head.label,
    contextMatch?.[1] ? compactLabel(contextMatch[1]) : undefined);
  const every = EVERY_RE.test(text) || undefined;

  const q = (index: number, source: string): string | undefined => {
    const matches = [...source.matchAll(QUOTED_G)];
    const hit = matches[index];
    return hit ? quotedValue(hit[1], hit[2], hit[3], hit[4]) : undefined;
  };

  // striking out “X” and substituting “Y” (Canadian) / striking “X” and
  // inserting “Y” (US) → substitute_text
  let m =
    /strik(?:ing|e)(?:\s+out)?\s+/iu.exec(text);
  if (m) {
    const afterStrike = text.slice(m.index + m[0].length);
    // A provision ref directly after "striking" wins over any quoted
    // text further along ("striking subsection (u) and inserting the
    // following: “…”" strikes the PROVISION; the quote is the block).
    const provisionFirst = LEAD_PROVISION_REF_U.exec(afterStrike);
    if (provisionFirst?.[1]) {
      const childTarget = joinLocator(head.label, compactLabel(provisionFirst[1]));
      if (/insert(?:ing)?\s+the\s+following/iu.test(afterStrike)) {
        return {
          kind: "replace_provision",
          target: childTarget,
          newText: quotedBlockAt(afterStrike),
          raw,
        };
      }
      return { kind: "strike_provision", target: childTarget, raw };
    }
    const struckQuote = q(0, afterStrike);
    const insertVerb = /\b(?:and\s+)?(?:insert(?:ing)?|substitut(?:ing|e))\b/iu.exec(afterStrike);
    if (struckQuote !== undefined) {
      // striking out “or” at the end of paragraph (d) — bare-token list
      // re-punctuation: scope to the named child, match whole words only,
      // and anchor to the last occurrence ("at the end").
      const quoteHit = [...afterStrike.matchAll(QUOTED_G)][0];
      const afterQuote = quoteHit
        ? afterStrike.slice((quoteHit.index ?? 0) + quoteHit[0].length)
        : "";
      const endOf = AT_END_OF_PROVISION_REF_U.exec(afterQuote);
      const scopedTarget = endOf?.[1]
        ? joinLocator(head.label, compactLabel(endOf[1]))
        : target;
      if (insertVerb) {
        const inserted = q(0, afterStrike.slice(insertVerb.index + insertVerb[0].length));
        if (inserted !== undefined) {
          return {
            kind: "substitute_text",
            target: scopedTarget,
            oldText: struckQuote,
            newText: inserted,
            everyOccurrence: every,
            anchorLast: endOf ? true : undefined,
            wholeWord: endOf ? true : undefined,
            raw,
          };
        }
      }
      return {
        kind: "strike_text",
        target: scopedTarget,
        oldText: struckQuote,
        everyOccurrence: every,
        anchorLast: endOf ? true : undefined,
        wholeWord: endOf ? true : undefined,
        raw,
      };
    }
    // striking the period at the end [and inserting “; and”]
    if (/^the\s+(?:period|comma|semicolon)\b/iu.test(afterStrike)) {
      const punct = /^the\s+(period|comma|semicolon)/iu.exec(afterStrike);
      const mark = punct?.[1].toLowerCase() === "comma" ? "," : punct?.[1].toLowerCase() === "semicolon" ? ";" : ".";
      const insertVerbAfter = /\b(?:and\s+)?insert(?:ing)?\b/iu.exec(afterStrike);
      const inserted = insertVerbAfter
        ? q(0, afterStrike.slice(insertVerbAfter.index + insertVerbAfter[0].length))
        : undefined;
      if (inserted !== undefined) {
        return {
          kind: "substitute_text",
          target,
          oldText: mark,
          newText: inserted,
          anchorLast: true,
          raw,
        };
      }
      return { kind: "strike_text", target, oldText: mark, anchorLast: true, raw };
    }
    // striking subsection (u) [and inserting the following:]
    const provision = LEAD_PROVISION_REF_U.exec(afterStrike);
    if (provision?.[1]) {
      const childTarget = joinLocator(head.label, compactLabel(provision[1]));
      if (/insert(?:ing)?\s+the\s+following/iu.test(afterStrike)) {
        const block = quotedBlockAt(afterStrike);
        return { kind: "replace_provision", target: childTarget, newText: block, raw };
      }
      return { kind: "strike_provision", target: childTarget, raw };
    }
    return { reason: "strike clause without quoted text or provision ref" };
  }

  // inserting “Y” after/before “X”
  m = /insert(?:ing)?\s+/iu.exec(text);
  if (m) {
    const rest = text.slice(m.index + m[0].length);
    const inserted = q(0, rest);
    const placement = /\b(after|before)\b/iu.exec(rest);
    if (inserted !== undefined && placement) {
      const tail = rest.slice((placement.index ?? 0) + placement[0].length);
      const anchor = q(0, tail);
      if (anchor !== undefined) {
        return {
          kind: "insert_text",
          target,
          newText: inserted,
          position: placement[1].toLowerCase() as "after" | "before",
          anchorText: anchor,
          everyOccurrence: every,
          raw,
        };
      }
      // "before the period at the end" — punctuation anchor, last occurrence
      const punct = /^\s*the\s+(period|comma|semicolon)\b/iu.exec(tail);
      if (punct) {
        const mark = punct[1].toLowerCase() === "comma" ? "," : punct[1].toLowerCase() === "semicolon" ? ";" : ".";
        return {
          kind: "insert_text",
          target,
          newText: inserted,
          position: placement[1].toLowerCase() as "after" | "before",
          anchorText: mark,
          anchorLast: true,
          raw,
        };
      }
    }
    // inserting after subsection (2) the following: (block form)
    const provision = AFTER_BEFORE_PROVISION_REF_U.exec(rest);
    if (provision && /the\s+following/iu.test(rest)) {
      return {
        kind: "add_provision",
        target,
        position: provision[1].toLowerCase() as "after" | "before",
        afterChild: joinLocator(head.label, compactLabel(provision[2])),
        newText: q(0, rest),
        raw,
      };
    }
    if (inserted !== undefined) {
      return { reason: "insert clause without placement anchor" };
    }
    return { reason: "insert clause without quoted text" };
  }

  // adding “or” at the end of paragraph (e) — bare-token append; the
  // applier owns the list re-punctuation (a terminal "." becomes ";").
  m = ADDING_QUOTED_AT_END_U.exec(text);
  if (m) {
    const token = quotedValue(m[1], m[2], m[3], m[4]);
    if (token !== undefined && m[5]) {
      return {
        kind: "append_text",
        target: joinLocator(head.label, compactLabel(m[5])),
        newText: token,
        raw,
      };
    }
  }

  // adding the following after subsection (4): (Canadian)
  m = /adding\s+the\s+following\s+(after|before)\s+/iu.exec(text);
  if (m) {
    const provision = LEAD_ANCHORED_PROVISION_REF_U.exec(text.slice(m.index + m[0].length));
    if (provision?.[1]) {
      return {
        kind: "add_provision",
        target,
        position: m[1].toLowerCase() as "after" | "before",
        afterChild: joinLocator(head.label, compactLabel(provision[1])),
        // Unquoted-block fallback works clause-level unless the block
        // itself contains " by " (clause splitting boundary).
        newText: quotedBlockAt(text) ?? unquotedBlock(text),
        raw,
      };
    }
    return { reason: "adding-the-following without provision ref" };
  }

  // adding at the end the following
  if (/adding\s+at\s+the\s+end/iu.test(text)) {
    return {
      kind: "add_at_end",
      target,
      newText: quotedBlockAt(text) ?? unquotedBlock(text),
      raw,
    };
  }

  // redesignating subsection (u) as subsection (v)
  m = REDESIGNATE_REF_U.exec(text);
  if (m) {
    return {
      kind: "redesignate",
      target: joinLocator(head.label, compactLabel(m[1])),
      newLabel: compactLabel(m[2]),
      raw,
    };
  }

  return { reason: "unrecognized amendment clause" };
}

/**
 * Parse amendment prose into typed ops. Deterministic; anything the
 * grammar cannot compile is reported, never guessed.
 */
export function parseAmendmentInstructions(text: string): AmendParseResult {
  const ops: AmendOp[] = [];
  const unparsed: AmendParseResult["unparsed"] = [];
  HEAD_RE.lastIndex = 0;
  const heads: Array<{ head: Head; start: number; end: number }> = [];
  for (const match of text.matchAll(HEAD_RE)) {
    const label = match[1] ?? match[3];
    const verb = (match[2] ?? match[4] ?? "").toLowerCase();
    if (!label?.trim()) continue;
    heads.push({
      head: { label: compactLabel(label), verbTail: verb, raw: match[0] },
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  for (const match of text.matchAll(FR_HEAD_RE)) {
    const label = match[1];
    if (!label?.trim()) continue;
    const verbTail =
      FR_VERB_TAIL.find(([re]) => re.test(match[2] ?? ""))?.[1] ?? "amended";
    heads.push({
      head: { label: compactLabelFr(label), verbTail, raw: match[0], lang: "fr" },
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  heads.sort((a, b) => a.start - b.start);
  for (let i = 0; i < heads.length; i += 1) {
    const { head, start, end } = heads[i];
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].start : text.length;
    // Body runs to the next instruction head; quoted blocks may span lines.
    const body = text.slice(end, bodyEnd);
    const raw = text.slice(start, Math.min(bodyEnd, end + 240)).trim();
    const scopedPrefix =
      head.lang === "fr"
        ? FR_SCOPED_PREFIX_RE.test(text.slice(Math.max(0, start - 90), start))
        : SCOPED_HEAD_RE.test(text.slice(Math.max(0, start - 30), start));
    if (scopedPrefix) {
      unparsed.push({
        excerpt: raw,
        reason: "scoped amendment (portion/heading) — not applied",
      });
      continue;
    }
    const target = joinLocator(head.label);

    if (head.verbTail === "repealed") {
      ops.push({ kind: "repeal_provision", target, raw });
      continue;
    }
    if (head.verbTail === "replaced") {
      // "is replaced by the following:" — quoted block (US-style) or the
      // unquoted indented block Canadian drafting uses.
      const block = quotedBlockAt(body) ?? unquotedBlock(body);
      if (block !== undefined) {
        ops.push({ kind: "replace_provision", target, newText: block, raw });
      } else {
        unparsed.push({ excerpt: raw, reason: "replaced-by without following block" });
      }
      continue;
    }
    if (head.verbTail === "redesignated" || head.verbTail === "renumbered") {
      const asRef = AS_PROVISION_REF_U.exec(body);
      if (asRef?.[1]) {
        ops.push({ kind: "redesignate", target, newLabel: compactLabel(asRef[1]), raw });
      } else {
        unparsed.push({ excerpt: raw, reason: "redesignation without new label" });
      }
      continue;
    }
    // "is amended …": read-as-follows, or clause list.
    if (/to\s+read\s+as\s+follows/iu.test(body.slice(0, 80))) {
      const block = quotedBlockAt(body) ?? unquotedBlock(body);
      if (block !== undefined) {
        ops.push({ kind: "replace_provision", target, newText: block, raw });
        continue;
      }
    }
    const clauses = splitClauses(body);
    if (!clauses.length) {
      unparsed.push({ excerpt: raw, reason: "amended-by without clauses" });
      continue;
    }
    for (const clause of clauses) {
      const op = opFromClause(clause, head, raw);
      if ("reason" in op) {
        unparsed.push({
          excerpt: clause.text.slice(0, 160).trim(),
          reason: op.reason,
        });
      } else {
        ops.push(op);
      }
    }
  }
  return { ops, unparsed };
}

/**
 * GPO/USLM quoted blocks span paragraphs: every quoted paragraph
 * re-opens with “ and only the block's final one closes with ”. A
 * single-pair capture truncates at the first interior ”, so extend
 * across ”…“ paragraph seams (optionally separated by punctuation and
 * whitespace). Interior nested quotes are retained verbatim.
 */
function endOfTypographicRun(body: string, open: number): number {
  const limit = Math.min(body.length, open + 60_000);
  let cursor = open;
  let close = -1;
  while (cursor < limit) {
    const next = body.indexOf("”", cursor + 1);
    if (next === -1 || next > limit) break;
    close = next;
    if (!/^[\s.;,]{0,6}“/u.test(body.slice(next + 1, next + 9))) break;
    cursor = next + 1;
  }
  return close;
}

function typographicBlock(body: string): string | undefined {
  const open = body.indexOf("“");
  if (open === -1) return undefined;
  const close = endOfTypographicRun(body, open);
  if (close === -1) return undefined;
  return body.slice(open + 1, close);
}

/**
 * Mask quoted-run interiors (length-preserving) so clause splitting and
 * context scanning cannot fire on words like " by " INSIDE a quoted
 * block — the mechanism that silently fragmented USLM blocks.
 */
function maskQuotedRuns(body: string): string {
  const chars = body.split("");
  let i = 0;
  while (i < body.length) {
    if (body[i] === "“") {
      const close = endOfTypographicRun(body, i);
      if (close !== -1) {
        for (let j = i + 1; j < close; j += 1) {
          if (chars[j] !== "\n") chars[j] = "x";
        }
        i = close + 1;
        continue;
      }
    }
    i += 1;
  }
  return chars.join("");
}

/** Block after "the following:" — GPO multi-paragraph form first. */
function quotedBlockAt(body: string): string | undefined {
  const typographic = typographicBlock(body);
  if (typographic) return typographic;
  const match = QUOTED_U.exec(body);
  return match ? quotedValue(match[1], match[2], match[3], match[4]) : undefined;
}

/**
 * Canadian acts do NOT quote replacement text — the block after "is
 * replaced by the following:" is plain indented text (quoting is a
 * US/GPO convention). Capture from the colon to the next instruction
 * line or chapter note, dropping marginal-note furniture. Verified
 * against S.C. 2021, c. 11 as printed on laws-lois.justice.gc.ca.
 */
function unquotedBlock(body: string): string | undefined {
  const colon = body.indexOf(":");
  // The colon must belong to the instruction ("…the following:"), not to
  // prose further along.
  if (colon === -1 || colon > 160) return undefined;
  const kept: string[] = [];
  let sawText = false;
  for (const line of body.slice(colon + 1).split("\n")) {
    const t = line.trim();
    if (!t) {
      kept.push("");
      continue;
    }
    if (/^(?:Marginal note:|Note marginale\s*:)/iu.test(t)) continue;
    // Next instruction ("3 The portion of…") or chapter note ("R.S., c. I-21"
    // / "L.R., ch. B-4"). L.R.C. must stay ahead of the bare L.R. alternative.
    if (sawText && /^\d{1,4}\s+\S/u.test(t)) break;
    if (/^(?:R\.S\.|S\.C\.|L\.R\.C\.|L\.C\.|L\.R\.)[,.\s]/u.test(t)) break;
    // Part/heading furniture ("Coming into Force", "Entrée en vigueur"): a
    // short unpunctuated Title-Case line. Statute block lines end in
    // punctuation or start with an enum token, so this cannot eat real
    // provision text.
    if (
      sawText &&
      /^(?:[A-ZÀ-Þ][\wà-ÿ’'-]*)(?:\s+(?:[a-zà-ÿ]{2,12}|[A-ZÀ-Þ][\wà-ÿ’'-]*)){1,5}$/u.test(t) &&
      !/[.;:,)]$/u.test(t)
    ) {
      break;
    }
    kept.push(line);
    sawText = true;
  }
  const block = kept.join("\n").trim();
  return block.length >= 3 ? block : undefined;
}

/* ------------------------------------------------------------------ */
/* Applier — the verifier                                              */
/* ------------------------------------------------------------------ */

export interface AmendReceipt {
  op: AmendOp;
  start: number;
  end: number;
  removed: string;
  inserted: string;
  occurrences?: number;
}

export interface AmendFailure {
  op: AmendOp;
  code:
    | "target_not_found"
    | "old_text_not_found"
    | "old_text_ambiguous"
    | "anchor_not_found"
    | "anchor_ambiguous"
    | "missing_new_text"
    | "overlapping_ops"
    | "unsupported_apply";
  detail: string;
}

export interface ApplyAmendmentsResult {
  text: string;
  applied: AmendReceipt[];
  failures: AmendFailure[];
  verification: {
    newTextPresent: number;
    newTextMissing: number;
    oldTextGone: number;
    oldTextLingers: number;
    ladderViolationsBefore: number;
    ladderViolationsAfter: number;
  };
}

/** Whitespace-tolerant literal matcher (quotes wrap across lines). */
function literalPattern(literal: string): RegExp {
  const escaped = literal
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\s+/gu, "\\s+");
  return new RegExp(escaped, "gu");
}

function findInSpan(
  text: string,
  span: [number, number],
  literal: string,
): Array<[number, number]> {
  const slice = text.slice(span[0], span[1]);
  const out: Array<[number, number]> = [];
  for (const match of slice.matchAll(literalPattern(literal))) {
    const at = match.index ?? 0;
    out.push([span[0] + at, span[0] + at + match[0].length]);
  }
  return out;
}

function resolveTarget(
  doc: SourceDoc,
  target: string,
  textLength: number,
): { span: [number, number]; node?: SourceDocBlock } | undefined {
  if (!target) return { span: [0, textLength] };
  const keys = [
    target.toLowerCase(),
    normalizeSourceDocLocator("section", target),
  ].filter(Boolean);
  for (const key of keys) {
    const position = Object.hasOwn(doc.index, key) ? doc.index[key] : undefined;
    if (position !== undefined) {
      const node = doc.blocks[position];
      return { span: [node.start, node.end], node };
    }
  }
  return undefined;
}

interface Splice {
  start: number;
  end: number;
  replacement: string;
  receipt: AmendReceipt;
}

export interface ApplyAmendOptions {
  /** Default true for extracted PDF/DOCX; authoritative feeds pass false. */
  reconstructLineation?: boolean;
}

/**
 * Apply parsed ops to source text. Every op either produces a receipt with
 * the exact spliced span or a typed failure; splices never overlap.
 */
export async function applyAmendOps(
  sourceText: string,
  ops: AmendOp[],
  options: ApplyAmendOptions = {},
): Promise<ApplyAmendmentsResult> {
  const before = await analyzeInstrument(sourceText, options.reconstructLineation);
  const labels = before.source_doc;
  const splices: Splice[] = [];
  const failures: AmendFailure[] = [];

  const pushSplice = (op: AmendOp, start: number, end: number, replacement: string) => {
    splices.push({
      start,
      end,
      replacement,
      receipt: {
        op,
        start,
        end,
        removed: sourceText.slice(start, end),
        inserted: replacement,
      },
    });
  };

  for (const op of ops) {
    const resolved = resolveTarget(labels, op.target, sourceText.length);
    if (!resolved) {
      failures.push({ op, code: "target_not_found", detail: op.target });
      continue;
    }
    const span = resolved.span;
    switch (op.kind) {
      case "strike_text":
      case "substitute_text": {
        if (!op.oldText?.trim()) {
          failures.push({ op, code: "old_text_not_found", detail: "empty quoted text" });
          break;
        }
        let hits = findInSpan(sourceText, span, op.oldText);
        if (op.wholeWord) {
          const wordChar = /[\p{L}\p{N}]/u;
          hits = hits.filter(
            ([start, end]) =>
              (start === 0 || !wordChar.test(sourceText[start - 1])) &&
              (end >= sourceText.length || !wordChar.test(sourceText[end])),
          );
        }
        if (!hits.length) {
          failures.push({ op, code: "old_text_not_found", detail: op.oldText.slice(0, 80) });
          break;
        }
        if (hits.length > 1 && !op.everyOccurrence && !op.anchorLast) {
          failures.push({
            op,
            code: "old_text_ambiguous",
            detail: `${hits.length} occurrences of "${op.oldText.slice(0, 60)}" in ${op.target || "document"}`,
          });
          break;
        }
        const replacement = op.kind === "substitute_text" ? op.newText ?? "" : "";
        const chosen = op.everyOccurrence
          ? hits
          : op.anchorLast
            ? hits.slice(-1)
            : hits.slice(0, 1);
        for (const [start, end] of chosen) {
          pushSplice(op, start, end, replacement);
        }
        break;
      }
      case "insert_text": {
        if (!op.anchorText?.trim() || op.newText === undefined) {
          failures.push({ op, code: "anchor_not_found", detail: "missing anchor or text" });
          break;
        }
        const hits = findInSpan(sourceText, span, op.anchorText);
        if (!hits.length) {
          failures.push({ op, code: "anchor_not_found", detail: op.anchorText.slice(0, 80) });
          break;
        }
        if (hits.length > 1 && !op.everyOccurrence && !op.anchorLast) {
          failures.push({
            op,
            code: "anchor_ambiguous",
            detail: `${hits.length} occurrences of "${op.anchorText.slice(0, 60)}"`,
          });
          break;
        }
        const spots = op.everyOccurrence
          ? hits
          : op.anchorLast
            ? hits.slice(-1)
            : hits.slice(0, 1);
        // No glue around punctuation anchors ("…, and” before the period").
        const punctuation = /^[.,;]$/u.test(op.anchorText);
        for (const [start, end] of spots) {
          const at = op.position === "before" ? start : end;
          const glue =
            punctuation || op.newText.startsWith(" ") || op.newText.startsWith("\n")
              ? ""
              : " ";
          pushSplice(
            op,
            at,
            at,
            op.position === "before" ? `${op.newText}${glue}` : `${glue}${op.newText}`,
          );
        }
        break;
      }
      case "replace_provision": {
        if (op.newText === undefined) {
          failures.push({ op, code: "missing_new_text", detail: op.target });
          break;
        }
        pushSplice(op, span[0], span[1], ensureBlock(op.newText));
        break;
      }
      case "strike_provision":
      case "repeal_provision": {
        if (!resolved.node) {
          failures.push({ op, code: "target_not_found", detail: "cannot repeal whole document" });
          break;
        }
        pushSplice(op, span[0], span[1], "");
        break;
      }
      case "add_at_end": {
        if (op.newText === undefined) {
          failures.push({ op, code: "missing_new_text", detail: op.target });
          break;
        }
        pushSplice(op, span[1], span[1], `\n${ensureBlock(op.newText)}`);
        break;
      }
      case "append_text": {
        if (!op.newText?.trim()) {
          failures.push({ op, code: "missing_new_text", detail: op.target });
          break;
        }
        // Bare-token append: the provision stops being list-final, so a
        // terminal "." becomes ";" before the token (gold: SC 2021 c. 24
        // s. 1(1) vs today's CLC s. 164(1)(e)); a terminal ";" just gains
        // the token. Any other terminal is a typed refusal, not a guess.
        let last = span[1] - 1;
        while (last >= span[0] && /\s/u.test(sourceText[last])) last -= 1;
        const terminal = last >= span[0] ? sourceText[last] : "";
        if (terminal === ".") {
          pushSplice(op, last, last + 1, `; ${op.newText}`);
        } else if (terminal === ";") {
          pushSplice(op, last + 1, last + 1, ` ${op.newText}`);
        } else {
          failures.push({
            op,
            code: "unsupported_apply",
            detail: `append_text needs a "." or ";" terminal, saw ${JSON.stringify(terminal)}`,
          });
        }
        break;
      }
      case "add_provision": {
        if (op.newText === undefined) {
          failures.push({ op, code: "missing_new_text", detail: op.target });
          break;
        }
        const child = op.afterChild
          ? resolveTarget(labels, op.afterChild, sourceText.length)
          : undefined;
        if (op.afterChild && !child?.node) {
          failures.push({ op, code: "target_not_found", detail: op.afterChild });
          break;
        }
        const at = child?.node
          ? op.position === "before"
            ? child.span[0]
            : child.span[1]
          : span[1];
        pushSplice(op, at, at, `\n${ensureBlock(op.newText)}`);
        break;
      }
      case "redesignate": {
        if (!resolved.node || !op.newLabel) {
          failures.push({ op, code: "unsupported_apply", detail: "redesignation needs a labelled node" });
          break;
        }
        const lead = sourceText.slice(span[0], Math.min(span[1], span[0] + 40));
        const oldToken = LEAD_TOKEN_U.exec(lead);
        if (!oldToken) {
          failures.push({ op, code: "unsupported_apply", detail: "no leading label token found" });
          break;
        }
        const start = span[0] + oldToken[1].length;
        pushSplice(op, start, start + oldToken[2].length, op.newLabel);
        break;
      }
      default:
        failures.push({ op, code: "unsupported_apply", detail: op.kind });
    }
  }

  // Reject overlaps deterministically: keep the earlier-starting op.
  splices.sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted: Splice[] = [];
  for (const splice of splices) {
    const prev = accepted[accepted.length - 1];
    if (prev && splice.start < prev.end) {
      failures.push({
        op: splice.receipt.op,
        code: "overlapping_ops",
        detail: `overlaps op at ${prev.start}-${prev.end}`,
      });
      continue;
    }
    accepted.push(splice);
  }

  let text = sourceText;
  for (const splice of [...accepted].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, splice.start) + splice.replacement + text.slice(splice.end);
  }

  const after = text === sourceText ? before : await analyzeInstrument(text, options.reconstructLineation);
  let newTextPresent = 0;
  let newTextMissing = 0;
  let oldTextGone = 0;
  let oldTextLingers = 0;
  const afterLabels = after.source_doc;
  for (const splice of accepted) {
    const op = splice.receipt.op;
    if (op.newText?.trim()) {
      if (findInSpan(text, [0, text.length], op.newText).length) newTextPresent += 1;
      else newTextMissing += 1;
    }
    if ((op.kind === "strike_text" || op.kind === "substitute_text") && op.oldText?.trim()) {
      const scope = resolveTarget(afterLabels, op.target, text.length);
      const lingering = scope ? findInSpan(text, scope.span, op.oldText).length : 0;
      if (lingering) oldTextLingers += 1;
      else oldTextGone += 1;
    }
  }

  return {
    text,
    applied: accepted.map((splice) => splice.receipt),
    failures,
    verification: {
      newTextPresent,
      newTextMissing,
      oldTextGone,
      oldTextLingers,
      ladderViolationsBefore: before.structure.diagnostics.filter(
        ({ code }: { code: string }) => code === "instrument_ladder_violation",
      ).length,
      ladderViolationsAfter: after.structure.diagnostics.filter(
        ({ code }: { code: string }) => code === "instrument_ladder_violation",
      ).length,
    },
  };
}

export type DeleteAndRenumberFailureCode =
  | "target_not_found"
  | "target_ambiguous"
  | "unsupported_target"
  | "sibling_ambiguous"
  | "sibling_sequence_unsupported"
  | "heading_not_found"
  | "reference_to_deleted_target"
  | "unresolved_reference"
  | "ambiguous_reference"
  | "external_reference"
  | "overlapping_ops"
  | "verification_failed";

export interface DeleteAndRenumberFailure {
  code: DeleteAndRenumberFailureCode;
  detail: string;
  start?: number;
  end?: number;
}

export interface DeleteAndRenumberReceipt {
  kind: "delete_provision" | "renumber_heading" | "update_cross_reference";
  start: number;
  end: number;
  removed: string;
  inserted: string;
  from: string;
  to: string | null;
}

export interface DeleteAndRenumberResult {
  text: string;
  mapping: Array<{ from: string; to: string }>;
  applied: DeleteAndRenumberReceipt[];
  failures: DeleteAndRenumberFailure[];
  verification: {
    headingsRenumbered: number;
    referencesUpdated: number;
  };
}

interface RenumberSplice {
  start: number;
  end: number;
  replacement: string;
  receipt: DeleteAndRenumberReceipt;
}

function occurrenceBase(label: string): string {
  return label.replace(/@\d+$/u, "");
}

/** The numbering parent, independent of the skeleton's ARTICLE/PART parent. */
function numberingParent(label: string): string {
  const clean = occurrenceBase(label);
  if (!clean.startsWith("sec")) return "";
  const body = clean.slice(3);
  if (body.endsWith(")")) {
    return `sec${body.replace(/\([^()]*\)$/u, "")}`;
  }
  const dot = body.lastIndexOf(".");
  return dot < 0 ? "" : `sec${body.slice(0, dot)}`;
}

function isAtOrBelow(label: string, root: string): boolean {
  const clean = occurrenceBase(label);
  return (
    clean === root ||
    clean.startsWith(`${root}(`) ||
    clean.startsWith(`${root}.`)
  );
}

function isInNumberingFamily(label: string, family: string): boolean {
  const clean = occurrenceBase(label);
  if (!clean.startsWith("sec")) return false;
  return family ? clean !== family && isAtOrBelow(clean, family) : true;
}

/** Prove that `from` is the immediate numeric/alphabetic successor of `to`. */
function closesOneSiblingStep(from: string, to: string): boolean {
  const pair = [occurrenceBase(from), occurrenceBase(to)];
  for (const pattern of [
    /^(.*?)(\d+)$/u,
    /^(.*)\((\d+)\)$/u,
    /^(.*)\(([a-z])\)$/u,
  ]) {
    const [next, previous] = pair.map((label) => pattern.exec(label));
    if (!next || !previous || next[1] !== previous[1]) continue;
    const ordinal = (value: string) =>
      /^\d+$/u.test(value) ? Number(value) : value.charCodeAt(0);
    return ordinal(next[2]) === ordinal(previous[2]) + 1;
  }
  return false;
}

function mappedLocator(
  locator: string,
  mapping: Array<{ from: string; to: string }>,
): string | null {
  const move = [...mapping]
    .sort((left, right) => right.from.length - left.from.length)
    .find(({ from }) => isAtOrBelow(locator, from));
  return move ? `${move.to}${locator.slice(move.from.length)}` : null;
}

function leadingLabelSpan(
  sourceText: string,
  node: { marker_range?: { start: number; end: number } },
): { start: number; end: number; token: string } | null {
  const range = node.marker_range;
  if (!range) return null;
  const marker = sourceText.slice(range.start, range.end);
  const match = /(\([^\s()]{1,12}\)|\d+[A-Za-z]?(?:[.-]\d+[A-Za-z]?)*\.?)(?=\s*$)/u.exec(marker);
  if (!match) return null;
  const start = range.start + match.index;
  return { start, end: start + match[1].length, token: match[1] };
}

function headingToken(label: string, oldToken: string): string {
  const body = label.replace(/^sec/u, "");
  const token = oldToken.startsWith("(")
    ? body.match(/\([^()]+\)$/u)?.[0] ?? body
    : body.replace(/\([^()]+\).*$/u, "");
  return oldToken.endsWith(".") && !token.endsWith(".") ? `${token}.` : token;
}

function referenceText(raw: string, rawLabel: string, locator: string): string {
  const full = locator.replace(/^sec/u, "");
  let label = full;
  if (rawLabel.startsWith("(")) {
    const depth = [...rawLabel.matchAll(/\([^()]+\)/gu)].length;
    const subs = [...full.matchAll(/\([^()]+\)/gu)].map((match) => match[0]);
    label = subs.slice(-depth).join("");
  }
  if (label === rawLabel) return raw;
  const at = raw.search(/[\d(]/u);
  return at < 0 ? raw : `${raw.slice(0, at)}${label}`;
}

/**
 * Delete one addressed provision, close the resulting gap using the actual
 * following siblings, and rewrite pointers to those moved provisions in one
 * atomic text plan. This deliberately does not imply insertion/open-gap
 * semantics: a caller needing those must use a separately specified op.
 */
export async function deleteProvisionAndRenumberSiblings(
  sourceText: string,
  target: string,
  options: ApplyAmendOptions = {},
): Promise<DeleteAndRenumberResult> {
  const failed = (
    failures: DeleteAndRenumberFailure[],
    mapping: Array<{ from: string; to: string }> = [],
  ): DeleteAndRenumberResult => ({
    text: sourceText,
    mapping,
    applied: [],
    failures,
    verification: { headingsRenumbered: 0, referencesUpdated: 0 },
  });
  const before = await analyzeInstrument(sourceText, options.reconstructLineation);
  const nodes = before.structure.nodes;
  const requested = target.toLowerCase().startsWith("sec")
    ? target.toLowerCase()
    : normalizeSourceDocLocator("section", target).toLowerCase();
  const matches = nodes.filter(
    (node) =>
      typeof node.label === "string" &&
      occurrenceBase(node.label).toLowerCase() === requested,
  );
  if (!requested || !matches.length) {
    return failed([{ code: "target_not_found", detail: target }]);
  }
  if (matches.length > 1) {
    return failed([{
      code: "target_ambiguous",
      detail: `${target} resolves to ${matches.length} provisions`,
    }]);
  }
  const selected = matches[0];
  const selectedLabel = selected.label!;
  if (
    selected.locator_kind !== "section" &&
    selected.locator_kind !== "subsection"
  ) {
    return failed([{
      code: "unsupported_target",
      detail: `${selectedLabel} is a ${selected.locator_kind ?? "non-provision"} locator`,
    }]);
  }

  const family = numberingParent(selectedLabel);
  const siblings = nodes
    .filter(
      (node) =>
        node.locator_kind === selected.locator_kind &&
        node.parent_id === selected.parent_id &&
        typeof node.label === "string" &&
        numberingParent(node.label) === family,
    )
    .sort((left, right) => left.range.start - right.range.start);
  const bases = siblings.map((node) => occurrenceBase(node.label!));
  if (new Set(bases).size !== bases.length) {
    return failed([{
      code: "sibling_ambiguous",
      detail: `The sibling sequence containing ${selectedLabel} repeats a label`,
    }]);
  }
  const selectedAt = siblings.indexOf(selected);
  const following = siblings.slice(selectedAt + 1);
  const mapping: Array<{ from: string; to: string }> = following.map(
    (node, index) => ({
      from: node.label!,
      to: index === 0 ? selectedLabel : following[index - 1].label!,
    }),
  );
  const unsafeStep = mapping.find(
    ({ from, to }) => !closesOneSiblingStep(from, to),
  );
  if (unsafeStep) {
    return failed([{
      code: "sibling_sequence_unsupported",
      detail:
        `Cannot prove that ${unsafeStep.from} immediately follows ` +
        `${unsafeStep.to}; existing gaps or unsupported numbering must not be compressed`,
    }], mapping);
  }

  const failures: DeleteAndRenumberFailure[] = [];
  const splices: RenumberSplice[] = [{
    start: selected.range.start,
    end: selected.range.end,
    replacement: "",
    receipt: {
      kind: "delete_provision",
      start: selected.range.start,
      end: selected.range.end,
      removed: sourceText.slice(selected.range.start, selected.range.end),
      inserted: "",
      from: selectedLabel,
      to: null,
    },
  }];

  const headingSpans: Array<{ start: number; end: number }> = [];
  for (const move of mapping) {
    const node = siblings.find((candidate) => candidate.label === move.from)!;
    const label = leadingLabelSpan(sourceText, node);
    if (!label) {
      failures.push({
        code: "heading_not_found",
        detail: `No leading label token at ${move.from}`,
        start: node.range.start,
        end: Math.min(node.range.end, node.range.start + 100),
      });
      continue;
    }
    const inserted = headingToken(move.to, label.token);
    headingSpans.push({ start: label.start, end: label.end });
    splices.push({
      start: label.start,
      end: label.end,
      replacement: inserted,
      receipt: {
        kind: "renumber_heading",
        start: label.start,
        end: label.end,
        removed: sourceText.slice(label.start, label.end),
        inserted,
        from: move.from,
        to: move.to,
      },
    });
  }

  const references = before.structure.cross_references.edges;
  for (const edge of references) {
    if (
      edge.sourceStart >= selected.range.start &&
      edge.sourceEnd <= selected.range.end
    ) {
      continue;
    }
    const locator = occurrenceBase(edge.normalizedLocator);
    if (!locator || !isInNumberingFamily(locator, family)) continue;
    if (edge.status !== "resolved") {
      const code: DeleteAndRenumberFailureCode =
        edge.status === "external"
          ? "external_reference"
          : edge.reason === "ambiguous_label"
            ? "ambiguous_reference"
            : "unresolved_reference";
      failures.push({
        code,
        detail: `${edge.raw}: ${edge.reason ?? edge.status}`,
        start: edge.sourceStart,
        end: edge.sourceEnd,
      });
      continue;
    }
    if (edge.targetLabel && isAtOrBelow(edge.targetLabel, selectedLabel)) {
      failures.push({
        code: "reference_to_deleted_target",
        detail: `${edge.raw} points to ${selectedLabel}`,
        start: edge.sourceStart,
        end: edge.sourceEnd,
      });
      continue;
    }
    const moved = mappedLocator(locator, mapping);
    if (!moved) continue;
    if (
      headingSpans.some(
        (span) => edge.sourceStart < span.end && edge.sourceEnd > span.start,
      )
    ) {
      continue;
    }
    const inserted = referenceText(edge.raw, edge.rawLabel, moved);
    if (inserted === edge.raw) continue;
    splices.push({
      start: edge.sourceStart,
      end: edge.sourceEnd,
      replacement: inserted,
      receipt: {
        kind: "update_cross_reference",
        start: edge.sourceStart,
        end: edge.sourceEnd,
        removed: sourceText.slice(edge.sourceStart, edge.sourceEnd),
        inserted,
        from: locator,
        to: moved,
      },
    });
  }
  if (failures.length) return failed(failures, mapping);

  splices.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < splices.length; index += 1) {
    if (splices[index].start < splices[index - 1].end) {
      return failed([{
        code: "overlapping_ops",
        detail: `${splices[index].start}-${splices[index].end} overlaps ` +
          `${splices[index - 1].start}-${splices[index - 1].end}`,
      }], mapping);
    }
  }

  let text = sourceText;
  for (const splice of [...splices].sort((left, right) => right.start - left.start)) {
    text = text.slice(0, splice.start) + splice.replacement + text.slice(splice.end);
  }
  const after = await analyzeInstrument(text, options.reconstructLineation);
  const counts = new Map<string, number>();
  for (const node of after.structure.nodes) {
    if (typeof node.label !== "string") continue;
    const key = occurrenceBase(node.label);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const expected = mapping.map(({ to }) => to);
  const vacated = mapping.at(-1)?.from ?? selectedLabel;
  if (
    expected.some((label) => counts.get(label) !== 1) ||
    (counts.get(vacated) ?? 0) !== 0
  ) {
    return failed([{
      code: "verification_failed",
      detail: `Renumbered structure did not compile uniquely; vacated ${vacated}`,
    }], mapping);
  }

  const applied = splices.map((splice) => splice.receipt);
  return {
    text,
    mapping,
    applied,
    failures: [],
    verification: {
      headingsRenumbered: applied.filter((receipt) => receipt.kind === "renumber_heading").length,
      referencesUpdated: applied.filter((receipt) => receipt.kind === "update_cross_reference").length,
    },
  };
}

function ensureBlock(text: string): string {
  const trimmed = text.replace(/\s+$/u, "");
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

/**
 * Parse + apply in one call — the rejection-sampling loop for a model
 * translating gnarly prose into ops: reject unless everything applies.
 */
export async function consolidateAmendment(
  sourceText: string,
  amendmentText: string,
  options: ApplyAmendOptions = {},
): Promise<ApplyAmendmentsResult & { parse: AmendParseResult }> {
  const parse = parseAmendmentInstructions(amendmentText);
  const result = await applyAmendOps(sourceText, parse.ops, options);
  return { ...result, parse };
}
