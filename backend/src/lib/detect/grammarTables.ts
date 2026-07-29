// Cross-runtime grammar tables: one authored pattern, two runtimes, zero
// drift. The contract that makes it safe: Python compiles every pattern
// with re.ASCII and JS compiles WITHOUT the u flag, which pins \d \w and
// \b to identical ASCII semantics on both sides. \s is the measured
// exception — JS \s is Unicode-ish (NBSP yes, FEFF yes) in every mode
// while Python re.ASCII \s is ASCII-only, and the SOURCE grammars were
// compiled under Python's Unicode \s (NBSP yes, FS yes, FEFF no) — so
// both loaders expand \s/\S to that explicit source whitespace class at
// compile time. The validator bans the constructs whose semantics
// genuinely diverge; everything else is ordinary regex. Named groups are
// authored JS-style ((?<name>…)); the Python loader translates to
// (?P<name>…). Lookbehind is allowed because Python only compiles the
// fixed-width form and the mandatory dual-runtime vector check therefore
// rejects any table Python cannot hold — the gate is structural, not
// syntactic. A table may carry `defs`, named pattern fragments spliced
// in via {{name}} before validation and compilation, mirroring how the
// source grammars compose rf-strings.

export interface GrammarVector {
  input: string;
  /** Expected named-group captures of the FIRST match; null = must not match. */
  groups: Record<string, string> | null;
  /** Optional expected canonicalized values (subset of groups). */
  canonical?: Record<string, string>;
}

export interface GrammarCanonical {
  lowercase?: string[];
  map?: Record<string, Record<string, string>>;
  strip?: Record<string, string>;
}

export interface GrammarEntry {
  id: string;
  pattern: string;
  /** Subset of "ims". */
  flags: string;
  canonical: GrammarCanonical;
  vectors: GrammarVector[];
}

export interface GrammarTable {
  format: string;
  description?: string;
  /** Named pattern fragments, spliced into patterns via {{name}}. */
  defs?: Record<string, string>;
  entries: GrammarEntry[];
}

export const GRAMMAR_TABLE_FORMAT = "beaver-grammar-table:v1";

/**
 * Splice {{name}} references to table defs into a pattern. Runs to a
 * fixpoint so defs may reference other defs; throws on an unknown name
 * or a reference cycle. Must stay byte-equivalent with the Python
 * loader's expansion.
 */
export function expandGrammarPattern(
  source: string,
  defs: Record<string, string> = {},
): string {
  let out = source;
  for (let pass = 0; ; pass += 1) {
    const next = out.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => {
      const value = defs[name];
      if (value === undefined) {
        throw new Error(`grammar def {{${name}}} is not defined`);
      }
      return value;
    });
    if (next === out) return out;
    if (pass >= 10) {
      throw new Error("grammar defs reference each other in a cycle");
    }
    out = next;
  }
}

/**
 * The whitespace set Python's Unicode \s matched when the source
 * grammars were battle-tested: ASCII whitespace + the C1/Unicode spaces
 * (NBSP, ogham, en/em spaces, line/para separators, narrow no-break,
 * math space, ideographic) + the \x1c-\x1f separators and \x85. NOT
 * ﻿ (JS-only). Both loaders expand \s/\S to this class so both
 * runtimes reproduce the source behavior exactly.
 */
const SOURCE_WHITESPACE =
  " \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/**
 * Expand \s and \S to the explicit source whitespace class, walking the
 * pattern so escapes and character-class state are respected. \S inside
 * a character class cannot be expressed as a class fragment and throws.
 * Must stay behavior-identical with the Python loader's expansion.
 */
export function expandWhitespaceEscapes(source: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      const next = source[i + 1];
      if (next === "s") {
        out += inClass ? SOURCE_WHITESPACE : `[${SOURCE_WHITESPACE}]`;
        i += 1;
        continue;
      }
      if (next === "S") {
        if (inClass) {
          throw new Error(
            "\\S inside a character class cannot be expanded portably",
          );
        }
        out += `[^${SOURCE_WHITESPACE}]`;
        i += 1;
        continue;
      }
      out += ch + next;
      i += 1;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    out += ch;
  }
  return out;
}

/**
 * Reject constructs whose behavior differs between Python re (with
 * re.ASCII) and JS RegExp (without u). Returns violation strings; empty
 * means the pattern is inside the shared dialect. Lookbehind passes here
 * deliberately: Python re only compiles fixed-width lookbehind, where JS
 * semantics coincide, and the dual-runtime vector check rejects any
 * table Python cannot compile. \uXXXX escapes pass because both engines
 * read them identically in patterns (measured, not assumed); only the
 * braced JS-only \u{…} form is banned.
 */
export function validateGrammarPattern(source: string): string[] {
  const violations: string[] = [];
  if (/\(\?P/.test(source)) {
    violations.push("(?P named-group syntax: author JS-style (?<name>…)");
  }
  if (/\\[pP]\{/.test(source)) {
    violations.push("\\p{…} classes: Python re has no support");
  }
  for (const match of source.matchAll(/\(\?([a-zA-Z-]+)[:)]/g)) {
    violations.push(`inline flags (?${match[1]}…: banned; use table flags`);
  }
  if (/(?:^|[^\\])\(\?\(/.test(source)) {
    // An escaped \(? followed by a group reads as "(?(" to a substring
    // scan; require the opening paren to be unescaped. A conditional that
    // slips past this still fails JS compilation in the vector run.
    violations.push("conditional groups: not portable");
  }
  if (/\\u\{/.test(source)) {
    violations.push(
      "braced \\u{…} escape: JS-only (needs the u flag); use \\uXXXX or the literal character",
    );
  }
  return violations;
}

export function validateGrammarEntry(
  entry: GrammarEntry,
  defs: Record<string, string> = {},
): string[] {
  let expanded: string;
  try {
    expanded = expandGrammarPattern(entry.pattern, defs);
  } catch (error) {
    return [`${entry.id}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const violations = validateGrammarPattern(expanded).map(
    (violation) => `${entry.id}: ${violation}`,
  );
  if (!/^[ims]*$/.test(entry.flags)) {
    violations.push(`${entry.id}: flags must be a subset of "ims"`);
  }
  return violations;
}

/** Compile for JS: defs and \s expanded, global added, never u. */
export function compileGrammarEntry(
  entry: GrammarEntry,
  defs: Record<string, string> = {},
): RegExp {
  return new RegExp(
    expandWhitespaceEscapes(expandGrammarPattern(entry.pattern, defs)),
    `${entry.flags}g`,
  );
}

export function canonicalizeGroups(
  groups: Record<string, string>,
  rules: GrammarCanonical,
): Record<string, string> {
  const out: Record<string, string> = { ...groups };
  for (const name of rules.lowercase ?? []) {
    if (out[name] !== undefined) out[name] = out[name].toLowerCase();
  }
  for (const [name, chars] of Object.entries(rules.strip ?? {})) {
    if (out[name] !== undefined) {
      out[name] = out[name]
        .split("")
        .filter((ch) => !chars.includes(ch))
        .join("");
    }
  }
  for (const [name, mapping] of Object.entries(rules.map ?? {})) {
    if (out[name] !== undefined && mapping[out[name]] !== undefined) {
      out[name] = mapping[out[name]];
    }
  }
  return out;
}

export interface VectorFailure {
  id: string;
  input: string;
  reason: string;
}

/** Run every vector of every entry; empty result = the table holds. */
export function runGrammarVectors(table: GrammarTable): VectorFailure[] {
  const failures: VectorFailure[] = [];
  for (const entry of table.entries) {
    for (const violation of validateGrammarEntry(entry, table.defs)) {
      failures.push({ id: entry.id, input: "", reason: violation });
    }
    let re: RegExp;
    try {
      re = compileGrammarEntry(entry, table.defs);
    } catch (error) {
      failures.push({
        id: entry.id,
        input: "",
        reason: `does not compile in JS: ${String(error)}`,
      });
      continue;
    }
    for (const vector of entry.vectors) {
      re.lastIndex = 0;
      const match = re.exec(vector.input);
      if (vector.groups === null) {
        if (match) {
          failures.push({
            id: entry.id,
            input: vector.input,
            reason: `expected no match, got "${match[0]}"`,
          });
        }
        continue;
      }
      if (!match) {
        failures.push({
          id: entry.id,
          input: vector.input,
          reason: "expected a match, got none",
        });
        continue;
      }
      const got = { ...(match.groups ?? {}) };
      for (const [name, expected] of Object.entries(vector.groups)) {
        if (got[name] !== expected) {
          failures.push({
            id: entry.id,
            input: vector.input,
            reason: `group ${name}: expected "${expected}", got "${got[name]}"`,
          });
        }
      }
      if (vector.canonical) {
        const canon = canonicalizeGroups(
          got as Record<string, string>,
          entry.canonical,
        );
        for (const [name, expected] of Object.entries(vector.canonical)) {
          if (canon[name] !== expected) {
            failures.push({
              id: entry.id,
              input: vector.input,
              reason: `canonical ${name}: expected "${expected}", got "${canon[name]}"`,
            });
          }
        }
      }
    }
  }
  return failures;
}
