/**
 * Deterministic DOCX version comparison → tracked-changes redline.
 *
 * `compareDocxVersions(oldBytes, newBytes)` produces the NEW document with
 * `w:ins` / `w:del` revision markup describing the changes FROM the old
 * version TO the new version, plus a typed change summary. The output is
 * built by transforming the new document's XML in place — its styles,
 * sections, numbering, and every untouched part of the package are
 * preserved byte-for-byte except `word/document.xml`.
 *
 * Algorithm:
 *   1. Extract the block sequence (paragraphs, tables, block-level content
 *      controls) from each document's main story.
 *   2. Align the sequences with an LCS over whitespace/quote-normalized
 *      block text (common prefix/suffix trimmed first).
 *   3. Inside each unmatched gap, pair up similar paragraphs with a small
 *      edit-distance DP (fast-diff similarity ≥ 0.5 allows a pairing).
 *   4. Changed pairs get a word-level diff (legal-text tokenization
 *      mirroring TableOfAuthoritiesMaker/quote_edits.py — see the diff
 *      section below — encoded into characters and diffed with
 *      fast-diff); the new paragraph's children are rebuilt with `w:del`
 *      splices carrying the old text and `w:ins` wraps around the new
 *      text. Quote-style, dash-style, and whitespace-run-only differences
 *      compare as equal (the same tolerance normalizeWs gives the whole
 *      tracked-changes stack) and are not marked.
 *   5. Unmatched old paragraphs are cloned into fully-deleted paragraphs
 *      (runs → `w:delText`, paragraph mark marked deleted) and spliced
 *      into the new body; unmatched new paragraphs are wrapped in `w:ins`
 *      with their paragraph mark marked inserted.
 *
 * Typed abstentions (house doctrine: refuse loudly, never mangle). Every
 * abstention leaves the affected content exactly as the NEW version has
 * it, without revision marks, and records `{ reason, excerpt }` where
 * `reason` starts with one of these stable codes followed by ": ":
 *
 *   table_changed / table_added / table_removed
 *       Tables are never diffed; any table difference abstains.
 *   content_control_changed / content_control_added / content_control_removed
 *       Block-level w:sdt differences abstain (control machinery is
 *       guarded house-wide).
 *   headers_changed / footers_changed / footnotes_changed / endnotes_changed
 *       Non-main stories are compared for *detection* only; differences
 *       abstain because this tool marks up the main story exclusively.
 *   paragraph_not_diffable
 *       A changed paragraph pair whose new-version paragraph contains
 *       structure the rewriter cannot safely rebuild (fields, hyperlinks,
 *       inline content controls, pre-existing tracked changes, runs mixing
 *       text with objects, unknown elements).
 *   deleted_paragraph_unrepresentable
 *       An old-only paragraph with no clonable text content (e.g. an
 *       image-only paragraph); its deletion is not shown in the redline.
 *   deleted_paragraph_content_dropped
 *       An old-only paragraph was written as a deleted paragraph but some
 *       non-text content (images/objects, footnote references, fields,
 *       hyperlink/control structure) could not be carried across packages.
 *   inserted_paragraph_not_markable
 *       A new-only paragraph with structure that cannot be wrapped in
 *       w:ins; it stays in the output unmarked.
 *   numbering_change_not_tracked
 *       An aligned paragraph pair differs in list-numbering presence or
 *       level; numbering property changes are not representable as text
 *       revisions here. (Cross-package numId renumbering is invisible.)
 *   inline_object_in_inserted_range
 *       A preserved inline object (image, note reference) sits inside an
 *       inserted text range and is kept, but not itself marked inserted.
 *   old_paragraph_objects_not_compared
 *       The old side of a changed pair contained non-text objects; only
 *       its text participates in the diff.
 *   documents_too_divergent
 *       The alignment working set exceeded the safety cap; the whole
 *       comparison abstains and the new document is returned unmarked.
 *
 * Reused house machinery (this module adds no parallel access layer):
 *   - `loadZip` (lib/zip) for all archive access, with the same
 *     backslash-entry fallback docxTrackedChanges uses;
 *   - `normalizeWs` (docxTrackedChanges) for all alignment/similarity
 *     normalization — the exact matcher-grade normalization
 *     docxTextOps/applyTrackedEdits anchor with;
 *   - `decodeXmlText` (lib/text) plus docxStructuralLint's w:t /
 *     deleted-run regex patterns for the read-only story comparison;
 *   - the docxTrackedChanges preserveOrder tree conventions (identical
 *     XMLParser/XMLBuilder settings, ":@"/"#text" node shape, and
 *     w:ins/w:del emission format: w:id/w:author/w:date attributes,
 *     w:delText with xml:space). Its tiny node helpers are file-local
 *     there (not exported), so they are mirrored here unchanged; the
 *     document-level writer itself (applyTrackedEdits) cannot be reused
 *     because its EditInput model is old-doc-anchored and cannot express
 *     paragraph-level insert/delete or transform-the-NEW-document
 *     semantics.
 *   - Word-level tokenization mirrors the proven legal-text conventions
 *     of TableOfAuthoritiesMaker/quote_edits.py (`_tokens`,
 *     `_mergeable`, `_equivalent`), minus its case folding and
 *     quote-editorial bracket rules.
 */

import diff from "fast-diff";
import type JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { loadZip } from "./zip";
import { normalizeWs } from "./docxTrackedChanges";
import { decodeXmlText } from "./text";

export interface CompareChange {
    kind: "insert" | "delete" | "replace";
    contextBefore: string;
    deletedText: string;
    insertedText: string;
    contextAfter: string;
}

export interface CompareAbstention {
    reason: string;
    excerpt: string;
}

export interface CompareDocxVersionsResult {
    /** The NEW document with w:ins/w:del markup for old→new changes. */
    bytes: Buffer;
    changes: CompareChange[];
    abstentions: CompareAbstention[];
}

const CONTEXT_CHARS = 40;
const EXCERPT_CHARS = 160;
/** LCS working-set cap after prefix/suffix trimming (cells). */
const MAX_LCS_CELLS = 4_000_000;
/** Gap paragraph-pairing DP cap (cells). */
const MAX_GAP_CELLS = 10_000;
/** Minimum fast-diff similarity for two paragraphs to count as a pair. */
const PAIR_SIMILARITY = 0.5;

// ---------------------------------------------------------------------------
// XML plumbing — mirrors the docxTrackedChanges conventions (preserveOrder
// trees from fast-xml-parser: element nodes are { [name]: children[] } with
// attributes under ":@" and text under "#text"). Those helpers are file-
// local there, so the small set needed here is redefined, not diverged.
// ---------------------------------------------------------------------------

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
    if (!n || typeof n !== "object") return false;
    const obj = n as XNode;
    return TEXT_KEY in obj && elName(n) === null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function setChildren(n: XNode, children: XNode[]): void {
    const name = elName(n);
    if (!name) return;
    n[name] = children;
}

function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    const a = (n as XNode)[ATTR_KEY];
    return (a as Record<string, string>) ?? {};
}

function makeEl(
    name: string,
    children: XNode[] = [],
    attrs?: Record<string, string>,
): XNode {
    const el: XNode = { [name]: children };
    if (attrs) {
        const attrObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(attrs)) {
            attrObj[`@_${k}`] = v;
        }
        el[ATTR_KEY] = attrObj;
    }
    return el;
}

function makeText(s: string): XNode {
    return { [TEXT_KEY]: s };
}

function getTextContent(wtEl: XNode): string {
    let out = "";
    for (const k of elChildren(wtEl)) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

function cloneNode<T>(n: T): T {
    return JSON.parse(JSON.stringify(n)) as T;
}

function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

function createBuilder() {
    return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        suppressEmptyNode: false,
        processEntities: true,
    });
}

function ensureXmlDeclaration(xml: string): string {
    if (xml.startsWith("<?xml")) return xml;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

// Some older Windows/Word archives store entries with backslash separators;
// accept the canonical forward-slash path and fall back (house pattern).
function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(zip: JSZip, pathSlash: string, content: string): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    if (!zip.file(pathSlash) && zip.file(backslash)) {
        zip.file(backslash, content);
        return;
    }
    zip.file(pathSlash, content);
}

function findBody(doc: XNode[]): XNode | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return c;
            }
        }
    }
    return null;
}

/** Max w:id across existing w:ins/w:del so fresh ids never collide. */
function maxTrackedId(doc: XNode[]): number {
    let max = 0;
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const raw = elAttrs(n)["@_w:id"];
            if (raw != null) {
                const v = parseInt(String(raw), 10);
                if (Number.isFinite(v) && v > max) max = v;
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of doc) visit(top);
    return max;
}

// ---------------------------------------------------------------------------
// Text extraction (accepted view: w:ins content counts, w:del content does
// not; tabs and soft line breaks become "\t" / "\n" markers so they survive
// diffs and paragraph rebuilds).
// ---------------------------------------------------------------------------

function extractInlineText(pNode: XNode): string {
    let out = "";
    const visit = (n: XNode) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:r") {
            for (const rk of elChildren(n)) {
                const rn = elName(rk);
                if (rn === "w:t") out += getTextContent(rk);
                else if (rn === "w:tab") out += "\t";
                else if (rn === "w:cr") out += "\n";
                else if (
                    rn === "w:br" &&
                    Object.keys(elAttrs(rk)).length === 0
                )
                    out += "\n";
            }
            return;
        }
        if (
            name === "w:hyperlink" ||
            name === "w:smartTag" ||
            name === "w:ins" ||
            name === "w:sdtContent" ||
            name === "w:customXml"
        ) {
            for (const c of elChildren(n)) visit(c);
            return;
        }
        if (name === "w:sdt") {
            for (const c of elChildren(n)) {
                if (elName(c) === "w:sdtContent") visit(c);
            }
            return;
        }
        // w:del content and unknown structures are absent from accepted text.
    };
    for (const c of elChildren(pNode)) visit(c);
    return out;
}

/** Recursive text of a table / content-control block, "\n" per paragraph. */
function extractBlockText(node: XNode): string {
    let out = "";
    const visit = (n: XNode) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:p") {
            out += extractInlineText(n) + "\n";
            return;
        }
        for (const c of elChildren(n)) visit(c);
    };
    visit(node);
    return out;
}

function normTrim(s: string): string {
    return normalizeWs(s).norm.trim();
}

function excerptOf(s: string): string {
    const t = s.replace(/\s+/gu, " ").trim();
    return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS)}…` : t;
}

// ---------------------------------------------------------------------------
// Block collection and alignment
// ---------------------------------------------------------------------------

interface Block {
    kind: "p" | "tbl" | "sdt";
    node: XNode;
    /** Index in the body's children array (stable until the final splice). */
    bodyIndex: number;
    /** Raw text (markers included) — exact, for diffing. */
    text: string;
    /** Kind-prefixed normalized key for LCS equality. */
    key: string;
}

function collectBlocks(bodyKids: XNode[]): Block[] {
    const blocks: Block[] = [];
    for (let i = 0; i < bodyKids.length; i++) {
        const n = bodyKids[i];
        const name = elName(n);
        if (name === "w:p") {
            const text = extractInlineText(n);
            blocks.push({
                kind: "p",
                node: n,
                bodyIndex: i,
                text,
                key: `p:${normTrim(text)}`,
            });
        } else if (name === "w:tbl") {
            const text = extractBlockText(n);
            blocks.push({
                kind: "tbl",
                node: n,
                bodyIndex: i,
                text,
                key: `tbl:${normTrim(text)}`,
            });
        } else if (name === "w:sdt") {
            const text = extractBlockText(n);
            blocks.push({
                kind: "sdt",
                node: n,
                bodyIndex: i,
                text,
                key: `sdt:${normTrim(text)}`,
            });
        }
        // w:sectPr, bookmarks, and other body-level elements are neither
        // aligned nor touched; they stay exactly where the new document
        // put them.
    }
    return blocks;
}

/**
 * LCS over block keys. Common prefix/suffix are trimmed first (versions of
 * one document share most content in order). Returns matched index pairs
 * in ascending order, or null when the trimmed working set exceeds the
 * safety cap.
 */
function alignSequences(
    a: string[],
    b: string[],
): Array<[number, number]> | null {
    let prefix = 0;
    while (
        prefix < a.length &&
        prefix < b.length &&
        a[prefix] === b[prefix]
    )
        prefix++;
    let suffix = 0;
    while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    )
        suffix++;

    const n = a.length - prefix - suffix;
    const m = b.length - prefix - suffix;
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < prefix; i++) pairs.push([i, i]);

    if (n > 0 && m > 0) {
        if (n * m > MAX_LCS_CELLS) return null;
        const W = m + 1;
        const table = new Int32Array((n + 1) * W);
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                if (a[prefix + i - 1] === b[prefix + j - 1]) {
                    table[i * W + j] = table[(i - 1) * W + (j - 1)] + 1;
                } else {
                    const up = table[(i - 1) * W + j];
                    const left = table[i * W + (j - 1)];
                    table[i * W + j] = up >= left ? up : left;
                }
            }
        }
        const middle: Array<[number, number]> = [];
        let i = n;
        let j = m;
        while (i > 0 && j > 0) {
            if (a[prefix + i - 1] === b[prefix + j - 1]) {
                middle.push([prefix + i - 1, prefix + j - 1]);
                i--;
                j--;
            } else if (table[(i - 1) * W + j] >= table[i * W + (j - 1)]) {
                i--;
            } else {
                j--;
            }
        }
        middle.reverse();
        pairs.push(...middle);
    }

    for (let k = suffix; k > 0; k--) {
        pairs.push([a.length - k, b.length - k]);
    }
    return pairs;
}

// ---------------------------------------------------------------------------
// Gap paragraph pairing
// ---------------------------------------------------------------------------

/** Dice-style similarity from fast-diff EQUAL mass over normalized texts. */
function similarity(aNorm: string, bNorm: string): number {
    const total = aNorm.length + bNorm.length;
    if (total === 0) return 1;
    // Length pre-filter: similarity can never reach the threshold when one
    // side is much shorter than the other; skip the O(n^2) diff.
    if ((2 * Math.min(aNorm.length, bNorm.length)) / total < PAIR_SIMILARITY)
        return 0;
    let equal = 0;
    for (const [op, text] of diff(aNorm, bNorm)) {
        if (op === diff.EQUAL) equal += text.length;
    }
    return (2 * equal) / total;
}

type GapOp =
    | { op: "sub"; oi: number; ni: number }
    | { op: "del"; oi: number }
    | { op: "ins"; ni: number };

/**
 * Pair old-gap paragraphs with new-gap paragraphs. Substitution is only
 * allowed at similarity ≥ PAIR_SIMILARITY; everything else becomes a
 * whole-paragraph delete/insert (which is always representable).
 */
function pairGapParagraphs(
    oldNorms: string[],
    newNorms: string[],
): GapOp[] {
    const n = oldNorms.length;
    const m = newNorms.length;
    const allDeletesTheninserts = (): GapOp[] => [
        ...oldNorms.map((_, oi): GapOp => ({ op: "del", oi })),
        ...newNorms.map((_, ni): GapOp => ({ op: "ins", ni })),
    ];
    if (n === 0 || m === 0 || n * m > MAX_GAP_CELLS)
        return allDeletesTheninserts();

    const W = m + 1;
    const cost = new Float64Array((n + 1) * W);
    // 1 = del (from up), 2 = ins (from left), 3 = sub (from diagonal)
    const from = new Uint8Array((n + 1) * W);
    for (let i = 1; i <= n; i++) {
        cost[i * W] = i;
        from[i * W] = 1;
    }
    for (let j = 1; j <= m; j++) {
        cost[j] = j;
        from[j] = 2;
    }
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const delCost = cost[(i - 1) * W + j] + 1;
            const insCost = cost[i * W + (j - 1)] + 1;
            const sim = similarity(oldNorms[i - 1], newNorms[j - 1]);
            const subCost =
                sim >= PAIR_SIMILARITY
                    ? cost[(i - 1) * W + (j - 1)] + 2 * (1 - sim)
                    : Infinity;
            // Preference on ties: sub, then del, then ins.
            if (subCost <= delCost && subCost <= insCost) {
                cost[i * W + j] = subCost;
                from[i * W + j] = 3;
            } else if (delCost <= insCost) {
                cost[i * W + j] = delCost;
                from[i * W + j] = 1;
            } else {
                cost[i * W + j] = insCost;
                from[i * W + j] = 2;
            }
        }
    }

    const ops: GapOp[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        const f = from[i * W + j];
        if (f === 3) {
            ops.push({ op: "sub", oi: i - 1, ni: j - 1 });
            i--;
            j--;
        } else if (f === 1) {
            ops.push({ op: "del", oi: i - 1 });
            i--;
        } else {
            ops.push({ op: "ins", ni: j - 1 });
            j--;
        }
    }
    ops.reverse();
    return ops;
}

// ---------------------------------------------------------------------------
// Word-level diff
//
// The tokenization conventions are a TypeScript mirror of the proven
// legal-text tokenizer in TableOfAuthoritiesMaker/quote_edits.py
// (`_tokens` / `_mergeable` / `_equivalent`): words keep internal
// apostrophes ("plaintiff's" is one token), punctuation is its own token
// (so ";" appearing after "costs" does not redline the word), "..." and
// "[...]" are atomic, adjacent word/bracket tokens with no gap between
// them merge ("[T]he"), and matching runs over equivalence-folded keys
// (all double-quote variants ≈ '"', single-quote variants ≈ "'", dash
// variants ≈ "-", any whitespace run ≈ " ") while emission always uses
// the original document text. Unlike quote_edits, case is NOT folded —
// capitalization changes are real edits a redline must show — and
// whitespace tokens are kept (with exact offsets) because clusters must
// map back to precise character ranges.
// ---------------------------------------------------------------------------

interface DiffCluster {
    /** Insert position in the NEW paragraph text. */
    newStart: number;
    /** End of the inserted new-text range (== newStart for pure deletes). */
    newEnd: number;
    /** Old text removed at newStart (may be empty for pure inserts). */
    deleted: string;
}

const DOUBLE_QUOTE_CHARS = new Set([
    '"',
    "“",
    "”",
    "«",
    "»",
    "„",
]);
const SINGLE_QUOTE_CHARS = new Set(["'", "‘", "’", "‚"]);
const DASH_CHARS = new Set([
    "-",
    "­",
    "‐",
    "‑",
    "‒",
    "–",
    "—",
    "―",
    "−",
]);
const DASH_FOLD_RE = /[­‐‑‒–—―−]/gu;

// quote_edits._WORD: letters/digits (no underscore) with internal
// apostrophes. The trailing `|.` catch-all makes the token stream a full
// partition of the input so offsets are exact.
const WORD_SRC = "[^\\W_]+(?:['\\u2019][^\\W_]+)*";
const TOKEN_RE = new RegExp(
    `\\s+|\\.\\.\\.|\\[[^\\]]+\\]|${WORD_SRC}|["\\u201C\\u201D\\u2018\\u2019]|[^\\w\\s]|.`,
    "gu",
);

interface DiffToken {
    text: string;
    key: string;
}

/** quote_edits._mergeable: word-bearing or bracketed tokens fuse when
 *  directly adjacent (no whitespace between). */
function tokenMergeable(t: string): boolean {
    if (/^\s/u.test(t)) return false;
    return /[^\W_]/u.test(t) || (t.startsWith("[") && t.endsWith("]"));
}

/** quote_edits._equivalent, minus case folding and bracket-initial. */
function tokenKey(t: string): string {
    if (/^\s/u.test(t)) return " ";
    if (t.length === 1) {
        if (DOUBLE_QUOTE_CHARS.has(t)) return '"';
        if (SINGLE_QUOTE_CHARS.has(t)) return "'";
        if (DASH_CHARS.has(t)) return "-";
    }
    return t
        .replace(/[‘’]/gu, "'")
        .replace(/[“”]/gu, '"')
        .replace(DASH_FOLD_RE, "-");
}

function tokenizeForDiff(text: string): DiffToken[] {
    const raw: { text: string; start: number; end: number }[] = [];
    for (const m of text.matchAll(TOKEN_RE)) {
        const start = m.index ?? 0;
        raw.push({ text: m[0], start, end: start + m[0].length });
    }
    const merged: DiffToken[] = [];
    let i = 0;
    while (i < raw.length) {
        let tok = raw[i].text;
        let end = raw[i].end;
        let j = i + 1;
        while (
            j < raw.length &&
            end === raw[j].start &&
            tokenMergeable(tok) &&
            tokenMergeable(raw[j].text)
        ) {
            tok += raw[j].text;
            end = raw[j].end;
            j++;
        }
        merged.push({ text: tok, key: tokenKey(tok) });
        i = j;
    }
    return merged;
}

/** Character-level fallback (docxTrackedChanges minimal-cluster style). */
function charDiffClusters(oldText: string, newText: string): DiffCluster[] {
    const clusters: DiffCluster[] = [];
    let newPos = 0;
    for (const [op, text] of diff(oldText, newText, undefined, true)) {
        if (op === diff.EQUAL) {
            newPos += text.length;
            continue;
        }
        const last = clusters[clusters.length - 1];
        let cluster: DiffCluster;
        if (last && last.newEnd === newPos) {
            cluster = last;
        } else {
            cluster = { newStart: newPos, newEnd: newPos, deleted: "" };
            clusters.push(cluster);
        }
        if (op === diff.DELETE) {
            cluster.deleted += text;
        } else {
            cluster.newEnd += text.length;
            newPos += text.length;
        }
    }
    return clusters;
}

/**
 * Word-level minimal clusters between two paragraph texts. Tokens are
 * encoded by equivalence key as single UTF-16 code units and diffed with
 * fast-diff, so changes always land on token boundaries and quote-style /
 * dash-style / whitespace-run differences compare as equal (matching the
 * normalizeWs tolerance the whole tracked-changes stack uses). Deleted
 * fragments are reassembled from the OLD tokens' original text; may
 * return zero clusters when the texts differ only by equivalence.
 * Falls back to character diff with semantic cleanup in the pathological
 * case of ~55k distinct token keys.
 */
function wordDiffClusters(oldText: string, newText: string): DiffCluster[] {
    if (oldText === newText) return [];

    const oldToks = tokenizeForDiff(oldText);
    const newToks = tokenizeForDiff(newText);

    const codeByKey = new Map<string, string>();
    let overflow = false;
    const encode = (toks: DiffToken[]): string => {
        let out = "";
        for (const t of toks) {
            let c = codeByKey.get(t.key);
            if (c === undefined) {
                const next = codeByKey.size + 1;
                if (next >= 0xd7ff) {
                    overflow = true;
                    return "";
                }
                c = String.fromCharCode(next);
                codeByKey.set(t.key, c);
            }
            out += c;
        }
        return out;
    };
    const encOld = encode(oldToks);
    const encNew = overflow ? "" : encode(newToks);
    if (overflow) return charDiffClusters(oldText, newText);

    const clusters: DiffCluster[] = [];
    let oi = 0;
    let nj = 0;
    let newPos = 0;
    const clusterAtCursor = (): DiffCluster => {
        const last = clusters[clusters.length - 1];
        if (last && last.newEnd === newPos) return last;
        const c: DiffCluster = { newStart: newPos, newEnd: newPos, deleted: "" };
        clusters.push(c);
        return c;
    };
    for (const [op, encoded] of diff(encOld, encNew)) {
        const k = encoded.length;
        if (op === diff.EQUAL) {
            // Equal by KEY — original text lengths may differ per side.
            for (let x = 0; x < k; x++) newPos += newToks[nj + x].text.length;
            oi += k;
            nj += k;
        } else if (op === diff.DELETE) {
            const c = clusterAtCursor();
            for (let x = 0; x < k; x++) c.deleted += oldToks[oi + x].text;
            oi += k;
        } else {
            const c = clusterAtCursor();
            for (let x = 0; x < k; x++) {
                const len = newToks[nj + x].text.length;
                c.newEnd += len;
                newPos += len;
            }
            nj += k;
        }
    }
    return clusters;
}

// ---------------------------------------------------------------------------
// Strict paragraph flattening for the in-place rewrite
// ---------------------------------------------------------------------------

type FlatAtom =
    | { kind: "chars"; text: string; rPr: XNode | null }
    | { kind: "tab" | "br"; rPr: XNode | null }
    | { kind: "keep"; node: XNode };

interface RewriteFlat {
    atoms: FlatAtom[];
    text: string;
}

const KEEP_PARA_CHILDREN = new Set([
    "w:bookmarkStart",
    "w:bookmarkEnd",
    "w:proofErr",
    "w:commentRangeStart",
    "w:commentRangeEnd",
]);

/** Run children a whole run may be atomically preserved for. */
const ATOMIC_RUN_CHILDREN = new Set([
    "w:footnoteReference",
    "w:endnoteReference",
    "w:commentReference",
    "w:drawing",
]);

/**
 * Flatten a paragraph for rewriting. Fails (typed) on any structure the
 * rebuild cannot round-trip: hyperlinks, inline content controls, fields,
 * pre-existing tracked changes, symbol/object runs, or runs mixing text
 * with atomic content.
 */
function flattenForRewrite(
    pNode: XNode,
): { ok: true; flat: RewriteFlat } | { ok: false; reason: string } {
    const atoms: FlatAtom[] = [];
    let text = "";
    for (const child of elChildren(pNode)) {
        const name = elName(child);
        if (!name || name === "w:pPr") continue;
        if (KEEP_PARA_CHILDREN.has(name)) {
            atoms.push({ kind: "keep", node: child });
            continue;
        }
        if (name !== "w:r") {
            return { ok: false, reason: `contains <${name}>` };
        }
        let rPr: XNode | null = null;
        const textual: FlatAtom[] = [];
        let textualText = "";
        let atomic = false;
        for (const rk of elChildren(child)) {
            const rn = elName(rk);
            if (rn === null) continue;
            if (rn === "w:rPr") {
                rPr = rk;
            } else if (rn === "w:t") {
                const t = getTextContent(rk);
                textual.push({ kind: "chars", text: t, rPr: null });
                textualText += t;
            } else if (rn === "w:tab") {
                textual.push({ kind: "tab", rPr: null });
                textualText += "\t";
            } else if (rn === "w:cr") {
                textual.push({ kind: "br", rPr: null });
                textualText += "\n";
            } else if (rn === "w:br") {
                if (Object.keys(elAttrs(rk)).length > 0) {
                    // Page/column breaks are positional, not text.
                    atomic = true;
                } else {
                    textual.push({ kind: "br", rPr: null });
                    textualText += "\n";
                }
            } else if (rn === "w:lastRenderedPageBreak") {
                // Rendering cache; Word regenerates it. Dropped silently.
            } else if (ATOMIC_RUN_CHILDREN.has(rn)) {
                atomic = true;
            } else {
                return { ok: false, reason: `contains run content <${rn}>` };
            }
        }
        if (atomic && textualText.length > 0) {
            return {
                ok: false,
                reason: "a run mixes text with non-text content",
            };
        }
        if (atomic) {
            atoms.push({ kind: "keep", node: child });
            continue;
        }
        for (const atom of textual) {
            if (atom.kind !== "keep") atom.rPr = rPr;
            atoms.push(atom);
        }
        text += textualText;
    }
    return { ok: true, flat: { atoms, text } };
}

// ---------------------------------------------------------------------------
// Paragraph rebuild (changed pairs)
// ---------------------------------------------------------------------------

/** A single w:del wrapper carrying old text; "\t"/"\n" markers become
 *  w:tab / w:br elements interleaved with w:delText segments. */
function buildDelWrapper(
    deleted: string,
    rPr: XNode | null,
    author: string,
    date: string,
    id: string,
): XNode {
    const kids: XNode[] = [];
    if (rPr) kids.push(cloneNode(rPr));
    let buf = "";
    const flushBuf = () => {
        if (buf) {
            kids.push(
                makeEl("w:delText", [makeText(buf)], {
                    "xml:space": "preserve",
                }),
            );
            buf = "";
        }
    };
    for (const ch of deleted) {
        if (ch === "\t") {
            flushBuf();
            kids.push(makeEl("w:tab", []));
        } else if (ch === "\n") {
            flushBuf();
            kids.push(makeEl("w:br", []));
        } else {
            buf += ch;
        }
    }
    flushBuf();
    return makeEl("w:del", [makeEl("w:r", kids)], {
        "w:id": id,
        "w:author": author,
        "w:date": date,
    });
}

interface RebuildResult {
    children: XNode[];
    notes: string[];
}

/**
 * Rebuild a changed paragraph's children from its flattened atoms and the
 * diff clusters. Untouched text keeps its exact source runs (grouped by
 * rPr identity), inserted ranges are wrapped in w:ins, and deleted old
 * text is spliced in as w:del/w:delText at the correct positions. Keep
 * atoms (bookmarks, comment ranges, preserved object runs) stay at their
 * original text offsets.
 */
function rebuildParagraphChildren(
    pNode: XNode,
    flat: RewriteFlat,
    clusters: DiffCluster[],
    author: string,
    date: string,
    nextId: () => string,
): RebuildResult {
    const notes: string[] = [];
    const out: XNode[] = [];
    const pPr = elChildren(pNode).find((k) => elName(k) === "w:pPr");
    if (pPr) out.push(pPr);

    // Per-character rPr map for delete-run formatting inheritance.
    const charRPr: (XNode | null)[] = [];
    for (const atom of flat.atoms) {
        if (atom.kind === "chars") {
            for (let i = 0; i < atom.text.length; i++) charRPr.push(atom.rPr);
        } else if (atom.kind === "tab" || atom.kind === "br") {
            charRPr.push(atom.rPr);
        }
    }
    const rPrForPos = (p: number): XNode | null => {
        if (charRPr.length === 0) return null;
        const clamped = Math.min(Math.max(p, 0), charRPr.length - 1);
        return charRPr[clamped];
    };

    // Run/wrapper emission state.
    let runOpen = false;
    let runRPr: XNode | null = null;
    let runKids: XNode[] = [];
    let openIns: { clusterIdx: number; runs: XNode[] } | null = null;
    // openIns is only ever assigned inside the closures below, so top-level
    // control flow would otherwise narrow it to its initializer (null).
    const currentOpenIns = () => openIns;

    const closeRun = () => {
        if (!runOpen) return;
        const kids: XNode[] = [];
        if (runRPr) kids.push(cloneNode(runRPr));
        kids.push(...runKids);
        const sink = openIns ? openIns.runs : out;
        sink.push(makeEl("w:r", kids));
        runOpen = false;
        runRPr = null;
        runKids = [];
    };
    const closeIns = () => {
        closeRun();
        if (openIns) {
            if (openIns.runs.length) {
                out.push(
                    makeEl("w:ins", openIns.runs, {
                        "w:id": nextId(),
                        "w:author": author,
                        "w:date": date,
                    }),
                );
            }
            openIns = null;
        }
    };
    const ensureRegion = (clusterIdx: number | null) => {
        if (clusterIdx === null) {
            if (openIns) closeIns();
            return;
        }
        if (openIns && openIns.clusterIdx !== clusterIdx) closeIns();
        if (!openIns) {
            closeRun();
            openIns = { clusterIdx, runs: [] };
        }
    };
    const appendToRun = (rPr: XNode | null, node: XNode) => {
        if (!runOpen || runRPr !== rPr) {
            closeRun();
            runOpen = true;
            runRPr = rPr;
            runKids = [];
        }
        runKids.push(node);
    };
    const appendTextToRun = (rPr: XNode | null, text: string) => {
        if (runOpen && runRPr === rPr && runKids.length > 0) {
            const last = runKids[runKids.length - 1];
            if (elName(last) === "w:t") {
                const kids = elChildren(last);
                if (kids.length === 1 && isTextNode(kids[0])) {
                    kids[0][TEXT_KEY] = String(kids[0][TEXT_KEY]) + text;
                    return;
                }
            }
        }
        appendToRun(
            rPr,
            makeEl("w:t", [makeText(text)], { "xml:space": "preserve" }),
        );
    };

    let delIdx = 0;
    const emitDelsThrough = (p: number) => {
        while (delIdx < clusters.length && clusters[delIdx].newStart <= p) {
            const c = clusters[delIdx];
            if (c.deleted) {
                closeIns();
                closeRun();
                out.push(
                    buildDelWrapper(
                        c.deleted,
                        rPrForPos(c.newStart),
                        author,
                        date,
                        nextId(),
                    ),
                );
            }
            delIdx++;
        }
    };

    let regionPtr = 0;
    const regionOf = (p: number): number | null => {
        while (
            regionPtr < clusters.length &&
            clusters[regionPtr].newEnd <= p
        )
            regionPtr++;
        const c = clusters[regionPtr];
        return c && c.newStart <= p && p < c.newEnd ? regionPtr : null;
    };
    const nextBoundary = (p: number): number => {
        for (let k = regionPtr; k < clusters.length; k++) {
            if (clusters[k].newStart > p) return clusters[k].newStart;
        }
        return Infinity;
    };

    let pos = 0;
    for (const atom of flat.atoms) {
        if (atom.kind === "keep") {
            emitDelsThrough(pos);
            const ins = currentOpenIns();
            if (ins) {
                const c = clusters[ins.clusterIdx];
                if (c && c.newStart < pos && pos < c.newEnd) {
                    notes.push(
                        "inline_object_in_inserted_range: an inline object " +
                            "inside inserted text was preserved but not " +
                            "itself marked as inserted",
                    );
                }
                closeIns();
            } else {
                closeRun();
            }
            out.push(atom.node);
            continue;
        }
        const text =
            atom.kind === "chars" ? atom.text : atom.kind === "tab" ? "\t" : "\n";
        let off = 0;
        while (off < text.length) {
            emitDelsThrough(pos);
            const region = regionOf(pos);
            const boundary =
                region === null ? nextBoundary(pos) : clusters[region].newEnd;
            const take = Math.min(text.length - off, boundary - pos);
            ensureRegion(region);
            if (atom.kind === "chars") {
                appendTextToRun(atom.rPr, text.substr(off, take));
            } else if (atom.kind === "tab") {
                appendToRun(atom.rPr, makeEl("w:tab", []));
            } else {
                appendToRun(atom.rPr, makeEl("w:br", []));
            }
            pos += take;
            off += take;
        }
        // Zero-length text atoms (empty w:t) contribute nothing.
        if (text.length === 0) emitDelsThrough(pos);
    }
    emitDelsThrough(pos);
    closeIns();
    closeRun();
    return { children: out, notes };
}

// ---------------------------------------------------------------------------
// Paragraph-mark revision helper + whole-paragraph insert / delete
// ---------------------------------------------------------------------------

/**
 * Mark a paragraph's own mark (its pilcrow) as inserted/deleted by adding
 * w:ins / w:del inside w:pPr > w:rPr, creating both containers if needed.
 * Schema placement: pPr's rPr sits before any sectPr; the revision element
 * is the first child of the rPr.
 */
function ensureParagraphMarkRevision(
    pNode: XNode,
    kind: "w:ins" | "w:del",
    attrs: Record<string, string>,
): void {
    const kids = elChildren(pNode);
    let pPr = kids.find((k) => elName(k) === "w:pPr");
    if (!pPr) {
        pPr = makeEl("w:pPr", []);
        setChildren(pNode, [pPr, ...kids]);
    }
    const pKids = elChildren(pPr);
    let rPr = pKids.find((k) => elName(k) === "w:rPr");
    if (!rPr) {
        rPr = makeEl("w:rPr", []);
        const sectIdx = pKids.findIndex((k) => elName(k) === "w:sectPr");
        const next = [...pKids];
        next.splice(sectIdx >= 0 ? sectIdx : next.length, 0, rPr);
        setChildren(pPr, next);
    }
    setChildren(rPr, [makeEl(kind, [], attrs), ...elChildren(rPr)]);
}

const DELETED_RUN_TEXTUAL = new Set([
    "w:tab",
    "w:br",
    "w:cr",
    "w:noBreakHyphen",
    "w:softHyphen",
    "w:sym",
]);

interface DeletedParagraphResult {
    /** Null when the paragraph has no representable content at all. */
    node: XNode | null;
    text: string;
    /** Kinds of old content that could not be carried across packages. */
    dropped: Set<string>;
}

/**
 * Synthesize a fully-deleted paragraph from the OLD document's node. Only
 * self-contained content is cloned (text, tabs, breaks, symbols, run
 * formatting, paragraph style). Anything that references old-package parts
 * (relationships, footnotes, media, comments, fields, controls) is dropped
 * and reported. sectPr/numPr are stripped so the new document's layout and
 * numbering stay authoritative.
 */
function buildDeletedParagraph(
    oldP: XNode,
    author: string,
    date: string,
    nextId: () => string,
): DeletedParagraphResult {
    const dropped = new Set<string>();
    const runs: XNode[] = [];

    const transformRun = (rEl: XNode): XNode | null => {
        const kids: XNode[] = [];
        let hasContent = false;
        for (const rk of elChildren(rEl)) {
            const rn = elName(rk);
            if (rn === null) continue;
            if (rn === "w:rPr") {
                kids.push(cloneNode(rk));
            } else if (rn === "w:t") {
                kids.push(
                    makeEl("w:delText", [makeText(getTextContent(rk))], {
                        "xml:space": "preserve",
                    }),
                );
                hasContent = true;
            } else if (DELETED_RUN_TEXTUAL.has(rn)) {
                kids.push(cloneNode(rk));
                hasContent = true;
            } else if (rn === "w:lastRenderedPageBreak") {
                // Rendering cache — dropped silently.
            } else if (rn === "w:commentReference") {
                // Old-package comment anchor; the comment itself is not
                // content, so this is dropped silently.
            } else if (rn === "w:footnoteReference" || rn === "w:endnoteReference") {
                dropped.add("note reference");
            } else if (rn === "w:drawing" || rn === "w:object" || rn === "w:pict") {
                dropped.add("image or object");
            } else if (rn === "w:fldChar" || rn === "w:instrText") {
                dropped.add("field");
            } else {
                dropped.add(rn);
            }
        }
        return hasContent ? makeEl("w:r", kids) : null;
    };

    const visit = (kids: XNode[]) => {
        for (const k of kids) {
            const name = elName(k);
            if (!name) continue;
            if (name === "w:pPr") continue;
            if (name === "w:r") {
                const run = transformRun(k);
                if (run) runs.push(run);
            } else if (name === "w:hyperlink") {
                dropped.add("hyperlink");
                visit(elChildren(k));
            } else if (name === "w:smartTag" || name === "w:customXml") {
                visit(elChildren(k));
            } else if (name === "w:ins") {
                // Accepted view: old insertions are ordinary text.
                visit(elChildren(k));
            } else if (name === "w:del") {
                // Already deleted in the old version — not part of it.
            } else if (name === "w:sdt") {
                dropped.add("content control");
                for (const c of elChildren(k)) {
                    if (elName(c) === "w:sdtContent") visit(elChildren(c));
                }
            } else if (name === "w:fldSimple") {
                dropped.add("field");
                visit(elChildren(k));
            } else if (KEEP_PARA_CHILDREN.has(name)) {
                // Old bookmarks / comment ranges / proofErr carry old ids;
                // they are structure, not content — dropped silently.
            } else {
                dropped.add(name);
            }
        }
    };
    visit(elChildren(oldP));

    const text = extractInlineText(oldP);
    if (runs.length === 0 && dropped.size > 0) {
        return { node: null, text, dropped };
    }

    const paraKids: XNode[] = [];
    const oldPPr = elChildren(oldP).find((k) => elName(k) === "w:pPr");
    if (oldPPr) {
        const c = cloneNode(oldPPr);
        setChildren(
            c,
            elChildren(c).filter((k) => {
                const n = elName(k);
                return n !== "w:sectPr" && n !== "w:numPr";
            }),
        );
        const rPr = elChildren(c).find((k) => elName(k) === "w:rPr");
        if (rPr) {
            setChildren(
                rPr,
                elChildren(rPr).filter((k) => {
                    const n = elName(k);
                    return n !== "w:ins" && n !== "w:del";
                }),
            );
        }
        paraKids.push(c);
    }
    if (runs.length) {
        paraKids.push(
            makeEl("w:del", runs, {
                "w:id": nextId(),
                "w:author": author,
                "w:date": date,
            }),
        );
    }
    const node = makeEl("w:p", paraKids);
    ensureParagraphMarkRevision(node, "w:del", {
        "w:id": nextId(),
        "w:author": author,
        "w:date": date,
    });
    return { node, text, dropped };
}

const INSERT_RUN_ALLOWED = new Set([
    "w:rPr",
    "w:t",
    "w:tab",
    "w:br",
    "w:cr",
    "w:noBreakHyphen",
    "w:softHyphen",
    "w:lastRenderedPageBreak",
    "w:footnoteReference",
    "w:endnoteReference",
    "w:commentReference",
    "w:drawing",
    "w:sym",
]);

/**
 * Validate that a new-only paragraph can be marked inserted: every run's
 * children are in the allowed set and only known containers appear.
 * Returns a reason string when it cannot, null when it can.
 */
function validateInsertable(pNode: XNode): string | null {
    const visitContainer = (kids: XNode[], allowPPr: boolean): string | null => {
        for (const k of kids) {
            const name = elName(k);
            if (!name) continue;
            if (name === "w:pPr") {
                if (!allowPPr) return `contains nested <${name}>`;
            } else if (name === "w:r") {
                for (const rk of elChildren(k)) {
                    const rn = elName(rk);
                    if (rn !== null && !INSERT_RUN_ALLOWED.has(rn)) {
                        return `contains run content <${rn}>`;
                    }
                }
            } else if (name === "w:hyperlink" || name === "w:smartTag") {
                const r = visitContainer(elChildren(k), false);
                if (r) return r;
            } else if (name === "w:sdt") {
                for (const c of elChildren(k)) {
                    if (elName(c) === "w:sdtContent") {
                        const r = visitContainer(elChildren(c), false);
                        if (r) return r;
                    }
                }
            } else if (
                name === "w:ins" ||
                name === "w:del" ||
                KEEP_PARA_CHILDREN.has(name)
            ) {
                // Existing revisions stay as they are; markers are inert.
            } else {
                return `contains <${name}>`;
            }
        }
        return null;
    };
    return visitContainer(elChildren(pNode), true);
}

/**
 * Wrap all runs of a new-only paragraph in w:ins (recursing into
 * hyperlinks, smart tags, and content-control content — Word's own
 * pattern puts w:ins inside those containers) and mark the paragraph
 * mark inserted.
 */
function markParagraphInserted(
    pNode: XNode,
    author: string,
    date: string,
    nextId: () => string,
): void {
    const wrapRuns = (kids: XNode[]): XNode[] => {
        const next: XNode[] = [];
        let group: XNode[] = [];
        const flush = () => {
            if (group.length) {
                next.push(
                    makeEl("w:ins", group, {
                        "w:id": nextId(),
                        "w:author": author,
                        "w:date": date,
                    }),
                );
                group = [];
            }
        };
        for (const k of kids) {
            const name = elName(k);
            if (name === "w:r") {
                group.push(k);
                continue;
            }
            flush();
            if (name === "w:hyperlink" || name === "w:smartTag") {
                setChildren(k, wrapRuns(elChildren(k)));
            } else if (name === "w:sdt") {
                for (const c of elChildren(k)) {
                    if (elName(c) === "w:sdtContent") {
                        setChildren(c, wrapRuns(elChildren(c)));
                    }
                }
            }
            next.push(k);
        }
        flush();
        return next;
    };
    setChildren(pNode, wrapRuns(elChildren(pNode)));
    ensureParagraphMarkRevision(pNode, "w:ins", {
        "w:id": nextId(),
        "w:author": author,
        "w:date": date,
    });
}

// ---------------------------------------------------------------------------
// Numbering signature + object detection
// ---------------------------------------------------------------------------

/**
 * Comparable numbering signature: presence of w:numPr and its ilvl.
 * numId values are NOT compared — the two packages number their abstract
 * lists independently, so equal-looking lists routinely carry different
 * ids. Only presence/level differences are trustworthy cross-package.
 */
function numberingSignature(pNode: XNode): string | null {
    const pPr = elChildren(pNode).find((k) => elName(k) === "w:pPr");
    if (!pPr) return null;
    const numPr = elChildren(pPr).find((k) => elName(k) === "w:numPr");
    if (!numPr) return null;
    const ilvl = elChildren(numPr).find((k) => elName(k) === "w:ilvl");
    const level = ilvl ? String(elAttrs(ilvl)["@_w:val"] ?? "0") : "0";
    return `ilvl:${level}`;
}

const OBJECT_ELEMENT_NAMES = new Set([
    "w:footnoteReference",
    "w:endnoteReference",
    "w:drawing",
    "w:object",
    "w:pict",
    "w:fldChar",
    "w:fldSimple",
]);

function subtreeContainsObjects(node: XNode): boolean {
    const name = elName(node);
    if (name && OBJECT_ELEMENT_NAMES.has(name)) return true;
    for (const c of elChildren(node)) {
        if (subtreeContainsObjects(c)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Auxiliary story comparison (headers / footers / footnotes / endnotes)
// ---------------------------------------------------------------------------

const STORY_PATTERNS: Array<{ code: string; label: string; pattern: RegExp }> = [
    {
        code: "headers_changed",
        label: "header",
        pattern: /^word[\/\\]header\d*\.xml$/iu,
    },
    {
        code: "footers_changed",
        label: "footer",
        pattern: /^word[\/\\]footer\d*\.xml$/iu,
    },
    {
        code: "footnotes_changed",
        label: "footnote",
        pattern: /^word[\/\\]footnotes\.xml$/iu,
    },
    {
        code: "endnotes_changed",
        label: "endnote",
        pattern: /^word[\/\\]endnotes\.xml$/iu,
    },
];

async function storyText(zip: JSZip, pattern: RegExp): Promise<string> {
    const files = zip
        .file(pattern)
        .sort((a, b) => a.name.localeCompare(b.name));
    const parts: string[] = [];
    for (const f of files) {
        const xml = await f.async("string");
        // Accepted view: deleted runs are not part of the story's text.
        const withoutDeleted = xml.replace(
            /<w:del\b[\s\S]*?<\/w:del>/gu,
            "",
        );
        const texts: string[] = [];
        for (const m of withoutDeleted.matchAll(
            /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu,
        )) {
            texts.push(decodeXmlText(m[1] ?? ""));
        }
        parts.push(texts.join(""));
    }
    return parts.join("\n");
}

async function compareAuxStories(
    oldZip: JSZip,
    newZip: JSZip,
): Promise<CompareAbstention[]> {
    const abstentions: CompareAbstention[] = [];
    for (const { code, label, pattern } of STORY_PATTERNS) {
        const [oldText, newText] = await Promise.all([
            storyText(oldZip, pattern),
            storyText(newZip, pattern),
        ]);
        if (normTrim(oldText) !== normTrim(newText)) {
            abstentions.push({
                reason:
                    `${code}: the ${label} story differs between the two ` +
                    "versions; compare_versions marks up the main document " +
                    "story only, so this difference is not shown in the " +
                    "redline",
                excerpt: excerptOf(newText || oldText),
            });
        }
    }
    return abstentions;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function compareDocxVersions(
    oldBytes: Buffer,
    newBytes: Buffer,
    options?: { author?: string },
): Promise<CompareDocxVersionsResult> {
    const author = options?.author ?? "Beaver";
    const now = new Date().toISOString();

    const [oldZip, newZip] = await Promise.all([
        loadZip(oldBytes),
        loadZip(newBytes),
    ]);
    const oldDocEntry = getZipEntry(oldZip, "word/document.xml");
    const newDocEntry = getZipEntry(newZip, "word/document.xml");
    if (!oldDocEntry) throw new Error("document.xml missing from old docx");
    if (!newDocEntry) throw new Error("document.xml missing from new docx");
    const [oldXmlRaw, newXmlRaw] = await Promise.all([
        oldDocEntry.async("string"),
        newDocEntry.async("string"),
    ]);

    const parser = createParser();
    const oldTree = parser.parse(oldXmlRaw) as XNode[];
    const newTree = parser.parse(newXmlRaw) as XNode[];
    const oldBody = findBody(oldTree);
    const newBody = findBody(newTree);
    if (!oldBody) throw new Error("w:body missing from old document.xml");
    if (!newBody) throw new Error("w:body missing from new document.xml");

    const changes: CompareChange[] = [];
    const abstentions: CompareAbstention[] = await compareAuxStories(
        oldZip,
        newZip,
    );

    const newBodyKids = elChildren(newBody);
    const oldBlocks = collectBlocks(elChildren(oldBody));
    const newBlocks = collectBlocks(newBodyKids);

    let endInsertIndex = newBodyKids.length;
    if (
        endInsertIndex > 0 &&
        elName(newBodyKids[endInsertIndex - 1]) === "w:sectPr"
    ) {
        endInsertIndex--;
    }

    const pairs = alignSequences(
        oldBlocks.map((b) => b.key),
        newBlocks.map((b) => b.key),
    );
    if (pairs === null) {
        abstentions.push({
            reason:
                "documents_too_divergent: the two versions share too " +
                "little aligned structure for a safe deterministic " +
                `comparison (${oldBlocks.length}×${newBlocks.length} ` +
                "blocks); the new version is returned without revision " +
                "marks",
            excerpt: excerptOf(newBlocks[0]?.text ?? ""),
        });
        return { bytes: newBytes, changes, abstentions };
    }

    let modified = false;
    let nextIdNum = maxTrackedId(newTree) + 1;
    const nextId = () => String(nextIdNum++);
    /** Deleted-paragraph splices: body index → nodes to insert before it. */
    const splices = new Map<number, XNode[]>();
    const queueSplice = (beforeIndex: number, node: XNode) => {
        const list = splices.get(beforeIndex) ?? [];
        list.push(node);
        splices.set(beforeIndex, list);
        modified = true;
    };

    const contextSlice = (text: string, from: number, to: number): string =>
        text.slice(Math.max(0, from), Math.min(text.length, to));

    /** Numbering-only representability check for an aligned pair. */
    const checkNumbering = (oldB: Block, newB: Block) => {
        const oldSig = numberingSignature(oldB.node);
        const newSig = numberingSignature(newB.node);
        if (oldSig !== newSig) {
            abstentions.push({
                reason:
                    "numbering_change_not_tracked: this paragraph's list " +
                    `numbering changed (${oldSig ?? "none"} → ` +
                    `${newSig ?? "none"}); numbering property changes are ` +
                    "not representable as text revisions and are left " +
                    "unmarked",
                excerpt: excerptOf(newB.text),
            });
        }
    };

    /** Word-diff a changed paragraph pair and rewrite the NEW node. */
    const handleChangedPair = (oldB: Block, newB: Block) => {
        if (oldB.text === newB.text) return;
        const flattened = flattenForRewrite(newB.node);
        if (!flattened.ok || flattened.flat.text !== newB.text) {
            const why = flattened.ok
                ? "its text has structure the differ cannot round-trip"
                : flattened.reason;
            abstentions.push({
                reason:
                    "paragraph_not_diffable: a changed paragraph " +
                    `${why}; it is left as the new version's text without ` +
                    "revision marks",
                excerpt: excerptOf(newB.text),
            });
            return;
        }
        if (subtreeContainsObjects(oldB.node)) {
            abstentions.push({
                reason:
                    "old_paragraph_objects_not_compared: the old version " +
                    "of a changed paragraph contains non-text content " +
                    "(fields, images, or note references); only its text " +
                    "was compared",
                excerpt: excerptOf(oldB.text),
            });
        }
        const clusters = wordDiffClusters(oldB.text, newB.text);
        if (clusters.length === 0) return;
        const rebuilt = rebuildParagraphChildren(
            newB.node,
            flattened.flat,
            clusters,
            author,
            now,
            nextId,
        );
        setChildren(newB.node, rebuilt.children);
        modified = true;
        for (const note of rebuilt.notes) {
            abstentions.push({ reason: note, excerpt: excerptOf(newB.text) });
        }
        for (const c of clusters) {
            const inserted = newB.text.slice(c.newStart, c.newEnd);
            changes.push({
                kind:
                    c.deleted && inserted
                        ? "replace"
                        : c.deleted
                          ? "delete"
                          : "insert",
                contextBefore: contextSlice(
                    newB.text,
                    c.newStart - CONTEXT_CHARS,
                    c.newStart,
                ),
                deletedText: c.deleted,
                insertedText: inserted,
                contextAfter: contextSlice(
                    newB.text,
                    c.newEnd,
                    c.newEnd + CONTEXT_CHARS,
                ),
            });
        }
    };

    const handleDeletedParagraph = (oldB: Block, beforeIndex: number) => {
        const result = buildDeletedParagraph(oldB.node, author, now, nextId);
        if (result.node === null) {
            abstentions.push({
                reason:
                    "deleted_paragraph_unrepresentable: a paragraph " +
                    "removed from the old version has no text content " +
                    `(only: ${[...result.dropped].join(", ")}); its ` +
                    "deletion is not shown in the redline",
                excerpt: excerptOf(result.text),
            });
            return;
        }
        if (result.dropped.size > 0) {
            abstentions.push({
                reason:
                    "deleted_paragraph_content_dropped: a deleted " +
                    "paragraph is shown in the redline but its non-text " +
                    `content (${[...result.dropped].join(", ")}) could ` +
                    "not be carried into the new document's package",
                excerpt: excerptOf(result.text),
            });
        }
        queueSplice(beforeIndex, result.node);
        changes.push({
            kind: "delete",
            contextBefore: "",
            deletedText: result.text,
            insertedText: "",
            contextAfter: "",
        });
    };

    const handleInsertedParagraph = (newB: Block) => {
        const problem = validateInsertable(newB.node);
        if (problem) {
            abstentions.push({
                reason:
                    "inserted_paragraph_not_markable: a paragraph added " +
                    `in the new version ${problem} and cannot be safely ` +
                    "wrapped in w:ins; it is included without revision " +
                    "marks",
                excerpt: excerptOf(newB.text),
            });
            return;
        }
        markParagraphInserted(newB.node, author, now, nextId);
        modified = true;
        changes.push({
            kind: "insert",
            contextBefore: "",
            deletedText: "",
            insertedText: newB.text,
            contextAfter: "",
        });
    };

    const blockLabel = (kind: "tbl" | "sdt") =>
        kind === "tbl" ? "table" : "content control";
    const blockCode = (kind: "tbl" | "sdt") =>
        kind === "tbl" ? "table" : "content_control";

    const processGap = (
        gapOld: Block[],
        gapNew: Block[],
        trailingBodyIndex: number,
    ) => {
        // Tables and block-level content controls: abstain, paired in order.
        for (const kind of ["tbl", "sdt"] as const) {
            const oldK = gapOld.filter((b) => b.kind === kind);
            const newK = gapNew.filter((b) => b.kind === kind);
            const paired = Math.min(oldK.length, newK.length);
            for (let k = 0; k < paired; k++) {
                abstentions.push({
                    reason:
                        `${blockCode(kind)}_changed: a ${blockLabel(kind)} ` +
                        "differs between the two versions; " +
                        `${blockLabel(kind)}s are not compared, and the ` +
                        "new version's content is included without " +
                        "revision marks",
                    excerpt: excerptOf(newK[k].text),
                });
            }
            for (let k = paired; k < oldK.length; k++) {
                abstentions.push({
                    reason:
                        `${blockCode(kind)}_removed: a ${blockLabel(kind)} ` +
                        "present in the old version does not appear in " +
                        "the new version; its removal is not shown in the " +
                        "redline",
                    excerpt: excerptOf(oldK[k].text),
                });
            }
            for (let k = paired; k < newK.length; k++) {
                abstentions.push({
                    reason:
                        `${blockCode(kind)}_added: a ${blockLabel(kind)} ` +
                        "added in the new version is included without " +
                        "revision marks; " +
                        `${blockLabel(kind)} changes are not tracked`,
                    excerpt: excerptOf(newK[k].text),
                });
            }
        }

        // Paragraphs: similarity-paired word diffs, whole-paragraph
        // deletes/inserts for the rest.
        const oldParas = gapOld.filter((b) => b.kind === "p");
        const newParas = gapNew.filter((b) => b.kind === "p");
        const ops = pairGapParagraphs(
            oldParas.map((b) => normTrim(b.text)),
            newParas.map((b) => normTrim(b.text)),
        );
        // For each op, the body index a deleted paragraph must precede:
        // the next new-side paragraph in the gap, else the trailing anchor.
        const anchors: number[] = new Array(ops.length);
        let carry = trailingBodyIndex;
        for (let k = ops.length - 1; k >= 0; k--) {
            anchors[k] = carry;
            const op = ops[k];
            if (op.op !== "del") carry = newParas[op.ni].bodyIndex;
        }
        for (let k = 0; k < ops.length; k++) {
            const op = ops[k];
            if (op.op === "sub") {
                checkNumbering(oldParas[op.oi], newParas[op.ni]);
                handleChangedPair(oldParas[op.oi], newParas[op.ni]);
            } else if (op.op === "del") {
                handleDeletedParagraph(oldParas[op.oi], anchors[k]);
            } else {
                handleInsertedParagraph(newParas[op.ni]);
            }
        }
    };

    // Walk matched pairs and the gaps between them (with a final sentinel
    // gap covering trailing unmatched blocks).
    let oi = 0;
    let ni = 0;
    for (let k = 0; k <= pairs.length; k++) {
        const isSentinel = k === pairs.length;
        const pi = isSentinel ? oldBlocks.length : pairs[k][0];
        const pj = isSentinel ? newBlocks.length : pairs[k][1];
        const trailing =
            pj < newBlocks.length
                ? newBlocks[pj].bodyIndex
                : endInsertIndex;
        processGap(
            oldBlocks.slice(oi, pi),
            newBlocks.slice(ni, pj),
            trailing,
        );
        if (isSentinel) break;
        const oldB = oldBlocks[pi];
        const newB = newBlocks[pj];
        if (oldB.kind === "p" && newB.kind === "p") {
            checkNumbering(oldB, newB);
            // Alignment normalizes whitespace/quotes; raw differences in a
            // matched pair (curly→straight quotes, spacing) still get a
            // real word-level diff so nothing changes silently.
            handleChangedPair(oldB, newB);
        }
        oi = pi + 1;
        ni = pj + 1;
    }

    if (!modified) {
        return { bytes: newBytes, changes, abstentions };
    }

    if (splices.size > 0) {
        const kids = elChildren(newBody);
        const rebuilt: XNode[] = [];
        for (let i = 0; i <= kids.length; i++) {
            const queued = splices.get(i);
            if (queued) rebuilt.push(...queued);
            if (i < kids.length) rebuilt.push(kids[i]);
        }
        setChildren(newBody, rebuilt);
    }

    const builder = createBuilder();
    const rebuiltXml = ensureXmlDeclaration(builder.build(newTree));
    setZipEntry(newZip, "word/document.xml", rebuiltXml);
    const outBytes = await newZip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: outBytes, changes, abstentions };
}
