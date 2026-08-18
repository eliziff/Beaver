import {
  A2AJ_JURISDICTIONS,
  fetchA2AJDocument,
  getA2AJDocumentSourceDoc,
  getA2AJLookupDocument,
  lookupA2AJLocator,
  type A2AJLocatorLookup,
} from "../../a2aj";
import {
  bakedCrossReferenceGraph,
  bakedSkeleton,
} from "../../legalStructureSidecar";
import { readSection, skeletonSubtreeLabels } from "../../legalTextSkeleton";
import { parseResourceReference } from "../../resourceReferences";
import { sourceDocBlockText, type SourceDocBlock } from "../../sourceDoc";
import { createA2AJLookupEvidence } from "../legalEvidence";

export function a2ajLookupEvidenceBlocks(
  lookup: A2AJLocatorLookup,
  sourceClass: "case" | "legislation",
) {
  if (lookup.status !== "found" || !lookup.block) return [];
  const document = getA2AJLookupDocument(lookup);
  const visible = [
    { role: "selected" as const, block: lookup.block },
    ...lookup.before.map((block) => ({ role: "context" as const, block })),
    ...lookup.after.map((block) => ({ role: "context" as const, block })),
  ];
  const seen = new Set<string>();
  return visible.flatMap(({ role, block }) => {
    const contained = document?.blocks.filter(
      (candidate) =>
        candidate.kind === block.kind &&
        candidate.start >= block.start &&
        candidate.end <= block.end,
    ) ?? [];
    const units = block.kind === "section" && contained.length > 1
      ? contained.filter(
          (candidate) => !contained.some(
            (child) =>
              child !== candidate &&
              child.start >= candidate.start &&
              child.end <= candidate.end &&
              (child.start > candidate.start || child.end < candidate.end),
          ),
        )
      : contained.length
        ? contained
        : [block];
    return units.flatMap((unit: SourceDocBlock & { text?: string }) => {
      if (unit.kind === "footnote") return [];
      const key = `${unit.kind}:${unit.start}:${unit.end}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const text = document
        ? sourceDocBlockText(document, unit)
        : unit.text ?? block.text;
      if (!text.trim()) return [];
      const childLookup: A2AJLocatorLookup = {
        ...lookup,
        requested: {
          kind: unit.kind,
          locator: unit.label,
          label: unit.label,
        },
        matches: [unit.label],
        block: { ...unit, text },
        before: [],
        after: [],
      };
      const receipt = createA2AJLookupEvidence(childLookup, sourceClass);
      return receipt ? [{ role, lookup: childLookup, receipt }] : [];
    });
  });
}

export type A2AJReferenceDirection = "none" | "inbound" | "outbound" | "both";

const MAX_REFERENCE_SECTIONS = 50;
const MAX_REFERENCE_TEXT_CHARS = 32_000;
export const A2AJ_REFERENCE_NEIGHBORHOOD_ENABLED =
  !process.env.MIKE_RETRIEVAL_EXPERIMENT?.trim() ||
  process.env.MIKE_RETRIEVAL_EXPERIMENT === "h4-legal-grep";

export async function readA2AJReferenceNeighborhood(
  lookup: A2AJLocatorLookup,
  direction: A2AJReferenceDirection,
  signal?: AbortSignal,
) {
  const empty = (failures: string[] = []) => ({
    lookups: [] as A2AJLocatorLookup[],
    truncated: false,
    failures,
    omitted: [] as string[],
    limitReason: null as "characters" | "sections" | null,
  });
  if (
    direction === "none" ||
    lookup.status !== "found" ||
    !lookup.block ||
    lookup.requested.kind !== "section"
  ) return empty();
  const document = await fetchA2AJDocument({
    citation: lookup.citation,
    docType: "laws",
    language: lookup.language,
    maxChars: 1,
    signal,
  });
  const source = document ? getA2AJDocumentSourceDoc(document) : null;
  if (!source) return empty(["reference graph source unavailable"]);
  const skeleton = await bakedSkeleton(source.text, source.id, {
    recoverExtraction: false,
  });
  const seed = readSection(skeleton, lookup.requested.locator);
  if (seed.status !== "found" || !seed.block) {
    return empty(["requested section is not addressable in the reference graph"]);
  }
  const graph = await bakedCrossReferenceGraph(source.text, source.id, {
    recoverExtraction: false,
  });
  if (graph.documentAbstained) {
    return empty([graph.note ?? "reference graph abstained"]);
  }
  const seedNode = skeleton.nodes.find(
    (node) =>
      node.label === seed.block!.label &&
      node.start === seed.block!.start &&
      node.end === seed.block!.end,
  );
  if (!seedNode) {
    return empty(["requested section is not addressable in the reference graph"]);
  }
  const subtree = skeletonSubtreeLabels(skeleton, seedNode.label);
  const labels: string[] = [];
  if (direction === "inbound" || direction === "both") {
    for (const edge of graph.edges) {
      if (
        edge.status === "resolved" &&
        edge.targetLabel && subtree.has(edge.targetLabel) &&
        edge.sourceLabel && !subtree.has(edge.sourceLabel)
      ) labels.push(edge.sourceLabel);
    }
  }
  if (direction === "outbound" || direction === "both") {
    for (const edge of graph.edges) {
      if (
        edge.status === "resolved" &&
        edge.sourceLabel && subtree.has(edge.sourceLabel) &&
        edge.targetLabel && !subtree.has(edge.targetLabel) &&
        !edge.selfLoop
      ) labels.push(edge.targetLabel);
    }
  }
  const unique = [...new Set(labels)].filter(
    (label) => label.toLowerCase() !== seed.block!.label.toLowerCase(),
  );
  const selected = unique.slice(0, MAX_REFERENCE_SECTIONS);
  const lookups: A2AJLocatorLookup[] = [];
  const failures: string[] = [];
  let chars = 0;
  let limitReason: "characters" | "sections" | null =
    unique.length > selected.length ? "sections" : null;
  const omitted = unique.slice(selected.length);
  for (const label of selected) {
    const related = await lookupA2AJLocator({
      citation: lookup.citation,
      docType: "laws",
      language: lookup.language,
      dataset: lookup.dataset,
      kind: "section",
      locator: label,
      signal,
    });
    if (!related || related.status !== "found" || !related.block) {
      failures.push(`could not resolve ${label}`);
      continue;
    }
    if (chars + related.block.text.length > MAX_REFERENCE_TEXT_CHARS) {
      limitReason = "characters";
      omitted.push(...selected.slice(selected.indexOf(label)));
      break;
    }
    chars += related.block.text.length;
    lookups.push(related);
  }
  return {
    lookups,
    truncated: omitted.length > 0,
    failures,
    omitted: [...new Set(omitted)],
    limitReason,
  };
}

function activityText(value: unknown, maximum: number) {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return !text ? undefined : text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1).trimEnd()}…`;
}

export function assistantToolActivityLabel(
  name: string,
  args: Record<string, unknown>,
): string | null | undefined {
  if (name === "load_tools") return "Loading tools";
  if (name === "Glob") return null;
  if (name === "Grep") {
    const query = activityText(args.pattern, 80);
    const path = activityText(args.path, 80);
    const scope = path ? `${path} in your Library` : "all documents in your Library";
    return query ? `Searching ${scope} for “${query}”` : `Searching ${scope}`;
  }
  if (name === "Read") {
    const file = activityText(args.file_path, 80);
    if (!file || file.startsWith(".mike/")) return null;
    const resource = parseResourceReference(file);
    if (resource?.kind === "source") {
      const labels: Record<string, string> = {
        a2aj: "A2AJ",
        courtlistener: "CourtListener",
        "courtlistener-opinion": "CourtListener",
        journal: "the journal corpus",
        hansard: "Hansard",
        tna: "The National Archives",
        "govuk-et": "GOV.UK",
        govinfo: "GovInfo",
        pdf: "the source PDF",
      };
      let title = "a source";
      if (resource.provider === "a2aj") {
        try {
          const [citation] = JSON.parse(resource.sourceId) as unknown[];
          if (typeof citation === "string" && citation.trim()) title = citation;
        } catch {}
      }
      return `Reading ${title} from ${labels[resource.provider] ?? resource.provider}`;
    }
    return `Reading ${file.replace(/^.*[\\/]/u, "")} from your Library`;
  }
  if (name === "search_sources") {
    const query = activityText(args.query, 160);
    const kinds = Array.isArray(args.source_types)
      ? args.source_types.filter((value): value is string => typeof value === "string")
      : [];
    const rawJurisdiction = activityText(args.jurisdiction, 40);
    const jurisdiction = rawJurisdiction &&
        /^(?:ca|canada|canadian)$/iu.test(rawJurisdiction)
      ? "Canadian"
      : rawJurisdiction && /^(?:us|usa|united states)$/iu.test(rawJurisdiction)
        ? "US"
        : rawJurisdiction;
    const collection = activityText(args.collection, 40)?.toUpperCase();
    const suffix = collection?.match(/-([A-Z]{2,3})$/u)?.[1];
    const province = (suffix ?? collection?.slice(0, 2)) === "YK"
      ? "YT"
      : suffix ?? collection?.slice(0, 2);
    const place = province && province in A2AJ_JURISDICTIONS
      ? A2AJ_JURISDICTIONS[province as keyof typeof A2AJ_JURISDICTIONS]
      : jurisdiction;
    const labels: Record<string, string> = {
      case: "case law",
      legislation: "legislation",
      journal: "journal articles",
      hansard: "Hansard",
    };
    const scope = [place, kinds.map((kind) => labels[kind] ?? kind).join(" and ")]
      .filter(Boolean).join(" ") || "legal sources";
    return query ? `Searching ${scope} for “${query}”` : `Searching ${scope}`;
  }
  if (name === "Edit") return "Editing the selected document";
  if (name === "submit_grounded_answer") return "Grounding findings";
  return undefined;
}
