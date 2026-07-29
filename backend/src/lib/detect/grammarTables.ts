// Cross-runtime grammar tables: one authored pattern, two runtimes, zero
// drift. The contract that makes it safe: Python compiles every pattern
// with re.ASCII and JS compiles WITHOUT the u flag, which pins \d \w \s
// and \b to identical ASCII semantics on both sides. The validator bans
// the constructs whose semantics genuinely diverge; everything else is
// ordinary regex. Named groups are authored JS-style ((?<name>…)); the
// Python loader translates to (?P<name>…).

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
  entries: GrammarEntry[];
}

export const GRAMMAR_TABLE_FORMAT = "beaver-grammar-table:v1";

/**
 * Reject constructs whose behavior differs between Python re (with
 * re.ASCII) and JS RegExp (without u). Returns violation strings; empty
 * means the pattern is inside the shared dialect.
 */
export function validateGrammarPattern(source: string): string[] {
  const violations: string[] = [];
  if (/\(\?P/.test(source)) {
    violations.push("(?P named-group syntax: author JS-style (?<name>…)");
  }
  if (/\(\?<[=!]/.test(source)) {
    violations.push("lookbehind: banned (arbitrary-width only in JS)");
  }
  if (/\\[pP]\{/.test(source)) {
    violations.push("\\p{…} classes: Python re has no support");
  }
  for (const match of source.matchAll(/\(\?([a-zA-Z-]+)[:)]/g)) {
    violations.push(`inline flags (?${match[1]}…: banned; use table flags`);
  }
  if (/\(\?\(/.test(source)) {
    violations.push("conditional groups: not portable");
  }
  if (/\\u(?!00[0-7][0-9a-fA-F])[0-9a-fA-F]{4}/.test(source)) {
    violations.push(
      "non-ASCII \\uXXXX escape inside a pattern: write the literal character (Python re reads \\u only in strings, and JSON decoding already resolves it)",
    );
  }
  return violations;
}

export function validateGrammarEntry(entry: GrammarEntry): string[] {
  const violations = validateGrammarPattern(entry.pattern).map(
    (violation) => `${entry.id}: ${violation}`,
  );
  if (!/^[ims]*$/.test(entry.flags)) {
    violations.push(`${entry.id}: flags must be a subset of "ims"`);
  }
  return violations;
}

/** Compile for JS: source verbatim, global added for iteration, never u. */
export function compileGrammarEntry(entry: GrammarEntry): RegExp {
  return new RegExp(entry.pattern, `${entry.flags}g`);
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
    for (const violation of validateGrammarEntry(entry)) {
      failures.push({ id: entry.id, input: "", reason: violation });
    }
    let re: RegExp;
    try {
      re = compileGrammarEntry(entry);
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
