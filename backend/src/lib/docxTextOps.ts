/**
 * Shared deterministic DOCX edit pipeline.
 *
 * The model names an operation and a scope; the server does the rest, so
 * document text is never retyped for mechanical transforms:
 *
 *   1. Project the pinned DOCX version's body text (`extractDocxBodyText` —
 *      the same flattening the tracked-changes matcher uses).
 *   2. Resolve each op's scope ONCE against that text (whole document, every
 *      or the Nth occurrence of found text, or a from/to range). Matching is
 *      whitespace- and smart-quote-tolerant via `normalizeWs`.
 *   3. Run the pure text op (textOps.ts registry) over each scoped interval
 *      and turn the character differences into minimal replacements
 *      (fast-diff), none of which may cross a paragraph boundary.
 *   4. Emit the replacements as `EditInput[]` through the existing
 *      `applyTrackedEdits`, which produces native w:ins/w:del tracked
 *      changes (author "Beaver") with one accept/rejectable change per
 *      replacement — the same emission path as `Edit`.
 */

import diff from "fast-diff";
import {
  applyTrackedEdits,
  clusterTextChanges,
  extractDocxBodyText,
  normalizeWs,
  type EditDiffSegment,
  type EditInput,
} from "./docxTrackedChanges";
import { runTextOp, type TextOpNote, type TextOpParams } from "./textOps";

export type TextOpScope =
  | { kind: "whole_document" }
  | { kind: "find_text"; text: string; occurrence?: number }
  | { kind: "range"; from_text: string; to_text: string }
  /**
   * Spans already resolved by the address layer (`at: "8.01"`, a page, a
   * clause plus what it references). Rust resolves the address against the
   * NativeDocument; execution only needs the resulting spans, so this module
   * stays free of structure-engine dependencies.
   *
   * Both layers project the DOCX with `extractDocxBodyText`, which is what
   * makes an offset resolved for reading valid for editing. That shared
   * plane is load-bearing: there is deliberately no second extractor.
   */
  | { kind: "spans"; spans: { start: number; end: number }[] };

export type TextOpRequest = TextOpParams & { op: string; scope: TextOpScope };

export type TextOpReport = {
  op: string;
  replacements: number;
  notes: TextOpNote[];
};

export type AppliedTextEdit = {
  changeId: string;
  delWId?: string;
  insWId?: string;
  deletedText: string;
  insertedText: string;
  contextBefore: string;
  contextAfter: string;
  diff: EditDiffSegment[];
};

export type ApplyTextOpsResult = {
  bytes: Buffer;
  edits: AppliedTextEdit[];
  reports: TextOpReport[];
  replacementCount: number;
  editErrors: string[];
};

type Replacement = { start: number; end: number; text: string };

function findNormalized(
  docText: string,
  docNorm: ReturnType<typeof normalizeWs>,
  needle: string,
): { start: number; end: number }[] {
  const needleNorm = normalizeWs(needle).norm;
  if (!needleNorm) return [];
  const out: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= docNorm.norm.length - needleNorm.length) {
    const at = docNorm.norm.indexOf(needleNorm, from);
    if (at < 0) break;
    from = at + 1;
    const start = docNorm.origIdx[at];
    const lastNorm = at + needleNorm.length - 1;
    const end =
      lastNorm < docNorm.origIdx.length
        ? docNorm.origIdx[lastNorm] + 1
        : docText.length;
    out.push({ start, end });
  }
  return out;
}

function resolveScope(
  scope: TextOpScope,
  docText: string,
  docNorm: ReturnType<typeof normalizeWs>,
): { start: number; end: number }[] {
  if (scope.kind === "whole_document") {
    return [{ start: 0, end: docText.length }];
  }
  if (scope.kind === "spans") {
    const spans = scope.spans
      .map((span) => ({
        start: Math.max(0, Math.min(span.start, docText.length)),
        end: Math.max(0, Math.min(span.end, docText.length)),
      }))
      .filter((span) => span.end > span.start)
      .sort((left, right) => left.start - right.start);
    if (!spans.length) throw new Error("Resolved scope is empty");
    return spans;
  }
  if (scope.kind === "find_text") {
    const hits = findNormalized(docText, docNorm, scope.text);
    if (!hits.length) {
      throw new Error(
        `Scope text not found: "${scope.text.slice(0, 80)}". Copy it verbatim from the document.`,
      );
    }
    if (typeof scope.occurrence === "number") {
      const hit = hits[scope.occurrence - 1];
      if (!hit) {
        throw new Error(
          `Scope occurrence ${scope.occurrence} not found (${hits.length} matches)`,
        );
      }
      return [hit];
    }
    return hits;
  }
  const fromHit = findNormalized(docText, docNorm, scope.from_text)[0];
  if (!fromHit) {
    throw new Error(`Range start not found: "${scope.from_text.slice(0, 80)}"`);
  }
  const toHit = findNormalized(docText, docNorm, scope.to_text).find(
    (hit) => hit.start >= fromHit.end,
  );
  if (!toHit) {
    throw new Error(
      `Range end not found after its start: "${scope.to_text.slice(0, 80)}"`,
    );
  }
  return [{ start: fromHit.start, end: toHit.end }];
}

/** Convert shared old-text diff clusters into paragraph-safe, anchorable edits.
 * Widen insertions before coalescing gaps of at most two original characters;
 * neither operation may join changes across a paragraph boundary. */
function textOpReplacements(
  docText: string, base: number, before: string, after: string,
) {
  const out: Replacement[] = [];
  for (const { offset, deleted, inserted } of clusterTextChanges(diff(before, after), "old")) {
    const delParts = deleted.split("\n"), insParts = inserted.split("\n");
    if (delParts.length !== insParts.length) {
      throw new Error("A text op moved a paragraph boundary");
    }
    let at = base + offset;
    for (let i = 0; i < delParts.length; i++) {
      let start = at, end = at + delParts[i].length, text = insParts[i];
      at = end + 1;
      if (start === end && !text) continue;
      // A pure insertion borrows a neighbor from the original paragraph.
      if (start === end) {
        if (start > 0 && docText[start - 1] !== "\n") {
          start -= 1;
          text = docText[start] + text;
        } else {
          text += docText[end];
          end += 1;
        }
      }
      const prev = out[out.length - 1];
      const gap = prev ? docText.slice(prev.end, start) : "";
      if (prev && start - prev.end <= 2 && !gap.includes("\n")) {
        prev.end = end;
        prev.text += gap + text;
      } else {
        out.push({ start, end, text });
      }
    }
  }
  return out;
}

export async function planTextOps(
  docText: string,
  ops: TextOpRequest[],
): Promise<{ replacements: Replacement[]; reports: TextOpReport[] }> {
  const docNorm = normalizeWs(docText);
  const all: Replacement[] = [];
  const reports: TextOpReport[] = [];
  for (const request of ops) {
    const intervals = resolveScope(request.scope, docText, docNorm);
    const report: TextOpReport = { op: request.op, replacements: 0, notes: [] };
    for (const interval of intervals) {
      const scoped = docText.slice(interval.start, interval.end);
      const { text, notes } = await runTextOp(request.op, scoped, request);
      report.notes.push(...notes);
      const replacements = textOpReplacements(docText, interval.start, scoped, text);
      report.replacements += replacements.length;
      all.push(...replacements);
    }
    reports.push(report);
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < all.length; i++) {
    if (all[i].start < all[i - 1].end) {
      throw new Error(
        "Two ops produced overlapping changes; apply them in separate calls",
      );
    }
  }
  return { replacements: all, reports };
}

/**
 * Apply deterministic text ops to DOCX bytes; returns the redlined bytes and
 * one accept/rejectable tracked edit per replacement. Store-agnostic —
 * persistence is the caller's job.
 */
export async function applyTextOpsToDocx(
  originalBytes: Buffer,
  ops: TextOpRequest[],
): Promise<ApplyTextOpsResult> {
  const docText = await extractDocxBodyText(originalBytes);
  const { replacements, reports } = await planTextOps(docText, ops);
  if (!replacements.length) {
    return {
      bytes: originalBytes,
      edits: [],
      reports,
      replacementCount: 0,
      editErrors: [],
    };
  }
  const edits: EditInput[] = replacements.map((r) => ({
    find: docText.slice(r.start, r.end),
    replace: r.text,
    exact_start: r.start, exact_end: r.end,
    context_before: "", context_after: "",
  }));
  const applied = await applyTrackedEdits(originalBytes, edits, {
    author: "Beaver",
  });
  return {
    bytes: applied.bytes,
    edits: applied.changes.map((change) => ({
      changeId: change.id,
      delWId: change.delId,
      insWId: change.insId,
      deletedText: change.deletedText,
      insertedText: change.insertedText,
      contextBefore: change.contextBefore,
      contextAfter: change.contextAfter,
      diff: change.diff,
    })),
    reports,
    replacementCount: replacements.length,
    editErrors: applied.errors.map(
      (error) => `change ${error.index + 1}: ${error.reason}`,
    ),
  };
}
