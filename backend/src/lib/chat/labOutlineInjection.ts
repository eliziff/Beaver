/**
 * Host-side, one-time structure injection for the Harvey LAB harness arm
 * `grounded_structure_outline_v1`.
 *
 * Hypothesis (H7, lean-understanding representation): presenting the agreement
 * structure to the composer once, as a compact outline plus a top-K
 * most-referenced cross-reference summary, may lower comprehension cost for
 * the model's single authoring turn compared to the two-hop Grep→Read path
 * whose match dumps flood context. The graph is therefore NOT a new tool and
 * NOT a per-section query surface — it is injected once into the system
 * context at surface build time, deterministically, with no model call.
 *
 * Bounds and refusals: per-document and total caps keep the block cheap; a
 * document that refuses (no numbered structure, source too large, outline too
 * big) contributes nothing. The block is never a truncated dump of a document.
 */
import { crossReferenceGraph } from "../legalCrossReference";
import {
  compileAgreementSkeleton,
  renderAgreementOutline,
  type AgreementSkeleton,
} from "../legalTextSkeleton";

export const GROUNDED_STRUCTURE_OUTLINE_INJECTION_ENABLED =
  process.env.MIKE_GROUNDED_OUTLINE_INJECTION === "1";

/** Upper bound on one document's injected block (outline + hub summary). */
export const LAB_OUTLINE_PER_DOC_MAX_CHARS = 2_000;
/** Upper bound on the whole injected block across all source documents. */
export const LAB_OUTLINE_TOTAL_MAX_CHARS = 6_000;
/** Cheapness guard: skip skeleton work entirely above this source size. */
export const LAB_OUTLINE_MAX_SOURCE_CHARS = 2_000_000;
/** Top-K most-referenced sections included in the hub summary. */
export const LAB_OUTLINE_TOP_K = 8;
/** Node-tree budget passed to the outline renderer (the body, pre-footer). */
export const LAB_OUTLINE_BODY_MAX_CHARS = 1_200;
/** Defined terms kept per outline before the hub summary takes over. */
export const LAB_OUTLINE_MAX_DEFINED_TERMS = 8;
/** Unresolved targets kept in the cross-reference footer line. */
export const LAB_OUTLINE_MAX_UNRESOLVED_TARGETS = 6;

export interface LabOutlineSourceDocument {
  /** doc-N label exactly as the surface's AVAILABLE DOCUMENTS block shows. */
  label: string;
  /** Filename shown in the surface inventory (orientation only). */
  filename: string;
  /** Extracted source text, in the same plane Read/Grep address. */
  text: string;
}

interface SectionHub {
  label: string;
  refs: number;
}

/** Most-referenced sections over the graph's resolved literal edges. */
function topReferencedSections(
  text: string,
  id: string,
  skeleton: AgreementSkeleton,
): SectionHub[] {
  const graph = crossReferenceGraph(text, id, { skeleton });
  const byTarget = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.status !== "resolved" || edge.selfLoop) continue;
    if (!edge.targetLabel) continue;
    byTarget.set(edge.targetLabel, (byTarget.get(edge.targetLabel) ?? 0) + 1);
  }
  return [...byTarget.entries()]
    .map(([label, refs]) => ({ label, refs }))
    .sort(
      (left, right) =>
        right.refs - left.refs || (left.label < right.label ? -1 : 1),
    )
    .slice(0, LAB_OUTLINE_TOP_K);
}

/**
 * Compact, LAB-safe outline via the product renderer.
 *
 * The product renderer tells the caller to consult the Library find tool for
 * repeated labels; the LAB surface has no such tool (a prose mention would
 * silently teach a name the served tool list does not carry). Keep the label,
 * drop the tool reference. The cross-reference footer's unresolved-target list
 * is also bounded — a composer does not need dozens of dangles.
 */
function labOutlineText(skeleton: AgreementSkeleton): string {
  return renderAgreementOutline(skeleton, {
    maxChars: LAB_OUTLINE_BODY_MAX_CHARS,
    maxDefinedTerms: LAB_OUTLINE_MAX_DEFINED_TERMS,
  })
    .replace(/\[repeated ([^\]]+); use library_find\]/gu, "[repeated $1]")
    .replace(/; unresolved internal targets: (.+)$/u, (_, rest: string) => {
      const targets = rest.split(", ");
      const kept = targets
        .slice(0, LAB_OUTLINE_MAX_UNRESOLVED_TARGETS)
        .join(", ");
      const tail =
        targets.length > LAB_OUTLINE_MAX_UNRESOLVED_TARGETS ? ", …" : "";
      return `; unresolved internal targets: ${kept}${tail}`;
    });
}

/**
 * Build the one-time structure block for a source bundle. Empty when every
 * document refuses or the whole bundle is empty — the caller then injects
 * nothing and the surface stays byte-identical to the non-injection arm.
 */
export function buildLabOutlineInjectionBlock(
  documents: LabOutlineSourceDocument[],
): string {
  const entries: string[] = [];
  let budget = LAB_OUTLINE_TOTAL_MAX_CHARS;
  for (const document of documents) {
    if (document.text.length > LAB_OUTLINE_MAX_SOURCE_CHARS) continue;
    const skeleton = compileAgreementSkeleton(document.text, document.label);
    if (!skeleton.nodes.length) continue; // typed refusal: not a numbered instrument
    const outline = labOutlineText(skeleton);
    if (outline.length > LAB_OUTLINE_PER_DOC_MAX_CHARS) continue;
    const hubs = topReferencedSections(
      document.text,
      document.label,
      skeleton,
    );
    const entry = [
      `-- ${document.label}: ${document.filename}`,
      outline,
      hubs.length
        ? `most-referenced sections: ${hubs
            .map((hub) => `${hub.label} (${hub.refs} refs)`)
            .join(", ")}`
        : "most-referenced sections: none resolved",
    ].join("\n");
    // Hard per-document cap on the whole entry, then the running total cap.
    if (entry.length > LAB_OUTLINE_PER_DOC_MAX_CHARS) continue;
    if (entry.length > budget) break;
    entries.push(entry);
    budget -= entry.length;
  }
  if (!entries.length) return "";
  return (
    "SOURCE STRUCTURE OUTLINE (host-computed, one-time orientation; a " +
    "document omitted below has no numbered structure or was too large for a " +
    "compact outline):\n" +
    entries.join("\n\n")
  );
}
