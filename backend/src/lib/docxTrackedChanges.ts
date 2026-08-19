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
    elAttrs,
    elChildren,
    elName,
    makeEl,
    makeText,
    setChildren,
} from "./docx/core";
import {
    type DocxParagraphIndex,
    openDocxSession,
} from "./docx/session";

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
}

export const revisionAttrs = (id: string, author: string, date: string) => ({
    "w:id": id,
    "w:author": author,
    "w:date": date,
});

export function markParagraphRevision(
    paragraph: XNode,
    kind: "w:ins" | "w:del",
    attrs: Record<string, string>,
): void {
    const kids = elChildren(paragraph);
    let pPr = kids.find((node) => elName(node) === "w:pPr");
    if (!pPr) kids.unshift((pPr = makeEl("w:pPr")));
    const properties = elChildren(pPr);
    let rPr = properties.find((node) => elName(node) === "w:rPr");
    if (!rPr) {
        rPr = makeEl("w:rPr");
        const section = properties.findIndex((node) => elName(node) === "w:sectPr");
        properties.splice(section < 0 ? properties.length : section, 0, rPr);
    }
    elChildren(rPr).unshift(makeEl(kind, [], attrs));
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

/**
 * A single logical change. Spans a contiguous [start, end) character range in
 * the paragraph text (may be empty for a pure insert) and may carry an
 * inserted string appended at `start`.
 */
interface PlannedChange {
    deleteStart: number;          // paragraph text offset (inclusive)
    deleteEnd: number;            // paragraph text offset (exclusive); may equal start
    insertedText: string;         // may be empty
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
    flat: DocxParagraphIndex,
    plan: PlannedChange[],
    now: string,
    author: string,
): XNode[] {
    if (plan.length === 0) return paraChildren;

    let firstRunIdx = flat.editRuns.length;
    let lastRunIdx = -1;
    for (const p of plan) {
        for (let pos = p.deleteStart; pos < p.deleteEnd; pos++) {
            const r = flat.charRun[pos];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
        if (p.deleteStart === p.deleteEnd && p.deleteStart < flat.acceptedText.length) {
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
        return paraChildren;
    }

    const startChildIdx = flat.editRuns[firstRunIdx].childIndex;
    const endChildIdx = flat.editRuns[lastRunIdx].childIndex;

    const firstRun = flat.editRuns[firstRunIdx];
    const lastRun = flat.editRuns[lastRunIdx];
    const spanStart =
        firstRun.textNodes.length > 0 ? firstRun.textNodes[0].paraStart : 0;
    const spanEnd =
        lastRun.textNodes.length > 0
            ? lastRun.textNodes[lastRun.textNodes.length - 1].paraEnd
            : spanStart;

    const newRunGroup: XNode[] = [];

    const rPrForPos = (pos: number): XNode | null => {
        if (pos < 0) pos = 0;
        if (pos >= flat.acceptedText.length) pos = flat.acceptedText.length - 1;
        if (pos < 0) return firstRun.rPr;
        return flat.editRuns[flat.charRun[pos]].rPr;
    };

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
            const slot = flat.editRuns[runIdx];
            const rPr = slot.rPr;
            const slice = flat.acceptedText.slice(i, j);
            newRunGroup.push(buildRun(rPr, slice, "w:t"));
            i = j;
        }
    };

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
            const slot = flat.editRuns[runIdx];
            const slice = flat.acceptedText.slice(i, j);
            inner.push(buildRun(slot.rPr, slice, "w:delText"));
            i = j;
        }
        newRunGroup.push(
            makeEl("w:del", inner, revisionAttrs(wId, author, now)),
        );
    };

    const emitIns = (pos: number, text: string, wId: string) => {
        if (!text) return;
        const rPr = rPrForPos(pos === spanEnd ? pos - 1 : pos);
        const run = buildRun(rPr, text, "w:t");
        newRunGroup.push(
            makeEl("w:ins", [run], revisionAttrs(wId, author, now)),
        );
    };

    let cursor = spanStart;
    for (const p of plan) {
        emitNormal(cursor, p.deleteStart);
        if (p.insertedText) emitIns(p.deleteStart, p.insertedText, p.insWId!);
        if (p.deleteEnd > p.deleteStart)
            emitDel(p.deleteStart, p.deleteEnd, p.delWId!);
        cursor = p.deleteEnd;
    }
    emitNormal(cursor, spanEnd);

    const droppedChildIdx = new Set<number>();
    for (let r = firstRunIdx; r <= lastRunIdx; r++) {
        droppedChildIdx.add(flat.editRuns[r].childIndex);
    }
    for (let i = startChildIdx; i <= endChildIdx; i++) {
        if (elName(paraChildren[i]) === "w:del") droppedChildIdx.add(i);
    }
    const firstDroppedIdx = startChildIdx;
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

interface ParagraphRef {
    paraNode: XNode;
    paraChildren: XNode[];
    flat: DocxParagraphIndex;
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
        const paragraphEnd = paragraph.globalStart + paragraph.flat.acceptedText.length;
        if (start < paragraph.globalStart) high = index - 1;
        else if (start > paragraphEnd) low = index + 1;
        else return end <= paragraphEnd ? index : -1;
    }
    return -1;
}

function preNormalize(s: string): string {
    return s
        .replace(/[\u2018\u2019\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/\u00A0/g, " ")
        .replace(/\u200B/g, " ");
}

interface Normalized {
    norm: string;
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

/**
 * The body text plus native DOCX table coordinates on the same offset plane.
 * Nested tables remain part of the containing cell's text. Vertical and
 * horizontal merge continuations remain in the global flattened text, but
 * mint no independent address and do not extend the restart cell's span.
 */
export async function extractDocxBodyStructure(
    bytes: Buffer,
): Promise<DocxBodyStructure> {
    const session = await openDocxSession(bytes);
    if (!session.has("word/document.xml")) return { text: "", tableCells: [] };
    const document = await session.document().catch((error: unknown) => {
        if (/^w:body missing from /u.test(String((error as Error).message))) {
            return null;
        }
        throw error;
    });
    if (!document) return { text: "", tableCells: [] };
    return { text: document.text, tableCells: document.tableCells };
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
    return (await (await openDocxSession(bytes)).revisions()).changes;
}

export async function applyTrackedEdits(
    bytes: Buffer,
    edits: EditInput[],
    opts?: { author?: string },
): Promise<ApplyTrackedEditsResult> {
    const author = opts?.author ?? "Beaver";
    const now = new Date().toISOString();

    const session = await openDocxSession(bytes);
    const document = await session.document();
    const { tree } = document;

    const paragraphs: ParagraphRef[] = document.paragraphs.map((flat) => ({
        paraNode: flat.node,
        paraChildren: flat.children,
        flat,
        globalStart: flat.globalStart,
    }));

    // Word tracks text inside paragraphs. The assistant, however, reads the
    // document on the canonical paragraph stream and may copy several adjacent
    // paragraphs into one edit. Resolve that edit once on the same stream,
    // then pin one exact replacement to each paragraph. This preserves the
    // document's paragraph/list structure and keeps the existing writer small.
    type ConcreteEdit = { edit: EditInput; sourceIndex: number };
    const concreteEdits: ConcreteEdit[] = [];
    const errors: EditError[] = [];
    const diffByEdit = new Map<number, EditDiffSegment[]>();
    const bodyText = document.text;
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

    let nextWId = document.maxTrackedId + 1;
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
                paragraph.flat.acceptedText.slice(findStart, findEnd) !== find
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

        const originalFind = paragraphs[paraIdx].flat.acceptedText.slice(
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
        const protectedAt = (position: number) =>
            position >= 0 &&
            position < paragraphs[paraIdx].flat.acceptedText.length &&
            paragraphs[paraIdx].flat.editRuns[
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
            deleteStart: findStart + cluster.offset,
            deleteEnd: findStart + cluster.offset + cluster.deleted.length,
            insertedText: cluster.inserted,
            delWId: cluster.deleted ? revision.delWId : undefined,
            insWId: cluster.inserted ? revision.insWId : undefined,
        }));

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
            .join(" … ");
        const insertedText = clusters
            .map((cluster) => cluster.inserted)
            .filter(Boolean)
            .join(" … ");
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

    session.writeDocument(tree);
    return {
        bytes: await session.save(),
        changes: [...appliedChangesByEdit.values()],
        errors,
    };
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
    const session = await openDocxSession(bytes);
    const document = await session.document();
    const { tree } = document;
    const body = elChildren(document.body);
    const byNode = new Map(
        document.paragraphs.map((paragraph) => [paragraph.node, paragraph]),
    );

    const paragraphIndexes = body
        .map((node, index) => ({ paragraph: byNode.get(node), index }))
        .filter(
            (entry): entry is { paragraph: DocxParagraphIndex; index: number } =>
                !!entry.paragraph,
        );
    let insertionIndex: number;
    let contextBefore = "";
    let contextAfter = "";
    if (input.anchorText?.trim()) {
        const needle = normalizeWs(input.anchorText).norm;
        const hits = paragraphIndexes.filter(({ paragraph }) =>
            normalizeWs(paragraph.visibleText).norm.includes(needle),
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
        const anchor = chosen.paragraph.visibleText;
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
    let nextId = document.maxTrackedId + 1;
    const changes: AppliedChange[] = [];
    const paragraphs = input.blocks.map((block) => {
        const id = String(nextId++);
        const attrs = revisionAttrs(id, author, date);
        changes.push({
            id,
            insId: id,
            deletedText: "",
            insertedText: block,
            contextBefore,
            contextAfter,
            diff: [{ kind: "insert", text: block }],
        });
        const paragraph = makeEl("w:p", [
            makeEl("w:ins", [
                makeEl("w:r", [
                    makeEl("w:t", [makeText(block)], { "xml:space": "preserve" }),
                ]),
            ], attrs),
        ]);
        markParagraphRevision(paragraph, "w:ins", attrs);
        return paragraph;
    });
    body.splice(insertionIndex, 0, ...paragraphs);
    session.writeDocument(tree);
    return {
        bytes: await session.save(),
        changes,
        errors: [],
    };
}

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
                        const inner =
                            name === "w:del"
                                ? (elChildren(n) as XNode[]).map(unwrapDelText)
                                : (elChildren(n) as XNode[]);
                        for (const c of inner) out.push(c);
                        continue;
                    } else {
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
    const session = await openDocxSession(bytes);
    const document = await session.document();
    const { tree } = document;
    const ids = new Set(changeIds.map(String));
    const present = new Set(document.trackedChanges.map(({ w_id }) => w_id));
    if (!ids.size || [...ids].some((id) => !present.has(id))) {
        return { bytes, found: false };
    }

    const { found } = resolveInTree(tree, changeIds, mode);

    session.writeDocument(tree);
    return { bytes: await session.save(), found };
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
