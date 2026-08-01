import {
  deleteProvisionAndRenumberSiblings,
  type DeleteAndRenumberFailureCode,
} from "./legalAmendOps";
import { nodeLinks, type PageMap } from "./legalDocumentNavigator";
import type {
  CrossReferenceEdge,
  CrossReferenceGraph,
} from "./legalCrossReference";
import {
  readSection,
  type AgreementSkeleton,
  type SkeletonNode,
} from "./legalTextSkeleton";

const MAX_OUTPUT_CHARS = 4_000;
const MAX_VALUE_CHARS = 200;

export interface OffsetReadRecipe {
  offset: number;
  limit: number;
}

export type ReadRecipe = { section: string } | OffsetReadRecipe;

export type DocumentMapFocus =
  | "provisions"
  | "tables"
  | "pages"
  | "landmarks";

export interface DocumentMapInput {
  text: string;
  skeleton: AgreementSkeleton;
  pageMap: PageMap;
  focus: DocumentMapFocus;
  query?: string;
  maxResults?: number;
}

export interface DocumentMapRow {
  kind: "provision" | "table" | "row" | "cell" | "page" | "landmark";
  label: string;
  read: ReadRecipe;
  heading?: string;
  ordinal?: number;
  /** Canonical page address, for example `pdf:12`. */
  pdf?: string;
  /** Canonical printed-page address, for example `printed:iv`. */
  printed?: string;
}

export type DocumentMapFailureCode =
  | "text_skeleton_mismatch"
  | "invalid_focus"
  | "invalid_query"
  | "invalid_max_results"
  | "invalid_span"
  | "pages_unavailable";

export interface DocumentMapFailure {
  code: DocumentMapFailureCode;
  label?: string;
  detail?: string;
}

export interface DocumentMapResult {
  rows: DocumentMapRow[];
  failures: DocumentMapFailure[];
  truncated: boolean;
}

export type ReferenceImpactOperation =
  | "inbound"
  | "outbound"
  | "delete_and_close_gap";

export interface ReferenceImpactInput {
  text: string;
  skeleton: AgreementSkeleton;
  graph: CrossReferenceGraph;
  targets: string[];
  operation: ReferenceImpactOperation;
}

export interface ReferenceImpactRow {
  kind: "target" | "affected_sibling" | "inbound" | "outbound";
  target: string;
  label: string;
  read: ReadRecipe;
  from?: string;
  to?: string;
}

export type ReferenceImpactFailureCode =
  | DeleteAndRenumberFailureCode
  | "text_skeleton_mismatch"
  | "graph_skeleton_mismatch"
  | "graph_abstained"
  | "targets_required"
  | "too_many_targets"
  | "invalid_target"
  | "invalid_operation"
  | "target_not_found"
  | "target_ambiguous"
  | "target_unavailable"
  | "invalid_span"
  | "reference_external"
  | "reference_unresolved"
  | "reference_abstained"
  | "reference_target_missing"
  | "planning_skeleton_mismatch";

export interface ReferenceImpactFailure {
  code: ReferenceImpactFailureCode;
  target?: string;
  detail?: string;
}

export interface ReferenceImpactResult {
  rows: ReferenceImpactRow[];
  failures: ReferenceImpactFailure[];
  truncated: boolean;
}

type BoundedResult<Row, Failure extends { detail?: string }> = {
  rows: Row[];
  failures: Failure[];
  truncated: boolean;
};

function compact(value: string, max = MAX_VALUE_CHARS): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

function boundedResult<Row, Failure extends { detail?: string }>(
  sourceRows: readonly Row[],
  sourceFailures: readonly Failure[],
  maxRows: number,
  alreadyTruncated = false,
): BoundedResult<Row, Failure> {
  const rows = sourceRows.slice(0, maxRows);
  const failures = sourceFailures.slice(0, maxRows).map((failure) => ({
    ...failure,
    ...(failure.detail ? { detail: compact(failure.detail) } : {}),
  }));
  const result: BoundedResult<Row, Failure> = {
    rows,
    failures,
    truncated:
      alreadyTruncated ||
      rows.length < sourceRows.length ||
      failures.length < sourceFailures.length,
  };
  while (JSON.stringify(result).length > MAX_OUTPUT_CHARS) {
    result.truncated = true;
    if (result.rows.length) result.rows.pop();
    else if (result.failures.length > 1) result.failures.pop();
    else if (result.failures[0]?.detail) delete result.failures[0].detail;
    else break;
  }
  return result;
}

function documentResult(
  rows: readonly DocumentMapRow[],
  failures: readonly DocumentMapFailure[],
  maxRows: number,
  alreadyTruncated = false,
): DocumentMapResult {
  return boundedResult<DocumentMapRow, DocumentMapFailure>(
    rows,
    failures,
    maxRows,
    alreadyTruncated,
  );
}

function impactResult(
  rows: readonly ReferenceImpactRow[],
  failures: readonly ReferenceImpactFailure[],
  alreadyTruncated = false,
): ReferenceImpactResult {
  return boundedResult<ReferenceImpactRow, ReferenceImpactFailure>(
    rows,
    failures,
    50,
    alreadyTruncated,
  );
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function offsetRecipe(
  text: string,
  starts: readonly number[],
  start: number,
  end: number,
): OffsetReadRecipe | null {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  ) {
    return null;
  }
  let last = end;
  while (last > start && (text[last - 1] === "\n" || text[last - 1] === "\r")) {
    last -= 1;
  }
  if (last === start) return null;
  const firstLine = lineAt(starts, start);
  const lastLine = lineAt(starts, last - 1);
  return { offset: firstLine + 1, limit: lastLine - firstLine + 1 };
}

function nodeRecipe(
  text: string,
  starts: readonly number[],
  skeleton: AgreementSkeleton,
  node: Pick<SkeletonNode, "label" | "start" | "end">,
): ReadRecipe | null {
  const lookup = readSection(skeleton, node.label);
  if (
    lookup.status === "found" &&
    lookup.block?.start === node.start &&
    lookup.block.end === node.end
  ) {
    return { section: node.label };
  }
  return offsetRecipe(text, starts, node.start, node.end);
}

function matchesQuery(
  text: string,
  query: readonly string[],
  fields: readonly string[],
  start?: number,
  end?: number,
): boolean {
  if (!query.length) return true;
  const body =
    start !== undefined && end !== undefined && start >= 0 && end >= start
      ? text.slice(start, end)
      : "";
  const haystack = [...fields, body].join(" ").toLocaleLowerCase();
  return query.every((term) => haystack.includes(term));
}

function mapKind(node: SkeletonNode): DocumentMapRow["kind"] {
  if (node.kind === "section" || node.kind === "subsection") return "provision";
  if (node.kind === "table" || node.kind === "row" || node.kind === "cell") {
    return node.kind;
  }
  return "landmark";
}

/** Build a bounded map of executable Read addresses, without document prose. */
export function documentMap(input: DocumentMapInput): DocumentMapResult {
  const failures: DocumentMapFailure[] = [];
  if (input.skeleton.doc.text !== input.text) {
    return documentResult([], [{ code: "text_skeleton_mismatch" }], 25);
  }
  const focusKinds: Record<DocumentMapFocus, ReadonlySet<SkeletonNode["kind"]>> = {
    provisions: new Set(["section", "subsection"]),
    tables: new Set(["table", "row", "cell"]),
    pages: new Set(),
    landmarks: new Set(["article", "part", "division", "schedule"]),
  };
  const kinds = focusKinds[input.focus];
  if (!kinds) return documentResult([], [{ code: "invalid_focus" }], 25);
  if (
    input.query !== undefined &&
    (typeof input.query !== "string" || input.query.length > MAX_VALUE_CHARS)
  ) {
    return documentResult([], [{ code: "invalid_query" }], 25);
  }
  if (
    input.maxResults !== undefined &&
    (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1)
  ) {
    return documentResult([], [{ code: "invalid_max_results" }], 25);
  }
  const maxResults = Math.min(input.maxResults ?? 25, 25);
  const query = (input.query ?? "")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  const starts = lineStarts(input.text);
  const rows: DocumentMapRow[] = [];

  if (input.focus === "pages") {
    if (!input.pageMap.pages.length) {
      return documentResult([], [{ code: "pages_unavailable" }], maxResults);
    }
    for (const page of [...input.pageMap.pages].sort(
      (left, right) => left.start - right.start || left.ordinal - right.ordinal,
    )) {
      const pdf = page.pdfPage === null ? undefined : `pdf:${page.pdfPage}`;
      const printed = page.printedLabel
        ? `printed:${page.printedLabel}`
        : undefined;
      if (
        !matchesQuery(input.text, query, [
          String(page.ordinal),
          pdf ?? "",
          printed ?? "",
        ])
      ) {
        continue;
      }
      const read = offsetRecipe(input.text, starts, page.start, page.end);
      if (!read) {
        failures.push({ code: "invalid_span", label: pdf ?? printed });
        continue;
      }
      rows.push({
        kind: "page",
        label: pdf ?? printed ?? `page:${page.ordinal}`,
        ordinal: page.ordinal,
        ...(pdf ? { pdf } : {}),
        ...(printed ? { printed } : {}),
        read,
      });
    }
  } else {
    for (const node of input.skeleton.nodes) {
      if (!kinds.has(node.kind)) continue;
      if (
        !matchesQuery(
          input.text,
          query,
          [node.label, node.display, node.heading],
          node.start,
          node.end,
        )
      ) {
        continue;
      }
      const read = nodeRecipe(input.text, starts, input.skeleton, node);
      if (!read) {
        failures.push({ code: "invalid_span", label: compact(node.label) });
        continue;
      }
      const heading = compact(node.heading, 120);
      rows.push({
        kind: mapKind(node),
        label: compact(node.label),
        ...(heading ? { heading } : {}),
        read,
      });
    }
  }
  return documentResult(rows, failures, maxResults);
}

function graphMatchesSkeleton(
  graph: CrossReferenceGraph,
  skeleton: AgreementSkeleton,
): boolean {
  if (graph.nodes.length !== skeleton.nodes.length) return false;
  const nodes = new Set(
    skeleton.nodes.map((node) => `${node.label}\u0000${node.start}\u0000${node.end}`),
  );
  return graph.nodes.every((node) =>
    nodes.has(`${node.label}\u0000${node.start}\u0000${node.end}`),
  );
}

function targetNode(
  skeleton: AgreementSkeleton,
  target: string,
): { node: SkeletonNode | null; status: ReturnType<typeof readSection>["status"] } {
  const lookup = readSection(skeleton, target);
  if (lookup.status !== "found" || !lookup.block) {
    return { node: null, status: lookup.status };
  }
  const node = skeleton.nodes.find(
    (candidate) =>
      candidate.label === lookup.block!.label &&
      candidate.start === lookup.block!.start &&
      candidate.end === lookup.block!.end,
  );
  return { node: node ?? null, status: node ? "found" : "not_found" };
}

function referenceFailure(
  target: string,
  edge: CrossReferenceEdge,
): ReferenceImpactFailure {
  const code: ReferenceImpactFailureCode =
    edge.status === "external"
      ? "reference_external"
      : edge.status === "abstained"
        ? "reference_abstained"
        : "reference_unresolved";
  return {
    code,
    target,
    detail: `${edge.raw}: ${edge.reason ?? edge.status}`,
  };
}

function locationRecipe(
  text: string,
  starts: readonly number[],
  start: number,
  end: number,
): OffsetReadRecipe | null {
  return offsetRecipe(text, starts, start, end);
}

/** Inspect literal-reference or delete-and-renumber impact without mutating text. */
export function referenceImpact(input: ReferenceImpactInput): ReferenceImpactResult {
  if (input.skeleton.doc.text !== input.text) {
    return impactResult([], [{ code: "text_skeleton_mismatch" }]);
  }
  if (!graphMatchesSkeleton(input.graph, input.skeleton)) {
    return impactResult([], [{ code: "graph_skeleton_mismatch" }]);
  }
  if (
    input.operation !== "inbound" &&
    input.operation !== "outbound" &&
    input.operation !== "delete_and_close_gap"
  ) {
    return impactResult([], [{ code: "invalid_operation" }]);
  }
  if (!Array.isArray(input.targets) || !input.targets.length) {
    return impactResult([], [{ code: "targets_required" }]);
  }
  if (input.targets.length > 25) {
    return impactResult([], [{ code: "too_many_targets" }]);
  }

  const starts = lineStarts(input.text);
  const rows: ReferenceImpactRow[] = [];
  const failures: ReferenceImpactFailure[] = [];
  const seenTargets = new Set<string>();
  const seenRows = new Set<string>();
  const pushRow = (row: ReferenceImpactRow) => {
    const key = JSON.stringify(row);
    if (!seenRows.has(key)) {
      seenRows.add(key);
      rows.push(row);
    }
  };

  for (const rawTarget of input.targets) {
    if (typeof rawTarget !== "string") {
      failures.push({ code: "invalid_target" });
      continue;
    }
    const requested = rawTarget.trim();
    if (!requested || requested.length > MAX_VALUE_CHARS) {
      failures.push({ code: "invalid_target", target: compact(requested) });
      continue;
    }
    const targetKey = requested.toLocaleLowerCase();
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);

    const resolved = targetNode(input.skeleton, requested);
    if (!resolved.node) {
      const code: ReferenceImpactFailureCode =
        resolved.status === "ambiguous"
          ? "target_ambiguous"
          : resolved.status === "unavailable"
            ? "target_unavailable"
            : "target_not_found";
      failures.push({ code, target: compact(requested) });
      continue;
    }
    const node = resolved.node;
    const target = node.label;
    const read = nodeRecipe(input.text, starts, input.skeleton, node);
    if (!read) {
      failures.push({ code: "invalid_span", target });
      continue;
    }
    pushRow({ kind: "target", target, label: target, read });

    if (input.graph.documentAbstained) {
      failures.push({
        code: "graph_abstained",
        target,
        detail: input.graph.note ?? undefined,
      });
      continue;
    }
    const links = nodeLinks(input.graph, target);

    if (input.operation === "inbound" || input.operation === "delete_and_close_gap") {
      for (const edge of [...links.incoming].sort(
        (left, right) => left.sourceStart - right.sourceStart,
      )) {
        const edgeRead = locationRecipe(
          input.text,
          starts,
          edge.sourceStart,
          edge.sourceEnd,
        );
        if (!edgeRead) {
          failures.push({ code: "invalid_span", target });
          continue;
        }
        pushRow({
          kind: "inbound",
          target,
          label: edge.sourceLabel ?? `offset:${edgeRead.offset}`,
          ...(edge.sourceLabel ? { from: edge.sourceLabel } : {}),
          to: target,
          read: edgeRead,
        });
      }
    }

    if (input.operation === "outbound") {
      for (const edge of [...links.outgoing].sort(
        (left, right) => left.sourceStart - right.sourceStart,
      )) {
        if (edge.selfLoop) continue;
        if (edge.status !== "resolved" || !edge.targetLabel) {
          failures.push(referenceFailure(target, edge));
          continue;
        }
        const affected = input.skeleton.nodes.find(
          (candidate) => candidate.label === edge.targetLabel,
        );
        if (!affected) {
          failures.push({
            code: "reference_target_missing",
            target,
            detail: edge.targetLabel,
          });
          continue;
        }
        const edgeRead = locationRecipe(
          input.text,
          starts,
          edge.sourceStart,
          edge.sourceEnd,
        );
        if (!edgeRead) {
          failures.push({ code: "invalid_span", target });
          continue;
        }
        pushRow({
          kind: "outbound",
          target,
          label: edge.sourceLabel ?? `offset:${edgeRead.offset}`,
          from: target,
          to: affected.label,
          read: edgeRead,
        });
      }
    }

    if (input.operation === "delete_and_close_gap") {
      const plan = deleteProvisionAndRenumberSiblings(input.text, target);
      for (const failure of plan.failures) {
        failures.push({
          code: failure.code,
          target,
          detail: failure.detail,
        });
      }
      if (plan.failures.length) continue;
      const deletion = plan.applied.find(
        (receipt) => receipt.kind === "delete_provision",
      );
      if (
        !deletion ||
        deletion.start !== node.start ||
        deletion.end !== node.end
      ) {
        failures.push({ code: "planning_skeleton_mismatch", target });
        continue;
      }
      for (const receipt of plan.applied) {
        if (receipt.kind === "renumber_heading" && receipt.to) {
          const sibling = input.skeleton.nodes.find(
            (candidate) => candidate.label === receipt.from,
          );
          const siblingRead = sibling
            ? nodeRecipe(input.text, starts, input.skeleton, sibling)
            : null;
          if (!siblingRead) {
            failures.push({ code: "invalid_span", target });
            continue;
          }
          pushRow({
            kind: "affected_sibling",
            target,
            label: receipt.from,
            from: receipt.from,
            to: receipt.to,
            read: siblingRead,
          });
        } else if (receipt.kind === "update_cross_reference" && receipt.to) {
          const receiptRead = locationRecipe(
            input.text,
            starts,
            receipt.start,
            receipt.end,
          );
          if (!receiptRead) {
            failures.push({ code: "invalid_span", target });
            continue;
          }
          pushRow({
            kind: "inbound",
            target,
            label: `offset:${receiptRead.offset}`,
            from: receipt.from,
            to: receipt.to,
            read: receiptRead,
          });
        }
      }
    }
  }

  return impactResult(rows, failures);
}
