/**
 * Reference grammar: the one place that knows what a provision REFERENCE
 * looks like.
 *
 * Legal instruments are self-referential — "Section 2.05 of the Credit
 * Agreement", "Subsection 5(1)", "clause 5(1)(b)(ii)", "Article VIII",
 * "le paragraphe 193(2)". Three consumers had grown their own copies of
 * that shape: `legalAmendOps` (which addresses amendment ops by it),
 * `docxStructuralLint` (which lints dangling ones), and `legalTextSkeleton`
 * (which counts them). This module owns the shape; they consume it.
 *
 * Deliberately NOT in scope — kept next door, not folded in:
 *   - what the sections and subsections ARE (`legalTextSkeleton`: structural
 *     segmentation). This module only says what a POINTER to one looks like.
 *   - citation grammar for other instruments (`citationKey.ts`,
 *     `caselawCitator.ts`, eyecite). `isExternalReference` is the boundary:
 *     everything it calls external belongs to those modules, not this one.
 *
 * Two tiers, deliberately distinct, because they answer different questions:
 *
 *   PROVISION_REF — the ANCHORED dialect. Used inside a larger pattern that
 *     has already established we are looking at a reference ("...at the end
 *     of ${PROVISION_REF}"), so it tolerates an empty label. Never use it as
 *     a free-text detector: on the LegalBench-RAG mini corpus it fires on
 *     9,989 maud spans of which 2,035 (20.4%) are a bare provision word with
 *     no label at all ("this section", "each paragraph"); on contractnli the
 *     bare-word share is 69% (113 -> 35).
 *
 *   findProvisionReferences — the FREE-TEXT detector. Requires a non-empty
 *     label and additionally accepts roman container numbering, which the
 *     anchored dialect does not: "Article VIII" occurs 612 times in maud
 *     (7.7% of that source's literal references) and 4 times in cuad.
 *
 * Known, measured misses in the free-text detector (each is a deliberate
 * precision choice, not an oversight):
 *   - list continuations — "Sections 2.1 and 2.2", "Articles I through IV" —
 *     yield only their HEAD reference. 191 continuations in maud (2.4% of
 *     its references), 41 cuad, 4 contractnli, 1 privacy_qa.
 *   - deictic references ("this Section", "hereof") carry no label and are
 *     not reference EDGES at all; they are self-loops. 1,308 + 1,713 in maud.
 */
import { normalizeSourceDocLocator } from "./sourceDoc";

/* ------------------------------------------------------------------ */
/* Anchored dialect (English + French federal drafting)                */
/* ------------------------------------------------------------------ */

export const PROVISION_WORD =
  "(?:sub-?section|section|paragraph|subparagraph|clause|subclause|item|article|part|division|schedule|definition)";

/** "Section 3", "Subsection 5(1)", "paragraph (b)", "clause 5(1)(b)(ii)". */
export const PROVISION_REF = String.raw`${PROVISION_WORD}s?\s+((?:\d+[A-Za-z]?(?:\.\d+)*)?(?:\s?\([^\s()]{1,12}\))*)`;

export function compactLabel(raw: string): string {
  return raw.replace(/\s+/gu, "");
}

/* French federal drafting ("est remplacé par ce qui suit :") — the same
 * op algebra; both language versions are equally authoritative. */
export const FR_PROVISION_WORD =
  "(?:sous-alinéas?|alinéas?|paragraphes?|articles?|sous-divisions?|divisions?|parties?|annexes?)";

// French writes paragraph letters without the opening paren — "42a)(i)",
// "alinéa b)" — while subclauses keep both parens.
export const FR_PROVISION_REF = String.raw`${FR_PROVISION_WORD}\s+((?:\d+(?:\.\d+)*[A-Za-z]?)?(?:\s?(?:\([^\s()]{1,12}\)|[a-zà-ÿ]{1,4}\)))*)`;

/** "42a)(i)" → "42(a)(i)": restore the shared locator dialect. */
export function compactLabelFr(raw: string): string {
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
/* Internal vs external                                                */
/* ------------------------------------------------------------------ */

// A reference like "Section 85 of the Income Tax Act" points outside this
// document. Only "of this ..." (and "hereof"/bare continuations) are internal.
export function isExternalReference(following: string) {
  const trimmed = following.replace(/^\s*\([a-z0-9]{1,4}\)/giu, "").trimStart();
  const external = trimmed.match(/^(?:of|to|under)\s+(\w+)/iu);
  if (!external) return false;
  return external[1].toLowerCase() !== "this";
}

/**
 * Instrument nouns that put the OWNING instrument in front of the provision
 * word: "Code Section 59A", "Treasury Regulation Section 1.482", "Exchange
 * Act Section 13(d)". `isExternalReference` reads only the right flank and
 * is structurally blind to these; the whole-flank test below composes the
 * two. Kept separate rather than folded into `isExternalReference`, whose
 * one-argument contract three shipping consumers depend on.
 */
const INSTRUMENT_LEAD =
  /\b(?:code|act|regulations?|rules?|statutes?|laws?|chapter|title|ordinance|directive|treaty|convention|constitution)\s*$/iu;

/** "Sections 302 and 906 of the Sarbanes-Oxley Act": skip to the "of". */
const LIST_CONTINUATION = /^(?:\s*(?:,|and|or|through)\s*\d[\w.()-]*)+/iu;

export interface ReferenceFlanks {
  /** text immediately before the reference */
  before: string;
  /** text immediately after the reference */
  after: string;
}

/**
 * Does this reference point outside the document? Both flanks, because
 * external statutory references in US contracts are written either way
 * round. Composes `isExternalReference` rather than replacing it.
 */
export function isExternalReferenceInContext(flanks: ReferenceFlanks): boolean {
  if (INSTRUMENT_LEAD.test(flanks.before)) return true;
  // "Section 1.6011-4(b)(2)" — a hyphenated subdivision is Treasury
  // Regulation numbering; no contract numbers a section that way.
  if (/^-\s?\d/u.test(flanks.after)) return true;
  // "Section 262 thereof" — "thereof" names an instrument already in scope,
  // which is never the present one ("hereof" is the present one).
  if (/^\s*thereof\b/iu.test(flanks.after)) return true;
  if (isExternalReference(flanks.after)) return true;
  // Only a member of a list can hide the "of the X Act" behind siblings.
  const skipped = flanks.after.replace(LIST_CONTINUATION, "");
  if (skipped === flanks.after) return false;
  // Deliberately stricter than isExternalReference here: it also accepts
  // "to", which past a numeric list is an infinitive far more often than a
  // preposition — "Section 7.2 or 7.3 to be satisfied" is internal. Dropping
  // "to" on this path costs 0 external references and recovers 4 resolvable
  // ones across the mini corpus.
  const owner = skipped.match(/^\s*(?:of|under)\s+(\w+)/iu);
  return Boolean(owner) && owner![1].toLowerCase() !== "this";
}

/* ------------------------------------------------------------------ */
/* Free-text detector                                                  */
/* ------------------------------------------------------------------ */

/** Container words whose numbering is conventionally roman ("Article VIII"). */
const ROMAN_LABEL = String.raw`[IVXLCDM]{1,7}`;
const NUMERIC_LABEL = String.raw`\d{1,4}[A-Za-z]?(?:\.\d{1,4}[A-Za-z]?)*(?:\s?\([^\s()]{1,12}\))*`;
/** A label that is only a subscript — "paragraph (b)", "clause (i)(A)". */
const SUB_ONLY_LABEL = String.raw`(?:\([^\s()]{1,12}\))+`;

/**
 * Free-text reference detector. Non-empty label required (see the census in
 * the module header); roman labels accepted only for container words, since
 * "Section I" is far more often a mis-OCR'd "Section 1" or a stray pronoun
 * than a roman section — measured: 5 "Section <roman>" spans in the whole
 * mini corpus (all contractnli) against 612 "Article <roman>".
 */
const REFERENCE_RE = new RegExp(
  String.raw`\b(${PROVISION_WORD})(s)?\s+(?:(${NUMERIC_LABEL})|(${SUB_ONLY_LABEL}))`,
  "giu",
);
const ROMAN_REFERENCE_RE = new RegExp(
  String.raw`\b(article|articles|part|parts|division|divisions)\s+(${ROMAN_LABEL})\b`,
  "giu",
);

export type ProvisionReferenceShape = "numeric" | "sub-only" | "roman";

export interface ProvisionReference {
  /** span of the whole match ("Section 2.05") in the source text */
  start: number;
  end: number;
  raw: string;
  /** lower-cased provision word, singular ("section", "article") */
  word: string;
  plural: boolean;
  /** whitespace-compacted label as written ("2.05(a)", "VIII", "(b)") */
  label: string;
  shape: ProvisionReferenceShape;
  /**
   * Shared locator dialect ("sec2.05(a)"), or "" when the label does not
   * normalize. Two shapes never normalize on their own:
   *   - roman labels, which resolve through skeleton ALIASES ("article viii",
   *     exposed as `aliasKey`);
   *   - sub-only labels, which are meaningless without the section they sit
   *     in — resolution is context-relative and belongs to the caller
   *     (`joinLocator(containingSection, label)`).
   */
  locator: string;
  /** lower-cased human form, the skeleton's alias key for containers */
  aliasKey: string;
  /** true when the text following the label names another instrument */
  external: boolean;
}

export interface FindProvisionReferencesOptions {
  /**
   * Restrict the provision vocabulary (lower-case, singular). Default: the
   * whole of PROVISION_WORD.
   */
  words?: readonly string[];
  /** Characters of lookahead handed to `isExternalReference`. Default 40. */
  window?: number;
}

/**
 * Every provision reference in `text`, in source order, de-duplicated by
 * start offset (the roman pass can only ever add spans the numeric pass
 * cannot match, but overlap is checked rather than assumed).
 */
export function findProvisionReferences(
  text: string,
  options: FindProvisionReferencesOptions = {},
): ProvisionReference[] {
  const window = options.window ?? 40;
  const allowed = options.words ? new Set(options.words) : null;
  const found = new Map<number, ProvisionReference>();

  const push = (
    start: number,
    raw: string,
    word: string,
    plural: boolean,
    rawLabel: string,
    shape: ProvisionReferenceShape,
  ) => {
    if (found.has(start)) return;
    const singular = word.toLowerCase().replace(/s$/u, "");
    if (allowed && !allowed.has(singular)) return;
    const label = compactLabel(rawLabel);
    const end = start + raw.length;
    const following = text.slice(end, end + window);
    const preceding = text.slice(Math.max(0, start - window), start);
    found.set(start, {
      start,
      end,
      raw,
      word: singular,
      plural,
      label,
      shape,
      locator: shape === "roman" ? "" : normalizeSourceDocLocator("section", label),
      aliasKey: `${singular} ${label}`.toLowerCase(),
      external: isExternalReferenceInContext({
        before: preceding,
        after: following,
      }),
    });
  };

  for (const match of text.matchAll(REFERENCE_RE)) {
    const start = match.index ?? 0;
    push(
      start,
      match[0],
      match[1],
      Boolean(match[2]),
      match[3] ?? match[4] ?? "",
      match[3] ? "numeric" : "sub-only",
    );
  }
  for (const match of text.matchAll(ROMAN_REFERENCE_RE)) {
    const start = match.index ?? 0;
    const word = match[1].toLowerCase();
    push(
      start,
      match[0],
      word,
      word.endsWith("s"),
      match[2],
      "roman",
    );
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}
