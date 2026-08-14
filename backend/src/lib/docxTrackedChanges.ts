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

import diff from "fast-diff";
import {
    ATTR_KEY,
    type XNode,
    cloneNode,
    createBuilder,
    createParser,
    elAttrs,
    elChildren,
    elName,
    ensureXmlDeclaration,
    findBodyChildren,
    getTextContent,
    getZipEntry,
    loadDocxPackage,
    makeEl,
    makeText,
    maxTrackedId,
    setChildren,
    setZipEntry,
} from "./docx/core";

export interface EditInput {
    find: string;
    replace: string;
    context_before: string;
    context_after: string;
    reason?: string;
    /** Trusted caller only: exact accepted-view offsets, within one paragraph. */
    exact_start?: number;
    exact_end?: number;
}

export type EditMode = "manual" | "auto";

export type EditDiffSegment = {
    kind: "equal" | "delete" | "insert";
    text: string;
};

export interface AppliedChange {
    id: string;
    delId?: string;
    insId?: string;
    deletedText: string;
    insertedText: string;
    contextBefore: string;
    contextAfter: string;
    reason?: string;
    diff: EditDiffSegment[];
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
function minimalTextEdit(
    find: string,
    replace: string,
): {
    clusters: { offset: number; deleted: string; inserted: string }[];
    diff: EditDiffSegment[];
} {
    const clusters: { offset: number; deleted: string; inserted: string }[] = [];
    const parts = diff(find, replace, undefined, true);
    let offset = 0;
    for (const [op, text] of parts) {
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
    return {
        clusters,
        diff: parts.map(([op, text]) => ({
            kind:
                op === diff.EQUAL
                    ? "equal"
                    : op === diff.DELETE
                      ? "delete"
                      : "insert",
            text,
        })),
    };
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

function paragraphIndexForRange(
    paragraphs: ParagraphRef[],
    start: number,
    end: number,
): number {
    let low = 0;
    let high = paragraphs.length - 1;
    while (low <= high) {
        const index = (low + high) >>> 1;
        const paragraph = paragraphs[index];
        const paragraphEnd = paragraph.globalStart + paragraph.flat.paraText.length;
        if (start < paragraph.globalStart) high = index - 1;
        else if (start > paragraphEnd) low = index + 1;
        else return end <= paragraphEnd ? index : -1;
    }
    return -1;
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
    let match = -1;

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
        const anchor = ctxBeforeNorm || ctxAfterNorm;
        let from = 0;
        while (from <= hayNorm.length - anchor.length) {
            const index = hayNorm.indexOf(anchor, from);
            if (index < 0) break;
            const position = ctxBeforeNorm ? index + ctxBeforeNorm.length : index;
            if (checkCtx(position)) {
                if (match >= 0) return { error: "ambiguous" };
                match = position;
            }
            from = index + 1;
        }
    } else {
        let from = 0;
        while (from <= hayNorm.length - findNorm.length) {
            const idx = hayNorm.indexOf(findNorm, from);
            if (idx < 0) break;
            if (checkCtx(idx)) {
                if (match >= 0) return { error: "ambiguous" };
                match = idx;
            }
            from = idx + 1;
        }
    }

    return match < 0
        ? { error: "none" }
        : { start: match, end: match + findNorm.length };
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

export interface DocxTableCellSpan {
    /** 1-based top-level table, row, and grid-column coordinates. */
    table: number;
    row: number;
    column: number;
    /** Horizontal grid width; no phantom address is minted for covered columns. */
    columnSpan: number;
    /** Exact offsets in `extractDocxBodyText`'s accepted-view text. */
    start: number;
    end: number;
}

export interface InsertTrackedBlocksInput {
    blocks: string[];
    position: "before" | "after";
    anchorText?: string;
    occurrence?: number;
}

export interface DocxBodyStructure {
    text: string;
    tableCells: DocxTableCellSpan[];
}

const directChild = (node: XNode, name: string) =>
    elChildren(node).find((child) => elName(child) === name);

const positiveWordInt = (node: XNode | undefined, name: string) => {
    const child = node && directChild(node, name);
    const value = Number(child && elAttrs(child)["@_w:val"]);
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
};

/**
 * The body text plus native DOCX table coordinates on the same offset plane.
 * Nested tables remain part of the containing cell's text. Vertical and
 * horizontal merge continuations remain in the global flattened text, but
 * mint no independent address and do not extend the restart cell's span.
 */
export async function extractDocxBodyStructure(
    bytes: Buffer,
): Promise<DocxBodyStructure> {
    // A truncated or byte-corrupted package fails JSZip with an opaque
    // "Corrupted zip: …" error; fail closed with a readable message instead.
    const zip = await loadDocxPackage(bytes).catch((error: unknown) => {
        const detail = String((error as { message?: unknown })?.message ?? error)
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 200);
        throw new Error(
            `DOCX is corrupted or truncated (not a readable ZIP archive): ${detail}`,
        );
    });
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return { text: "", tableCells: [] };
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBodyChildren(tree);
    if (!bodyChildren) return { text: "", tableCells: [] };

    const lines: string[] = [];
    const lineStarts: number[] = [];
    const tableCells: DocxTableCellSpan[] = [];
    let cursor = 0;
    let table = 0;

    const pushParagraph = (node: XNode) => {
        if (lines.length) cursor += 1;
        lineStarts.push(cursor);
        const value = flattenParagraph(elChildren(node)).paraText;
        lines.push(value);
        cursor += value.length;
    };

    const collect = (nodes: XNode[], tableDepth = 0) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                pushParagraph(n);
            } else if (name === "w:tbl" && tableDepth === 0) {
                collectTable(n);
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(n), tableDepth + (name === "w:tbl" ? 1 : 0));
            }
        }
    };

    const collectTable = (node: XNode) => {
        table += 1;
        const tableNumber = table;
        let row = 0;

        const collectRows = (nodes: XNode[]) => {
            for (const child of nodes) {
                const name = elName(child);
                if (name === "w:tr") {
                    row += 1;
                    collectRow(child, tableNumber, row);
                } else if (name === "w:sdt" || name === "w:sdtContent") {
                    collectRows(elChildren(child));
                }
            }
        };
        collectRows(elChildren(node));
    };

    const collectRow = (node: XNode, tableNumber: number, rowNumber: number) => {
        const trPr = directChild(node, "w:trPr");
        const gridBefore = trPr && directChild(trPr, "w:gridBefore");
        const skipped = Number(gridBefore && elAttrs(gridBefore)["@_w:val"]);
        let column = Number.isSafeInteger(skipped) && skipped >= 0 ? skipped + 1 : 1;

        const collectCells = (nodes: XNode[]) => {
            for (const child of nodes) {
                const name = elName(child);
                if (name === "w:tc") {
                    const tcPr = directChild(child, "w:tcPr");
                    const columnSpan = positiveWordInt(tcPr, "w:gridSpan");
                    const vMerge = tcPr && directChild(tcPr, "w:vMerge");
                    const hMerge = tcPr && directChild(tcPr, "w:hMerge");
                    const mergeValue = (merge: XNode | undefined) =>
                        String(merge && elAttrs(merge)["@_w:val"] || "").toLowerCase();
                    const continuation =
                        (!!vMerge && mergeValue(vMerge) !== "restart") ||
                        (!!hMerge && mergeValue(hMerge) !== "restart");
                    const firstLine = lines.length;
                    collect(elChildren(child), 1);
                    const lastLine = lines.length - 1;
                    if (!continuation) {
                        tableCells.push({
                            table: tableNumber,
                            row: rowNumber,
                            column,
                            columnSpan,
                            start: firstLine <= lastLine ? lineStarts[firstLine] : cursor,
                            end:
                                firstLine <= lastLine
                                    ? lineStarts[lastLine] + lines[lastLine].length
                                    : cursor,
                        });
                    }
                    column += columnSpan;
                } else if (name === "w:sdt" || name === "w:sdtContent") {
                    collectCells(elChildren(child));
                }
            }
        };
        collectCells(elChildren(node));
    };

    collect(bodyChildren);
    return { text: lines.join("\n"), tableCells };
}

/**
 * Extract the body text of a .docx using the same flattening rules as the
 * tracked-changes matcher. Paragraphs are joined by a single newline. The
 * output is what the LLM should base its `find` / `context_before` /
 * `context_after` strings on, since it exactly mirrors the string the
 * anchor matcher operates against.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    return (await extractDocxBodyStructure(bytes)).text;
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
    const zip = await loadDocxPackage(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return [];
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    return trackedChangeIds(tree);
}

function trackedChangeIds(
    tree: XNode[],
): { kind: "ins" | "del"; w_id: string }[] {
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

    const zip = await loadDocxPackage(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const bodyChildren = findBodyChildren(tree);
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

    // Word tracks text inside paragraphs. The assistant, however, reads the
    // document on the canonical paragraph stream and may copy several adjacent
    // paragraphs into one edit. Resolve that edit once on the same stream,
    // then pin one exact replacement to each paragraph. This preserves the
    // document's paragraph/list structure and keeps the existing writer small.
    type ConcreteEdit = { edit: EditInput; sourceIndex: number };
    const concreteEdits: ConcreteEdit[] = [];
    const errors: EditError[] = [];
    const diffByEdit = new Map<number, EditDiffSegment[]>();
    const bodyText = paragraphs.map((p) => p.flat.paraText).join("\n");
    const bodyNorm = normalizeWs(bodyText);

    for (let sourceIndex = 0; sourceIndex < edits.length; sourceIndex++) {
        const source = edits[sourceIndex];
        const find = (source.find ?? "").replace(/\r\n?/g, "\n");
        const replace = (source.replace ?? "").replace(/\r\n?/g, "\n");
        if (!find.includes("\n") && !replace.includes("\n")) {
            concreteEdits.push({ edit: source, sourceIndex });
            continue;
        }

        const candidate = findUniqueAnchor(
            bodyNorm.norm,
            normalizeWs(find).norm,
            normalizeWs(source.context_before ?? "").norm,
            normalizeWs(source.context_after ?? "").norm,
        );
        if ("error" in candidate) {
            errors.push({
                index: sourceIndex,
                reason:
                    candidate.error === "ambiguous"
                        ? "Ambiguous match for the multi-paragraph edit; the document is unchanged."
                        : "Could not locate the multi-paragraph edit; the document is unchanged.",
            });
            continue;
        }
        const matched = mapNormRangeToOriginal(
            bodyNorm,
            bodyText.length,
            candidate.start,
            candidate.end,
        );

        const actualFind = bodyText.slice(matched.start, matched.end);
        diffByEdit.set(sourceIndex, minimalTextEdit(actualFind, replace).diff);
        const findLines = actualFind.split("\n");
        const replaceLines = replace.split("\n");
        if (findLines.length !== replaceLines.length) {
            errors.push({
                index: sourceIndex,
                reason: `Multi-paragraph replacement must preserve the paragraph count (${findLines.length} found, ${replaceLines.length} supplied).`,
            });
            continue;
        }

        let cursor = matched.start;
        let changed = false;
        for (let line = 0; line < findLines.length; line++) {
            const original = findLines[line];
            const replacement = replaceLines[line];
            if (original !== replacement) {
                changed = true;
                concreteEdits.push({
                    sourceIndex,
                    edit: {
                        find: original,
                        replace: replacement,
                        context_before: bodyText.slice(Math.max(0, cursor - 40), cursor),
                        context_after: bodyText.slice(
                            cursor + original.length,
                            cursor + original.length + 40,
                        ),
                        reason: source.reason,
                        exact_start: cursor,
                        exact_end: cursor + original.length,
                    },
                });
            }
            cursor += original.length + (line + 1 < findLines.length ? 1 : 0);
        }
        if (!changed) {
            errors.push({
                index: sourceIndex,
                reason: "Replacement does not change the matched text.",
            });
        }
    }

    let nextWId = maxTrackedId(tree) + 1;
    const plansPerParagraph = new Map<number, PlannedChange[]>();
    const appliedChangesByEdit = new Map<number, AppliedChange>();
    const revisionIdsByEdit = new Map<
        number,
        { changeId: string; delWId?: string; insWId?: string }
    >();

    for (let concreteIndex = 0; concreteIndex < concreteEdits.length; concreteIndex++) {
        const { edit, sourceIndex: editIdx } = concreteEdits[concreteIndex];
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

        let paraIdx = -1;
        let findStart = -1;
        let findEnd = -1;
        const hasExact =
            Number.isSafeInteger(edit.exact_start) &&
            Number.isSafeInteger(edit.exact_end);
        if (hasExact) {
            const exactStart = edit.exact_start!;
            const exactEnd = edit.exact_end!;
            if (exactStart < 0 || exactEnd < exactStart) {
                errors.push({ index: editIdx, reason: "Invalid exact edit span." });
                continue;
            }
            paraIdx = paragraphIndexForRange(paragraphs, exactStart, exactEnd);
            if (paraIdx < 0) {
                errors.push({
                    index: editIdx,
                    reason: "Exact edit span must resolve inside one paragraph.",
                });
                continue;
            }
            const paragraph = paragraphs[paraIdx];
            findStart = exactStart - paragraph.globalStart;
            findEnd = exactEnd - paragraph.globalStart;
            if (
                paragraph.flat.paraText.slice(findStart, findEnd) !== find
            ) {
                errors.push({
                    index: editIdx,
                    reason: "Exact edit span no longer matches the pinned text.",
                });
                continue;
            }
        } else {
            const hit = findUniqueAnchor(
                bodyNorm.norm,
                findNorm,
                ctxBeforeNorm,
                ctxAfterNorm,
            );
            if (!("error" in hit)) {
                const global = mapNormRangeToOriginal(
                    bodyNorm,
                    bodyText.length,
                    hit.start,
                    hit.end,
                );
                paraIdx = paragraphIndexForRange(
                    paragraphs,
                    global.start,
                    global.end,
                );
                if (paraIdx >= 0) {
                    findStart = global.start - paragraphs[paraIdx].globalStart;
                    findEnd = global.end - paragraphs[paraIdx].globalStart;
                }
            }

            if (paraIdx < 0) {
                errors.push({
                    index: editIdx,
                    reason:
                        "error" in hit && hit.error === "ambiguous"
                            ? "Ambiguous match for this edit; the document is unchanged."
                            : "Could not locate this edit on the current document text plane; the document is unchanged.",
                });
                continue;
            }
        }

        // Use the actual original text in that range as `deletedText` —
        // this preserves the document's whitespace/quote style rather than
        // the normalized needle the LLM provided.
        const originalFind = paragraphs[paraIdx].flat.paraText.slice(
            findStart,
            findEnd,
        );

        const minimal = minimalTextEdit(originalFind, replace);
        const clusters = minimal.clusters;
        if (!diffByEdit.has(editIdx)) diffByEdit.set(editIdx, minimal.diff);
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

        const revision = revisionIdsByEdit.get(editIdx) ?? {
            changeId: `mike-${editIdx}-${Date.now()}`,
        };
        if (clusters.some((cluster) => cluster.deleted) && !revision.delWId)
            revision.delWId = String(nextWId++);
        if (clusters.some((cluster) => cluster.inserted) && !revision.insWId)
            revision.insWId = String(nextWId++);
        revisionIdsByEdit.set(editIdx, revision);

        const editPlans: PlannedChange[] = clusters.map((cluster) => ({
            editIndex: editIdx,
            deleteStart: findStart + cluster.offset,
            deleteEnd: findStart + cluster.offset + cluster.deleted.length,
            deletedText: cluster.deleted,
            insertedText: cluster.inserted,
            contextBefore: edit.context_before ?? "",
            contextAfter: edit.context_after ?? "",
            reason: edit.reason,
            changeId: revision.changeId,
            delWId: cluster.deleted ? revision.delWId : undefined,
            insWId: cluster.inserted ? revision.insWId : undefined,
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

        const deletedText = clusters
            .map((cluster) => cluster.deleted)
            .filter(Boolean)
            .join(" â€¦ ");
        const insertedText = clusters
            .map((cluster) => cluster.inserted)
            .filter(Boolean)
            .join(" â€¦ ");
        const applied = appliedChangesByEdit.get(editIdx);
        if (applied) {
            applied.delId = revision.delWId;
            applied.insId = revision.insWId;
            if (deletedText)
                applied.deletedText += `${applied.deletedText ? "\n" : ""}${deletedText}`;
            if (insertedText)
                applied.insertedText += `${applied.insertedText ? "\n" : ""}${insertedText}`;
            applied.contextAfter = edit.context_after ?? "";
        } else {
            appliedChangesByEdit.set(editIdx, {
                id: revision.changeId,
                delId: revision.delWId,
                insId: revision.insWId,
                deletedText,
                insertedText,
                contextBefore: edit.context_before ?? "",
                contextAfter: edit.context_after ?? "",
                reason: edit.reason,
                diff: diffByEdit.get(editIdx) ?? minimal.diff,
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
        changes: [...appliedChangesByEdit.values()],
        errors,
        comments: commentsAdded,
    };
}

function acceptedNodeText(node: XNode): string {
    const name = elName(node);
    if (!name || name === "w:del") return "";
    if (name === "w:t") return getTextContent(node);
    if (name === "w:tab") return "\t";
    if (name === "w:br") return "\n";
    return elChildren(node).map(acceptedNodeText).join("");
}

/** Insert new paragraphs as tracked text plus an inserted paragraph mark. */
export async function insertTrackedBlocks(
    bytes: Buffer,
    input: InsertTrackedBlocksInput,
    opts?: { author?: string },
): Promise<ApplyTrackedEditsResult> {
    if (!input.blocks.length || input.blocks.some((block) => !block.trim())) {
        throw new Error("insert_blocks requires one or more non-empty blocks");
    }
    if (input.blocks.some((block) => /[\r\n]/u.test(block))) {
        throw new Error("Each insert_blocks item must be one paragraph without a newline");
    }
    const zip = await loadDocxPackage(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const parser = createParser();
    const tree = parser.parse(await docXmlFile.async("string")) as XNode[];
    const body = findBodyChildren(tree);
    if (!body) throw new Error("document body missing from docx");

    const paragraphIndexes = body
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => elName(node) === "w:p");
    let insertionIndex: number;
    let contextBefore = "";
    let contextAfter = "";
    if (input.anchorText?.trim()) {
        const needle = normalizeWs(input.anchorText).norm;
        const hits = paragraphIndexes.filter(({ node }) =>
            normalizeWs(acceptedNodeText(node)).norm.includes(needle),
        );
        const chosen =
            typeof input.occurrence === "number"
                ? hits[input.occurrence - 1]
                : hits.length === 1
                  ? hits[0]
                  : undefined;
        if (!chosen) {
            throw new Error(
                hits.length
                    ? `insert_blocks anchor is ambiguous (${hits.length} paragraphs); set occurrence`
                    : "insert_blocks anchor paragraph was not found",
            );
        }
        const anchor = acceptedNodeText(chosen.node);
        contextBefore = input.position === "after" ? anchor.slice(-120) : "";
        contextAfter = input.position === "before" ? anchor.slice(0, 120) : "";
        insertionIndex = chosen.index + (input.position === "after" ? 1 : 0);
    } else if (input.position === "before") {
        insertionIndex = paragraphIndexes[0]?.index ?? 0;
    } else {
        const sectionProperties = body.findIndex(
            (node) => elName(node) === "w:sectPr",
        );
        insertionIndex = sectionProperties < 0 ? body.length : sectionProperties;
    }

    const author = opts?.author ?? "Beaver";
    const date = new Date().toISOString();
    let nextId = maxTrackedId(tree) + 1;
    const changes: AppliedChange[] = [];
    const paragraphs = input.blocks.map((block) => {
        const id = String(nextId++);
        const attrs = { "w:id": id, "w:author": author, "w:date": date };
        changes.push({
            id,
            insId: id,
            deletedText: "",
            insertedText: block,
            contextBefore,
            contextAfter,
            diff: [{ kind: "insert", text: block }],
        });
        return makeEl("w:p", [
            makeEl("w:pPr", [makeEl("w:rPr", [makeEl("w:ins", [], attrs)])]),
            makeEl("w:ins", [
                makeEl("w:r", [
                    makeEl("w:t", [makeText(block)], { "xml:space": "preserve" }),
                ]),
            ], attrs),
        ]);
    });
    body.splice(insertionIndex, 0, ...paragraphs);
    const rebuilt = ensureXmlDeclaration(createBuilder().build(tree));
    setZipEntry(zip, "word/document.xml", rebuilt);
    return {
        bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
        changes,
        errors: [],
        comments: 0,
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

            if (name === "w:p" && mode === "reject") {
                const paragraphMarkIds = elChildren(n)
                    .filter((child) => elName(child) === "w:pPr")
                    .flatMap((child) => elChildren(child))
                    .filter((child) => elName(child) === "w:rPr")
                    .flatMap((child) => elChildren(child))
                    .filter((child) => elName(child) === "w:ins")
                    .map((child) => String(elAttrs(child)["@_w:id"] ?? ""));
                if (paragraphMarkIds.some((id) => ids.has(id))) {
                    touched = true;
                    continue;
                }
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
    const zip = await loadDocxPackage(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const ids = new Set(changeIds.map(String));
    const present = new Set(trackedChangeIds(tree).map(({ w_id }) => w_id));
    if (!ids.size || [...ids].some((id) => !present.has(id))) {
        return { bytes, found: false };
    }

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

/** Apply the host-selected policy to newly written revision wrappers. */
export async function finalizeTrackedEdits(
    bytes: Buffer,
    changeIds: string[],
    mode: EditMode,
): Promise<{ bytes: Buffer; status: "pending" | "accepted" }> {
    if (mode === "manual") return { bytes, status: "pending" };
    const ids = [...new Set(changeIds.filter(Boolean))];
    const resolved = await resolveTrackedChange(bytes, ids, "accept");
    if (!resolved.found) {
        throw new Error("The automatic edit could not be verified; the document is unchanged");
    }
    return { bytes: resolved.bytes, status: "accepted" };
}
