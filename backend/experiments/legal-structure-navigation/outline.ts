import type { AgreementSkeleton } from "../../src/lib/legalTextSkeleton";

export interface OutlineOptions {
  maxChars?: number;
  maxDefinedTerms?: number;
}

/** Compact, complete map: the whole point is that nothing structural is lost. */
export function renderAgreementOutline(
  skeleton: AgreementSkeleton,
  options?: OutlineOptions,
): string {
  const maxChars = options?.maxChars ?? 8_000;
  const maxTerms = options?.maxDefinedTerms ?? 60;
  const lines: string[] = [];
  const labelCounts = new Map<string, number>();
  for (const node of skeleton.nodes) {
    labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
  }
  for (const node of skeleton.nodes) {
    const size = node.end - node.start;
    const indent = "  ".repeat(node.depth);
    const heading = node.heading ? ` ${node.heading}` : "";
    const sizeNote = node.depth === 0 ? ` (${Math.round(size / 4)} tokens approx)` : "";
    const handle =
      (labelCounts.get(node.label) ?? 0) === 1
        ? `[${node.label}]`
        : `[repeated ${node.label}]`;
    lines.push(`${indent}${node.display}${heading} ${handle}${sizeNote}`);
  }
  let body = lines.join("\n");
  let truncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    body = body.slice(0, body.lastIndexOf("\n"));
    truncated = true;
  }
  const parts = [body];
  if (truncated) {
    parts.push(`… outline truncated (${skeleton.nodes.length} nodes total)`);
  }
  if (skeleton.definedTerms.length) {
    const shown = skeleton.definedTerms.slice(0, maxTerms);
    parts.push(
      `Defined terms (${skeleton.definedTerms.length}): ` +
        shown
          .map(
            (entry) =>
              `"${entry.term}"${entry.sectionLabel ? ` [${entry.sectionLabel}]` : ""}`,
          )
          .join(", ") +
        (skeleton.definedTerms.length > shown.length ? ", …" : ""),
    );
  }
  if (skeleton.schedules.length) {
    parts.push(`Schedules/Exhibits: ${skeleton.schedules.join("; ")}`);
  }
  const refs = skeleton.crossReferences;
  parts.push(
    `Cross-references: ${refs.internal} internal, ${refs.external} external` +
      (refs.unresolved.length
        ? `; unresolved internal targets: ${refs.unresolved.join(", ")}`
        : ""),
  );
  if (skeleton.ladder.restarts || skeleton.ladder.violations) {
    parts.push(
      `Ladder notes: ${skeleton.ladder.restarts} enumerator restart(s), ` +
        `${skeleton.ladder.violations} out-of-order enumerator(s); repeated ` +
        `subsection labels carry @n occurrence suffixes.`,
    );
  }
  return parts.join("\n\n");
}
