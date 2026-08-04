/**
 * SILO'D LAB EXPERIMENT — derived-section-index arm (`mike_markdown_e2e_index_v1`).
 *
 * Derives the section tree of a .docx at ingest using the EXISTING detectors —
 * `extractDocxBodyStructure` for the plaintext paragraph-stream, then
 * `compileAgreementSkeleton` — and prepends a compact SECT-INDEX to the served
 * markdown so the model can orient and read selectively instead of whole-reading.
 *
 * Consumers only: no detector is modified. The whole experiment is gated on
 * `MIKE_STRUCTURE_INDEX === "1"`. To remove it: delete this file, delete the
 * `STRUCTURE_INDEX_ENABLED` branch in the docx read path in
 * `localAssistantTools.ts`, delete `MARKDOWN_E2E_INDEX_*` from
 * `upstreamMikeBenchmarkSurface.ts`, and delete the `mike_markdown_e2e_index_v1`
 * arm entry from `lab-beaver-arm.ts`.
 *
 * Rationale (measured): the markdown already states top-level section numbers
 * in its headings, and pandoc does not flatten subsections — `(a)` items are
 * the literal docx text. What the markdown never states is the COMPOSED
 * subsection identity ("Section 2.01(a)"), which the skeleton derives from the
 * parent section plus the `(a)` token. The index carries that identity once,
 * compactly, so inline markers would only duplicate the heading text.
 */
import { extractDocxBodyStructure } from "../docxTrackedChanges";
import {
  compileAgreementSkeleton,
  type SkeletonNode,
} from "../legalTextSkeleton";

export const STRUCTURE_INDEX_ENABLED =
  process.env.MIKE_STRUCTURE_INDEX === "1";

/** Node kinds that form the derived section spine (never table/row/cell). */
const INDEX_KINDS = new Set<string>([
  "article",
  "part",
  "division",
  "section",
  "subsection",
  "schedule",
]);

const MAX_HEADING_CHARS = 64;

function headingTail(node: SkeletonNode): string {
  const heading = node.heading?.trim() ?? "";
  if (!heading) return "";
  const shown =
    heading.length <= MAX_HEADING_CHARS
      ? heading
      : `${heading.slice(0, MAX_HEADING_CHARS).trimEnd()}…`;
  return ` — ${shown}`;
}

/**
 * The compact section spine: one line per derived node, `display — heading`
 * (e.g. `Section 2.01(a) — Subject to the terms and conditions set forth her…`).
 * The heading fragment is the text a `find_in_document` search can locate in
 * the served markdown, so every index line has a resolvable anchor.
 */
export function renderStructureIndex(nodes: SkeletonNode[]): string {
  const spine = nodes.filter((node) => INDEX_KINDS.has(node.kind));
  if (!spine.length) return "";
  const lines = spine.map(
    (node) => `  ${node.display}${headingTail(node)}`,
  );
  return [
    `SECT-INDEX (derived from the document's own numbering; ${spine.length} numbered sections/parts; read only what the deliverable requires)`,
    ...lines,
  ].join("\n");
}

/**
 * Consumes the existing .docx detectors to get the derived section tree.
 * Reads the same bytes the drafting-source read uses.
 */
export async function deriveSectionNodes(
  bytes: Buffer,
): Promise<SkeletonNode[]> {
  const body = await extractDocxBodyStructure(bytes);
  if (!body.text) return [];
  return compileAgreementSkeleton(body.text, "drafting", {}).nodes;
}

/**
 * Prepend the index to the served markdown. A document with no derived
 * structure contributes nothing (typed refusal — the surface stays identical).
 */
export function attachStructureIndex(
  markdown: string,
  index: string,
): string {
  return index ? `${index}\n\n${markdown}` : markdown;
}
