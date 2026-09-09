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
    ATTR_KEY, type XNode, cloneNode, createBuilder, ensureXmlDeclaration,
    elAttrs, elChildren, elName, makeEl, makeText, setChildren,
} from "./docx/core";
import { type DocxParagraphIndex, openDocxSession } from "./docx/session";

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

/** Exact paragraph-child replacement; alignment and style selection belong to the planner. */
export type DocxRevisionPlan = {
    start: number;
    end: number;
    replacement: XNode[];
    insertion?: Record<string, string>;
    deletion?: { nodes: XNode[]; attributes: Record<string, string> };
};

export function emitDocxRevisionPlan(source: XNode[], plans: DocxRevisionPlan[]): XNode[] {
    const deleted = (node: XNode): XNode => {
        const name = elName(node);
        if (!name) return cloneNode(node);
        return { [name === "w:t" ? "w:delText" : name === "w:instrText" ? "w:delInstrText" : name]:
            elChildren(node).map(deleted), ...(node[ATTR_KEY] ? { [ATTR_KEY]: elAttrs(node) } : {}) };
    };
    const output: XNode[] = [];
    let cursor = 0;
    for (const plan of plans) {
        if (!Number.isSafeInteger(plan.start) || !Number.isSafeInteger(plan.end) ||
            plan.start < cursor || plan.end < plan.start || plan.end > source.length)
            throw new Error("Invalid or overlapping DOCX revision plan");
        output.push(...source.slice(cursor, plan.start));
        const insertion = plan.insertion
            ? [makeEl("w:ins", plan.replacement, plan.insertion)] : plan.replacement;
        const deletion = plan.deletion
            ? [makeEl("w:del", plan.deletion.nodes.map(deleted), plan.deletion.attributes)] : [];
        output.push(...deletion, ...insertion);
        cursor = plan.end;
    }
    return [...output, ...source.slice(cursor)];
}

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
export function buildRun(rPr: XNode | null, text: string, tagName: "w:t" | "w:delText", tabs = false): XNode {
    const children: XNode[] = [];
    if (rPr) children.push(cloneNode(rPr));
    const segments = text.split(tabs ? /(\t|\n)/u : /(\n)/u).filter(Boolean);
    for (const segment of segments) {
        children.push(segment === "\n" ? makeEl("w:br", [])
            : tabs && segment === "\t" ? makeEl("w:tab", [])
            : makeEl(tagName, [makeText(segment)], { "xml:space": "preserve" }));
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

/** Group adjacent edits in the character coordinates of the document being rewritten.
 * Callers own alignment: normalized equal tokens must carry that document's text.
 */
export function clusterTextChanges(parts: Iterable<diff.Diff>, coordinate: "old" | "new") {
    const clusters: { offset: number; deleted: string; inserted: string }[] = [];
    const coordinateText = coordinate === "old" ? "deleted" : "inserted";
    let offset = 0;
    for (const [op, text] of parts) {
        if (op === diff.EQUAL) {
            offset += text.length;
            continue;
        }
        const last = clusters[clusters.length - 1];
        let cluster: { offset: number; deleted: string; inserted: string };
        if (last && last.offset + last[coordinateText].length === offset) {
            cluster = last;
        } else {
            cluster = { offset, deleted: "", inserted: "" };
            clusters.push(cluster);
        }
        const field = op === diff.DELETE ? "deleted" : "inserted";
        cluster[field] += text;
        if (field === coordinateText) offset += text.length;
    }
    return clusters;
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
function minimalTextEdit(find: string, replace: string): {
    clusters: { offset: number; deleted: string; inserted: string }[];
    diff: EditDiffSegment[];
} {
    const parts = diff(find, replace, undefined, true);
    return {
        clusters: clusterTextChanges(parts, "old"),
        diff: parts.map(([op, text]) => ({ text,
            kind: op === diff.EQUAL ? "equal"
                : op === diff.DELETE ? "delete" : "insert" })),
    };
}

/** First interval ending after position. Empty runs/text nodes are skipped. */
function spanAt(spans: readonly { end: number }[], position: number): number {
    let low = 0;
    let high = spans.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (spans[middle].end <= position) low = middle + 1;
        else high = middle;
    }
    return low;
}

/** Rewrite only the runs touched by sorted, non-overlapping changes. */
function planParagraphRevision(flat: DocxParagraphIndex, plan: PlannedChange[],
    now: string, author: string): XNode[] {
    if (plan.length === 0 || flat.acceptedText.length === 0) return flat.children;
    // An insertion at paragraph end inherits the preceding nonempty run.
    const runAt = (position: number) => spanAt(flat.editRuns,
        Math.min(Math.max(position, 0), flat.acceptedText.length - 1));
    const firstRunIdx = runAt(plan[0].deleteStart);
    let lastRunIdx = firstRunIdx;
    for (const change of plan) {
        lastRunIdx = Math.max(lastRunIdx,
            runAt(Math.max(change.deleteStart, change.deleteEnd - 1)));
    }
    const firstRun = flat.editRuns[firstRunIdx];
    const lastRun = flat.editRuns[lastRunIdx];
    const newRunGroup: XNode[] = [];
    const revisions: DocxRevisionPlan[] = [];
    const emitText = (start: number, end: number, deletionId?: string) => {
        if (start >= end) return;
        const output = deletionId === undefined ? newRunGroup : [];
        for (let index = spanAt(flat.editRuns, start); index <= lastRunIdx; index++) {
            const run = flat.editRuns[index];
            if (run.start >= end) break;
            for (let n = spanAt(run.textNodes, start); n < run.textNodes.length; n++) {
                const node = run.textNodes[n];
                if (node.start >= end) break;
                const a = Math.max(start, node.start);
                const b = Math.min(end, node.end);
                if (a < b) output.push(buildRun(run.rPr, flat.acceptedText.slice(a, b),
                    deletionId === undefined ? "w:t" : "w:delText"));
            }
        }
        if (deletionId !== undefined) revisions.push({ start: newRunGroup.length,
            end: newRunGroup.length, replacement: [],
            deletion: { nodes: output, attributes: revisionAttrs(deletionId, author, now) } });
    };

    let cursor = firstRun.start;
    for (const change of plan) {
        emitText(cursor, change.deleteStart);
        if (change.insertedText) {
            const position = change.deleteStart === lastRun.end
                ? change.deleteStart - 1 : change.deleteStart;
            revisions.push({ start: newRunGroup.length, end: newRunGroup.length,
                replacement: [buildRun(flat.editRuns[runAt(position)].rPr, change.insertedText, "w:t")],
                insertion: revisionAttrs(change.insWId!, author, now) });
        }
        if (change.deleteEnd > change.deleteStart)
            emitText(change.deleteStart, change.deleteEnd, change.delWId!);
        cursor = change.deleteEnd;
    }
    emitText(cursor, lastRun.end);

    const dropped = new Set(flat.editRuns.slice(firstRunIdx, lastRunIdx + 1)
        .map((run) => run.childIndex));
    for (let index = firstRun.childIndex; index <= lastRun.childIndex; index++) {
        if (elName(flat.children[index]) === "w:del") dropped.add(index);
    }
    const revised = emitDocxRevisionPlan(newRunGroup, revisions);
    return flat.children.flatMap((child, index) =>
        index === firstRun.childIndex ? revised : dropped.has(index) ? [] : [child]);
}

function touchesContentControl(flat: DocxParagraphIndex, start: number, end: number): boolean {
    // At an insertion boundary either adjoining character can belong to a control.
    if (start === end) {
        start--;
        end++;
    }
    for (let index = spanAt(flat.editRuns, start); index < flat.editRuns.length; index++) {
        const run = flat.editRuns[index];
        if (run.start >= end) break;
        if (run.start < run.end && run.protectedByContentControl) return true;
    }
    return false;
}

function paragraphIndexForRange(paragraphs: DocxParagraphIndex[], start: number,
    end: number): number {
    let low = 0;
    let high = paragraphs.length - 1;
    while (low <= high) {
        const index = (low + high) >>> 1;
        const paragraph = paragraphs[index];
        const paragraphEnd = paragraph.globalStart + paragraph.acceptedText.length;
        if (start < paragraph.globalStart) high = index - 1;
        else if (start > paragraphEnd) low = index + 1;
        else return end <= paragraphEnd ? index : -1;
    }
    return -1;
}

interface Normalized {
    norm: string;
    origIdx: number[];
}

export function normalizeWs(input: string): Normalized {
    const s = input
        .replace(/[\u2018\u2019\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/\u00A0/g, " ")
        .replace(/\u200B/g, " ");
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        const space = /\s/.test(ch);
        if (space && prevSpace) continue;
        norm.push(space ? " " : ch);
        origIdx.push(i);
        prevSpace = space;
    }
    return { norm: norm.join(""), origIdx };
}

/**
 * Locate one context-qualified edit and return original UTF-16 document offsets.
 * Match contexts separately: concatenating them with the find text would change
 * the meaning of whitespace collapsed at their boundaries.
 */
function locateEdit(body: Normalized, originalLength: number, edit: EditInput):
    { start: number; end: number } | { error: "none" | "ambiguous" } {
    const find = normalizeWs(edit.find ?? "").norm;
    const before = normalizeWs(edit.context_before ?? "").norm;
    const after = normalizeWs(edit.context_after ?? "").norm;
    const needle = find || before || after;
    const offset = !find && before ? before.length : 0;
    let match = -1;

    for (let from = 0; from <= body.norm.length - needle.length;) {
        const index = body.norm.indexOf(needle, from);
        if (index < 0) break;
        from = index + 1; // Include overlapping occurrences when checking uniqueness.
        const position = index + offset;
        const contextStart = position - before.length;
        const contextEnd = position + find.length;
        if (contextStart < 0 ||
            body.norm.slice(contextStart, position) !== before ||
            body.norm.slice(contextEnd, contextEnd + after.length) !== after) continue;
        if (match >= 0) return { error: "ambiguous" };
        match = position;
    }

    if (match < 0) return { error: "none" };
    // An insertion can land at EOF; a nonempty match always has a last character.
    const start = body.origIdx[match] ?? originalLength;
    const end = find ? body.origIdx[match + find.length - 1] + 1 : start;
    return { start, end };
}

export interface InsertTrackedBlocksInput {
    blocks: string[];
    position: "before" | "after";
    anchorText?: string;
    occurrence?: number;
}

/**
 * Extract the body text of a .docx using the same flattening rules as the
 * tracked-changes matcher. Paragraphs are joined by a single newline. The
 * output is what the LLM should base its `find` / `context_before` /
 * `context_after` strings on, since it exactly mirrors the string the
 * anchor matcher operates against.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    const session = await openDocxSession(bytes);
    if (!session.has("word/document.xml")) return "";
    return session.document().then((document) => document.text, (error: unknown) => {
        if (/^w:body missing from /u.test(String((error as Error).message))) return "";
        throw error;
    });
}

/**
 * Walk document.xml in render order and collect the w:id for every
 * w:ins / w:del wrapper. The order here matches what docx-preview emits
 * as <ins>/<del> in the DOM, so the frontend can tag each rendered
 * element by index to recover the w:id attribute that docx-preview drops.
 */
export async function extractTrackedChangeIds(bytes: Buffer):
    Promise<{ kind: "ins" | "del"; w_id: string }[]> {
    return (await (await openDocxSession(bytes)).revisions()).changes;
}

export async function applyTrackedEdits(bytes: Buffer, edits: EditInput[],
    opts?: { author?: string }): Promise<ApplyTrackedEditsResult> {
    const author = opts?.author ?? "Beaver";
    const now = new Date().toISOString();

    const session = await openDocxSession(bytes);
    const document = await session.document();
    const { tree } = document;
    const paragraphs = document.paragraphs;

    // Word tracks text inside paragraphs. The assistant, however, reads the
    // document on the canonical paragraph stream and may copy several adjacent
    // paragraphs into one edit. Resolve that edit once on the same stream,
    // then pin one exact replacement to each paragraph. This preserves the
    // document's paragraph/list structure and keeps the existing writer small.
    type ConcreteEdit = { edit: EditInput; sourceIndex: number };
    const concreteEdits: ConcreteEdit[] = [];
    const errors: EditError[] = [];
    const fail = (index: number, reason: string) => errors.push({ index, reason });
    const diffByEdit = new Map<number, EditDiffSegment[]>();
    const bodyText = document.text;
    const bodyNorm = normalizeWs(bodyText);

    for (let sourceIndex = 0; sourceIndex < edits.length; sourceIndex++) {
        const source = edits[sourceIndex];
        const find = (source.find ?? "").replace(/\r\n?/g, "\n");
        const replace = (source.replace ?? "").replace(/\r\n?/g, "\n");
        const multiline = find.includes("\n") || replace.includes("\n");
        if (!find && (!replace || !source.context_before && !source.context_after &&
            !Number.isSafeInteger(source.exact_start))) {
            fail(sourceIndex, replace
                ? "Pure insertion requires context_before or context_after." : "Empty edit.");
            continue;
        }
        const hasExact = Number.isSafeInteger(source.exact_start) && Number.isSafeInteger(source.exact_end);
        const matched = hasExact
            ? { start: source.exact_start!, end: source.exact_end! }
            : locateEdit(bodyNorm, bodyText.length, source);
        if ("error" in matched) {
            fail(sourceIndex, multiline
                ? matched.error === "ambiguous"
                    ? "Ambiguous match for the multi-paragraph edit; the document is unchanged."
                    : "Could not locate the multi-paragraph edit; the document is unchanged."
                : matched.error === "ambiguous"
                    ? "Ambiguous match for this edit; the document is unchanged."
                    : "Could not locate this edit on the current document text plane; the document is unchanged.");
            continue;
        }
        if (!multiline) {
            concreteEdits.push({ edit: { ...source, find: hasExact ? source.find : bodyText.slice(matched.start, matched.end),
                exact_start: matched.start, exact_end: matched.end }, sourceIndex });
            continue;
        }

        const actualFind = bodyText.slice(matched.start, matched.end);
        diffByEdit.set(sourceIndex, minimalTextEdit(actualFind, replace).diff);
        const findLines = actualFind.split("\n");
        const replaceLines = replace.split("\n");
        if (findLines.length !== replaceLines.length) {
            fail(sourceIndex, `Multi-paragraph replacement must preserve the paragraph count (${findLines.length} found, ${replaceLines.length} supplied).`);
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
                        context_after: bodyText.slice(cursor + original.length,
                            cursor + original.length + 40),
                        reason: source.reason,
                        exact_start: cursor,
                        exact_end: cursor + original.length,
                    },
                });
            }
            cursor += original.length + (line + 1 < findLines.length ? 1 : 0);
        }
        if (!changed) fail(sourceIndex, "Replacement does not change the matched text.");
    }

    let nextWId = document.maxTrackedId + 1;
    const plansPerParagraph = new Map<number, PlannedChange[]>();
    const appliedChangesByEdit = new Map<number, AppliedChange>();
    const revisionIdsByEdit = new Map<
        number,
        { changeId: string; delWId?: string; insWId?: string }
    >();

    for (const { edit, sourceIndex: editIdx } of concreteEdits) {
        const find = edit.find ?? "";
        const replace = edit.replace ?? "";
        const exactStart = edit.exact_start!;
        const exactEnd = edit.exact_end!;
        if (exactStart < 0 || exactEnd < exactStart) {
            fail(editIdx, "Invalid exact edit span.");
            continue;
        }
        const paraIdx = paragraphIndexForRange(paragraphs, exactStart, exactEnd);
        if (paraIdx < 0) {
            fail(editIdx, "Exact edit span must resolve inside one paragraph.");
            continue;
        }
        const paragraph = paragraphs[paraIdx];
        const findStart = exactStart - paragraph.globalStart;
        const findEnd = exactEnd - paragraph.globalStart;
        // The pinned span is the matcher's own coordinate: it must still read
        // exactly as `find`, which the minimal diff then works from.
        if (paragraph.acceptedText.slice(findStart, findEnd) !== find) {
            fail(editIdx, "Exact edit span no longer matches the pinned text.");
            continue;
        }

        const minimal = minimalTextEdit(find, replace);
        const clusters = minimal.clusters;
        if (!diffByEdit.has(editIdx)) diffByEdit.set(editIdx, minimal.diff);
        if (clusters.length === 0) {
            fail(editIdx, "Replacement does not change the matched text.");
            continue;
        }
        if (clusters.some((cluster) => touchesContentControl(paragraph,
            findStart + cluster.offset,
            findStart + cluster.offset + cluster.deleted.length))) {
            fail(editIdx, "This edit touches a Word content control. Edit the control in Word or regenerate the draft.");
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
        const overlap = editPlans.some((plan) => existing.some((p) =>
            !(plan.deleteEnd <= p.deleteStart || plan.deleteStart >= p.deleteEnd)));
        if (overlap) {
            fail(editIdx, "Overlaps a previous edit in the same paragraph.");
            continue;
        }

        existing.push(...editPlans);
        existing.sort((a, b) => a.deleteStart - b.deleteStart);
        plansPerParagraph.set(paraIdx, existing);

        const joinClusters = (field: "deleted" | "inserted") =>
            clusters.map((cluster) => cluster[field]).filter(Boolean).join(" … ");
        const deletedText = joinClusters("deleted");
        const insertedText = joinClusters("inserted");
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
        const paragraph = paragraphs[paraIdx];
        setChildren(paragraph.node, planParagraphRevision(paragraph, plan, now, author));
    }

    session.writeDocument(tree);
    return { bytes: await session.save(), errors,
        changes: [...appliedChangesByEdit.values()] };
}

/** Insert new paragraphs as tracked text plus an inserted paragraph mark. */
export async function insertTrackedBlocks(bytes: Buffer,
    input: InsertTrackedBlocksInput,
    opts?: { author?: string }): Promise<ApplyTrackedEditsResult> {
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
        document.paragraphs.map((paragraph) => [paragraph.node, paragraph]));

    const paragraphIndexes = body.flatMap((node, index) => {
        const paragraph = byNode.get(node);
        return paragraph ? [{ paragraph, index }] : [];
    });
    let insertionIndex: number;
    let contextBefore = "";
    let contextAfter = "";
    if (input.anchorText?.trim()) {
        const needle = normalizeWs(input.anchorText).norm;
        const hits = paragraphIndexes.filter(({ paragraph }) =>
            normalizeWs(paragraph.visibleText).norm.includes(needle));
        const chosen = typeof input.occurrence === "number"
            ? hits[input.occurrence - 1]
            : hits.length === 1 ? hits[0] : undefined;
        if (!chosen) {
            throw new Error(hits.length
                ? `insert_blocks anchor is ambiguous (${hits.length} paragraphs); set occurrence`
                : "insert_blocks anchor paragraph was not found");
        }
        const anchor = chosen.paragraph.visibleText;
        contextBefore = input.position === "after" ? anchor.slice(-120) : "";
        contextAfter = input.position === "before" ? anchor.slice(0, 120) : "";
        insertionIndex = chosen.index + (input.position === "after" ? 1 : 0);
    } else if (input.position === "before") {
        insertionIndex = paragraphIndexes[0]?.index ?? 0;
    } else {
        const sectionProperties = body.findIndex((n) => elName(n) === "w:sectPr");
        insertionIndex = sectionProperties < 0 ? body.length : sectionProperties;
    }

    const author = opts?.author ?? "Beaver";
    const date = new Date().toISOString();
    let nextId = document.maxTrackedId + 1;
    const changes: AppliedChange[] = [];
    const paragraphs = input.blocks.map((block) => {
        const id = String(nextId++);
        const attrs = revisionAttrs(id, author, date);
        changes.push({ id, insId: id, deletedText: "", insertedText: block,
            contextBefore, contextAfter, diff: [{ kind: "insert", text: block }] });
        const paragraph = makeEl("w:p", emitDocxRevisionPlan([], [{ start: 0, end: 0,
            replacement: [buildRun(null, block, "w:t")], insertion: attrs }]));
        markParagraphRevision(paragraph, "w:ins", attrs);
        return paragraph;
    });
    body.splice(insertionIndex, 0, ...paragraphs);
    session.writeDocument(tree);
    return { bytes: await session.save(), changes, errors: [] };
}

/** Transform matching w:ins/w:del wrappers in place, in every story tree. */
function resolveInTree(doc: XNode[], changeIds: string[],
    mode: "accept" | "reject"): { found: boolean } {
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
                const marks = elChildren(n)
                    .flatMap((c) => elName(c) === "w:pPr" ? elChildren(c) : [])
                    .flatMap((c) => elName(c) === "w:rPr" ? elChildren(c) : [])
                    .filter((c) => elName(c) === "w:ins");
                if (marks.some((c) => ids.has(String(elAttrs(c)["@_w:id"] ?? "")))) {
                    touched = true;
                    continue;
                }
            }

            const kids = elChildren(n);
            if (kids.length) setChildren(n, rewrite(kids));

            if (name === "w:ins" || name === "w:del") {
                if (ids.has(String(elAttrs(n)["@_w:id"] ?? ""))) {
                    touched = true;
                    // Accepting an insertion or rejecting a deletion keeps the
                    // wrapped content; the other two cases drop it.
                    if ((name === "w:ins" && mode === "accept") ||
                        (name === "w:del" && mode === "reject")) {
                        out.push(...(name === "w:del"
                            ? elChildren(n).map(unwrapDelText) : elChildren(n)));
                    }
                    continue;
                }
            }

            out.push(n);
        }
        return out;
    };

    for (const top of doc) {
        const docKids = elChildren(top);
        setChildren(top, rewrite(docKids));
    }

    return { found: touched };
}

function unwrapDelText(n: XNode): XNode {
    const name = elName(n);
    if (!name) return n;
    if (name === "w:delText" || name === "w:delInstrText") {
        const attrs = elAttrs(n);
        return { [name === "w:delText" ? "w:t" : "w:instrText"]: elChildren(n),
            ...(Object.keys(attrs).length ? { [ATTR_KEY]: attrs } : {}) };
    }
    setChildren(n, elChildren(n).map(unwrapDelText));
    return n;
}

export async function resolveTrackedChange(bytes: Buffer, changeIds: string[],
    mode: "accept" | "reject"): Promise<{ bytes: Buffer; found: boolean }> {
    const session = await openDocxSession(bytes);
    const parts = await session.revisionParts();
    const ids = new Set(changeIds.map(String));
    const present = new Set(parts.flatMap(({ changes }) => changes.map(({ w_id }) => w_id)));
    if (!ids.size || [...ids].some((id) => !present.has(id))) return { bytes, found: false };
    for (const { path, tree } of parts) {
        if (resolveInTree(tree, changeIds, mode).found)
            session.write(path, ensureXmlDeclaration(createBuilder().build(tree)));
    }
    return { bytes: await session.save(), found: true };
}

/** Apply the host-selected policy to newly written revision wrappers. */
export async function finalizeTrackedEdits(bytes: Buffer, changeIds: string[],
    mode: EditMode): Promise<{ bytes: Buffer; status: "pending" | "accepted" }> {
    if (mode === "manual") return { bytes, status: "pending" };
    const ids = [...new Set(changeIds.filter(Boolean))];
    const resolved = await resolveTrackedChange(bytes, ids, "accept");
    if (!resolved.found) {
        throw new Error("The automatic edit could not be verified; the document is unchanged");
    }
    return { bytes: resolved.bytes, status: "accepted" };
}
