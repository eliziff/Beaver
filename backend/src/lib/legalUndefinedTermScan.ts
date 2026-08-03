/**
 * Undefined defined-term scan — a deterministic forward-reference omission
 * organ.
 *
 * General legal pattern: an analytical deliverable or drafted agreement
 * references a capitalized, defined-term-style phrase ("Permitted Tax
 * Distributions") that resolves to NO definition in the combined sources +
 * draft. The reader cannot know what the term means. This is a stable
 * drafting defect, general to any contract/agreement task.
 *
 * The organ reuses the repo's existing defined-term extraction
 * (`collectDefinedTerms` for parenthetical `(the "Term")` definitions, plus
 * the `"Term" means / has the meaning / is defined as` list-entry grammar
 * from legalTermDrift.ts) rather than inventing a parallel parser. It then
 * scans the DRAFT for capitalized phrase candidates and flags one only when
 * ALL of these hold:
 *
 *   (a) it is used as a defined term — capitalized, phrase-like (two or more
 *       words), appearing UNQUOTED in the draft's prose;
 *   (b) it is NOT a proper noun, party/entity name, office title,
 *       jurisdiction/regime name, section/caption title, all-caps legend, or
 *       descriptive extension of a defined term;
 *   (c) it has NO matching definition in sources + draft.
 *
 * The quoting/using boundary is the load-bearing design choice: a markup
 * analysis legitimately QUOTES the counterparty's terms ("the agreement
 * defines 'Permitted Tax Distributions' as …") without using them as defined
 * terms. A phrase whose occurrences all sit inside quotation marks is a
 * quotation/description, never a use; only phrases with at least one unquoted
 * occurrence are candidates. (Measured on the grounded-cache indenture stack:
 * 113 of 245 candidate phrases were quoted-only mentions.) A term used only
 * inside the body of another definition ("ABL Priority Collateral" means "…,
 * Deposit Accounts, …") is an enumeration, not an operative use, and is left
 * alone too.
 *
 * Strictness is the point (CLAUDE.md rule 5): a false positive — a wrong
 * finding in front of a busy lawyer — costs more trust than a miss, so the
 * filters below are biased toward abstaining. When a capitalized phrase can be
 * resolved from a defined head word, an entity/regime name, or a decomposable
 * run of defined terms, it is treated as descriptive and left alone.
 *
 * Measure-first basis (2026-08-03, grounded-cache v3 indenture stack, 11
 * source DOCX + draft): 245 phrase candidates, 830 defined-term forms
 * extracted across the stack, 1 fired — "Designated Non-Cash Consideration", a
 * coined compound used in the operative Asset Sale covenant that no source or
 * the draft defines. The canonical validation term "Permitted Tax
 * Distributions" is defined in term-sheet.docx and is correctly silent.
 */
import { collectDefinedTerms } from "./docxStructuralLint";
import { COMMON_ENGLISH } from "./commonEnglishWords";

export interface UndefinedTermDocument {
  name: string;
  text: string;
}

export interface UndefinedTermFinding {
  kind: "undefined_defined_term";
  /** the capitalized phrase the draft treats as a defined term */
  term: string;
  /** how many unquoted uses of the phrase occur in the draft */
  occurrences: number;
  /** char offset of the first unquoted use in the draft, for quoting */
  at: number;
  excerpt: string;
  /** the defect, spelled out */
  detail: string;
}

export interface UndefinedTermScanStats {
  /** distinct capitalized phrase candidates in the draft */
  candidates: number;
  /** total candidate occurrences in the draft */
  occurrences: number;
  /** distinct terms defined across sources + draft */
  definedTerms: number;
  /** candidates that appear only as quoted mentions (the markup boundary) */
  quotedOnly: number;
}

const MAX_FINDINGS = 12;
const EXCERPT_CHARS = 160;

/**
 * A capitalized phrase-like expression: two or more Title-Case words, with
 * optional compound-forming connectors ("Change of Control", "Sale and
 * Leaseback Transactions") sandwiched between Title-Case words. Only
 * compound-forming connectors ("of", "and", "or", …) extend a phrase; the
 * time/place prepositions ("in", "on", "at", "due", …) do NOT, so
 * "Permitted Tax Distributions in January" is the term "Permitted Tax
 * Distributions" followed by an adjunct, never a longer coined phrase.
 * Separators are spaces and tabs only, never paragraph breaks, so a phrase
 * cannot join a heading to the sentence that follows it.
 */
const PHRASE_RE =
  /\b[A-Z][A-Za-z0-9&'’\-]+(?:[ \t]+(?:(?:of|and|or|to|for|by|with|without|upon)[ \t]+)?[A-Z][A-Za-z0-9&'’\-]+)+\b/gu;

/**
 * Leading determiners / sentence-initial conjunctions that glue onto a
 * following capitalized phrase ("If Excess Proceeds", "Subject to Permitted
 * Liens") without being part of a defined term. Stripping them can only make a
 * candidate more likely to resolve, never more likely to fire.
 */
const DETERMINER_RE =
  /^(?:(?:The|This|Such|Any|Each|All|If|Unless|Where|When|Upon|Provided|Wherever|After|Before|During|Except)\s+|Subject\s+(?:to\s+)?|Notwithstanding\s+)/iu;

/** A party-possessive prefix: "Issuer's Voting Stock" → "Voting Stock". */
const POSSESSIVE_RE = /^(?:[A-Z][A-Za-z0-9&'’\-]*['’]s\s+)+/iu;

/** A cross-reference label ("Article X", "Section 4.07"), never a term. */
const CROSS_REFERENCE_RE =
  /^(?:Article|Section|Clause|Exhibit|Schedule|Annex|Annexure|Appendix|Part|Chapter)\s+[\dIVXLCDMv.]+/iu;

/** Entity / party designators: a phrase containing one is a proper noun. */
const ENTITY_WORDS = new Set([
  "inc", "incorporated", "corp", "corporation", "llc", "llp", "l.p.", "lp",
  "ltd", "limited", "co.", "co", "company", "n.a.", "na", "trust", "bank",
  "bancorp", "fund", "funds", "holdings", "group", "partners", "partner",
  "capital", "associates", "enterprises", "industries", "systems",
  "technologies", "communications", "energy", "properties", "insurance",
  "logistics", "global", "international", "media", "resources", "materials",
  "services", "ventures",
  // International entity designators (M4): "GmbH" (DE), "Sàrl"/"SARL" (CH),
  // "KK" (JP), "Pty" (AU/GB), "PLC" (GB/IE), "AG" (DE/CH), "SE" (EU),
  // "BV"/"NV" (NL/BE), "S.p.A."/"SA" (IT/FR/ES), "AB" (SE), "AS" (NO),
  // "KGaA" (DE), "Oy"/"Oyj" (FI), "ApS" (DK). "Limited" may appear as "Pty
  // Limited" — "pty" is in the set so the compound carries a matched
  // designator even where "Limited" is the name's last word.
  "gmbh", "sàrl", "kk", "pty", "plc", "ag", "se", "sarl", "bv", "nv",
  "unlimited", "spa", "sa", "ab", "as", "kgaa", "oy", "oyj", "aps",
  // This set (like JURISDICTION_NAMES below) is best-effort and will keep
  // needing additions. A proper-noun phrase that misses the set fires a
  // tolerated false positive — the model can see it is an entity/jurisdiction
  // name — while over-suppressing could hide a genuine undefined term, so
  // entries are added deliberately, never by a sweeping regex.
]);

/**
 * Entity-designator abbreviations that commonly follow a comma after a
 * company name ("Triton Industrial Gas Distribution, Inc.", "Cascadia Trust
 * Company, N.A."). When a phrase is immediately followed by `, <word>` and
 * the word matches this set (trailing period stripped), the phrase is part
 * of a proper noun — not a defined term.
 */
const TRAILING_ENTITY_RE =
  /^, [A-Z][A-Za-z0-9&'’\-\.]+/u;

/** Officer / role titles in signature blocks and capacity clauses. */
const OFFICE_TITLE_RE =
  /^(?:Chief\s+(?:Executive|Financial|Operating|Administrative|Legal|Compliance|Technology|Information|Risk)\s+Officer|Vice\s+President|Chairman|Chairperson|President|Treasurer|Secretary)$/iu;

/** Multi-word jurisdiction / regime names (single-word states never match). */
const JURISDICTION_NAMES = new Set([
  "united states", "united kingdom", "united arab emirates", "new york",
  "new jersey", "new mexico", "new hampshire", "north carolina",
  "north dakota", "south carolina", "south dakota", "rhode island",
  "west virginia", "pennsylvania", "massachusetts", "michigan", "minnesota",
  "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
  "maryland", "ohio", "oklahoma", "oregon", "texas", "virginia",
  "washington", "wisconsin", "canada", "england", "scotland", "wales",
  "australia", "singapore", "hong kong", "netherlands", "germany", "france",
  "japan", "china", "india", "mexico", "brazil",
  // US cities / metro areas that appear as place-of-business references in
  // analytical memos and will never be defined terms.
  "baton rouge", "new orleans", "gulfport", "biloxi", "hattiesburg",
  "jackson", "mobile", "pensacola", "tallahassee", "birmingham",
  "montgomery", "huntsville", "little rock", "fayetteville",
  "atlanta", "savannah", "augusta", "macon", "charleston",
  "columbia", "greenville", "charlotte", "raleigh", "durham",
  "nashville", "memphis", "knoxville", "chattanooga", "louisville",
  "lexington", "richmond", "norfolk", "baltimore", "annapolis",
  "philadelphia", "pittsburgh", "harrisburg", "cleveland",
  "cincinnati", "columbus", "dayton", "toledo", "detroit",
  "grand rapids", "lansing", "chicago", "springfield", "peoria",
  "indianapolis", "fort wayne", "milwaukee", "madison", "minneapolis",
  "st. paul", "saint paul", "des moines", "kansas city", "st. louis",
  "saint louis", "omaha", "lincoln", "wichita", "topeka",
  "denver", "boulder", "phoenix", "tucson", "las vegas", "reno",
  "salt lake city", "boise", "portland", "salem", "seattle",
  "tacoma", "spokane", "anchorage", "honolulu", "san diego",
  "los angeles", "san francisco", "sacramento", "san jose",
  "oakland", "fresno", "palo alto", "mountain view", "cupertino",
  "san antonio", "austin", "dallas", "fort worth", "el paso",
  "houston", "corpus christi", "oklahoma city", "tulsa",
  "albuquerque", "santa fe", "miami", "orlando", "tampa",
  "jacksonville", "west palm beach", "fort lauderdale",
  "washington dc", "washington d.c.", "boston", "cambridge",
  "providence", "hartford", "new haven", "stamford",
  "montreal", "toronto", "vancouver", "ottawa", "calgary",
  "london", "paris", "berlin", "tokyo", "sydney", "melbourne",
  // Canadian provinces and territories (M4): governing-law clauses reference
  // them as "Province of British Columbia" / "Territory of Yukon" / "Province
  // of Quebec". The full "Newfoundland and Labrador" compound is included so
  // the "and"-joined Title-Case phrase resolves as a unit.
  "british columbia", "nova scotia", "new brunswick", "manitoba",
  "saskatchewan", "alberta", "newfoundland", "labrador",
  "newfoundland and labrador", "prince edward island", "yukon", "nunavut",
  "northwest territories", "quebec",
  // Other offshore / civil-law jurisdictions commonly named in governing-law
  // and choice-of-forum clauses. Compound forms ("Trinidad and Tobago",
  // "Turks and Caicos Islands", "Antigua and Barbuda", "St. Kitts and
  // Nevis") are included so the "and"-joined phrases resolve as a unit.
  "cayman islands", "cayman", "isle of man", "channel islands",
  "puerto rico", "bermuda", "bahamas", "barbados", "jamaica", "trinidad",
  "tobago", "trinidad and tobago", "gibraltar", "luxembourg",
  "liechtenstein", "monaco", "andorra", "san marino", "vatican",
  "seychelles", "mauritius", "cyprus", "malta", "guernsey", "jersey",
  "anguilla", "british virgin islands", "turks", "caicos",
  "turks and caicos", "turks and caicos islands", "curacao", "aruba",
  "st. kitts", "nevis", "st. kitts and nevis", "antigua", "barbuda",
  "antigua and barbuda", "st. lucia", "grenada", "dominica",
  "st. vincent", "grenadines", "st. vincent and the grenadines",
  // Canadian cities / metro areas that appear as place-of-business
  // references in legal documents and will never be defined terms.
  "edmonton", "winnipeg", "hamilton", "waterloo", "kitchener",
  "london ontario", "mississauga", "brampton", "markham", "vaughan",
  "burnaby", "surrey", "richmond bc", "coquitlam", "delta", "langley",
  "abbotsford", "kelowna", "regina", "saskatoon", "halifax", "dartmouth",
  "st. john's", "fredericton", "moncton", "charlottetown",
  "yellowknife", "whitehorse", "iqaluit",
]);

/**
 * A jurisdiction/regime name, allowing the "State of X" / "Province of X"
 * lead-in that governing-law clauses use ("the laws of the State of New York").
 */
function isJurisdiction(phrase: string): boolean {
  const lower = phrase.toLowerCase().trim();
  if (JURISDICTION_NAMES.has(lower)) return true;
  for (const prefix of [
    "state of ", "commonwealth of ", "province of ", "territory of ",
    "city of ", "county of ", "district of ",
  ]) {
    if (lower.startsWith(prefix) && JURISDICTION_NAMES.has(lower.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

/** Government agency / regulatory regime designators. */
const REGIME_WORDS = new Set([
  "commission", "authority", "agency", "bureau", "department",
  "administration", "board", "exchange", "reserve", "association",
  "institute", "union", "office", "ministry", "regulator",
  // Statute / regulation / form names ("Hart-Scott-Rodino Act",
  // "Internal Revenue Code", "Notification and Report Form",
  // "Federal Rules of Civil Procedure").
  "act", "code", "rules", "regulations", "statute", "form",
  "court", "circuit", "district",
]);

/** Connector words that may glue defined terms into a descriptive run. */
const CONNECTOR_WORDS = new Set([
  "of", "and", "or", "in", "to", "for", "on", "the", "a", "an", "as", "by",
  "with", "from", "at", "per", "under", "over", "without", "upon",
]);

/**
 * The `"Term" means / shall mean / has the meaning / is defined as / includes`
 * list-entry grammar from legalTermDrift.ts, made tolerant of the common
 * extraction artifact where a quoted term carries whitespace inside the quotes
 * (" Equity Interests "). The leading `\s*` after the opening quote and the
 * trailing `\s*` before the closing quote let both `"X" means` and
 * `" X " means` be recognized.
 */
const DEFINITION_RE =
  /(?:“\s*([A-Z][^”\n]{0,79}?)\s*”|"\s*([A-Z][^"\n]{0,79}?)\s*")\s+(?:means|shall mean|has the meaning|shall have the meaning|is defined as|includes)\b/gu;

/** Curly → straight quote glyphs; NBSP → space, so offsets stay aligned. */
function normalizeQuotes(text: string): string {
  return text
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/ /gu, " ");
}

/**
 * The defined term plus its trivial singular/plural variants, lowercased.
 * Compound terms pluralize either the head ("Credit Facility" → "Credit
 * Facilities") or the first element ("Opinion of Counsel" → "Opinions of
 * Counsel"), so the first and last words are both pluralized/singularized.
 * Extra invented variants are harmless: they can only make a phrase MORE
 * likely to resolve, never more likely to fire (strictness bias).
 */
function termVariants(term: string): string[] {
  const words = term.toLowerCase().trim().split(/\s+/u);
  const out = new Set([words.join(" ")]);
  for (const k of [0, words.length - 1]) {
    const word = words[k];
    if (/[^aeiou]y$/u.test(word)) {
      out.add(words.map((w, i) => (i === k ? word.replace(/y$/u, "ies") : w)).join(" "));
    } else if (word.endsWith("s") && !word.endsWith("ss")) {
      out.add(words.map((w, i) => (i === k ? word.slice(0, -1) : w)).join(" "));
    } else {
      out.add(words.map((w, i) => (i === k ? `${w}s` : w)).join(" "));
    }
  }
  return [...out];
}

/**
 * The set of terms defined anywhere in the combined sources + draft, in a
 * lowercased form ready for membership checks. Reuses the repo's two existing
 * grammars: `collectDefinedTerms` (parenthetical `(the "Term")` and
 * definition-list entries) and the `"Term" means` list-entry grammar shared
 * with legalTermDrift.ts.
 */
function definedTermSet(documents: readonly UndefinedTermDocument[]): Set<string> {
  const out = new Set<string>();
  for (const document of documents) {
    const text = normalizeQuotes(document.text);
    // Parenthetical and definition-list forms (the canonical extractor).
    for (const term of collectDefinedTerms(text.split("\n")).keys()) {
      for (const variant of termVariants(term)) out.add(variant);
    }
    // "Term" means … anywhere in the text, whitespace-tolerant.
    for (const match of text.matchAll(DEFINITION_RE)) {
      const term = (match[1] ?? match[2] ?? "").trim();
      if (!term) continue;
      for (const variant of termVariants(term)) out.add(variant);
    }
  }
  return out;
}

/**
 * A char-index mask marking positions inside straight/curly quotation marks.
 * Single-quote glyphs are treated as delimiters only when they are not
 * word-internal apostrophes ("Issuer's" stays outside the quoted region).
 */
function quoteMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  const stack: { quote: boolean }[] = [];
  const isWordChar = (c: string) => /[A-Za-z0-9]/u.test(c);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : " ";
    const next = i + 1 < text.length ? text[i + 1] : " ";
    if (ch === '"') {
      if (stack.length && stack[stack.length - 1].quote) stack.pop();
      else stack.push({ quote: true });
    } else if (ch === "'") {
      // A quote delimiter unless it is a word-internal apostrophe.
      if (isWordChar(prev) && isWordChar(next)) {
        /* apostrophe — leave the quote stack untouched */
      } else if (stack.length && stack[stack.length - 1].quote) {
        stack.pop();
      } else {
        stack.push({ quote: true });
      }
    }
    if (stack.length) mask[i] = true;
  }
  return mask;
}

/**
 * Lowercase words that may legitimately sit between Title-Case words in a
 * caption ("Change of Control", "Notice of Default", "Sale and Leaseback").
 * A caption like "8.01 Financial Covenants." or "Definitions and
 * Interpretation" has no OTHER lowercase words; prose ("…the Borrower shall
 * not permit…") does, so the presence of a non-connector lowercase word is
 * the prose marker. Measured on the grounded-cache indenture stack: numbered,
 * period-terminated captions were the one caption shape the previous
 * capital-first / unpunctuated gate missed, so "Financial Covenants" in a
 * section title leaked as an undefined-term finding.
 */
const CAPTION_CONNECTORS = new Set([
  "of", "and", "or", "to", "for", "in", "by", "with", "without", "upon",
  "under", "on", "at", "from", "as", "the", "a", "an",
  // Legal caption-specific connectors (C3 fix): "In re Smith Corp.",
  // "Doe vs. Roe", "Ex parte Motion", "Sub rosa", "Non disclosure".
  "re", "vs", "ex", "per", "sub", "non",
]);

/**
 * A line is heading/caption-like when short and free of non-connector
 * lowercase words — numbered captions ("8.01 Financial Covenants."), section
 * titles ("Definitions and Interpretation"), and all-caps legends all pass;
 * prose sentences ("…the Borrower shall not permit…") carry verbs and
 * quantifiers and do not. "Vice President of the Issuer" keeps "of"/"the"
 * as connectors, so a caption that ends in an officer title still reads as a
 * caption.
 */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  // 180-char ceiling: memo header blocks ("From: ... Date: ... Re: ...")
  // can run 130+ chars on one line; real prose sentences over 180 chars
  // are rare and, when they exist, their capitalized phrases are nearly
  // always proper nouns, not defined terms — the strictness bias prefers
  // a miss (suppressed phrase) over noise (spurious finding).
  if (trimmed.length === 0 || trimmed.length > 180) return false;
  const words = trimmed.split(/\s+/u).filter(Boolean);
  if (words.length < 2) return false;
  // Memo header fields: a line that begins with a memo/letter label
  // ("From:", "Date:", "Re:", "To:", "Subject:", "cc:") is a metadata
  // header, never operative prose, even when the field content carries
  // lowercase words ("Re: Proposed acquisition of...").
  if (/^(?:From|Date|Re|To|Subject|cc|Memo|File|Ref)\s*:/iu.test(trimmed)) {
    return true;
  }
  for (const word of words) {
    // A prose marker is a word that BEGINS lowercase and is not a caption
    // connector: Title-Case words ("Financial", "Covenants.") and all-caps
    // words carry no lowercase first letter, so only real prose words
    // ("shall", "maintain", "certificate") reject the line as a caption.
    if (/^[a-z]/u.test(word) && !CAPTION_CONNECTORS.has(word.toLowerCase())) {
      return false;
    }
  }
  return true;
}

interface Occurrence {
  at: number;
  quoted: boolean;
  heading: boolean;
  coupon: boolean;
  /** the occurrence sits inside the body of a `"Term" means` definition */
  inDefinitionBody: boolean;
}

/** The line index containing a char offset, via a cumulative line map. */
function lineIndexAt(offsets: number[], at: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= at) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * A char-index mask marking the BODY of each `"Term" means` definition in the
 * draft — from the definition's opening quote to the next definition's opening
 * quote, or the end of the line. A capitalized phrase enumerated inside a
 * definition body ("ABL Priority Collateral" means "…, Deposit Accounts, …")
 * is describing what another term includes, not operatively USING that phrase
 * as a defined term; occurrences inside a body do not count as uses.
 */
function definitionBodyMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  const defStarts: number[] = [];
  for (const match of text.matchAll(DEFINITION_RE)) {
    defStarts.push(match.index ?? 0);
  }
  if (defStarts.length === 0) return mask;
  const lineEnds: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lineEnds.push(i);
  }
  const nextLineEnd = (at: number): number => {
    let low = 0;
    let high = lineEnds.length - 1;
    let answer = text.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lineEnds[mid] >= at) {
        answer = lineEnds[mid];
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return answer;
  };
  for (let i = 0; i < defStarts.length; i += 1) {
    const start = defStarts[i];
    const end = Math.min(
      i + 1 < defStarts.length ? defStarts[i + 1] : text.length,
      nextLineEnd(start),
    );
    for (let j = start; j < end; j += 1) mask[j] = true;
  }
  return mask;
}

/**
 * Collect the draft's capitalized phrase candidates and classify each
 * occurrence as a quotation/description or a genuine (unquoted) use, and
 * whether the use sits in a caption, a coupon-titled instrument descriptor,
 * or inside a definition body.
 */
function collectCandidates(
  draftText: string,
  mask: boolean[],
  lineOffsets: number[],
  headings: boolean[],
  definitionBody: boolean[],
): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  for (const match of draftText.matchAll(PHRASE_RE)) {
    const phrase = match[0].replace(/[ \t]+/gu, " ").trim();
    const at = match.index ?? 0;
    const quoted = mask[at] === true;
    const line = lineIndexAt(lineOffsets, at);
    const heading = headings[line];
    // A coupon+instrument descriptor: "8.250% Senior Secured Notes due …".
    const before = draftText.slice(Math.max(0, at - 14), at);
    const coupon = /%\s*$/u.test(before);
    const list = out.get(phrase) ?? [];
    list.push({
      at,
      quoted,
      heading,
      coupon,
      inDefinitionBody: definitionBody[at] === true,
    });
    out.set(phrase, list);
  }
  return out;
}

function excerptAt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - EXCERPT_CHARS / 2);
  const end = Math.min(text.length, at + length + EXCERPT_CHARS / 2);
  const window = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return (start > 0 ? "…" : "") + window + (end < text.length ? "…" : "");
}

/**
 * True when the phrase is fully covered by a run of defined terms with
 * connector words — "Hedging Obligations and Attributable Indebtedness" is two
 * defined terms joined by "and", a descriptive run, not a coined undefined
 * term. The `defined` set already includes singular/plural variants, so
 * "Opinions of Counsel" resolves against a defined "Opinion of Counsel".
 */
function decomposesIntoDefined(
  phrase: string,
  defined: Set<string>,
): boolean {
  const words = phrase.split(" ");
  const n = words.length;
  const reachable = new Array<boolean>(n + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < n; i += 1) {
    if (!reachable[i]) continue;
    if (CONNECTOR_WORDS.has(words[i].toLowerCase())) {
      reachable[i + 1] = true;
      continue;
    }
    for (let j = i; j < n; j += 1) {
      const candidate = words.slice(i, j + 1).join(" ").toLowerCase();
      if (defined.has(candidate)) {
        reachable[j + 1] = true;
        if (reachable[n]) return true;
      }
    }
  }
  return reachable[n];
}

/**
 * Scan the draft for capitalized defined-term-style phrases that resolve to no
 * definition in the combined sources + draft. See the file JSDoc for the
 * quoting/using boundary and the strictness rationale.
 */
export function undefinedTermScan(
  sources: readonly UndefinedTermDocument[],
  draft: UndefinedTermDocument,
): UndefinedTermFinding[] {
  const defined = definedTermSet([...sources, draft]);
  const draftText = normalizeQuotes(draft.text);
  const mask = quoteMask(draftText);
  const definitionBody = definitionBodyMask(draftText);

  // Per-line heading detection, aligned with char offsets.
  const lines = draftText.split("\n");
  const lineOffsets: number[] = [0];
  for (let i = 1; i < lines.length; i += 1) {
    lineOffsets[i] = lineOffsets[i - 1] + lines[i - 1].length + 1;
  }
  const headings = lines.map(isHeadingLine);

  const candidates = collectCandidates(
    draftText,
    mask,
    lineOffsets,
    headings,
    definitionBody,
  );
  const findings: UndefinedTermFinding[] = [];
  const seen = new Set<string>();
  const cap = MAX_FINDINGS;

  for (const [phrase, occurrences] of candidates) {
    const uses = occurrences.filter((occurrence) => !occurrence.quoted);
    // (quoting boundary) quoted-only mentions are descriptions, never uses.
    if (uses.length === 0) continue;

    // (a, operative context) a term used ONLY inside the body of another
    // definition ("ABL Priority Collateral" means "…, Deposit Accounts, …")
    // is an enumeration describing that term, not an independent use.
    if (uses.every((occurrence) => occurrence.inDefinitionBody)) continue;

    // A sentence subject like "The Issuer" or a possessive like "Issuer's
    // Voting Stock" collapses to the bare term; a single-word remainder is too
    // generic to be a phrase-like defined term.
    const bare = phrase.replace(DETERMINER_RE, "").replace(POSSESSIVE_RE, "");
    if (bare.split(/[ \t]+/u).length < 2) continue;

    // (c) defined anywhere in sources + draft → silent. Both the stripped bare
    // form and the full phrase are checked, so a genuinely-defined phrase that
    // happens to start with a determiner ("Subject Company") still resolves.
    const lower = bare.toLowerCase();
    const fullLower = phrase.toLowerCase();
    const definedVariants = new Set([
      lower,
      fullLower,
      lower.replace(/ies$/u, "y"),
      lower.replace(/([^aeiou])y$/u, "$1ies"),
      lower.replace(/s$/u, ""),
      `${lower}s`,
    ]);
    let isDefined = false;
    for (const variant of definedVariants) {
      if (defined.has(variant)) {
        isDefined = true;
        break;
      }
    }
    if (isDefined) continue;

    // A run of defined terms ("Hedging Obligations and Attributable
    // Indebtedness") is descriptive, not a coined undefined term.
    if (decomposesIntoDefined(bare, defined)) continue;

    // A cross-reference label ("Article X", "Section 4.07") is a locator.
    if (CROSS_REFERENCE_RE.test(bare)) continue;

    // Proper nouns, titles, jurisdictions and regimes are not defined terms.
    const words = bare.split(/[ \t]+/u);
    // Strip trailing punctuation from each word before the entity check
    // so "Inc." / "L.P." / "N.A." resolve against the ENTITY_WORDS set.
    const hasEntityWord = words.some((word) =>
      ENTITY_WORDS.has(word.toLowerCase().replace(/[.,;:!?]+$/u, "")),
    );
    if (hasEntityWord) continue;
    // A company name whose entity designator sits across a comma from the
    // name ("Triton Industrial Gas Distribution, Inc.") — the comma breaks
    // the PHRASE_RE match, so the designator is never captured. Check the
    // text immediately after the phrase for ", <entity word>".
    const firstUse = uses[0];
    const afterPhrase = draftText.slice(
      firstUse.at + bare.length,
      firstUse.at + bare.length + 30,
    );
    const trailingEntity = TRAILING_ENTITY_RE.exec(afterPhrase);
    if (trailingEntity) {
      // Normalize: strip leading ", ", then all punctuation, so "Inc.",
      // "L.P.", and "N.A." all resolve against the dot-free ENTITY_WORDS.
      const entityWord = trailingEntity[0]
        .replace(/^, /u, "")
        .replace(/[.,;:!?]+$/u, "")
        .replace(/\./gu, "")
        .toLowerCase();
      if (ENTITY_WORDS.has(entityWord)) continue;
    }
    if (OFFICE_TITLE_RE.test(bare)) continue;
    if (isJurisdiction(bare)) continue;
    if (words.some((word) => REGIME_WORDS.has(word.toLowerCase()))) continue;

    // Common-English head-noun filter: a legal defined term's head noun is
    // virtually always a common English word ("Permitted Tax Distributions",
    // "Change of Control", "SOFR Rate"). Person names and company names
    // typically have proper-noun heads ("Frank Castellano", "Gulf Coast
    // Shipbuilders"). Requiring the last content word (the head noun) to be
    // common English catches this distinction without a gazetteer.
    // De-pluralization is tried before rejecting: "Distributions" →
    // "distribution", "Securities" → "security", "Covenants" → "covenant".
    const contentWordsForCommon = words.filter(
      (word) => !CONNECTOR_WORDS.has(word.toLowerCase()),
    );
    if (contentWordsForCommon.length >= 2) {
      const raw = contentWordsForCommon[contentWordsForCommon.length - 1].toLowerCase();
      const headVariants = new Set([raw]);
      // De-pluralize: -ies → -y (Securities → Security, Parties → Party)
      if (/[^aeiou]ies$/u.test(raw)) headVariants.add(raw.replace(/ies$/u, "y"));
      // Strip -s (Distributions → Distribution, Covenants → Covenant)
      if (raw.endsWith("s") && !raw.endsWith("ss")) headVariants.add(raw.slice(0, -1));
      // Add -s (Distribution → Distributions, Covenant → Covenants)
      headVariants.add(`${raw}s`);
      if (![...headVariants].some((variant) => COMMON_ENGLISH.has(variant))) {
        continue;
      }
    }

    // A descriptive extension of a defined head ("Senior Secured Notes" ends
    // in the defined term "Notes") is comprehensible and left alone.
    const head = words[words.length - 1].toLowerCase();
    if (defined.has(head) || defined.has(head.replace(/ies$/u, "y"))) continue;

    // A coupon-titled instrument descriptor ("8.250% Senior Secured Notes") —
    // every use is a security title, not an undefined term.
    if (uses.every((occurrence) => occurrence.coupon)) continue;

    // A caption-only phrase (appears solely as a section/caption title).
    if (uses.every((occurrence) => occurrence.heading)) continue;

    // An all-caps legend or header block: when most non-connector words are
    // fully uppercase (not just Title-Case), the phrase is a confidentiality
    // legend, privilege header, or similar boilerplate — never a defined term.
    // "SOFR Rate" has one all-caps word out of two (50%); "ATTORNEY-CLIENT
    // PRIVILEGED AND CONFIDENTIAL" has ≥5 all-caps words out of 5 (100%).
    // Threshold: ≥60% of non-connector words are all-caps AND the phrase has
    // 4+ words (so "EBITDA Adjustment" and "SOFR Rate" are left alone).
    const contentWords = words.filter(
      (word) => !CONNECTOR_WORDS.has(word.toLowerCase()),
    );
    if (
      contentWords.length >= 4 &&
      contentWords.filter((word) => /^[A-Z][A-Z0-9&'’\-\.]+$/u.test(word)).length >=
        contentWords.length * 0.6
    ) {
      continue;
    }

    const key = `undefined-term:${lower}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      kind: "undefined_defined_term",
      term: bare,
      occurrences: uses.length,
      at: firstUse.at,
      excerpt: excerptAt(draftText, firstUse.at, bare.length),
      detail: `"${bare}" is used as a defined term in the draft but is not defined in the draft or any of the ${sources.length} source document(s); the reader cannot know what it means`,
    });
    if (findings.length >= cap) break;
  }

  return findings;
}

/**
 * Candidate and defined-term counts for a stack, for honest reporting and
 * debugging (the probe uses this to show what was considered vs fired).
 */
export function undefinedTermScanStats(
  sources: readonly UndefinedTermDocument[],
  draft: UndefinedTermDocument,
): UndefinedTermScanStats {
  const defined = definedTermSet([...sources, draft]);
  const draftText = normalizeQuotes(draft.text);
  const mask = quoteMask(draftText);
  const definitionBody = definitionBodyMask(draftText);
  const lines = draftText.split("\n");
  const lineOffsets: number[] = [0];
  for (let i = 1; i < lines.length; i += 1) {
    lineOffsets[i] = lineOffsets[i - 1] + lines[i - 1].length + 1;
  }
  const headings = lines.map(isHeadingLine);
  const candidates = collectCandidates(
    draftText,
    mask,
    lineOffsets,
    headings,
    definitionBody,
  );
  let occurrences = 0;
  let quotedOnly = 0;
  for (const occs of candidates.values()) {
    occurrences += occs.length;
    if (!occs.some((occ) => !occ.quoted)) quotedOnly += 1;
  }
  return {
    candidates: candidates.size,
    occurrences,
    definedTerms: defined.size,
    quotedOnly,
  };
}
