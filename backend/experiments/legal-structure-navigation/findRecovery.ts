import { findTextMatches, type TextMatch } from "../../src/lib/chat/tools/documentOps";

export function foldFindPlane(text: string): {
  folded: string;
  rawIdx: number[];
} {
  const folded: string[] = [];
  const rawIdx: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "*") continue;
    if (
      ch === "\\" &&
      i + 1 < text.length &&
      /[!-/:-@[-`{-~]/.test(text[i + 1])
    ) {
      continue;
    }
    let out = ch;
    if (ch === "“" || ch === "”") out = '"';
    else if (ch === "‘" || ch === "’") out = "'";
    folded.push(out);
    rawIdx.push(i);
  }
  return { folded: folded.join(""), rawIdx };
}

/**
 * Literal-first folded find: byte-identical to findTextMatches whenever the
 * literal pass hits; only a zero-hit literal pass runs the folded plane, and
 * folded hits are re-anchored to RAW offsets (excerpt/context rebuilt from the
 * raw text) so `at` stays composable with read_document offset windows.
 */
export function findTextMatchesFolded(params: {
  text: string;
  query: string;
  maxResults: number;
  contextChars: number;
  startIndex?: number;
}): { hits: TextMatch[]; totalMatches: number; matchMode: "literal" | "folded" } {
  const literal = findTextMatches(params);
  if (literal.totalMatches > 0) return { ...literal, matchMode: "literal" };
  const { folded, rawIdx } = foldFindPlane(params.text);
  const foldedQuery = foldFindPlane(params.query).folded;
  const foldedRun = findTextMatches({
    ...params,
    text: folded,
    query: foldedQuery,
  });
  if (foldedRun.totalMatches === 0) return { ...literal, matchMode: "literal" };
  const hits = foldedRun.hits.map((hit) => {
    const at = rawIdx[Math.min(hit.at, rawIdx.length - 1)] ?? 0;
    const rawEnd =
      rawIdx[
        Math.min(hit.at + Math.max(1, hit.excerpt.length) - 1, rawIdx.length - 1)
      ] ?? at;
    const ctxStart = Math.max(0, at - params.contextChars);
    const ctxEnd = Math.min(params.text.length, rawEnd + 1 + params.contextChars);
    return {
      index: hit.index,
      excerpt: params.text.slice(at, rawEnd + 1),
      context:
        (ctxStart > 0 ? "…" : "") +
        params.text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
        (ctxEnd < params.text.length ? "…" : ""),
      at,
    };
  });
  return { hits, totalMatches: foldedRun.totalMatches, matchMode: "folded" };
}

export function findRegexMatches(params: {
  text: string;
  pattern: string;
  maxResults: number;
  contextChars: number;
  caseInsensitive?: boolean;
}): { hits: TextMatch[]; totalMatches: number } | { error: string } {
  const { text, pattern, maxResults, contextChars } = params;
  if (pattern.length > 300) {
    return { error: "regex pattern too long (max 300 chars)" };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, params.caseInsensitive ? "giu" : "gu");
  } catch (error) {
    return { error: `invalid regex: ${(error as Error).message}` };
  }
  const hits: TextMatch[] = [];
  let totalMatches = 0;
  let lineStart = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    for (const match of line.matchAll(re)) {
      if (!match[0]) continue;
      totalMatches++;
      if (hits.length < maxResults) {
        const at = lineStart + (match.index ?? 0);
        const end = at + match[0].length;
        const ctxStart = Math.max(0, at - contextChars);
        const ctxEnd = Math.min(text.length, end + contextChars);
        hits.push({
          index: hits.length,
          excerpt: text.slice(at, end),
          context:
            (ctxStart > 0 ? "…" : "") +
            text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
            (ctxEnd < text.length ? "…" : ""),
          at,
        });
      }
    }
    lineStart += rawLine.length + 1;
  }
  return { hits, totalMatches };
}
