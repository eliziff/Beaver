/**
 * Deterministic text-operation registry for DOCX editing.
 *
 * Contract: an op is a named pure function `(text, params) => string` (or
 * `{ text, notes }` when it has ambiguous sites to report). Ops never see
 * DOCX structure — they transform projected scope text and the shared
 * pipeline (docxTextOps.ts) turns the character-level differences into
 * tracked changes. Adding an op = one function here + unit tests.
 *
 * `\n` is the block (paragraph) separator in scope text; no op may add,
 * remove, or move a `\n`.
 */

export type TextOpNote = {
  /** Short verbatim excerpt of the site that was left unchanged. */
  site: string;
  reason: string;
  /** check_spelling only: dictionary suggestions for a flagged word. */
  suggestions?: string[];
  /** check_spelling only: surrounding text locating the flagged word. */
  context?: string;
};

export type TextOpResult = { text: string; notes: TextOpNote[] };

export type TextOpParams = {
  find?: string;
  replace?: string;
  match_case?: boolean;
  whole_word?: boolean;
  occurrence?: number;
  style?: string;
};

type OpFn = (
  text: string,
  params: TextOpParams,
) => string | TextOpResult | Promise<string | TextOpResult>;

const MAX_NOTES = 40;

const note = (
  notes: TextOpNote[],
  site: string,
  reason: string,
  extra?: Pick<TextOpNote, "suggestions" | "context">,
) => {
  if (notes.length < MAX_NOTES) {
    notes.push({
      site: site.length > 60 ? `${site.slice(0, 60)}…` : site,
      reason,
      ...extra,
    });
  }
};

const isLetter = (ch: string) => /\p{L}/u.test(ch);
const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

// ---------------------------------------------------------------------------
// Case family (Word's Change Case menu + conventional title case)
// ---------------------------------------------------------------------------

const toggleCase = (text: string) =>
  [...text]
    .map((ch) => {
      const up = ch.toUpperCase();
      const low = ch.toLowerCase();
      if (up === low) return ch;
      return ch === up ? low : up;
    })
    .join("");

/** First letter of every word upper, rest of the word lower (Word behavior). */
function capitalizeEachWord(text: string) {
  let out = "";
  let atWordStart = true;
  for (const ch of text) {
    if (isLetter(ch)) {
      out += atWordStart ? ch.toUpperCase() : ch.toLowerCase();
      atWordStart = false;
    } else {
      out += ch;
      if (!/[\p{L}\p{N}'’]/u.test(ch)) atWordStart = true;
    }
  }
  return out;
}

/**
 * Lowercase everything, capitalize the first letter of each sentence
 * (scope start, or after `. ! ? …` plus optional closers and whitespace),
 * and keep the pronoun "I" and its contractions capitalized.
 */
function sentenceCase(text: string) {
  const lowered = text.toLowerCase();
  const chars = [...lowered];
  let capitalizeNext = true;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (isLetter(ch)) {
      if (capitalizeNext) chars[i] = ch.toUpperCase();
      capitalizeNext = false;
    } else if (/[.!?…]/u.test(ch)) {
      capitalizeNext = true;
    } else if (ch === "\n") {
      capitalizeNext = true;
    } else if (!/[\s"'”’)\]]/u.test(ch)) {
      capitalizeNext = false;
    }
  }
  return chars
    .join("")
    .replace(/(^|[^\p{L}'’])i(?=$|[^\p{L}])/gmu, "$1I")
    .replace(/(^|[^\p{L}'’])i(?=['’](?:m|ve|ll|d)(?:$|[^\p{L}]))/gmu, "$1I");
}

const TITLE_SMALL_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet",
  "at", "by", "in", "of", "on", "to", "up",
]);

/**
 * Conventional title case: every word capitalized (first letter upper, rest
 * lower), small words lowercased unless they are the first or last word of a
 * line. ALL-CAPS words of 2+ letters are preserved as acronyms.
 */
function titleCase(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const tokens = line.split(/( +)/);
      const wordIdx = tokens
        .map((token, i) => (token && !/^ +$/.test(token) ? i : -1))
        .filter((i) => i >= 0);
      return tokens
        .map((token, i) => {
          if (!token || /^ +$/.test(token)) return token;
          const letters = token.replace(/[^\p{L}]/gu, "");
          if (letters.length >= 2 && letters === letters.toUpperCase()) {
            return token; // acronym — preserve
          }
          const isEdge = i === wordIdx[0] || i === wordIdx[wordIdx.length - 1];
          if (!isEdge && TITLE_SMALL_WORDS.has(letters.toLowerCase())) {
            return token.toLowerCase();
          }
          let seenLetter = false;
          return [...token]
            .map((ch) => {
              if (!isLetter(ch)) return ch;
              if (!seenLetter) {
                seenLetter = true;
                return ch.toUpperCase();
              }
              return ch.toLowerCase();
            })
            .join("");
        })
        .join("");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// replace_text — Word-style find/replace over the scope
// ---------------------------------------------------------------------------

function replaceText(text: string, params: TextOpParams): TextOpResult {
  const find = params.find ?? "";
  const replace = params.replace ?? "";
  if (!find) throw new Error("replace_text requires a non-empty find string");
  if (/[\n\r]/.test(find) || /[\r]/.test(replace)) {
    throw new Error("replace_text find/replace must not span paragraphs");
  }
  const matchCase = params.match_case === true;
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  const notes: TextOpNote[] = [];
  const starts: number[] = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    if (params.whole_word === true) {
      const before = text[at - 1];
      const after = text[at + find.length];
      if ((before && isWordChar(before)) || (after && isWordChar(after))) {
        continue;
      }
    }
    starts.push(at);
  }
  const wanted =
    typeof params.occurrence === "number"
      ? starts.filter((_, i) => i + 1 === params.occurrence)
      : starts;
  if (typeof params.occurrence === "number" && !wanted.length && starts.length) {
    note(notes, find, `occurrence ${params.occurrence} not found (${starts.length} matches)`);
  }
  let out = "";
  let cursor = 0;
  for (const at of wanted) {
    if (at < cursor) {
      note(notes, text.slice(at, at + find.length), "overlaps a previous replacement");
      continue;
    }
    out += text.slice(cursor, at) + replace;
    cursor = at + find.length;
  }
  out += text.slice(cursor);
  return { text: out, notes };
}

// ---------------------------------------------------------------------------
// sentence_spacing — one or two spaces after sentence-ending punctuation
// ---------------------------------------------------------------------------

/** Abbreviations that end with a period but do not end a sentence. */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "v", "vs", "s", "ss", "no", "nos", "para", "paras", "art", "arts", "sec",
  "secs", "cl", "ch", "pt", "fn", "n", "p", "pp", "cf", "id", "ibid", "etc",
  "e.g", "i.e", "seq", "supra", "infra", "ed", "rev", "op", "loc", "st",
  "dr", "mr", "mrs", "ms", "prof", "hon", "jr", "sr", "inc", "ltd", "corp",
  "co", "llc", "llp", "dept", "div", "reg", "stat", "misc", "approx",
]);

function sentenceSpacing(text: string, params: TextOpParams): TextOpResult {
  const style = params.style === "two" ? "  " : " ";
  if (params.style !== "one" && params.style !== "two") {
    throw new Error('sentence_spacing requires style "one" or "two"');
  }
  const notes: TextOpNote[] = [];
  const re = /([\p{L}\p{N}])([.!?…])(["'”’)\]]*)( {1,4})(?=["“'‘(\[]?\p{Lu})/gu;
  return {
    text: text.replace(re, (full, lastChar: string, term: string, closers: string, spaces: string, offset: number) => {
      const before = text.slice(Math.max(0, offset - 12), offset + 1);
      const wordMatch = before.match(/([\p{L}.]+)$/u);
      const word = (wordMatch?.[1] ?? "").replace(/\.$/u, "").toLowerCase();
      const skip =
        term === "." &&
        (/\p{N}/u.test(lastChar) ||
          (lastChar.length === 1 &&
            /\p{Lu}/u.test(lastChar) &&
            (word.length === 1 || /^(?:[a-z]\.)+[a-z]?$/u.test(word))) ||
          NON_TERMINAL_ABBREVIATIONS.has(word));
      if (skip) {
        if (spaces !== style) {
          note(notes, before.trimStart(), "possible abbreviation or citation — spacing left unchanged");
        }
        return full;
      }
      return `${lastChar}${term}${closers}${style}`;
    }),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Typographic ops
// ---------------------------------------------------------------------------

const straightenQuotes = (text: string) =>
  text.replace(/[“”„‟]/gu, '"').replace(/[‘’‚‛]/gu, "'");

/** Elided words that start with an apostrophe, not an opening quote. */
const APOSTROPHE_ELISIONS = new Set([
  "tis", "twas", "twere", "em", "cause", "til", "till", "n",
]);

function curlQuotes(text: string): TextOpResult {
  const notes: TextOpNote[] = [];
  const chars = [...text];
  const out = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch !== '"' && ch !== "'") continue;
    const prev = chars[i - 1] ?? "";
    const next = chars[i + 1] ?? "";
    const context = text.slice(Math.max(0, i - 12), i + 12);
    if (/\p{N}/u.test(prev)) {
      note(notes, context, "quote after a digit may be a measurement — left unchanged");
      continue;
    }
    const opensHere = prev === "" || /[\s\n([{—–-]/u.test(prev);
    if (ch === '"') {
      out[i] = opensHere ? "“" : "”";
      continue;
    }
    if (/\p{L}/u.test(prev)) {
      out[i] = "’"; // contraction or possessive
      continue;
    }
    if (/\p{N}/u.test(next)) {
      out[i] = "’"; // decade abbreviation like '90s
      continue;
    }
    if (opensHere && /\p{L}/u.test(next)) {
      const wordMatch = text.slice(i + 1).match(/^\p{L}+/u);
      if (wordMatch && APOSTROPHE_ELISIONS.has(wordMatch[0].toLowerCase())) {
        out[i] = "’";
        continue;
      }
      const rest = text.slice(i + 1, text.indexOf("\n", i) < 0 ? undefined : text.indexOf("\n", i));
      if (rest.includes("'")) {
        out[i] = "‘";
        continue;
      }
      note(notes, context, "apostrophe or opening quote is ambiguous — left unchanged");
      continue;
    }
    out[i] = opensHere ? "‘" : "’";
  }
  return { text: out.join(""), notes };
}

/** Runs of 2+ spaces collapse to one, except leading line indentation. */
const collapseDoubleSpaces = (text: string) =>
  text.replace(/(^ *)|( {2,})/gm, (_, indent: string | undefined) =>
    indent !== undefined ? indent : " ",
  );

function normalizeDashes(text: string): TextOpResult {
  const notes: TextOpNote[] = [];
  const withRanges = text.replace(
    /(?<![\p{L}\p{N}.-])(\d{1,4})-(\d{1,4})(?![\p{L}\p{N}.-])/gu,
    (full, a: string, b: string) => {
      if (parseInt(a, 10) < parseInt(b, 10)) return `${a}–${b}`;
      note(notes, full, "hyphenated numbers are not an ascending range — left unchanged");
      return full;
    },
  );
  const out = withRanges
    .replace(/(\S) -{1,2} (?=\S)/gu, "$1—")
    .replace(/(\S)--(?=\S)/gu, "$1—");
  return { text: out, notes };
}

/** style "character" (default): "..." -> "…" ; style "periods": "…" -> "..." */
function normalizeEllipses(text: string, params: TextOpParams) {
  const style = params.style ?? "character";
  if (style === "periods") return text.replace(/…/gu, "...");
  if (style !== "character") {
    throw new Error('normalize_ellipses style must be "character" or "periods"');
  }
  return text.replace(/(?<!\.)\.{3}(?!\.)/gu, "…");
}

/** Ordinary space between s./ss./§/¶ and a following number becomes NBSP. */
const nonbreakingSectionRefs = (text: string) =>
  text.replace(/(§§?|¶¶?|\bss?\.) (?=\d)/gu, "$1 ");

const removeTrailingWhitespace = (text: string) =>
  text.replace(/[ \t]+(?=\n|$)/gu, "");

// ---------------------------------------------------------------------------
// check_spelling — flag-only dictionary review (never mutates)
// ---------------------------------------------------------------------------

/** Common legal/drafting terms missing from both hunspell dictionaries. */
const LEGAL_SUPPLEMENT = [
  "arguendo", "assignee", "assignor", "bailee", "bailor", "chattel",
  "choate", "covenantor", "covenantee", "delegee", "disseisin", "emolument",
  "estop", "estoppel", "garnishee", "garnishor", "gravamen", "hereinabove",
  "hereinbelow", "indemnitee", "indemnitor", "indemnitors", "indemnitees",
  "laches", "mortgagee", "mortgagor", "novation", "obligee", "obligor",
  "offeree", "offeror", "pled", "promisee", "promisor", "recoupment",
  "remittitur", "replevin", "subrogee", "subrogor", "sublessee", "sublessor",
  "testatrix", "tortfeasor", "tortfeasors", "usufruct", "curtilage",
  "interpleader", "remand", "remanded", "affiant", "declarant",
  "tortious", "tortiously", "justiciable", "justiciability",
  "Blackacre", "Whiteacre", "Greenacre",
  // Canadian/British legal spellings absent from both dictionaries.
  "judgement", "judgements", "analyse", "analysed", "analysing", "analyses",
  "fulfil", "fulfils", "fulfilling", "fulfilment", "instalment",
  "instalments", "enrol", "enrolment", "wilful", "wilfully", "skilful",
  // Latin terms of art common in legal prose.
  "bona", "fide", "fides", "mala", "prima", "facie", "alia", "alios",
  "judicata", "sui", "generis", "vires", "mens", "rea", "actus", "reus",
  "decidendi", "obiter", "dicta", "dictum", "certiorari", "mandamus",
  "habeas", "proferentem", "meruit", "ejusdem", "delicto", "pendens",
  "curiae", "novo", "banc", "forma", "pauperis", "subpoena", "duces",
  "tecum", "voir", "dire",
];

type Speller = {
  correct: (word: string) => boolean;
  suggest: (word: string) => string[];
};

let spellerPromise: Promise<Speller> | null = null;

type DictionaryModule = { default: { aff: unknown; dic: unknown } };

const SPELLING_DICTIONARY_PACKAGES: Record<string, string> = {
  "en-ca": "dictionary-en-ca",
  "en-us": "dictionary-en",
};

/**
 * Canadian English is the default and only dictionary. The single override
 * mechanism is the BEAVER_SPELLING_DICTIONARY env var: a comma-separated
 * list of codes ("en-US", or "en-CA,en-US" to add en-US alongside).
 * Unknown codes are ignored; an empty result falls back to en-CA.
 */
export function configuredSpellingDictionaries(
  raw = process.env.BEAVER_SPELLING_DICTIONARY,
): string[] {
  const codes = [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((code) => code.trim().toLowerCase())
        .filter((code) => code in SPELLING_DICTIONARY_PACKAGES),
    ),
  ];
  return codes.length ? codes : ["en-ca"];
}

/**
 * The wooorm dictionaries are ESM-only with top-level await, so the
 * transpiled-CJS runtime cannot `require()` them. Try a plain dynamic import
 * first (vitest / native ESM keep it a real import); fall back to a
 * constructed import that survives TypeScript's CommonJS downleveling.
 */
async function importDictionary(specifier: string): Promise<DictionaryModule> {
  try {
    return (await import(specifier)) as DictionaryModule;
  } catch {
    const importEsm = new Function("s", "return import(s)") as (
      s: string,
    ) => Promise<DictionaryModule>;
    return importEsm(specifier);
  }
}

/** A word accepted by ANY configured dictionary is never flagged;
 *  suggestions come from the first configured dictionary that has some. */
function loadSpeller(): Promise<Speller> {
  spellerPromise ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nspell = require("nspell") as (dict: unknown) => Speller & {
      add: (word: string) => unknown;
    };
    const spellers = await Promise.all(
      configuredSpellingDictionaries().map(async (code) => {
        const dictionary = await importDictionary(
          SPELLING_DICTIONARY_PACKAGES[code],
        );
        const speller = nspell(dictionary.default);
        for (const word of LEGAL_SUPPLEMENT) speller.add(word);
        return speller;
      }),
    );
    return {
      correct: (word) => spellers.some((speller) => speller.correct(word)),
      suggest: (word) => {
        for (const speller of spellers) {
          const suggestions = speller.suggest(word);
          if (suggestions.length) return suggestions;
        }
        return [];
      },
    };
  })();
  return spellerPromise;
}

const CITATION_NEIGHBOR =
  /^(?:v|vs|s|ss|no|nos|para|paras|art|arts|sec|secs|cl|cf|id|ibid|supra|infra|et|al|seq|c)$/iu;

/** Character ranges lying inside double-quoted spans (straight or curly). */
function quotedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /"[^"\n]*"|“[^“”\n]*”/gu;
  for (const match of text.matchAll(re)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * FLAG-ONLY spelling review: the document text is NEVER changed by this op.
 * Possible misspellings are reported with their surrounding context and top
 * dictionary suggestions (bounded list); an actual correction happens only
 * when the model or user explicitly issues replace_text for that word.
 */
async function checkSpelling(text: string): Promise<TextOpResult> {
  const speller = await loadSpeller();
  const notes: TextOpNote[] = [];
  const quoted = quotedRanges(text);
  const inQuotes = (at: number) => quoted.some(([a, b]) => at >= a && at < b);
  for (const match of text.matchAll(/[\p{L}][\p{L}'’]*/gu)) {
    const word = match[0];
    const at = match.index;
    const preceding = text.slice(Math.max(0, at - 24), at);
    const following = text.slice(at + word.length, at + word.length + 24);
    const core = word.replace(/’/gu, "'").replace(/'s$|'$/iu, "");
    if (core.length < 3) continue; // too short to judge — never flag
    if (/\p{N}/u.test(preceding.slice(-2)) || /^\s*\p{N}/u.test(following)) {
      continue; // digit-adjacent: citation-like — out of scope
    }
    if (inQuotes(at)) continue; // quoted text is out of scope
    if (core === core.toUpperCase() && core.length >= 2) continue; // acronym
    if (core.slice(1) !== core.slice(1).toLowerCase()) continue; // mixed case
    const prevToken = preceding.match(/([\p{L}§¶.]+)\s*$/u)?.[1] ?? "";
    const nextToken = following.match(/^\s*([\p{L}§¶]+)/u)?.[1] ?? "";
    if (
      CITATION_NEIGHBOR.test(prevToken.replace(/\.$/u, "")) ||
      CITATION_NEIGHBOR.test(nextToken) ||
      /[§¶]/u.test(prevToken) ||
      /[§¶]/u.test(nextToken)
    ) {
      continue; // citation neighborhood — out of scope
    }
    if (speller.correct(core) || speller.correct(core.toLowerCase())) continue;
    const context = `${preceding}${word}${following}`.trim();
    if (/^\p{Lu}/u.test(core)) {
      // Proper-noun shaped: report without suggestions — a party name must
      // never be presented next to a lookalike (Hansman is not Hangman).
      note(notes, word, "possible proper noun — verify manually", { context });
      continue;
    }
    note(notes, word, "possible misspelling", {
      context,
      suggestions: speller.suggest(core).slice(0, 3),
    });
  }
  return { text, notes };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TEXT_OPS: Record<string, OpFn> = {
  uppercase: (text) => text.toUpperCase(),
  lowercase: (text) => text.toLowerCase(),
  sentence_case: sentenceCase,
  capitalize_each_word: capitalizeEachWord,
  toggle_case: toggleCase,
  title_case: titleCase,
  replace_text: replaceText,
  sentence_spacing: sentenceSpacing,
  check_spelling: checkSpelling,
  straighten_quotes: straightenQuotes,
  curl_quotes: curlQuotes,
  collapse_double_spaces: collapseDoubleSpaces,
  normalize_dashes: normalizeDashes,
  normalize_ellipses: normalizeEllipses,
  nonbreaking_section_refs: nonbreakingSectionRefs,
  remove_trailing_whitespace: removeTrailingWhitespace,
};

export const TEXT_OP_NAMES = Object.keys(TEXT_OPS);

export async function runTextOp(
  op: string,
  text: string,
  params: TextOpParams = {},
): Promise<TextOpResult> {
  const fn = TEXT_OPS[op];
  if (!fn) throw new Error(`Unknown text op: ${op}`);
  const result = await fn(text, params);
  const normalized =
    typeof result === "string" ? { text: result, notes: [] } : result;
  if (
    normalized.text.split("\n").length !== text.split("\n").length
  ) {
    throw new Error(`Text op ${op} altered paragraph boundaries`);
  }
  return normalized;
}
