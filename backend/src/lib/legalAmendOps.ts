/**
 * Amendment calculus: legal text's native diff language, compiled.
 *
 * Amendment prose ("Section 5(1) is amended by striking out “X” and
 * substituting “Y”") is parsed into typed edit ops addressed by skeleton
 * labels, and a deterministic applier consolidates them into as-amended
 * text. The applier doubles as a verifier: an op either lands cleanly at
 * its address or fails loudly with a typed reason, so nothing silently
 * "mostly applies". Covers both drafting grammars:
 *   - US federal cut-and-bite (strike/insert quoted strings, add at end)
 *   - Canadian federal replace-style ("is replaced by the following",
 *     "is amended by adding the following after subsection (2)")
 * plus the contract dialect ("Section 2.05 of the Credit Agreement").
 */
import { normalizeSourceDocLocator } from "./sourceDoc";
import type { SourceDoc, SourceDocBlock } from "./sourceDoc";

import { compileAgreementSkeleton } from "./legalTextSkeleton";

export type AmendOpKind =
  | "strike_text"
  | "insert_text"
  | "substitute_text"
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

function quotedValue(...groups: Array<string | undefined>): string | undefined {
  for (const group of groups) if (group !== undefined) return group;
  return undefined;
}

const PROVISION_WORD =
  "(?:sub-?section|section|paragraph|subparagraph|clause|subclause|item|article|part|division|schedule|definition)";

/** "Section 3", "Subsection 5(1)", "paragraph (b)", "clause 5(1)(b)(ii)". */
const PROVISION_REF = String.raw`${PROVISION_WORD}s?\s+((?:\d+[A-Za-z]?(?:\.\d+)*)?(?:\s?\([^\s()]{1,12}\))*)`;

function compactLabel(raw: string): string {
  return raw.replace(/\s+/gu, "");
}

/* French federal drafting ("est remplacé par ce qui suit :") — the same
 * op algebra; both language versions are equally authoritative. */
const FR_PROVISION_WORD =
  "(?:sous-alinéas?|alinéas?|paragraphes?|articles?|sous-divisions?|divisions?|parties?|annexes?)";

// French writes paragraph letters without the opening paren — "42a)(i)",
// "alinéa b)" — while subclauses keep both parens.
const FR_PROVISION_REF = String.raw`${FR_PROVISION_WORD}\s+((?:\d+(?:\.\d+)*[A-Za-z]?)?(?:\s?(?:\([^\s()]{1,12}\)|[a-zà-ÿ]{1,4}\)))*)`;

/** "42a)(i)" → "42(a)(i)": restore the shared locator dialect. */
function compactLabelFr(raw: string): string {
  return compactLabel(raw).replace(/(?<!\()([a-zà-ÿ]{1,4})\)/gu, "($1)");
}

/** Join a head label with a nested sub-label: "3" + "(u)" → "sec3(u)". */
export function joinLocator(head: string, sub?: string): string {
  const headCompact = compactLabel(head);
  const subCompact = sub ? compactLabel(sub) : "";
  const joined = subCompact.startsWith("(")
    ? `${headCompact}${subCompact}`
    : subCompact || headCompact;
  if (!joined) return "";
  return (
    normalizeSourceDocLocator("section", joined) || `sec${joined.toLowerCase()}`
  );
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

function contextLabel(context: string | undefined): string | undefined {
  if (!context) return undefined;
  const match = new RegExp(PROVISION_REF, "iu").exec(context);
  return match?.[1] ? compactLabel(match[1]) : undefined;
}

function opFromClause(
  clause: Clause,
  head: Head,
  raw: string,
): AmendOp | { reason: string } {
  const text = clause.text;
  const target = joinLocator(head.label, contextLabel(clause.context));
  const every = EVERY_RE.test(text) || undefined;

  const q = (index: number, source: string): string | undefined => {
    const matches = [...source.matchAll(new RegExp(QUOTED, "gu"))];
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
    const provisionFirst = new RegExp(`^(?:the\\s+)?${PROVISION_REF}`, "iu").exec(afterStrike);
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
      if (insertVerb) {
        const inserted = q(0, afterStrike.slice(insertVerb.index + insertVerb[0].length));
        if (inserted !== undefined) {
          return {
            kind: "substitute_text",
            target,
            oldText: struckQuote,
            newText: inserted,
            everyOccurrence: every,
            raw,
          };
        }
      }
      return { kind: "strike_text", target, oldText: struckQuote, everyOccurrence: every, raw };
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
    const provision = new RegExp(`^(?:the\\s+)?${PROVISION_REF}`, "iu").exec(afterStrike);
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
    const provision = new RegExp(String.raw`(after|before)\s+${PROVISION_REF}`, "iu").exec(rest);
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

  // adding the following after subsection (4): (Canadian)
  m = /adding\s+the\s+following\s+(after|before)\s+/iu.exec(text);
  if (m) {
    const provision = new RegExp(`^${PROVISION_REF}`, "iu").exec(text.slice(m.index + m[0].length));
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
  m = new RegExp(String.raw`redesignat(?:ing|ed)\s+${PROVISION_REF}[\s\S]{0,40}?\bas\s+${PROVISION_REF}`, "iu").exec(text);
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
      const asRef = new RegExp(String.raw`as\s+${PROVISION_REF}`, "iu").exec(body);
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

/** First quoted block: typographic-quoted multiline run, or “…” string. */
function firstQuotedBlock(body: string): string | undefined {
  const match = new RegExp(QUOTED, "u").exec(body);
  if (!match) return undefined;
  return quotedValue(match[1], match[2], match[3], match[4]);
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
  return typographicBlock(body) ?? firstQuotedBlock(body);
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
    const position = doc.index.get(key);
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

/**
 * Apply parsed ops to source text. Every op either produces a receipt with
 * the exact spliced span or a typed failure; splices never overlap.
 */
export function applyAmendOps(
  sourceText: string,
  ops: AmendOp[],
): ApplyAmendmentsResult {
  const before = compileAgreementSkeleton(sourceText);
  const labels = before.doc;
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
        const hits = findInSpan(sourceText, span, op.oldText);
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
        const oldToken = new RegExp(String.raw`^(\s*)(\(([^\s()]{1,12})\)|\d+[A-Za-z]?(?:\.\d+)*\.?)`, "u").exec(lead);
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

  const after = compileAgreementSkeleton(text);
  let newTextPresent = 0;
  let newTextMissing = 0;
  let oldTextGone = 0;
  let oldTextLingers = 0;
  const afterLabels = after.doc;
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
      ladderViolationsBefore: before.ladder.violations,
      ladderViolationsAfter: after.ladder.violations,
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
export function consolidateAmendment(
  sourceText: string,
  amendmentText: string,
): ApplyAmendmentsResult & { parse: AmendParseResult } {
  const parse = parseAmendmentInstructions(amendmentText);
  const result = applyAmendOps(sourceText, parse.ops);
  return { ...result, parse };
}
