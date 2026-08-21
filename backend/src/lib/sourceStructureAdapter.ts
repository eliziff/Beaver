import { sha256 } from "./hash";
import { createSourceDoc, type SourceDocBlock, type SourceDocProvider } from "./sourceDoc";
import {
  STRUCTURE_EVIDENCE_SCHEMA,
  documentScalarOffsets,
  type StructureEvidenceV1,
  type StructureGraphV2,
  type StructureKind,
} from "./structureWire";

const KINDS = ["paragraph", "prose", "page", "section", "heading", "footnote", "endnote"] as const;
type Utf16Range = { start: number; end: number };

export type SourceStructureInput = {
  provider: SourceDocProvider | null;
  id: string;
  documentId?: string;
  url?: string | null;
  docType?: "cases" | "laws" | null;
  text: string;
  providerRevision: string;
  sourceSha256?: string;
  representationRevision?: string;
  scope: { kind: "complete" | "excerpt"; excerptOf?: string };
  profile: StructureEvidenceV1["profile"];
  reportStartPage?: number;
  requireReportStart?: boolean;
  allowHyphenatedSections?: boolean;
  nativeBlocks?: SourceDocBlock[];
  nativeClaimRanges?: ReadonlyMap<string, Utf16Range>;
  completeKinds?: ReadonlySet<StructureKind>;
  exclusions?: Utf16Range[];
  order: "case" | "legislation" | "position" | "stable-position" | "native";
};

export type MaterializedSourceStructure = {
  input: SourceStructureInput;
  evidence: StructureEvidenceV1;
  originalClaims: Map<string, SourceDocBlock>;
  offsets: ReturnType<typeof documentScalarOffsets>;
};

function validRange(range: Utf16Range, length: number) {
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) &&
    range.start >= 0 && range.start <= range.end && range.end <= length;
}

export function materializeSourceStructure(input: SourceStructureInput): MaterializedSourceStructure {
  const native = input.nativeBlocks ?? [];
  const completeKinds = input.completeKinds ?? new Set<StructureKind>();
  const offsets = documentScalarOffsets(input.text);
  const originId = "provider-adapter";
  const originalClaims = new Map<string, SourceDocBlock>();
  const usedRangeOverrides = new Set<string>();
  const nativeClaims = native.map((block, index) => {
    const id = `native-${String(index + 1).padStart(6, "0")}`;
    originalClaims.set(id, block);
    const range = input.nativeClaimRanges?.get(id) ?? block;
    if (input.nativeClaimRanges?.has(id)) usedRangeOverrides.add(id);
    if (!validRange(range, input.text.length)) {
      throw new RangeError(`${id} has an invalid provider UTF-16 range (${range.start}:${range.end})`);
    }
    return {
      id,
      kind: block.kind,
      label: block.label,
      aliases: block.aliases ?? [],
      parent_label: block.parentLabel,
      anchor: block.anchor,
      range: { start: offsets.utf16ToScalar(range.start), end: offsets.utf16ToScalar(range.end) },
      provider_order: index,
      origin_id: originId,
    };
  });
  if (input.nativeClaimRanges &&
      [...input.nativeClaimRanges.keys()].some((id) => !usedRangeOverrides.has(id))) {
    throw new RangeError("A provider native-claim range override does not name an emitted claim");
  }
  const scalarEnd = offsets.scalarLength;
  const evidence: StructureEvidenceV1 = {
    schema_version: STRUCTURE_EVIDENCE_SCHEMA,
    document_id: input.documentId ?? input.id,
    provider: input.provider ?? "internal",
    provider_revision: input.providerRevision,
    profile: input.profile,
    ...(input.reportStartPage === undefined ? {} : { report_start_page: input.reportStartPage }),
    require_report_start: input.requireReportStart ?? false,
    allow_hyphenated_sections: input.allowHyphenatedSections ?? false,
    text: input.text,
    text_sha256: sha256(input.text),
    ...(input.sourceSha256 ? { source_sha256: input.sourceSha256 } : {}),
    offset_unit: "unicode-scalar",
    scope: {
      kind: input.scope.kind,
      ...(input.scope.excerptOf ? { excerpt_of: input.scope.excerptOf } : {}),
    },
    origins: [{
      id: originId,
      producer: input.provider ?? "beaver-internal",
      representation: "provider-rendered-text",
      revision: input.representationRevision ?? input.providerRevision,
      authority: "provider-native-claims",
    }],
    units: [],
    native_claims: nativeClaims,
    coverage: KINDS.map((kind) => ({
      kind,
      range: { start: 0, end: scalarEnd },
      state: completeKinds.has(kind) ? "complete" : native.some((block) => block.kind === kind) ? "augment" : "absent",
      reason: completeKinds.has(kind) ? "provider kind is complete" : "shared-engine recovery lane",
      ...(completeKinds.has(kind) || native.some((block) => block.kind === kind) ? { origin_id: originId } : {}),
    })),
    exclusions: (input.exclusions ?? []).map((range) => {
      if (!validRange(range, input.text.length)) {
        throw new RangeError(`Exclusion has an invalid provider UTF-16 range (${range.start}:${range.end})`);
      }
      return {
        range: { start: offsets.utf16ToScalar(range.start), end: offsets.utf16ToScalar(range.end) },
        applies_to: ["paragraph"],
        reason: "provider-marked non-opinion region",
        origin_id: originId,
      };
    }),
    paragraph_breaks: [],
  };
  return { input, evidence, originalClaims, offsets };
}

export function projectSourceStructure(materialized: MaterializedSourceStructure, graph: StructureGraphV2) {
  const { input, originalClaims, offsets } = materialized;
  const labels = new Map(graph.nodes.flatMap((node) => node.label ? [[node.id, node.label] as const] : []));
  let prose = 0;
  const blocks = graph.nodes.flatMap((node): SourceDocBlock[] => {
    const original = originalClaims.get(node.id);
    if (original) return [original];
    const kind = node.kind === "prose" ? "paragraph" : node.kind;
    if (!(["paragraph", "page", "section", "footnote"] as string[]).includes(kind)) return [];
    const label = node.kind === "prose" ? `par${++prose}` : node.label;
    if (!label) return [];
    const start = offsets.scalarToUtf16(node.range.start);
    const end = offsets.scalarToUtf16(node.range.end);
    if (input.profile === "journal" && node.kind !== "prose") {
      return [{ kind: kind as SourceDocBlock["kind"], label, start,
        ...(node.aliases?.length ? { aliases: node.aliases } : {}), origin: "heuristic", end }];
    }
    return [{ kind: kind as SourceDocBlock["kind"], label, start, end, origin: "heuristic",
      ...(node.aliases?.length ? { aliases: node.aliases } : {}),
      ...(node.anchor ? { anchor: node.anchor } : {}),
      ...(node.parent_id && labels.get(node.parent_id) ? { parentLabel: labels.get(node.parent_id) } : {}) }];
  });
  if (input.order === "stable-position") {
    blocks.sort((left, right) => left.start - right.start || left.end - right.end);
  } else if (input.order === "position") {
    blocks.sort((left, right) => left.start - right.start || left.end - right.end || left.label.localeCompare(right.label));
  } else if (input.order === "legislation") {
    blocks.sort((left, right) => left.start - right.start || right.end - left.end || left.label.localeCompare(right.label));
  }
  return createSourceDoc({ provider: input.provider, id: input.id, url: input.url,
    docType: input.docType, text: input.text, blocks });
}
