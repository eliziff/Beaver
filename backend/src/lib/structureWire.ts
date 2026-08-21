import { isJsonRecord as record } from "./value";

export const STRUCTURE_EVIDENCE_SCHEMA = "legalpdf.structure-evidence.v1";
export const STRUCTURE_RESULT_SCHEMA = "legalpdf.structure-graph.v1";
export const STRUCTURE_CAPABILITIES = ["native_claims", "raw_recovery"] as const;

export type StructureCapability = typeof STRUCTURE_CAPABILITIES[number];
export type StructureRange = { start: number; end: number };
export type StructureKind =
  | "paragraph" | "prose" | "page" | "section" | "heading" | "footnote" | "endnote";
export type StructureOrigin = {
  id: string; producer: string; representation: string; revision: string; authority: string;
};
type UnitBase = {
  id: string; parent_id?: string; source_order: number; provider_order?: number;
  range: StructureRange; origin_id: string; page_index?: number; page_number?: number;
  flow_id?: string;
  raw_geometry?: {
    coordinate_space: string; page_width: number; page_height: number;
    bbox: [number, number, number, number];
  };
};
export type StructureUnit =
  | (UnitBase & { role: "page"; page_layout?: {
      column_separator?: number; source?: string; text_quality?: number;
    } })
  | (UnitBase & { role: "region"; region_layout?: {
      kind?: string; member_line_ids?: string[]; reading_order?: number;
    } })
  | (UnitBase & { role: "line"; line_layout?: {
      source_index?: number; reading_order?: number; block_index?: number; source?: string;
      exclude_from_body?: boolean; region_id?: string; region_type?: string;
      note_region_mode?: string; suppress_footnote_label?: boolean;
      detached_references?: Array<{
        note_id?: string; range?: StructureRange; selected_text?: string; source_line_id?: string;
      }>;
    } })
  | (UnitBase & { role: "word" })
  | (UnitBase & { role: "span"; span_style?: {
      font?: string; size?: number; flags?: number; superscript?: boolean;
    } });
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
  origins: StructureOrigin[]; units: StructureUnit[];
  native_claims: Array<{
    id: string; kind: StructureKind; label?: string; aliases: string[]; parent_label?: string;
    anchor?: string; range: StructureRange; provider_order: number; origin_id: string;
  }>;
  coverage: Array<{
    kind: StructureKind; range: StructureRange; state: "absent" | "augment" | "complete";
    origin_id?: string; reason: string;
  }>;
  exclusions: Array<{
    range: StructureRange; applies_to: string[]; reason: string; origin_id: string;
  }>;
  paragraph_breaks: Array<{
    at: number; before_unit?: string; after_unit?: string; origin_id: string; strength: string;
  }>;
};

type GraphSource = "native" | "heuristic" | "model";
export type StructureGraphV1 = {
  schema_version: typeof STRUCTURE_RESULT_SCHEMA; document_id: string; text_sha256: string;
  source_sha256?: string; status: "complete" | "partial";
  nodes: Array<{
    id: string; kind: StructureKind | "heading" | "endnote" | "prose";
    range: StructureRange; origin_id: string; source: GraphSource; label?: string;
    aliases?: string[]; parent_id?: string; anchor?: string; content_start?: number;
  }>;
  boundaries: Array<{
    kind: "paragraph" | "prose"; at: number; origin_id: string; source: GraphSource;
  }>;
  relations: Array<{
    id: string; kind: "contains" | "precedes" | "references" | "footnote_for";
    from: { node_id: string } | { range: StructureRange };
    to: { node_id: string } | { range: StructureRange };
    origin_id: string; source: GraphSource;
  }>;
  diagnostics: Array<{
    code: string; severity: "info" | "warning" | "error";
    ranges: StructureRange[]; node_ids: string[];
  }>;
};
export type StructureResultItem =
  | { id: string; ok: true; result: StructureGraphV1 }
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
const NODE_KINDS = ["paragraph", "page", "section", "heading", "footnote", "endnote", "prose"];
const RELATION_KINDS = ["contains", "precedes", "references", "footnote_for"];
export function structureWireShape(value: unknown, required: string[], optional: string[] = []) {
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
export function validateStructureGraph(value: unknown, input: StructureInputIdentity): StructureGraphV1 {
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
    const node = structureWireShape(raw, ["id", "kind", "range", "origin_id", "source"], ["label", "aliases", "parent_id", "anchor", "content_start"]);
    if (!nonempty(node.id) || nodes.has(node.id) || !NODE_KINDS.includes(String(node.kind)) ||
        !nonempty(node.origin_id) || !SOURCES.includes(String(node.source)) ||
        !scalarRange(node.range, input.scalarLength) ||
        ["label", "parent_id", "anchor"].some((key) => node[key] !== undefined && !nonempty(node[key])) ||
        (node.aliases !== undefined && (!Array.isArray(node.aliases) || !node.aliases.every((alias) => nonempty(alias)))) ||
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
    const relation = structureWireShape(raw, ["id", "kind", "from", "to", "origin_id", "source"]);
    if (!nonempty(relation.id) || relations.has(relation.id) || !RELATION_KINDS.includes(String(relation.kind)) ||
        !nonempty(relation.origin_id) || !SOURCES.includes(String(relation.source))) {
      throw new Error("Structure sidecar returned an invalid relation");
    }
    endpoint(relation.from, nodes, input.scalarLength); endpoint(relation.to, nodes, input.scalarLength);
    relations.add(relation.id);
  }
  for (const raw of root.diagnostics as unknown[]) {
    const diagnostic = structureWireShape(raw, ["code", "severity", "ranges", "node_ids"]);
    if (!nonempty(diagnostic.code) || !["info", "warning", "error"].includes(String(diagnostic.severity)) ||
        !Array.isArray(diagnostic.ranges) || !diagnostic.ranges.every((range) => scalarRange(range, input.scalarLength)) ||
        !Array.isArray(diagnostic.node_ids) || !diagnostic.node_ids.every((id) => nonempty(id) && nodes.has(id))) {
      throw new Error("Structure sidecar returned an invalid diagnostic");
    }
  }
  return root as StructureGraphV1;
}
