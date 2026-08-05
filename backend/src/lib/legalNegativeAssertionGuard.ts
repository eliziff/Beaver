/**
 * Asserted-negative guard — a deterministic post-draft check for scoped reads.
 *
 * Measured failure mode (Harvey-LAB Phase C, `banking/mike_markdown_e2e_index_v1`,
 * criteria C-011/C-012): a run that read Section 7.05 but never served
 * Section 2.05 wrote
 *
 *   "The 365-day reinvestment period in Section 7.05(d) is consistent with the
 *    asset sale mandatory prepayment provisions in Section 2.05(b). No
 *    inconsistency identified between the two provisions."
 *
 * Section 2.05(b) states 180 days. The conflict is real; the deliverable
 * asserted its ABSENCE about a region the run had never seen. That is strictly
 * worse than silence: an omission is a gap, an asserted negative is a false
 * statement a reader will rely on. Across the 21-cell grid, 29 cross-references
 * were asserted over never-served targets and every one of them sits in a
 * scoped arm; whole-read arms score zero on this measure by construction.
 *
 * What this module does: find negative assertions in a deliverable, resolve the
 * provision anchors they cite or implicate against the run's served-span map,
 * and report the ones whose cited region was never served.
 *
 * What it deliberately does NOT do:
 *  - guess coordinates. An anchor that no served document's section spine
 *    carries resolves to `unresolvable`, never to a nearest-neighbour offset.
 *  - fire on ambiguity. A label carried by two documents where at least one
 *    side was served resolves to `ambiguous` and is not actionable: the model
 *    may well have read the one that matters.
 *  - judge truth. "No inconsistency" over a fully served region is a claim this
 *    module has nothing to say about; only the exposure predicate is decided
 *    here, and residual semantics stay with the model over the bounded excerpt.
 *
 * Consumers only: nothing here is wired into a read path or a detector. The
 * intended shape is a post-draft gate that hands the model back its own
 * sentence plus the exposure fact, so it can read the region or withdraw the
 * claim.
 */
import { findProvisionReferences } from "./legalReferenceGrammar";

export type NegativeFamily =
  /** "no inconsistency identified", "no conflict between" */
  | "no_conflict"
  /** "there is no provision", "nothing in Section 4 requires" */
  | "absence_of_provision"
  /** "does not address", "do not contain" */
  | "does_not"
  /** "is silent on", "silent as to" */
  | "silent"
  /** "never references", "makes no mention of", "fails to define" */
  | "no_reference"
  /** "is consistent with", "mirrors", "aligns with" — asserts no conflict */
  | "consistency";

export interface ServedSpan {
  start: number;
  end: number;
}

/** One addressable section of one served document, on the SERVED BODY plane. */
export interface SectionAnchor {
  /** document key — filename is what deliverables cite by */
  document: string;
  /** display as the document's own numbering states it: "Section 2.05(b)" */
  display: string;
  /** body-plane char offset where the section begins */
  start: number;
  /** body-plane char offset where the section ends (exclusive) */
  end: number;
}

export interface ServedDocument {
  document: string;
  /** length of the served body plane for this document */
  bodyChars: number;
  /** unioned served intervals on that plane; empty means nothing was served */
  spans: ServedSpan[];
  /** the document's section spine, addressable; may be empty (no structure) */
  anchors: SectionAnchor[];
}

export interface ResolvedAnchor {
  document: string;
  display: string;
  start: number;
  end: number;
  /** fraction of [start,end) covered by the served spans */
  servedFraction: number;
  /** exact label match, or resolved through the parent of a sub-clause */
  via: "exact" | "parent";
}

export type CitationResolution =
  | { status: "unserved"; anchor: ResolvedAnchor }
  | { status: "partially-served"; anchor: ResolvedAnchor }
  | { status: "served"; anchor: ResolvedAnchor }
  | { status: "ambiguous"; candidates: ResolvedAnchor[] }
  | {
      status: "unresolvable";
      reason: "no-matching-anchor" | "no-addressable-structure";
    };

export interface NegativeCitation {
  /** the reference exactly as the deliverable wrote it */
  raw: string;
  /** whitespace-compacted label: "2.05(b)", "VII" */
  label: string;
  /** provision word, singular: "section", "article" */
  word: string;
  /** where the reference was found relative to the trigger */
  scope: "trigger-sentence" | "claim-unit";
  resolution: CitationResolution;
}

export type NegativeVerdict =
  /** at least one cited anchor was NEVER served — the actionable case */
  | "unserved-anchor"
  /** every cited anchor resolved, at least one only partially served */
  | "partially-served-anchor"
  /** every cited anchor resolved and was served — nothing to say */
  | "served-anchor"
  /** the assertion cites an anchor no served document carries */
  | "unresolvable-anchor"
  /** the assertion cites nothing addressable (a claim about the world) */
  | "no-anchor";

export interface NegativeAssertionFinding {
  family: NegativeFamily;
  /** the matched trigger text, as written */
  trigger: string;
  /** char offset of the trigger in the deliverable */
  triggerAt: number;
  /** the sentence carrying the trigger, plus any backward claim unit used */
  excerpt: string;
  citations: NegativeCitation[];
  verdict: NegativeVerdict;
}

export interface GuardOptions {
  /**
   * How far back from the trigger sentence a citation may sit and still be
   * treated as the subject of the negative. Needed because the sharpest form
   * of the defect splits the two: "…Section 7.05(d) is consistent with …
   * Section 2.05(b). No inconsistency identified between the two provisions."
   * Bounded, and never crosses a blank line (a paragraph boundary).
   */
  claimUnitBackChars: number;
  /** A section is "served" at or above this covered fraction. */
  servedFractionMin: number;
  /** Cap on findings returned, newest-suppressed. 0 = uncapped. */
  maxFindings: number;
}

export const DEFAULT_GUARD_OPTIONS: GuardOptions = {
  claimUnitBackChars: 400,
  servedFractionMin: 0.5,
  maxFindings: 0,
};

/* ------------------------------------------------------------------ */
/* Trigger grammar                                                     */
/* ------------------------------------------------------------------ */

const NEGATED_NOUN =
  "inconsistenc(?:y|ies)|conflicts?|discrepanc(?:y|ies)|contradictions?|ambiguit(?:y|ies)|tensions?|mismatch(?:es)?|disagreements?|divergences?";
const ASSERTION_VERB =
  "identified|found|noted|observed|detected|exists?|arises?|appears?|apparent|present|between|among|with\\s+respect|in\\s+the|here";

const ABSENT_NOUN =
  "provisions?|clauses?|sections?|articles?|language|requirements?|obligations?|carve-?outs?|exceptions?|definitions?|limitations?|caps?|references?|restrictions?|conditions?|deadlines?|remed(?:y|ies)";

const DOES_NOT_VERB =
  "address(?:es)?|contains?|includes?|requires?|provides?|specif(?:y|ies)|defines?|imposes?|limits?|restricts?|mentions?|references?|refers?|states?|prohibits?|permits?|allows?|covers?|extends?|applies|appear|obligate|entitle";

const TRIGGERS: Array<{ family: NegativeFamily; re: RegExp }> = [
  {
    family: "no_conflict",
    re: new RegExp(
      String.raw`\bno\s+(?:material\s+|apparent\s+|actual\s+|direct\s+|obvious\s+|internal\s+)?(?:${NEGATED_NOUN})\b(?:[^.;\n]{0,60}?\b(?:${ASSERTION_VERB})\b)?`,
      "giu",
    ),
  },
  {
    family: "absence_of_provision",
    re: new RegExp(
      String.raw`\b(?:there\s+(?:is|are|was|were)\s+no\b|nothing\s+in\b|no\s+(?:such\s+)?(?:${ABSENT_NOUN})\b\s*(?:${ASSERTION_VERB}|(?:that|which|to)\b))`,
      "giu",
    ),
  },
  {
    family: "does_not",
    re: new RegExp(
      String.raw`\b(?:does|do|did|shall|will|would)\s+not\s+(?:expressly\s+|specifically\s+|otherwise\s+|actually\s+)?(?:${DOES_NOT_VERB})\b`,
      "giu",
    ),
  },
  {
    family: "silent",
    re: /\b(?:is|are|was|were|remains?|stays?)\s+(?:entirely\s+|wholly\s+|completely\s+|notably\s+)?silent\b|\bsilence\s+(?:of|in)\b/giu,
  },
  {
    family: "no_reference",
    re: /\b(?:never\s+(?:references?|mentions?|addresses(?:es)?|defines?|states?|identifies)|makes?\s+no\s+(?:reference|mention|provision)|fails?\s+to\s+(?:address|define|specify|include|contain|reference|mention|provide)|omits?\s+(?:any|all)\b|with\s+no\s+(?:reference|mention))/giu,
  },
  {
    family: "consistency",
    re: /\b(?:is|are|remains?|appears?\s+to\s+be|reads?\s+as)\s+(?:fully\s+|entirely\s+|generally\s+|broadly\s+|substantially\s+|otherwise\s+)?consistent\s+with\b|\b(?:mirrors?|tracks?|aligns?\s+with|matches)\s+(?:the\s+)?(?:section|article|clause|provision|language|terms?)\b/giu,
  },
];

/* ------------------------------------------------------------------ */
/* Sentence / claim-unit segmentation                                  */
/* ------------------------------------------------------------------ */

/** Start of the sentence containing `at`, bounded by a blank line. */
function sentenceStart(text: string, at: number): number {
  let i = at;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === "\n" && (text[i - 2] === "\n" || i - 2 < 0)) return i;
    if (
      (ch === "." || ch === "!" || ch === "?" || ch === ":") &&
      /\s/u.test(text[i] ?? " ")
    ) {
      return i;
    }
    i--;
  }
  return 0;
}

/** End of the sentence containing `at`, bounded by a blank line. */
function sentenceEnd(text: string, at: number): number {
  let i = at;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n" && text[i + 1] === "\n") return i;
    if (
      (ch === "." || ch === "!" || ch === "?") &&
      /\s|$/u.test(text[i + 1] ?? " ")
    ) {
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/** Backward claim unit: earlier sentences in the same paragraph, bounded. */
function claimUnitStart(
  text: string,
  sentStart: number,
  backChars: number,
): number {
  const floor = Math.max(0, sentStart - backChars);
  let i = sentStart;
  while (i > floor) {
    // never cross a blank line
    const nl = text.lastIndexOf("\n", i - 1);
    if (nl >= floor && text[nl - 1] === "\n") return Math.max(nl + 1, floor);
    const prev = sentenceStart(text, Math.max(0, i - 1));
    if (prev >= i) break;
    i = prev;
  }
  return Math.max(i, floor);
}

/* ------------------------------------------------------------------ */
/* Anchor resolution                                                   */
/* ------------------------------------------------------------------ */

const CONTAINER_WORD =
  /^(article|part|division|schedule|title|chapter|annex|appendix|exhibit)\b/iu;

/**
 * Is `inner` inside `outer` in the document's own numbering? Two shapes, both
 * read off the display alone:
 *  - "Section 2.02" contains "Section 2.02(a)" and "Section 2.02(b)(i)":
 *    the display extends with a bracketed enum;
 *  - "ARTICLE VII" contains every non-container display that follows it, up to
 *    the next container of the same word.
 * A citation to a section means the section INCLUDING its subsections, so the
 * exposure question has to be asked over the whole subtree — asking it over the
 * heading line alone would report a served heading as a served provision.
 */
function isDescendantDisplay(outer: string, inner: string): boolean {
  if (inner.startsWith(outer) && inner.slice(outer.length).trimStart().startsWith("(")) {
    return true;
  }
  const outerWord = outer.match(CONTAINER_WORD)?.[1]?.toLowerCase();
  if (!outerWord) return false;
  const innerWord = inner.match(CONTAINER_WORD)?.[1]?.toLowerCase();
  return innerWord !== outerWord;
}

/**
 * Build section ranges from a display/offset list: each entry runs to the next
 * entry that is NOT one of its descendants, and the last runs to `bodyChars`.
 * Entries without an offset are dropped by the caller (unaddressable -> never
 * guessed at).
 */
export function buildSectionAnchors(
  document: string,
  entries: Array<{ display: string; start: number }>,
  bodyChars: number,
): SectionAnchor[] {
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  return sorted.map((entry, i) => {
    let end = bodyChars;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start <= entry.start) continue;
      if (isDescendantDisplay(entry.display, sorted[j].display)) continue;
      end = sorted[j].start;
      break;
    }
    return { document, display: entry.display, start: entry.start, end };
  });
}

/** "Section 2.05(b)" / "§7.05(d)" / "ARTICLE VII" -> "section 2.05(b)". */
function anchorKey(word: string, label: string): string {
  return `${word.toLowerCase().replace(/s$/u, "")} ${label
    .replace(/\s+/gu, "")
    .toLowerCase()}`;
}

/** Drop one trailing "(x)" group: "2.05(b)(i)" -> "2.05(b)" -> "2.05". */
function parentLabel(label: string): string | null {
  const m = label.match(/^(.*?)\([^()]*\)\s*$/u);
  if (m && m[1]) return m[1];
  return null;
}

function coveredFraction(
  spans: ServedSpan[],
  start: number,
  end: number,
): number {
  const width = end - start;
  if (width <= 0) return 0;
  let covered = 0;
  for (const span of spans) {
    const lo = Math.max(span.start, start);
    const hi = Math.min(span.end, end);
    if (hi > lo) covered += hi - lo;
  }
  return covered / width;
}

interface AnchorIndex {
  byKey: Map<string, ResolvedAnchor[]>;
  addressable: boolean;
}

function buildAnchorIndex(served: ServedDocument[]): AnchorIndex {
  const byKey = new Map<string, ResolvedAnchor[]>();
  let addressable = false;
  for (const doc of served) {
    for (const anchor of doc.anchors) {
      addressable = true;
      // "Section 2.05(b)" -> word "section", label "2.05(b)";
      // "ARTICLE VII" -> word "article", label "VII".
      const m = anchor.display.match(/^\s*([A-Za-z§]+)\s*(.*)$/u);
      if (!m) continue;
      const word = m[1] === "§" ? "section" : m[1];
      const key = anchorKey(word, m[2]);
      const resolved: ResolvedAnchor = {
        document: doc.document,
        display: anchor.display,
        start: anchor.start,
        end: anchor.end,
        servedFraction: coveredFraction(doc.spans, anchor.start, anchor.end),
        via: "exact",
      };
      const list = byKey.get(key);
      if (list) list.push(resolved);
      else byKey.set(key, [resolved]);
    }
  }
  return { byKey, addressable };
}

function resolveCitation(
  index: AnchorIndex,
  word: string,
  label: string,
  servedFractionMin: number,
): CitationResolution {
  if (!index.addressable) {
    return { status: "unresolvable", reason: "no-addressable-structure" };
  }
  let key = anchorKey(word, label);
  let via: "exact" | "parent" = "exact";
  let hits = index.byKey.get(key);
  let cursor = label;
  while (!hits?.length) {
    const parent = parentLabel(cursor);
    if (!parent) break;
    cursor = parent;
    via = "parent";
    key = anchorKey(word, cursor);
    hits = index.byKey.get(key);
  }
  if (!hits?.length) {
    return { status: "unresolvable", reason: "no-matching-anchor" };
  }
  const candidates = hits.map((hit) => ({ ...hit, via }));
  if (candidates.length > 1) {
    // Same label in two documents: the model may have read the one that
    // matters. Report, never fire.
    const distinctDocs = new Set(candidates.map((c) => c.document));
    if (distinctDocs.size > 1) return { status: "ambiguous", candidates };
    // Same document, repeated label (amended/restated): fire only when EVERY
    // occurrence is dark.
    const worst = candidates.reduce((a, b) =>
      a.servedFraction <= b.servedFraction ? a : b,
    );
    const best = candidates.reduce((a, b) =>
      a.servedFraction >= b.servedFraction ? a : b,
    );
    if (best.servedFraction === 0) return { status: "unserved", anchor: worst };
    if (best.servedFraction >= servedFractionMin)
      return { status: "served", anchor: best };
    return { status: "partially-served", anchor: best };
  }
  const anchor = candidates[0];
  if (anchor.servedFraction === 0) return { status: "unserved", anchor };
  if (anchor.servedFraction >= servedFractionMin)
    return { status: "served", anchor };
  return { status: "partially-served", anchor };
}

/* ------------------------------------------------------------------ */
/* § references (the reference grammar's vocabulary is word-based)     */
/* ------------------------------------------------------------------ */

const SECTION_SIGN_RE =
  /§{1,2}\s?(\d{1,4}[A-Za-z]?(?:\.\d{1,4}[A-Za-z]?)*(?:\s?\([^\s()]{1,12}\))*)/gu;

interface RawReference {
  start: number;
  end: number;
  raw: string;
  word: string;
  label: string;
  external: boolean;
}

function referencesIn(text: string, offset: number): RawReference[] {
  const out: RawReference[] = [];
  for (const ref of findProvisionReferences(text)) {
    out.push({
      start: offset + ref.start,
      end: offset + ref.end,
      raw: ref.raw,
      word: ref.word,
      label: ref.label,
      external: ref.external,
    });
  }
  for (const m of text.matchAll(SECTION_SIGN_RE)) {
    const start = offset + (m.index ?? 0);
    if (out.some((r) => r.start === start)) continue;
    out.push({
      start,
      end: start + m[0].length,
      raw: m[0],
      word: "section",
      label: m[1].replace(/\s+/gu, ""),
      external: false,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* Scan                                                                */
/* ------------------------------------------------------------------ */

const VERDICT_RANK: Record<NegativeVerdict, number> = {
  "unserved-anchor": 0,
  "partially-served-anchor": 1,
  "unresolvable-anchor": 2,
  "served-anchor": 3,
  "no-anchor": 4,
};

export function scanNegativeAssertions(params: {
  /** the deliverable text, on whatever plane it was authored */
  draft: string;
  served: ServedDocument[];
  options?: Partial<GuardOptions>;
}): NegativeAssertionFinding[] {
  const opts = { ...DEFAULT_GUARD_OPTIONS, ...(params.options ?? {}) };
  const { draft, served } = params;
  const index = buildAnchorIndex(served);

  const seen = new Set<number>();
  const findings: NegativeAssertionFinding[] = [];

  for (const { family, re } of TRIGGERS) {
    re.lastIndex = 0;
    for (const match of draft.matchAll(re)) {
      const at = match.index ?? 0;
      if (seen.has(at)) continue;
      seen.add(at);

      const sStart = sentenceStart(draft, at);
      const sEnd = sentenceEnd(draft, at + match[0].length);
      const uStart = claimUnitStart(draft, sStart, opts.claimUnitBackChars);

      const citations: NegativeCitation[] = [];
      const pushRefs = (
        from: number,
        to: number,
        scope: NegativeCitation["scope"],
      ) => {
        for (const ref of referencesIn(draft.slice(from, to), from)) {
          if (ref.external) continue;
          if (citations.some((c) => c.raw === ref.raw && c.scope === scope))
            continue;
          citations.push({
            raw: ref.raw,
            label: ref.label,
            word: ref.word,
            scope,
            resolution: resolveCitation(
              index,
              ref.word,
              ref.label,
              opts.servedFractionMin,
            ),
          });
        }
      };
      pushRefs(sStart, sEnd, "trigger-sentence");
      if (!citations.length && uStart < sStart) {
        pushRefs(uStart, sStart, "claim-unit");
      }

      let verdict: NegativeVerdict = "no-anchor";
      if (citations.length) {
        const statuses = citations.map((c) => c.resolution.status);
        if (statuses.includes("unserved")) verdict = "unserved-anchor";
        else if (statuses.includes("partially-served"))
          verdict = "partially-served-anchor";
        else if (statuses.includes("served")) verdict = "served-anchor";
        else verdict = "unresolvable-anchor";
      }

      findings.push({
        family,
        trigger: match[0],
        triggerAt: at,
        excerpt: draft
          .slice(citations.some((c) => c.scope === "claim-unit") ? uStart : sStart, sEnd)
          .replace(/\s+/gu, " ")
          .trim(),
        citations,
        verdict,
      });
    }
  }

  findings.sort(
    (a, b) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      a.triggerAt - b.triggerAt,
  );
  return opts.maxFindings > 0
    ? findings.slice(0, opts.maxFindings)
    : findings;
}

/** The actionable subset: negatives asserted over never-served regions. */
export function unservedNegatives(
  findings: NegativeAssertionFinding[],
): NegativeAssertionFinding[] {
  return findings.filter((f) => f.verdict === "unserved-anchor");
}

export interface ResolvedReference {
  raw: string;
  label: string;
  word: string;
  at: number;
  resolution: CitationResolution;
}

/**
 * Every internal provision reference the draft asserts, resolved against the
 * served map. The guard is a strict subset of this: the same resolution, asked
 * only where a negative assertion carries the citation. Exposed because the
 * coverage-certificate wing needs the denominator.
 */
export function resolveReferences(params: {
  draft: string;
  served: ServedDocument[];
  options?: Partial<GuardOptions>;
}): ResolvedReference[] {
  const opts = { ...DEFAULT_GUARD_OPTIONS, ...(params.options ?? {}) };
  const index = buildAnchorIndex(params.served);
  return referencesIn(params.draft, 0)
    .filter((ref) => !ref.external)
    .map((ref) => ({
      raw: ref.raw,
      label: ref.label,
      word: ref.word,
      at: ref.start,
      resolution: resolveCitation(
        index,
        ref.word,
        ref.label,
        opts.servedFractionMin,
      ),
    }));
}
