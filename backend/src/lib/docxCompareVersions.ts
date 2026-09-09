/**
 * Deterministic old→new DOCX comparison. The new package is authoritative:
 * only document.xml is rewritten, with native w:ins/w:del revisions.
 * Unsupported structures stay untouched and produce typed abstentions.
 *
 * Block alignment determines paragraph correspondence; legal token
 * boundaries keep punctuation edits narrow. Shared tracked-change helpers
 * own package IO and revision attributes. This file keeps only the
 * comparison-specific reverse diff and cross-package safety rules.
 */

import diff from "fast-diff";
import {
    TEXT_KEY, type XNode, cloneNode, elAttrs, elChildren, elName,
    getTextContent, makeEl, makeText, setChildren,
} from "./docx/core";
import {
    type DocxParagraphIndex, type DocxRewriteAtom, type DocxSession,
    openDocxSession,
} from "./docx/session";
import {
    buildRun, emitDocxRevisionPlan, type DocxRevisionPlan, clusterTextChanges,
    markParagraphRevision, normalizeWs, revisionAttrs,
} from "./docxTrackedChanges";
import { decodeXmlText } from "./text";

export interface CompareChange {
    kind: "insert" | "delete" | "replace";
    deletedText: string;
    insertedText: string;
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

const EXCERPT_CHARS = 160;
const MAX_LCS_CELLS = 4_000_000;
const MAX_GAP_CELLS = 10_000;
const PAIR_SIMILARITY = 0.5;

function normTrim(s: string): string {
    return normalizeWs(s).norm.trim();
}

function excerptOf(s: string): string {
    const t = s.replace(/\s+/gu, " ").trim();
    return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS)}…` : t;
}

/** Every abstention names the affected text by bounded excerpt. */
function abstention(reason: string, source: string): CompareAbstention {
    return { reason, excerpt: excerptOf(source) };
}

interface Block {
    kind: "p" | "tbl" | "sdt";
    node: XNode;
    bodyIndex: number;
    text: string;
    key: string;
    paragraph?: DocxParagraphIndex;
}

function alignSequences(a: string[], b: string[]): Array<[number, number]> | null {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
        prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
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

    for (let k = suffix; k > 0; k--) pairs.push([a.length - k, b.length - k]);
    return pairs;
}

function similarity(aNorm: string, bNorm: string): number {
    const total = aNorm.length + bNorm.length;
    if (total === 0) return 1;
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

function pairGapParagraphs(oldNorms: string[], newNorms: string[]): GapOp[] {
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

// Word-level diff
// Mirrors quote_edits.py: punctuation stays separate; adjacent word/bracket
// tokens merge; quote, dash, and whitespace variants compare as equivalent.
// Case remains significant and original offsets/text are always emitted.

interface DiffCluster {
    /** Insert position in the NEW paragraph text. */
    newStart: number;
    /** End of the inserted new-text range (== newStart for pure deletes). */
    newEnd: number;
    /** Old text removed at newStart (may be empty for pure inserts). */
    deleted: string;
}

const DOUBLE_QUOTE_CHARS = new Set(['"', "“", "”", "«", "»", "„"]);
const SINGLE_QUOTE_CHARS = new Set(["'", "‘", "’", "‚"]);
const DASH_CHARS = new Set(["-", "­", "‐", "‑", "‒", "–",
    "—", "―", "−"]);
const DASH_FOLD_RE = /[­‐‑‒–—―−]/gu;

// quote_edits._WORD: letters/digits (no underscore) with internal
// apostrophes. The trailing `|.` catch-all makes the token stream a full
// partition of the input so offsets are exact.
const WORD_SRC = "[^\\W_]+(?:['\\u2019][^\\W_]+)*";
const TOKEN_RE = new RegExp(
    `\\s+|\\.\\.\\.|\\[[^\\]]+\\]|${WORD_SRC}|["\\u201C\\u201D\\u2018\\u2019]|[^\\w\\s]|.`,
    "gu",
);

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

function tokenizeForDiff(text: string): string[] {
    const merged: string[] = [];
    // TOKEN_RE covers every character, so consecutive matches are adjacent.
    for (const [token] of text.matchAll(TOKEN_RE)) {
        const previous = merged.at(-1);
        if (previous !== undefined && tokenMergeable(previous) && tokenMergeable(token)) {
            merged[merged.length - 1] += token;
        } else {
            merged.push(token);
        }
    }
    return merged;
}

function clustersInNewText(parts: Iterable<diff.Diff>): DiffCluster[] {
    return clusterTextChanges(parts, "new").map(({ offset, deleted, inserted }) => ({
        newStart: offset,
        newEnd: offset + inserted.length,
        deleted,
    }));
}

function wordDiffClusters(oldText: string, newText: string): DiffCluster[] {
    if (oldText === newText) return [];

    const oldToks = tokenizeForDiff(oldText);
    const newToks = tokenizeForDiff(newText);

    const codeByKey = new Map<string, string>();
    let overflow = false;
    const encode = (toks: string[]): string => {
        let out = "";
        for (const token of toks) {
            const key = tokenKey(token);
            let c = codeByKey.get(key);
            if (c === undefined) {
                const next = codeByKey.size + 1;
                if (next >= 0xd7ff) {
                    overflow = true;
                    return "";
                }
                c = String.fromCharCode(next);
                codeByKey.set(key, c);
            }
            out += c;
        }
        return out;
    };
    const encOld = encode(oldToks);
    const encNew = overflow ? "" : encode(newToks);
    if (overflow) return clustersInNewText(diff(oldText, newText, undefined, true));

    const parts: diff.Diff[] = [];
    let oi = 0;
    let nj = 0;
    for (const [op, encoded] of diff(encOld, encNew)) {
        const count = encoded.length;
        // Equal keys can have different lengths: offsets belong to the NEW text.
        const tokens = op === diff.DELETE
            ? oldToks.slice(oi, oi + count)
            : newToks.slice(nj, nj + count);
        parts.push([op, tokens.join("")]);
        if (op !== diff.INSERT) oi += count;
        if (op !== diff.DELETE) nj += count;
    }
    return clustersInNewText(parts);
}

const KEEP_PARA_CHILDREN = new Set(["w:bookmarkStart", "w:bookmarkEnd",
    "w:proofErr", "w:commentRangeStart", "w:commentRangeEnd"]);

interface RebuildResult {
    children: XNode[];
    notes: string[];
}

function planComparisonRevision(pNode: XNode,
    flat: { atoms: DocxRewriteAtom[]; text: string }, clusters: DiffCluster[],
    author: string, date: string, nextId: () => string): RebuildResult {
    const notes: string[] = [];
    const out: XNode[] = [];
    const plans: DocxRevisionPlan[] = [];
    const pPr = elChildren(pNode).find((k) => elName(k) === "w:pPr");
    if (pPr) out.push(pPr);

    // Deletions inherit the next textual atom's style (the last one at EOF).
    // Both lookups and emission advance through atoms, never through characters.
    let styleIndex = 0;
    let styleEnd = 0;
    let style: XNode | null = null;
    const rPrForPos = (position: number): XNode | null => {
        while (styleIndex < flat.atoms.length && styleEnd <= position) {
            const atom = flat.atoms[styleIndex++];
            if (atom.kind === "keep" || (atom.kind === "chars" && !atom.text)) continue;
            styleEnd += atom.kind === "chars" ? atom.text.length : 1;
            style = atom.rPr;
        }
        return style;
    };

    let run: { rPr: XNode | null; children: XNode[] } | null = null;
    let insertion: { cluster: DiffCluster; runs: XNode[] } | null = null;
    const closeRegion = () => {
        run = null;
        if (insertion) {
            plans.push({ start: out.length, end: out.length, replacement: insertion.runs,
                insertion: revisionAttrs(nextId(), author, date) });
            insertion = null;
        }
    };
    const selectRegion = (cluster: DiffCluster | null) => {
        if ((insertion?.cluster ?? null) === cluster) return;
        closeRegion();
        if (cluster) insertion = { cluster, runs: [] };
    };
    const currentInsertion = () => insertion;
    const append = (atom: Exclude<DocxRewriteAtom, { kind: "keep" }>, text: string) => {
        if (!run || run.rPr !== atom.rPr) {
            const children = atom.rPr ? [cloneNode(atom.rPr)] : [];
            (insertion ? insertion.runs : out).push(makeEl("w:r", children));
            run = { rPr: atom.rPr, children };
        }
        const last = run.children[run.children.length - 1];
        if (atom.kind === "chars" && elName(last) === "w:t") {
            const node = elChildren(last)[0]; // Only text emitted here enters this buffer.
            node[TEXT_KEY] = String(node[TEXT_KEY]) + text;
        } else {
            run.children.push(atom.kind === "chars"
                ? makeEl("w:t", [makeText(text)], { "xml:space": "preserve" })
                : makeEl(atom.kind === "tab" ? "w:tab" : "w:br", []));
        }
    };

    let nextCluster = 0;
    let active: DiffCluster | null = null;
    const advance = (position: number) => {
        while (nextCluster < clusters.length && clusters[nextCluster].newStart <= position) {
            const cluster = clusters[nextCluster++];
            if (cluster.deleted) {
                closeRegion();
                plans.push({ start: out.length, end: out.length, replacement: [], deletion: {
                    nodes: [buildRun(rPrForPos(cluster.newStart), cluster.deleted, "w:delText", true)],
                    attributes: revisionAttrs(nextId(), author, date) } });
            }
            active = cluster;
        }
        if (active && active.newEnd <= position) active = null;
        return active;
    };

    let position = 0;
    for (const atom of flat.atoms) {
        if (atom.kind === "keep") {
            advance(position);
            const inserted = currentInsertion();
            if (inserted && inserted.cluster.newStart < position && position < inserted.cluster.newEnd) {
                notes.push("inline_object_in_inserted_range: an inline object " +
                    "inside inserted text was preserved but not itself marked as inserted");
            }
            closeRegion();
            out.push(atom.node);
            continue;
        }
        const text = atom.kind === "chars" ? atom.text : atom.kind === "tab" ? "\t" : "\n";
        let offset = 0;
        while (offset < text.length) {
            const cluster = advance(position);
            const boundary = cluster?.newEnd ?? clusters[nextCluster]?.newStart ?? Infinity;
            const length = Math.min(text.length - offset, boundary - position);
            selectRegion(cluster);
            append(atom, text.slice(offset, offset + length));
            position += length;
            offset += length;
        }
        if (!text.length) advance(position);
    }
    advance(position);
    closeRegion();
    return { children: emitDocxRevisionPlan(out, plans), notes };
}

const DELETED_RUN_TEXTUAL = new Set(["w:tab", "w:br", "w:cr", "w:noBreakHyphen",
    "w:softHyphen", "w:sym"]);

interface DeletedParagraphResult {
    /** Null when the paragraph has no representable content at all. */
    node: XNode | null;
    text: string;
    /** Kinds of old content that could not be carried across packages. */
    dropped: Set<string>;
}

function buildDeletedParagraph(oldP: XNode, text: string, author: string,
    date: string, nextId: () => string): DeletedParagraphResult {
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
                kids.push(makeEl("w:delText", [makeText(getTextContent(rk))],
                    { "xml:space": "preserve" }));
                hasContent = true;
            } else if (DELETED_RUN_TEXTUAL.has(rn)) {
                kids.push(cloneNode(rk));
                hasContent = true;
            } else if (rn === "w:lastRenderedPageBreak") {
            } else if (rn === "w:commentReference") {
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
                visit(elChildren(k));
            } else if (name === "w:del") {
            } else if (name === "w:sdt") {
                dropped.add("content control");
                for (const c of elChildren(k)) {
                    if (elName(c) === "w:sdtContent") visit(elChildren(c));
                }
            } else if (name === "w:fldSimple") {
                dropped.add("field");
                visit(elChildren(k));
            } else if (KEEP_PARA_CHILDREN.has(name)) {
            } else {
                dropped.add(name);
            }
        }
    };
    visit(elChildren(oldP));

    if (runs.length === 0 && dropped.size > 0) {
        return { node: null, text, dropped };
    }

    const paraKids: XNode[] = [];
    const oldPPr = elChildren(oldP).find((k) => elName(k) === "w:pPr");
    if (oldPPr) {
        const drop = (node: XNode, names: string[]) => setChildren(node,
            elChildren(node).filter((k) => !names.includes(elName(k) ?? "")));
        const c = cloneNode(oldPPr);
        drop(c, ["w:sectPr", "w:numPr"]);
        const rPr = elChildren(c).find((k) => elName(k) === "w:rPr");
        if (rPr) drop(rPr, ["w:ins", "w:del"]);
        paraKids.push(c);
    }
    if (runs.length) {
        paraKids.push(...emitDocxRevisionPlan([], [{ start: 0, end: 0, replacement: [],
            deletion: { nodes: runs, attributes: revisionAttrs(nextId(), author, date) } }]));
    }
    const node = makeEl("w:p", paraKids);
    markParagraphRevision(node, "w:del", revisionAttrs(nextId(), author, date));
    return { node, text, dropped };
}

const INSERT_RUN_ALLOWED = new Set(["w:rPr", "w:t", "w:tab", "w:br", "w:cr",
    "w:noBreakHyphen", "w:softHyphen", "w:lastRenderedPageBreak",
    "w:footnoteReference", "w:endnoteReference", "w:commentReference",
    "w:drawing", "w:sym"]);

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
            } else {
                return `contains <${name}>`;
            }
        }
        return null;
    };
    return visitContainer(elChildren(pNode), true);
}

function markParagraphInserted(pNode: XNode, author: string, date: string,
    nextId: () => string): void {
    const wrapRuns = (kids: XNode[]): XNode[] => {
        const next: XNode[] = [];
        let group: XNode[] = [];
        const flush = () => {
            if (group.length) {
                next.push(...emitDocxRevisionPlan([], [{ start: 0, end: 0, replacement: group,
                    insertion: revisionAttrs(nextId(), author, date) }]));
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
    markParagraphRevision(pNode, "w:ins", revisionAttrs(nextId(), author, date));
}

/** numId is package-local; only list presence and level compare reliably. */
function numberingSignature(pNode: XNode): string | null {
    const pPr = elChildren(pNode).find((k) => elName(k) === "w:pPr");
    if (!pPr) return null;
    const numPr = elChildren(pPr).find((k) => elName(k) === "w:numPr");
    if (!numPr) return null;
    const ilvl = elChildren(numPr).find((k) => elName(k) === "w:ilvl");
    const level = ilvl ? String(elAttrs(ilvl)["@_w:val"] ?? "0") : "0";
    return `ilvl:${level}`;
}

const STORY_PATTERNS = [
    ["headers_changed", "header", /^word[\/\\]header\d*\.xml$/iu],
    ["footers_changed", "footer", /^word[\/\\]footer\d*\.xml$/iu],
    ["footnotes_changed", "footnote", /^word[\/\\]footnotes\.xml$/iu],
    ["endnotes_changed", "endnote", /^word[\/\\]endnotes\.xml$/iu],
] as const;

async function storyText(session: DocxSession, pattern: RegExp): Promise<string> {
    const paths = session.paths.filter((path) => pattern.test(path));
    const parts = await Promise.all(paths.map(async (path) => {
        const xml = ((await session.readText(path)) ?? "")
            .replace(/<w:del\b[\s\S]*?<\/w:del>/gu, "");
        return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)]
            .map((match) => decodeXmlText(match[1] ?? ""))
            .join("");
    }));
    return parts.join("\n");
}

async function compareAuxStories(oldSession: DocxSession,
    newSession: DocxSession): Promise<CompareAbstention[]> {
    const abstentions: CompareAbstention[] = [];
    for (const [code, label, pattern] of STORY_PATTERNS) {
        const [oldText, newText] = await Promise.all([
            storyText(oldSession, pattern), storyText(newSession, pattern)]);
        if (normTrim(oldText) !== normTrim(newText)) {
            abstentions.push(abstention(
                `${code}: the ${label} story differs between the two ` +
                "versions; compare_versions marks up the main document " +
                "story only, so this difference is not shown in the " +
                "redline",
                newText || oldText));
        }
    }
    return abstentions;
}

export async function compareDocxVersions(oldBytes: Buffer, newBytes: Buffer,
    options?: { author?: string }): Promise<CompareDocxVersionsResult> {
    const author = options?.author ?? "Beaver";
    const now = new Date().toISOString();

    const [oldSession, newSession] = await Promise.all([
        openDocxSession(oldBytes), openDocxSession(newBytes)]);
    const [oldDocument, newDocument] = await Promise.all([
        oldSession.document("old docx"), newSession.document("new docx")]);
    const { tree: newTree, body: newBody } = newDocument;

    const changes: CompareChange[] = [];
    const abstentions = await compareAuxStories(oldSession, newSession);
    const abstain = (reason: string, source: string) =>
        abstentions.push(abstention(reason, source));
    const record = (deletedText: string, insertedText: string,
        kind: CompareChange["kind"] = deletedText && insertedText ? "replace"
            : deletedText ? "delete" : "insert") =>
        changes.push({ kind, deletedText, insertedText });

    const newBodyKids = elChildren(newBody);
    const blocksFor = (document: typeof oldDocument): Block[] => {
        const paragraphs = new Map(
            document.paragraphs.map((paragraph) => [paragraph.node, paragraph]),
        );
        return document.blocks.map((block) => ({
            ...block,
            key: `${block.kind}:${normTrim(block.text)}`,
            paragraph: paragraphs.get(block.node),
        }));
    };
    const oldBlocks = blocksFor(oldDocument);
    const newBlocks = blocksFor(newDocument);

    let endInsertIndex = newBodyKids.length;
    if (endInsertIndex > 0 &&
        elName(newBodyKids[endInsertIndex - 1]) === "w:sectPr") endInsertIndex--;

    const pairs = alignSequences(oldBlocks.map((b) => b.key),
        newBlocks.map((b) => b.key));
    if (pairs === null) {
        abstain(
            "documents_too_divergent: the two versions share too " +
            "little aligned structure for a safe deterministic " +
            `comparison (${oldBlocks.length}×${newBlocks.length} ` +
            "blocks); the new version is returned without revision " +
            "marks",
            newBlocks[0]?.text ?? "");
        return { bytes: newBytes, changes, abstentions };
    }

    let modified = false;
    let nextIdNum = newDocument.maxTrackedId + 1;
    const nextId = () => String(nextIdNum++);
    /** Deleted-paragraph splices: body index → nodes to insert before it. */
    const splices = new Map<number, XNode[]>();
    const queueSplice = (beforeIndex: number, node: XNode) => {
        const list = splices.get(beforeIndex) ?? [];
        list.push(node);
        splices.set(beforeIndex, list);
        modified = true;
    };

    /** Numbering-only representability check for an aligned pair. */
    const checkNumbering = (oldB: Block, newB: Block) => {
        const oldSig = numberingSignature(oldB.node);
        const newSig = numberingSignature(newB.node);
        if (oldSig !== newSig) {
            abstain(
                "numbering_change_not_tracked: this paragraph's list " +
                `numbering changed (${oldSig ?? "none"} → ` +
                `${newSig ?? "none"}); numbering property changes are ` +
                "not representable as text revisions and are left " +
                "unmarked",
                newB.text);
        }
    };

    /** Word-diff a changed paragraph pair and rewrite the NEW node. */
    const handleChangedPair = (oldB: Block, newB: Block) => {
        if (oldB.text === newB.text) return;
        const flattened = newB.paragraph!.rewrite;
        if (!flattened.ok || flattened.text !== newB.text) {
            const why = flattened.ok
                ? "its text has structure the differ cannot round-trip"
                : flattened.reason;
            abstain(
                "paragraph_not_diffable: a changed paragraph " +
                `${why}; it is left as the new version's text without ` +
                "revision marks",
                newB.text);
            return;
        }
        if (oldB.paragraph!.containsObjects) {
            abstain(
                "old_paragraph_objects_not_compared: the old version " +
                "of a changed paragraph contains non-text content " +
                "(fields, images, or note references); only its text " +
                "was compared",
                oldB.text);
        }
        const clusters = wordDiffClusters(oldB.text, newB.text);
        if (clusters.length === 0) return;
        const rebuilt = planComparisonRevision(newB.node, flattened, clusters,
            author, now, nextId);
        setChildren(newB.node, rebuilt.children);
        modified = true;
        for (const note of rebuilt.notes) abstain(note, newB.text);
        for (const c of clusters) {
            record(c.deleted, newB.text.slice(c.newStart, c.newEnd));
        }
    };

    const handleDeletedParagraph = (oldB: Block, beforeIndex: number) => {
        const result = buildDeletedParagraph(oldB.node, oldB.text, author, now,
            nextId);
        if (result.node === null) {
            abstain(
                "deleted_paragraph_unrepresentable: a paragraph " +
                "removed from the old version has no text content " +
                `(only: ${[...result.dropped].join(", ")}); its ` +
                "deletion is not shown in the redline",
                result.text);
            return;
        }
        if (result.dropped.size > 0) {
            abstain(
                "deleted_paragraph_content_dropped: a deleted " +
                "paragraph is shown in the redline but its non-text " +
                `content (${[...result.dropped].join(", ")}) could ` +
                "not be carried into the new document's package",
                result.text);
        }
        queueSplice(beforeIndex, result.node);
        record(result.text, "", "delete");
    };

    const handleInsertedParagraph = (newB: Block) => {
        const problem = validateInsertable(newB.node);
        if (problem) {
            abstain(
                "inserted_paragraph_not_markable: a paragraph added " +
                `in the new version ${problem} and cannot be safely ` +
                "wrapped in w:ins; it is included without revision " +
                "marks",
                newB.text);
            return;
        }
        markParagraphInserted(newB.node, author, now, nextId);
        modified = true;
        record("", newB.text, "insert");
    };

    const blockLabel = (k: "tbl" | "sdt") => k === "tbl" ? "table" : "content control";
    const blockCode = (k: "tbl" | "sdt") => k === "tbl" ? "table" : "content_control";

    const processGap = (
        gapOld: Block[],
        gapNew: Block[],
        trailingBodyIndex: number,
    ) => {
        for (const kind of ["tbl", "sdt"] as const) {
            const oldK = gapOld.filter((b) => b.kind === kind);
            const newK = gapNew.filter((b) => b.kind === kind);
            const paired = Math.min(oldK.length, newK.length);
            for (let k = 0; k < paired; k++) {
                abstain(
                    `${blockCode(kind)}_changed: a ${blockLabel(kind)} ` +
                    "differs between the two versions; " +
                    `${blockLabel(kind)}s are not compared, and the ` +
                    "new version's content is included without " +
                    "revision marks",
                    newK[k].text);
            }
            for (let k = paired; k < oldK.length; k++) {
                abstain(
                    `${blockCode(kind)}_removed: a ${blockLabel(kind)} ` +
                    "present in the old version does not appear in " +
                    "the new version; its removal is not shown in the " +
                    "redline",
                    oldK[k].text);
            }
            for (let k = paired; k < newK.length; k++) {
                abstain(
                    `${blockCode(kind)}_added: a ${blockLabel(kind)} ` +
                    "added in the new version is included without " +
                    "revision marks; " +
                    `${blockLabel(kind)} changes are not tracked`,
                    newK[k].text);
            }
        }

        const oldParas = gapOld.filter((b) => b.kind === "p");
        const newParas = gapNew.filter((b) => b.kind === "p");
        const ops = pairGapParagraphs(
            oldParas.map((b) => normTrim(b.text)),
            newParas.map((b) => normTrim(b.text)),
        );
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

    let oi = 0;
    let ni = 0;
    for (let k = 0; k <= pairs.length; k++) {
        const isSentinel = k === pairs.length;
        const pi = isSentinel ? oldBlocks.length : pairs[k][0];
        const pj = isSentinel ? newBlocks.length : pairs[k][1];
        const trailing = pj < newBlocks.length
            ? newBlocks[pj].bodyIndex : endInsertIndex;
        processGap(oldBlocks.slice(oi, pi), newBlocks.slice(ni, pj), trailing);
        if (isSentinel) break;
        const oldB = oldBlocks[pi];
        const newB = newBlocks[pj];
        if (oldB.kind === "p" && newB.kind === "p") {
            checkNumbering(oldB, newB);
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

    newSession.writeDocument(newTree);
    return { bytes: await newSession.save(), changes, abstentions };
}
