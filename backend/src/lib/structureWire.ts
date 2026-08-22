import { isJsonRecord as record } from "./value";

export const STRUCTURE_EVIDENCE_SCHEMA = "legalpdf.structure-evidence.v1";
const STRUCTURE_RESULT_SCHEMA = "legalpdf.structure-graph.v2";
const STRUCTURE_CAPABILITIES = ["native_claims", "raw_recovery"] as const;

export type StructureCapability = typeof STRUCTURE_CAPABILITIES[number];
export type StructureRange = { start: number; end: number };
export type StructureKind =
  | "paragraph" | "prose" | "page" | "section" | "heading" | "footnote" | "endnote"
  | "list" | "list_item" | "navigation";
export type StructureOrigin = { id: string };
export type StructureEvidenceV1 = {
  schema_version: typeof STRUCTURE_EVIDENCE_SCHEMA;
  document_id: string; provider: string; provider_revision: string; text: string;
  profile:
    | "case_rooted_complete" | "case_contiguous_complete" | "case_lossy"
    | "legislation" | "instrument" | "journal";
  report_start_page?: number; require_report_start: boolean;
  allow_hyphenated_sections: boolean;
  text_sha256: string; source_sha256?: string; offset_unit: "unicode-scalar";
  scope: { kind: "complete" | "excerpt"; excerpt_of?: string };
  origins: StructureOrigin[];
  native_claims: Array<{
    id: string; kind: StructureKind; label?: string; aliases: string[]; parent_label?: string;
    anchor?: string; range: StructureRange; origin_id: string;
  }>;
  coverage: Array<{
    kind: StructureKind; range: StructureRange; state: "absent" | "augment" | "complete";
  }>;
  exclusions: Array<{ range: StructureRange; applies_to: string[] }>;
  paragraph_breaks: Array<{ at: number; origin_id: string }>;
};

type GraphSource = "native" | "heuristic" | "model";
export type StructureGraphV2 = {
  schema_version: typeof STRUCTURE_RESULT_SCHEMA; document_id: string; text_sha256: string;
  source_sha256?: string; status: "complete" | "partial";
  nodes: Array<{
    id: string; kind: StructureKind | "heading" | "endnote" | "prose";
    range: StructureRange; origin_id: string; source: GraphSource; label?: string;
    locator_kind?: "section" | "subsection" | "article" | "part" | "schedule" |
      "clause" | "subclause" | "exhibit" | "annex" | "appendix";
    aliases?: string[]; parent_id?: string; anchor?: string; content_start?: number;
    marker_range?: StructureRange;
    page_indexes?: number[]; line_ids?: string[]; level?: number; grammar?: string;
    proof?: { rule: string; observations: unknown[] };
  }>;
  boundaries: Array<{
    kind: "paragraph" | "prose"; at: number; origin_id: string; source: GraphSource;
  }>;
  relations: Array<{
    id: string; kind: "contains" | "precedes" | "references" | "footnote_for";
    from: { node_id: string } | { range: StructureRange };
    to: { node_id: string } | { range: StructureRange };
    origin_id: string; source: GraphSource; page_indexes: number[]; line_ids: string[];
  }>;
  diagnostics: Array<{
    code: string; severity: "info" | "warning" | "error";
    run_id?: string; candidate_ids?: string[]; rules?: string[];
    ranges: StructureRange[]; node_ids: string[];
  }>;
};
export type StructureResultItem =
  | { id: string; ok: true; result: StructureGraphV2 }
  | { id: string; ok: false; error: { code: string; message: string } };

function checkedOffset(value: number, maximum: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} offset is out of range`);
  }
}
export function documentScalarOffsets(text: string) {
  if (!/[\uD800-\uDFFF]/.test(text)) return {
    scalarLength: text.length,
    utf16ToScalar(offset: number) { checkedOffset(offset, text.length, "UTF-16"); return offset; },
    scalarToUtf16(offset: number) { checkedOffset(offset, text.length, "scalar"); return offset; },
  };
  const boundaries = [0];
  for (let offset = 0; offset < text.length; boundaries.push(offset)) {
    const first = text.charCodeAt(offset++);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = text.charCodeAt(offset++);
      if (!(second >= 0xdc00 && second <= 0xdfff)) throw new Error("Document text contains an unpaired UTF-16 surrogate");
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error("Document text contains an unpaired UTF-16 surrogate");
    }
  }
  return {
    scalarLength: boundaries.length - 1,
    utf16ToScalar(offset: number) {
      checkedOffset(offset, text.length, "UTF-16");
      let low = 0, high = boundaries.length - 1;
      while (low <= high) {
        const at = (low + high) >>> 1;
        if (boundaries[at] === offset) return at;
        if (boundaries[at] < offset) low = at + 1; else high = at - 1;
      }
      throw new RangeError("UTF-16 offset splits a Unicode scalar");
    },
    scalarToUtf16(offset: number) {
      checkedOffset(offset, boundaries.length - 1, "scalar"); return boundaries[offset];
    },
  };
}

export type StructureInputIdentity = {
  id: string; textHash: string; sourceHash?: string; scalarLength: number;
};
const HEX = /^[a-f0-9]{64}$/u;
const SOURCES = ["native", "heuristic", "model"];
const NODE_KINDS = ["paragraph", "page", "section", "heading", "footnote", "endnote", "prose", "list", "list_item", "navigation"];
const RELATION_KINDS = ["contains", "precedes", "references", "footnote_for"];
function structureWireShape(value: unknown, required: string[], optional: string[] = []) {
  if (!record(value) || !required.every((key) => key in value) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("Structure sidecar returned an invalid shape");
  }
  return value;
}
function scalarRange(value: unknown, length: number) {
  const range = structureWireShape(value, ["start", "end"]);
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      Number(range.start) < 0 || Number(range.start) > Number(range.end) || Number(range.end) > length) {
    throw new Error("Structure sidecar returned an invalid scalar range");
  }
  return range as StructureRange;
}
function nonempty(value: unknown, maximum = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function endpoint(value: unknown, nodes: Set<string>, length: number) {
  const item = structureWireShape(value, [], ["node_id", "range"]);
  if (("node_id" in item) === ("range" in item) ||
      ("node_id" in item && (!nonempty(item.node_id) || !nodes.has(item.node_id))) ||
      ("range" in item && !scalarRange(item.range, length))) {
    throw new Error("Structure sidecar returned an invalid relation endpoint");
  }
}
export function validateStructureGraph(value: unknown, input: StructureInputIdentity): StructureGraphV2 {
  const root = structureWireShape(value,
    ["schema_version", "document_id", "text_sha256", "status", "nodes", "boundaries", "relations", "diagnostics"],
    ["source_sha256"]);
  if (root.schema_version !== STRUCTURE_RESULT_SCHEMA || root.document_id !== input.id ||
      root.text_sha256 !== input.textHash || !["complete", "partial"].includes(String(root.status)) ||
      root.source_sha256 !== input.sourceHash ||
      (root.source_sha256 !== undefined && (typeof root.source_sha256 !== "string" || !HEX.test(root.source_sha256))) ||
      ![root.nodes, root.boundaries, root.relations, root.diagnostics].every(Array.isArray)) {
    throw new Error(`Structure sidecar returned an invalid graph for ${input.id}`);
  }
  const nodes = new Set<string>();
  for (const raw of root.nodes as unknown[]) {
    const node = structureWireShape(raw, ["id", "kind", "range", "origin_id", "source"], ["label", "locator_kind", "aliases", "parent_id", "anchor", "content_start", "marker_range", "page_indexes", "line_ids", "level", "grammar", "proof"]);
    if (!nonempty(node.id) || nodes.has(node.id) || !NODE_KINDS.includes(String(node.kind)) ||
        !nonempty(node.origin_id) || !SOURCES.includes(String(node.source)) ||
        !scalarRange(node.range, input.scalarLength) ||
        ["label", "parent_id", "anchor"].some((key) => node[key] !== undefined && !nonempty(node[key])) ||
        (node.locator_kind !== undefined && (node.kind !== "section" || !nonempty(node.locator_kind))) ||
        (node.aliases !== undefined && (!Array.isArray(node.aliases) || !node.aliases.every((alias) => nonempty(alias)))) ||
        (node.page_indexes !== undefined && (!Array.isArray(node.page_indexes) || !node.page_indexes.every((page) => Number.isSafeInteger(page) && Number(page) >= 0))) ||
        (node.line_ids !== undefined && (!Array.isArray(node.line_ids) || !node.line_ids.every((id) => nonempty(id)))) ||
        (node.level !== undefined && (!Number.isSafeInteger(node.level) || Number(node.level) < 0)) ||
        (node.grammar !== undefined && !nonempty(node.grammar)) ||
        (node.proof !== undefined && !record(node.proof)) ||
        (node.marker_range !== undefined && !scalarRange(node.marker_range, input.scalarLength)) ||
        (node.content_start !== undefined && (node.kind !== "section" || !Number.isSafeInteger(node.content_start) ||
          Number(node.content_start) < (node.range as StructureRange).start ||
          Number(node.content_start) > (node.range as StructureRange).end))) {
      throw new Error("Structure sidecar returned an invalid node");
    }
    nodes.add(node.id);
  }
  for (const raw of root.nodes as Record<string, unknown>[]) {
    if (raw.parent_id !== undefined && !nodes.has(String(raw.parent_id))) throw new Error("Structure sidecar returned an invalid parent node");
  }
  for (const raw of root.boundaries as unknown[]) {
    const boundary = structureWireShape(raw, ["kind", "at", "origin_id", "source"]);
    scalarRange({ start: boundary.at, end: boundary.at }, input.scalarLength);
    if (!["paragraph", "prose"].includes(String(boundary.kind)) || !nonempty(boundary.origin_id) ||
        !SOURCES.includes(String(boundary.source))) throw new Error("Structure sidecar returned an invalid boundary");
  }
  const relations = new Set<string>();
  for (const raw of root.relations as unknown[]) {
    const relation = structureWireShape(raw,
      ["id", "kind", "from", "to", "origin_id", "source", "page_indexes", "line_ids"]);
    if (!nonempty(relation.id) || relations.has(relation.id) || !RELATION_KINDS.includes(String(relation.kind)) ||
        !nonempty(relation.origin_id) || !SOURCES.includes(String(relation.source)) ||
        !Array.isArray(relation.page_indexes) ||
        !relation.page_indexes.every((page) => Number.isSafeInteger(page) && Number(page) >= 0) ||
        !Array.isArray(relation.line_ids) || !relation.line_ids.every((id) => nonempty(id))) {
      throw new Error("Structure sidecar returned an invalid relation");
    }
    endpoint(relation.from, nodes, input.scalarLength); endpoint(relation.to, nodes, input.scalarLength);
    relations.add(relation.id);
  }
  for (const raw of root.diagnostics as unknown[]) {
    const diagnostic = structureWireShape(raw, ["code", "severity", "ranges", "node_ids"],
      ["run_id", "candidate_ids", "rules"]);
    if (!nonempty(diagnostic.code) || !["info", "warning", "error"].includes(String(diagnostic.severity)) ||
        !Array.isArray(diagnostic.ranges) || !diagnostic.ranges.every((range) => scalarRange(range, input.scalarLength)) ||
        (diagnostic.run_id !== undefined && !nonempty(diagnostic.run_id)) ||
        (diagnostic.candidate_ids !== undefined && (!Array.isArray(diagnostic.candidate_ids) || !diagnostic.candidate_ids.every((id) => nonempty(id)))) ||
        (diagnostic.rules !== undefined && (!Array.isArray(diagnostic.rules) ||
          !diagnostic.rules.every((rule) => nonempty(rule)))) ||
        !Array.isArray(diagnostic.node_ids) || !diagnostic.node_ids.every((id) => nonempty(id) && nodes.has(id))) {
      throw new Error("Structure sidecar returned an invalid diagnostic");
    }
  }
  return root as StructureGraphV2;
}
