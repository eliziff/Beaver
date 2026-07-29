/**
 * DOCX tracked-changes helpers.
 *
 * `applyTrackedEdits` rewrites a .docx so that the requested substitutions
 * appear as `<w:ins>` / `<w:del>` tracked changes rather than direct text
 * replacements. `resolveTrackedChange` accepts or rejects one change by
 * its `w:id`, producing a new .docx with only that change collapsed.
 *
 * Only text inside `<w:p><w:r><w:t>` is considered. Headers, footers,
 * comments, footnotes are left alone. Pre-existing tracked changes in the
 * paragraph are presented to the matcher in *accepted view*: w:ins runs are
 * treated as normal text, w:del wrappers are invisible. When a new edit's
 * range lands on runs inside a pre-existing w:ins, the wrapper is dropped
 * (accepting that insertion) before the new change is emitted.
 */

import type JSZip from "jszip";
import diff from "fast-diff";
import { loadZip } from "./zip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

// Some older Windows/Word archives store entries with backslash path
// separators (e.g. `word\document.xml`) even though the zip spec requires
// forward slashes. JSZip looks up entries by exact string, so
// `zip.file("word/document.xml")` misses those files. These helpers accept
// the canonical forward-slash form and transparently fall back to the
// backslash variant for both reads and writes.

function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(
    zip: JSZip,
    pathSlash: string,
    content: string | Buffer,
): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    // If the archive already stores the entry under backslashes, keep it
    // there so we don't emit both variants side by side.
    if (!zip.file(pathSlash) && zip.file(backslash)) {
        zip.file(backslash, content);
        return;
    }
    zip.file(pathSlash, content);
}

export interface EditInput {
    find: string;
    replace: string;
    context_before: string;
    context_after: string;
    reason?: string;
}

interface AppliedChange {
    id: string;
    delId?: string;
    insId?: string;
    deletedText: string;
    insertedText: string;
    contextBefore: string;
    contextAfter: string;
    reason?: string;
}

interface EditError {
    index: number;
    reason: string;
}

export interface ApplyTrackedEditsResult {
    bytes: Buffer;
    changes: AppliedChange[];
    errors: EditError[];
    /** anchored Word comments created from edit reasons (annotate mode) */
    comments: number;
}

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
    // A w:t node has only a single text child (or nothing).
    const kids = elChildren(wtEl);
    let out = "";
    for (const k of kids) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

// Build a w:r element that wraps a piece of text. Newlines in the text are
// emitted as <w:br/> soft line breaks (interleaved with w:t/w:delText
// segments) so models can request multi-line replacements without the
// literal "\n" showing up as visible text.
function buildRun(rPr: XNode | null, text: string, tagName: "w:t" | "w:delText"): XNode {
    const children: XNode[] = [];
    if (rPr) children.push(cloneNode(rPr));
    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
        if (i > 0) children.push(makeEl("w:br", []));
        const seg = segments[i];
        if (seg.length > 0) {
            children.push(
                makeEl(tagName, [makeText(seg)], { "xml:space": "preserve" }),
            );
        }
    }
    return makeEl("w:r", children);
}

function cloneNode<T>(n: T): T {
    return JSON.parse(JSON.stringify(n)) as T;
}

interface RunSlot {
    childIndex: number;         // index in paragraph.children
    rPr: XNode | null;          // reference (not cloned)
    protectedByContentControl: boolean;
    /**
     * Per-w:t info. Slots preserve the relative order of the run's textual
     * children. Non-textual run children (w:tab, w:br, ...) are ignored for
     * the char stream but left in place via their surrounding w:r.
     */
    textNodes: { wtEl: XNode; text: string; paraStart: number; paraEnd: number }[];
}

interface Flattened {
    paraText: string;
    // For each char index in paraText: which run slot + which textNode + offset within text
    charRun: Int32Array;      // runIdx
    charTextNode: Int32Array; // index into slot.textNodes
    charOffset: Int32Array;   // offset within that textNode.text
    runs: RunSlot[];          // order corresponds to their paragraph position
}

function flattenParagraph(paraChildren: XNode[]): Flattened {
    const runs: RunSlot[] = [];
    let paraText = "";
    const charRunArr: number[] = [];
    const charTextNodeArr: number[] = [];
    const charOffsetArr: number[] = [];

    const processRun = (
        rEl: XNode,
        topChildIdx: number,
        protectedByContentControl: boolean,
    ) => {
        const rKids = elChildren(rEl);
        let rPr: XNode | null = null;
        const textNodes: RunSlot["textNodes"] = [];
        for (const rk of rKids) {
            const name = elName(rk);
            if (name === "w:rPr") {
                rPr = rk;
            } else if (name === "w:t") {
                const txt = getTextContent(rk);
                const start = paraText.length;
                textNodes.push({
                    wtEl: rk,
                    text: txt,
                    paraStart: start,
                    paraEnd: start + txt.length,
                });
                const runIdx = runs.length;
                const tnIdx = textNodes.length - 1;
                paraText += txt;
                for (let i = 0; i < txt.length; i++) {
                    charRunArr.push(runIdx);
                    charTextNodeArr.push(tnIdx);
                    charOffsetArr.push(i);
                }
            }
            // other run children (w:tab, w:br, w:sym, …) are left alone
        }
        runs.push({
            childIndex: topChildIdx,
            rPr,
            textNodes,
            protectedByContentControl,
        });
    };

    const processAcceptedNode = (
        node: XNode,
        topChildIdx: number,
        protectedByContentControl = false,
    ) => {
        const name = elName(node);
        if (name === "w:r") {
            processRun(node, topChildIdx, protectedByContentControl);
        } else if (name === "w:ins" || name === "w:sdtContent") {
            for (const child of elChildren(node)) {
                processAcceptedNode(
                    child,
                    topChildIdx,
                    protectedByContentControl,
                );
            }
        } else if (name === "w:sdt") {
            for (const child of elChildren(node)) {
                if (elName(child) === "w:sdtContent") {
                    processAcceptedNode(child, topChildIdx, true);
                }
            }
        }
        // w:del and unsupported children are absent from accepted text.
    };

    for (let ci = 0; ci < paraChildren.length; ci++) {
        processAcceptedNode(paraChildren[ci], ci);
    }

    return {
        paraText,
        charRun: Int32Array.from(charRunArr),
        charTextNode: Int32Array.from(charTextNodeArr),
        charOffset: Int32Array.from(charOffsetArr),
        runs,
    };
}

/**
 * A single logical change. Spans a contiguous [start, end) character range in
 * the paragraph text (may be empty for a pure insert) and may carry an
 * inserted string appended at `start`.
 */
interface PlannedChange {
    editIndex: number;            // source edit index
    deleteStart: number;          // paragraph text offset (inclusive)
    deleteEnd: number;            // paragraph text offset (exclusive); may equal start
    deletedText: string;          // substring of paraText in [start, end)
    insertedText: string;         // may be empty
    contextBefore: string;
    contextAfter: string;
    reason?: string;
    changeId: string;             // logical id (not the w:id)
    delWId?: string;              // w:id of w:del wrapper (if deletedText non-empty)
    insWId?: string;              // w:id of w:ins wrapper (if insertedText non-empty)
}

/**
 * Split one matched edit into its minimal change clusters using `fast-diff`
 * with semantic cleanup, so fixing "paras 332-334" is one deleted "3" — and a
 * two-spot edit is two tiny tracked changes — instead of one giant
 * delete-and-reinsert of everything between the first and last difference.
 * Each cluster is a contiguous deleted range of `find` (empty for a pure
 * insertion) plus the text inserted at its start; the semantic cleanup keeps
 * word-shaped changes whole rather than character confetti.
 */
function minimalEditClusters(
    find: string,
    replace: string,
): { offset: number; deleted: string; inserted: string }[] {
    const clusters: { offset: number; deleted: string; inserted: string }[] = [];
    let offset = 0;
    for (const [op, text] of diff(find, replace, undefined, true)) {
        if (op === diff.EQUAL) {
            offset += text.length;
            continue;
        }
        const last = clusters[clusters.length - 1];
        let cluster: { offset: number; deleted: string; inserted: string };
        if (last && last.offset + last.deleted.length === offset) {
            cluster = last;
        } else {
            cluster = { offset, deleted: "", inserted: "" };
            clusters.push(cluster);
        }
        if (op === diff.DELETE) {
            cluster.deleted += text;
            offset += text.length;
        } else {
            cluster.inserted += text;
        }
    }
    return clusters;
}

/**
 * Given a paragraph's children and a sorted, non-overlapping list of
 * `PlannedChange`s that fall within it, return a new children array with
 * tracked changes inserted.
 */
function reconstructParagraph(
    paraChildren: XNode[],
    flat: Flattened,
    plan: PlannedChange[],
    now: string,
    author: string,
): XNode[] {
    if (plan.length === 0) return paraChildren;

    // Determine the run-index span that edits touch.
    let firstRunIdx = flat.runs.length;
    let lastRunIdx = -1;
    for (const p of plan) {
        for (let pos = p.deleteStart; pos < p.deleteEnd; pos++) {
            const r = flat.charRun[pos];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
        // Also include the run to the left/right of a pure insertion so we
        // can inherit its rPr.
        if (p.deleteStart === p.deleteEnd && p.deleteStart < flat.paraText.length) {
            const r = flat.charRun[p.deleteStart];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        } else if (p.deleteStart === p.deleteEnd && p.deleteStart > 0) {
            const r = flat.charRun[p.deleteStart - 1];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
    }
    if (firstRunIdx > lastRunIdx) {
        // No runs touched (edits against empty paragraph?) — nothing to do.
        return paraChildren;
    }

    // Child-index range in paragraph.children we are going to replace.
    const startChildIdx = flat.runs[firstRunIdx].childIndex;
    const endChildIdx = flat.runs[lastRunIdx].childIndex;

    // Paragraph-text range that this run span covers.
    const firstRun = flat.runs[firstRunIdx];
    const lastRun = flat.runs[lastRunIdx];
    const spanStart =
        firstRun.textNodes.length > 0 ? firstRun.textNodes[0].paraStart : 0;
    const spanEnd =
        lastRun.textNodes.length > 0
            ? lastRun.textNodes[lastRun.textNodes.length - 1].paraEnd
            : spanStart;

    // Walk [spanStart, spanEnd) in paraText, producing a new children array.
    const newRunGroup: XNode[] = [];

    // Helper: get the rPr for the run containing paragraph offset `pos`
    // (clamped to the touched span). Used to inherit formatting for
    // insertions that fall exactly on a boundary.
    const rPrForPos = (pos: number): XNode | null => {
        if (pos < 0) pos = 0;
        if (pos >= flat.paraText.length) pos = flat.paraText.length - 1;
        if (pos < 0) return firstRun.rPr;
        return flat.runs[flat.charRun[pos]].rPr;
    };

    // Emit a "normal" run fragment covering [a, b) of paraText, grouping
    // consecutive chars that belong to the same source text node.
    const emitNormal = (a: number, b: number) => {
        if (a >= b) return;
        let i = a;
        while (i < b) {
            const runIdx = flat.charRun[i];
            const tnIdx = flat.charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                flat.charRun[j] === runIdx &&
                flat.charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const rPr = slot.rPr;
            const slice = flat.paraText.slice(i, j);
            newRunGroup.push(buildRun(rPr, slice, "w:t"));
            i = j;
        }
    };

    // Emit a w:del wrapping run fragments covering [a, b) of paraText.
    const emitDel = (a: number, b: number, wId: string) => {
        if (a >= b) return;
        const inner: XNode[] = [];
        let i = a;
        while (i < b) {
            const runIdx = flat.charRun[i];
            const tnIdx = flat.charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                flat.charRun[j] === runIdx &&
                flat.charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const slice = flat.paraText.slice(i, j);
            inner.push(buildRun(slot.rPr, slice, "w:delText"));
            i = j;
        }
        newRunGroup.push(
            makeEl("w:del", inner, {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    // Emit a w:ins at position `pos` inheriting rPr from there.
    const emitIns = (pos: number, text: string, wId: string) => {
        if (!text) return;
        const rPr = rPrForPos(pos === spanEnd ? pos - 1 : pos);
        const run = buildRun(rPr, text, "w:t");
        newRunGroup.push(
            makeEl("w:ins", [run], {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    let cursor = spanStart;
    for (const p of plan) {
        // Untouched slice before this edit
        emitNormal(cursor, p.deleteStart);
        // Insertion fires at the edit boundary
        if (p.insertedText) emitIns(p.deleteStart, p.insertedText, p.insWId!);
        // Deletion wraps the span
        if (p.deleteEnd > p.deleteStart)
            emitDel(p.deleteStart, p.deleteEnd, p.delWId!);
        cursor = p.deleteEnd;
    }
    emitNormal(cursor, spanEnd);

    // Replace only the w:r children that the edits touch; preserve any other
    // interleaved elements (bookmarks, existing tracked-changes, w:sdt …) at
    // their original positions.
    const droppedChildIdx = new Set<number>();
    for (let r = firstRunIdx; r <= lastRunIdx; r++) {
        droppedChildIdx.add(flat.runs[r].childIndex);
    }
    // Any w:del wrappers that sit inside the span we're rewriting are also
    // dropped, which accepts their deletions (their text is already absent
    // from paraText in the accepted view).
    for (let i = startChildIdx; i <= endChildIdx; i++) {
        if (elName(paraChildren[i]) === "w:del") droppedChildIdx.add(i);
    }
    const firstDroppedIdx = startChildIdx;
    void endChildIdx;
    const out: XNode[] = [];
    for (let i = 0; i < paraChildren.length; i++) {
        if (i === firstDroppedIdx) {
            for (const n of newRunGroup) out.push(n);
        }
        if (droppedChildIdx.has(i)) continue;
        out.push(paraChildren[i]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Locating context in the document
// ---------------------------------------------------------------------------

interface ParagraphRef {
    paraNode: XNode;
    paraChildren: XNode[];
    flat: Flattened;
    globalStart: number; // where this paragraph starts in the full doc text
}

// --- Whitespace / punctuation normalization for anchor matching -------------
// The text LLMs see (via mammoth's extractRawText) does not line up 1:1 with
// the raw w:t concatenation: smart quotes, non-breaking spaces, tabs, and
// runs of whitespace all differ. We normalize both haystack and needle to
// a canonical form for matching, then map matched offsets back to the
// original paragraph text.

function preNormalize(s: string): string {
    // All 1-to-1 character replacements — preserves length for straightforward
    // index mapping.
    return s
        .replace(/[\u2018\u2019\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/\u00A0/g, " ")
        .replace(/\u200B/g, " ");
}

interface Normalized {
    norm: string;
    // origIdx[i] = index in the *original* string for norm[i]
    origIdx: number[];
}

export function normalizeWs(input: string): Normalized {
    const s = preNormalize(input);
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch);
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

/**
 * Locate the unique position in `hayNorm` where `findNorm` appears AND is
 * preceded by `ctxBeforeNorm` AND followed by `ctxAfterNorm`. The context
 * check uses direct string-slice equality rather than concatenation so
 * boundary-whitespace collapsing doesn't matter. Returns the normalized
 * [start, end) range of the `find` portion, or a structured error.
 */
function findUniqueAnchor(
    hayNorm: string,
    findNorm: string,
    ctxBeforeNorm: string,
    ctxAfterNorm: string,
): { start: number; end: number } | { error: "none" | "ambiguous" } {
    const candidates: number[] = [];

    const checkCtx = (pos: number): boolean => {
        if (ctxBeforeNorm) {
            const start = pos - ctxBeforeNorm.length;
            if (start < 0) return false;
            if (hayNorm.slice(start, pos) !== ctxBeforeNorm) return false;
        }
        if (ctxAfterNorm) {
            const end = pos + findNorm.length;
            if (hayNorm.slice(end, end + ctxAfterNorm.length) !== ctxAfterNorm)
                return false;
        }
        return true;
    };

    if (findNorm.length === 0) {
        // Pure insertion — scan every position
        for (let i = 0; i <= hayNorm.length; i++) {
            if (checkCtx(i)) candidates.push(i);
        }
    } else {
        let from = 0;
        while (from <= hayNorm.length - findNorm.length) {
            const idx = hayNorm.indexOf(findNorm, from);
            if (idx < 0) break;
            if (checkCtx(idx)) candidates.push(idx);
            from = idx + 1;
        }
    }

    if (candidates.length === 0) return { error: "none" };
    if (candidates.length > 1) return { error: "ambiguous" };
    return {
        start: candidates[0],
        end: candidates[0] + findNorm.length,
    };
}

/** Map a normalized [start, end) range back to the original string range. */
function mapNormRangeToOriginal(
    paraNorm: Normalized,
    origLen: number,
    normStart: number,
    normEnd: number,
): { start: number; end: number } {
    const origStart =
        normStart < paraNorm.origIdx.length
            ? paraNorm.origIdx[normStart]
            : origLen;
    const origEnd =
        normEnd === normStart
            ? origStart
            : normEnd - 1 < paraNorm.origIdx.length
              ? paraNorm.origIdx[normEnd - 1] + 1
              : origLen;
    return { start: origStart, end: origEnd };
}

// --- Anchor failure diagnosis ----------------------------------------------
// A failed anchor is the most expensive event in a drafting turn: without new
// information the model can only guess again at the same wording. So a failure
// answers in the document's own words — either the exact context_before /
// context_after that would disambiguate, or the point at which the quoted text
// stops matching. The probes below are bounded so diagnosis stays cheap enough
// to run unconditionally on every miss.

/** Occurrence sites counted before we stop counting and say "20+". */
const SITE_SCAN_LIMIT = 20;
/** Sites quoted back to the model. */
const MAX_REPORTED_SITES = 3;
/** Characters of the document's own text shown either side of a site. */
const SITE_CONTEXT_CHARS = 60;
/**
 * Shortest match worth reporting as a near miss, and the seed length used to
 * shortlist paragraphs for the divergence probe. The two are deliberately the
 * same number: a match shorter than this is not reportable anyway, so seeding
 * on it costs no fidelity.
 */
const MIN_USEFUL_AFFIX = 12;
/** Paragraphs the divergence probe will binary-search per side. */
const CANDIDATE_LIMIT = 8;

/** Every paragraph offset where `needle` occurs, capped for cost. */
function occurrencesOf(
    paraNorms: Normalized[],
    needle: string,
    limit: number,
): { paraIdx: number; normStart: number }[] {
    const out: { paraIdx: number; normStart: number }[] = [];
    if (!needle) return out;
    for (let pi = 0; pi < paraNorms.length && out.length < limit; pi++) {
        const hay = paraNorms[pi].norm;
        let from = 0;
        for (;;) {
            const idx = hay.indexOf(needle, from);
            if (idx < 0) break;
            out.push({ paraIdx: pi, normStart: idx });
            if (out.length >= limit) break;
            from = idx + 1;
        }
    }
    return out;
}

/**
 * Longest prefix (or suffix) of `needle` present in `hay`. Presence is
 * monotone in length, so binary search brackets the divergence point in
 * log(len) scans.
 */
function longestAffix(
    hay: string,
    needle: string,
    kind: "prefix" | "suffix",
): { len: number; at: number } {
    let lo = 0;
    let hi = needle.length;
    let at = -1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const probe =
            kind === "prefix"
                ? needle.slice(0, mid)
                : needle.slice(needle.length - mid);
        const found = hay.indexOf(probe);
        if (found >= 0) {
            lo = mid;
            at = found;
        } else {
            hi = mid - 1;
        }
    }
    return { len: lo, at };
}

/** The document's own words either side of a normalized match, verbatim. */
function siteContext(
    para: ParagraphRef,
    paraNorm: Normalized,
    normStart: number,
    normLen: number,
): { before: string; after: string } {
    const text = para.flat.paraText;
    const { start, end } = mapNormRangeToOriginal(
        paraNorm,
        text.length,
        normStart,
        normStart + normLen,
    );
    return {
        before: text.slice(Math.max(0, start - SITE_CONTEXT_CHARS), start),
        after: text.slice(end, Math.min(text.length, end + SITE_CONTEXT_CHARS)),
    };
}

/**
 * Explain a failed anchor. Returns the whole reason string for the edit error:
 * ambiguity is answered with the real disambiguating contexts, absence with
 * either "already applied" or the document's wording at the divergence point.
 */
function diagnoseAnchor(params: {
    paragraphs: ParagraphRef[];
    paraNorms: Normalized[];
    find: string;
    findNorm: string;
    ctxBeforeNorm: string;
    ctxAfterNorm: string;
    replaceNorm: string;
}): string {
    const { paragraphs, paraNorms, find, findNorm, replaceNorm } = params;

    // For a pure insertion the context IS the anchor, so diagnose whichever
    // side the caller supplied.
    const anchor = findNorm || params.ctxBeforeNorm || params.ctxAfterNorm;
    const label = findNorm
        ? `find="${truncate(find, 80)}"`
        : `context_${params.ctxBeforeNorm ? "before" : "after"}`;

    const sites = occurrencesOf(paraNorms, anchor, SITE_SCAN_LIMIT);

    if (sites.length > 1) {
        const count =
            sites.length >= SITE_SCAN_LIMIT ? `${SITE_SCAN_LIMIT}+` : `${sites.length}`;
        const shown = sites.slice(0, MAX_REPORTED_SITES).map((site, i) => {
            const { before, after } = siteContext(
                paragraphs[site.paraIdx],
                paraNorms[site.paraIdx],
                site.normStart,
                anchor.length,
            );
            return `  ${i + 1}. context_before: "…${before}"  context_after: "${after}…"`;
        });
        return [
            `Ambiguous match for ${label}: ${count} occurrences, and the context you gave singled out none of them.`,
            `Copy context_before / context_after verbatim from the site you meant:`,
            ...shown,
        ].join("\n");
    }

    if (replaceNorm && occurrencesOf(paraNorms, replaceNorm, 1).length) {
        return `${label} is not in the document, but the replacement text already is — this edit looks like one that was applied already. Do not re-send it; re-read the document to confirm.`;
    }

    // Shortlist by seed, then binary-search only those paragraphs. A seed that
    // matches nowhere already proves the best affix is under MIN_USEFUL_AFFIX.
    const seedLen = Math.min(MIN_USEFUL_AFFIX, anchor.length);
    let best = { len: 0, at: -1, paraIdx: -1, kind: "prefix" as "prefix" | "suffix" };
    for (const kind of ["prefix", "suffix"] as const) {
        const seed =
            kind === "prefix"
                ? anchor.slice(0, seedLen)
                : anchor.slice(anchor.length - seedLen);
        for (const cand of occurrencesOf(paraNorms, seed, CANDIDATE_LIMIT)) {
            const probe = longestAffix(paraNorms[cand.paraIdx].norm, anchor, kind);
            if (probe.len > best.len) best = { ...probe, paraIdx: cand.paraIdx, kind };
        }
    }

    if (best.len < MIN_USEFUL_AFFIX || best.paraIdx < 0) {
        return `Could not locate ${label}: no part of this wording appears in the document body. Re-read the document — the text may be in a header, footer, footnote or text box (which tracked-change editing does not reach), or in a different document than the one you are editing.`;
    }

    const para = paragraphs[best.paraIdx];
    const paraNorm = paraNorms[best.paraIdx];
    const { start, end } = mapNormRangeToOriginal(
        paraNorm,
        para.flat.paraText.length,
        best.at,
        best.at + best.len,
    );
    // Show the document either side of where the match ran out, so the quoted
    // window always spans the divergence.
    const windowStart =
        best.kind === "prefix" ? start : Math.max(0, start - SITE_CONTEXT_CHARS);
    const windowEnd = Math.min(
        para.flat.paraText.length,
        best.kind === "prefix" ? end + SITE_CONTEXT_CHARS : end,
    );
    const side = best.kind === "prefix" ? "first" : "last";
    const lead = windowStart > 0 ? "…" : "";
    const tail = windowEnd < para.flat.paraText.length ? "…" : "";
    return [
        `Could not locate ${label}. Its ${side} ${best.len} characters do match, in this paragraph — but the wording then diverges. The document reads:`,
        `  "${lead}${para.flat.paraText.slice(windowStart, windowEnd)}${tail}"`,
        `Copy the document's wording verbatim, including punctuation and spacing.`,
    ].join("\n");
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

function findBody(doc: XNode[]): XNode[] | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return elChildren(c);
            }
        }
    }
    return null;
}

/**
 * Walk a tree and collect all max w:id values in w:ins/w:del so new changes
 * can start their numbering safely above it.
 */
function maxTrackedId(doc: XNode[]): number {
    let max = 0;
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
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

/**
 * Extract the body text of a .docx using the same flattening rules as the
 * tracked-changes matcher. Paragraphs are joined by a single newline. The
 * output is what the LLM should base its `find` / `context_before` /
 * `context_after` strings on, since it exactly mirrors the string the
 * anchor matcher operates against.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    const zip = await loadZip(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return "";
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) return "";

    const lines: string[] = [];
    const collect = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const flat = flattenParagraph(elChildren(n));
                lines.push(flat.paraText);
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(n));
            }
        }
    };
    collect(bodyChildren);
    return lines.join("\n");
}

/**
 * Walk document.xml in render order and collect the w:id for every
 * w:ins / w:del wrapper. The order here matches what docx-preview emits
 * as <ins>/<del> in the DOM, so the frontend can tag each rendered
 * element by index to recover the w:id attribute that docx-preview drops.
 */
export async function extractTrackedChangeIds(
    bytes: Buffer,
): Promise<{ kind: "ins" | "del"; w_id: string }[]> {
    const zip = await loadZip(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return [];
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const out: { kind: "ins" | "del"; w_id: string }[] = [];
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                out.push({
                    kind: name === "w:ins" ? "ins" : "del",
                    w_id: String(raw),
                });
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of tree) visit(top);
    return out;
}

export async function applyTrackedEdits(
    bytes: Buffer,
    edits: EditInput[],
    opts?: { author?: string; annotate?: boolean },
): Promise<ApplyTrackedEditsResult> {
    const author = opts?.author ?? "Beaver";
    const now = new Date().toISOString();
    const annotate = opts?.annotate ?? false;

    const zip = await loadZip(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const bodyChildren = findBody(tree);
    if (!bodyChildren) throw new Error("w:body missing from document.xml");

    // Build paragraph table (only w:p at the top level of the body — does not
    // recurse into tables; for tables, w:p also appears inside w:tbl > w:tr >
    // w:tc so we need to traverse deeper).
    const paragraphs: ParagraphRef[] = [];
    const collectParagraphs = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const kids = elChildren(n);
                const flat = flattenParagraph(kids);
                paragraphs.push({
                    paraNode: n,
                    paraChildren: kids,
                    flat,
                    globalStart: 0, // set below
                });
            } else if (name === "w:tbl" || name === "w:tr" || name === "w:tc" || name === "w:sdt" || name === "w:sdtContent") {
                collectParagraphs(elChildren(n));
            }
        }
    };
    collectParagraphs(bodyChildren);

    // Assign global offsets (paragraphs joined by "\n" so context can
    // straddle a paragraph boundary, though edits themselves must stay
    // inside a single paragraph).
    {
        let off = 0;
        for (const p of paragraphs) {
            p.globalStart = off;
            off += p.flat.paraText.length + 1; // +1 for synthetic separator
        }
    }

    // Precompute normalized forms per paragraph for reuse across edits.
    const paraNorms: Normalized[] = paragraphs.map((p) =>
        normalizeWs(p.flat.paraText),
    );

    let nextWId = maxTrackedId(tree) + 1;
    const plansPerParagraph = new Map<number, PlannedChange[]>();
    const appliedChanges: AppliedChange[] = [];
    const errors: EditError[] = [];

    for (let editIdx = 0; editIdx < edits.length; editIdx++) {
        const edit = edits[editIdx];
        const find = edit.find ?? "";
        const replace = edit.replace ?? "";
        const ctxBefore = edit.context_before ?? "";
        const ctxAfter = edit.context_after ?? "";

        if (!find && !replace) {
            errors.push({ index: editIdx, reason: "Empty edit." });
            continue;
        }
        if (!find && !ctxBefore && !ctxAfter) {
            errors.push({
                index: editIdx,
                reason: "Pure insertion requires context_before or context_after.",
            });
            continue;
        }

        const findNorm = normalizeWs(find).norm;
        const ctxBeforeNorm = normalizeWs(ctxBefore).norm;
        const ctxAfterNorm = normalizeWs(ctxAfter).norm;

        // Strategy:
        //   1) find + full context  (strictest — preferred)
        //   2) find + half context  (drop whichever context side is shorter)
        //   3) find alone           (only if globally unique across doc)
        // At each stage we scan every paragraph. "Unique across the doc"
        // means exactly one paragraph yields exactly one match.
        type Hit = { paraIdx: number; normStart: number; normEnd: number };

        /**
         * Search every paragraph with the given context sides. If any
         * paragraph returns a match AND no paragraph is internally ambiguous,
         * return the collected hits; otherwise signal ambiguous.
         */
        const tryStrategy = (
            cb: string,
            ca: string,
        ): { kind: "ok"; hits: Hit[] } | { kind: "ambiguous" } => {
            const hits: Hit[] = [];
            let ambiguous = false;
            for (let pi = 0; pi < paragraphs.length; pi++) {
                const r = findUniqueAnchor(
                    paraNorms[pi].norm,
                    findNorm,
                    cb,
                    ca,
                );
                if ("error" in r) {
                    if (r.error === "ambiguous") ambiguous = true;
                    continue;
                }
                hits.push({ paraIdx: pi, normStart: r.start, normEnd: r.end });
            }
            if (ambiguous || hits.length > 1) return { kind: "ambiguous" };
            return { kind: "ok", hits };
        };

        let selected: Hit | null = null;
        const attempts = [
            { cb: ctxBeforeNorm, ca: ctxAfterNorm },
            { cb: ctxBeforeNorm, ca: "" },
            { cb: "", ca: ctxAfterNorm },
            { cb: "", ca: "" }, // find-only
        ];
        for (const { cb, ca } of attempts) {
            const r = tryStrategy(cb, ca);
            if (r.kind === "ok" && r.hits.length === 1) {
                selected = r.hits[0];
                break;
            }
        }

        if (!selected) {
            errors.push({
                index: editIdx,
                reason: diagnoseAnchor({
                    paragraphs,
                    paraNorms,
                    find,
                    findNorm,
                    ctxBeforeNorm,
                    ctxAfterNorm,
                    replaceNorm: normalizeWs(replace).norm,
                }),
            });
            continue;
        }

        const hit = selected;
        const paraIdx = hit.paraIdx;
        const paraNorm = paraNorms[paraIdx];
        const origLen = paragraphs[paraIdx].flat.paraText.length;
        const { start: findStart, end: findEnd } = mapNormRangeToOriginal(
            paraNorm,
            origLen,
            hit.normStart,
            hit.normEnd,
        );

        // Use the actual original text in that range as `deletedText` —
        // this preserves the document's whitespace/quote style rather than
        // the normalized needle the LLM provided.
        const originalFind = paragraphs[paraIdx].flat.paraText.slice(
            findStart,
            findEnd,
        );

        const clusters = minimalEditClusters(originalFind, replace);
        if (clusters.length === 0) {
            errors.push({
                index: editIdx,
                reason: "Replacement does not change the matched text.",
            });
            continue;
        }
        void findEnd;

        const protectedAt = (position: number) =>
            position >= 0 &&
            position < paragraphs[paraIdx].flat.paraText.length &&
            paragraphs[paraIdx].flat.runs[
                paragraphs[paraIdx].flat.charRun[position]
            ]?.protectedByContentControl;
        const clusterTouchesControl = (start: number, end: number) => {
            if (start === end)
                return Boolean(protectedAt(start) || protectedAt(start - 1));
            for (let position = start; position < end; position += 1)
                if (protectedAt(position)) return true;
            return false;
        };
        if (
            clusters.some((cluster) =>
                clusterTouchesControl(
                    findStart + cluster.offset,
                    findStart + cluster.offset + cluster.deleted.length,
                ),
            )
        ) {
            errors.push({
                index: editIdx,
                reason: "This edit touches a Word content control. Edit the control in Word or regenerate the draft.",
            });
            continue;
        }

        const editPlans: PlannedChange[] = clusters.map((cluster, clusterIdx) => ({
            editIndex: editIdx,
            deleteStart: findStart + cluster.offset,
            deleteEnd: findStart + cluster.offset + cluster.deleted.length,
            deletedText: cluster.deleted,
            insertedText: cluster.inserted,
            contextBefore: edit.context_before ?? "",
            contextAfter: edit.context_after ?? "",
            reason: edit.reason,
            changeId: `mike-${editIdx}-${clusterIdx}-${Date.now()}`,
            delWId: cluster.deleted ? String(nextWId++) : undefined,
            insWId: cluster.inserted ? String(nextWId++) : undefined,
        }));

        // Check for overlap with earlier edits' plans in the same paragraph.
        // The whole edit is rejected atomically — never half its clusters.
        const existing = plansPerParagraph.get(paraIdx) ?? [];
        const overlap = editPlans.some((plan) =>
            existing.some(
                (p) => !(plan.deleteEnd <= p.deleteStart || plan.deleteStart >= p.deleteEnd),
            ),
        );
        if (overlap) {
            errors.push({
                index: editIdx,
                reason: "Overlaps a previous edit in the same paragraph.",
            });
            continue;
        }

        existing.push(...editPlans);
        existing.sort((a, b) => a.deleteStart - b.deleteStart);
        plansPerParagraph.set(paraIdx, existing);

        for (const plan of editPlans) {
            appliedChanges.push({
                id: plan.changeId,
                delId: plan.delWId,
                insId: plan.insWId,
                deletedText: plan.deletedText,
                insertedText: plan.insertedText,
                contextBefore: plan.contextBefore,
                contextAfter: plan.contextAfter,
                reason: plan.reason,
            });
        }
    }

    // Apply plans per paragraph.
    for (const [paraIdx, plan] of plansPerParagraph) {
        const p = paragraphs[paraIdx];
        const newKids = reconstructParagraph(
            p.paraChildren,
            p.flat,
            plan,
            now,
            author,
        );
        setChildren(p.paraNode, newKids);
    }

    // Annotate mode: each edit's reason becomes a real anchored Word
    // comment spanning that edit's revision wrappers, so the rationale is
    // IN the deliverable rather than dying in the receipt. One comment per
    // edit (its clusters share one reason).
    let commentsAdded = 0;
    if (annotate) {
        const existingEntry = getZipEntry(zip, "word/comments.xml");
        const existingXml = existingEntry
            ? await existingEntry.async("string")
            : "";
        let nextCommentId = maxCommentId(existingXml) + 1;
        const commentBodies: string[] = [];

        for (const [paraIdx, plans] of plansPerParagraph) {
            const p = paragraphs[paraIdx];
            const kids = elChildren(p.paraNode);
            const byEdit = new Map<number, PlannedChange[]>();
            for (const plan of plans) {
                const list = byEdit.get(plan.editIndex) ?? [];
                list.push(plan);
                byEdit.set(plan.editIndex, list);
            }
            const inserts: Array<{ at: number; after: boolean; nodes: XNode[] }> =
                [];
            for (const group of byEdit.values()) {
                const reason = group[0].reason?.trim();
                if (!reason) continue;
                const wrapperIds = new Set<string>();
                for (const plan of group) {
                    if (plan.delWId) wrapperIds.add(plan.delWId);
                    if (plan.insWId) wrapperIds.add(plan.insWId);
                }
                let first = -1;
                let last = -1;
                kids.forEach((kid, index) => {
                    const name = elName(kid);
                    if (name !== "w:ins" && name !== "w:del") return;
                    const id = elAttrs(kid)["@_w:id"];
                    if (id != null && wrapperIds.has(String(id))) {
                        if (first < 0) first = index;
                        last = index;
                    }
                });
                if (first < 0) continue;
                const commentId = String(nextCommentId++);
                inserts.push({
                    at: first,
                    after: false,
                    nodes: [
                        makeEl("w:commentRangeStart", [], { "w:id": commentId }),
                    ],
                });
                inserts.push({
                    at: last,
                    after: true,
                    nodes: [
                        makeEl("w:commentRangeEnd", [], { "w:id": commentId }),
                        makeEl("w:r", [
                            makeEl("w:commentReference", [], { "w:id": commentId }),
                        ]),
                    ],
                });
                commentBodies.push(
                    `<w:comment w:id="${commentId}" w:author="${escapeXmlAttr(author)}" ` +
                        `w:date="${now}" w:initials="BV">` +
                        `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(reason)}</w:t></w:r></w:p>` +
                        `</w:comment>`,
                );
                commentsAdded += 1;
            }
            if (inserts.length) {
                // Descending positions keep earlier indexes valid.
                inserts.sort(
                    (a, b) => b.at - a.at || Number(b.after) - Number(a.after),
                );
                const next = [...kids];
                for (const insert of inserts) {
                    next.splice(
                        insert.at + (insert.after ? 1 : 0),
                        0,
                        ...insert.nodes,
                    );
                }
                setChildren(p.paraNode, next);
            }
        }

        if (commentBodies.length) {
            const bodies = commentBodies.join("");
            let commentsXml: string;
            if (existingXml.includes("</w:comments>")) {
                commentsXml = existingXml.replace(
                    /<\/w:comments>\s*$/u,
                    `${bodies}</w:comments>`,
                );
            } else if (/<w:comments\b[^>]*\/>\s*$/u.test(existingXml)) {
                // Generators commonly ship an empty self-closed comments part.
                commentsXml = existingXml.replace(
                    /\/>\s*$/u,
                    `>${bodies}</w:comments>`,
                );
            } else {
                commentsXml =
                    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
                    `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
                    `${bodies}</w:comments>`;
            }
            setZipEntry(zip, "word/comments.xml", commentsXml);

            // Register the part: content type + document relationship.
            const typesEntry = getZipEntry(zip, "[Content_Types].xml");
            if (typesEntry) {
                const typesXml = await typesEntry.async("string");
                if (!typesXml.includes('PartName="/word/comments.xml"')) {
                    setZipEntry(
                        zip,
                        "[Content_Types].xml",
                        typesXml.replace(
                            "</Types>",
                            `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`,
                        ),
                    );
                }
            }
            const relsEntry = getZipEntry(zip, "word/_rels/document.xml.rels");
            if (relsEntry) {
                const relsXml = await relsEntry.async("string");
                if (
                    !relsXml.includes(
                        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
                    )
                ) {
                    let relNumber = 1000;
                    while (relsXml.includes(`Id="rId${relNumber}"`)) relNumber += 1;
                    setZipEntry(
                        zip,
                        "word/_rels/document.xml.rels",
                        relsXml.replace(
                            "</Relationships>",
                            `<Relationship Id="rId${relNumber}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`,
                        ),
                    );
                }
            }
        }
    }

    const builder = createBuilder();
    const rebuiltXml = builder.build(tree);
    const withDecl = ensureXmlDeclaration(rebuiltXml);
    setZipEntry(zip, "word/document.xml", withDecl);

    const outBuf = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return {
        bytes: outBuf,
        changes: appliedChanges,
        errors,
        comments: commentsAdded,
    };
}

function maxCommentId(commentsXml: string): number {
    let max = 0;
    for (const match of commentsXml.matchAll(
        /<w:comment\b[^>]*\bw:id="(\d+)"/gu,
    )) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > max) max = value;
    }
    return max;
}

const XML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
};

function escapeXmlText(value: string): string {
    return value.replace(/[&<>]/gu, (ch) => XML_ESCAPES[ch]);
}

function escapeXmlAttr(value: string): string {
    return value.replace(/[&<>"']/gu, (ch) => XML_ESCAPES[ch]);
}

// ---------------------------------------------------------------------------
// Resolve a single tracked change (Accept or Reject)
// ---------------------------------------------------------------------------

/**
 * Walk the XML tree and transform matching w:ins/w:del wrappers for the
 * given change id. Returns { found, updatedTree }.
 */
function resolveInTree(
    doc: XNode[],
    changeIds: string[],
    mode: "accept" | "reject",
): { found: boolean } {
    const ids = new Set(changeIds.map((s) => String(s)));
    let touched = false;

    const rewrite = (parentKids: XNode[]): XNode[] => {
        const out: XNode[] = [];
        for (const n of parentKids) {
            const name = elName(n);
            if (!name) {
                out.push(n);
                continue;
            }

            // Recurse first so nested tables/sdts get processed
            const kids = elChildren(n);
            if (kids.length) {
                const newKids = rewrite(kids);
                if (newKids !== kids) setChildren(n, newKids);
            }

            if (name === "w:ins" || name === "w:del") {
                const a = elAttrs(n);
                const wId = String(a["@_w:id"] ?? "");
                if (ids.has(wId)) {
                    touched = true;
                    if (
                        (name === "w:ins" && mode === "accept") ||
                        (name === "w:del" && mode === "reject")
                    ) {
                        // Keep children, drop wrapper. For w:del rejected, we
                        // also need to convert inner w:delText → w:t so the
                        // text reverts to normal body content.
                        const inner =
                            name === "w:del"
                                ? (elChildren(n) as XNode[]).map(unwrapDelText)
                                : (elChildren(n) as XNode[]);
                        for (const c of inner) out.push(c);
                        continue;
                    } else {
                        // accept-del / reject-ins → drop the wrapper and its
                        // inner runs entirely.
                        continue;
                    }
                }
            }

            out.push(n);
        }
        return out;
    };

    for (const top of doc) {
        if (elName(top) !== "w:document") continue;
        const docKids = elChildren(top);
        setChildren(top, rewrite(docKids));
    }

    return { found: touched };
}

function unwrapDelText(n: XNode): XNode {
    const name = elName(n);
    if (!name) return n;
    if (name === "w:r") {
        const kids = elChildren(n).map(unwrapDelText);
        setChildren(n, kids);
        return n;
    }
    if (name === "w:delText") {
        const attrs = elAttrs(n);
        return {
            "w:t": elChildren(n),
            ...(Object.keys(attrs).length ? { [ATTR_KEY]: attrs } : {}),
        };
    }
    return n;
}

export async function resolveTrackedChange(
    bytes: Buffer,
    changeIds: string[],
    mode: "accept" | "reject",
): Promise<{ bytes: Buffer; found: boolean }> {
    const zip = await loadZip(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const { found } = resolveInTree(tree, changeIds, mode);

    const builder = createBuilder();
    const rebuilt = ensureXmlDeclaration(builder.build(tree));
    setZipEntry(zip, "word/document.xml", rebuilt);
    const out = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: out, found };
}

function ensureXmlDeclaration(xml: string): string {
    if (xml.startsWith("<?xml")) return xml;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

function truncate(s: string, n: number): string {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
}
