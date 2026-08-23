import {
  a2ajLegalSourceProvider,
  type A2AJLocatorLookup,
} from "../../legalSources/a2aj";
import { collapseProvisionLabels } from "../../provisionLabels";
import { referenceLabelsOutside } from "../../legalDocumentNavigator";
import { parseResourceReference } from "../../resourceReferences";
import { jsonRecord } from "../../value";
import {
  lookupSourceDocLabel,
  sourceDocSubtreeLabels,
} from "../../sourceDoc";
import {
  createA2AJLookupEvidence,
  type LegalEvidenceReceipt,
} from "../legalEvidence";

export function a2ajLookupEvidenceBlocks(
  lookup: A2AJLocatorLookup,
  sourceClass: "case" | "legislation",
) {
  if (lookup.status !== "found" || !lookup.block) return [];
  return a2ajLegalSourceProvider.lookupBlocks(lookup).flatMap(({ role, lookup }) => {
    const receipt = createA2AJLookupEvidence(lookup, sourceClass);
    return receipt ? [{ role, lookup, receipt }] : [];
  });
}

export type A2AJReferenceDirection = "none" | "inbound" | "outbound" | "both";

const MAX_REFERENCE_SECTIONS = 50;
const MAX_REFERENCE_TEXT_CHARS = 32_000;

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
  const document = await a2ajLegalSourceProvider.document({
    citation: lookup.citation,
    docType: "laws",
    language: lookup.language,
    dataset: lookup.dataset,
    signal,
  });
  const source = document ? a2ajLegalSourceProvider.source(document) : null;
  const graph = jsonRecord(document?.analysis?.structure)?.cross_references as
    | Parameters<typeof referenceLabelsOutside>[0]
    | undefined;
  if (!source || !graph) return empty(["reference graph source unavailable"]);
  const seed = lookupSourceDocLabel(source, "section", lookup.block.label);
  if (seed.status !== "found" || !seed.block) {
    return empty(["requested section is not addressable in the reference graph"]);
  }
  if (graph.documentAbstained) {
    return empty([graph.note ?? "reference graph abstained"]);
  }
  const subtree = sourceDocSubtreeLabels(source.blocks, seed.block.label);
  const follow = direction === "inbound" ? "in"
    : direction === "outbound" ? "out" : "both";
  const unique = referenceLabelsOutside(graph, subtree, follow).filter(
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
    const related = await a2ajLegalSourceProvider.lookup({
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

function activityLocatorLabel(label: string, kind?: string) {
  const value = label
    .replace(/^\[\s*[a-z]+(?:\s+|=)([^\]]+)\s*\]$/iu, "$1")
    .replace(/^[a-z]+=/iu, "")
    .trim();
  const prefix = kind === "paragraph"
    ? /^(?:paragraphs?|paras?|par)\.?\s*/iu
    : kind === "section"
      ? /^(?:sections?|secs?|ss?|s)\.?\s*/iu
      : null;
  return prefix
    ? value.replace(prefix, "").replace(new RegExp(`([–—-])${prefix.source.slice(1)}`, "giu"), "$1")
    : value;
}

function activityLocatorNoun(kind: string, plural: boolean) {
  if (kind === "paragraph") return plural ? "paras" : "para";
  if (kind === "section") return plural ? "ss" : "s";
  return plural ? `${kind}s` : kind;
}

export function assistantToolActivityLabel(
  name: string,
  args: Record<string, unknown>,
  sourceName?: string,
): string | null | undefined {
  if (name === "load_tools") return "Loading tools";
  if (name === "Glob") return null;
  if (name === "Grep") {
    const query = activityText(args.pattern, 80);
    const path = activityText(args.path, 80);
    const scope = sourceName ?? (path ? `${path} in your Library` : "all documents in your Library");
    return query ? `Searching ${scope} for “${query}”` : `Searching ${scope}`;
  }
  if (name === "Read") {
    const file = activityText(args.file_path, 80);
    if (!file || file.startsWith(".mike/")) return null;
    const resource = parseResourceReference(file);
    let title = sourceName;
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
      if (!title && resource.provider === "a2aj") {
        try {
          const [citation] = JSON.parse(resource.sourceId) as unknown[];
          if (typeof citation === "string" && citation.trim()) title = citation;
        } catch {}
      }
      title ??= labels[resource.provider] ?? resource.provider;
    } else {
      title ??= file.replace(/^.*[\\/]/u, "");
    }
    const pattern = activityText(args.pattern, 80);
    const contextChars = Number.isInteger(args.context_chars) && Number(args.context_chars) > 0
      ? Number(args.context_chars) : 0;
    if (pattern) return `Searching ${title} for “${pattern}”${contextChars
      ? ` with up to ${contextChars} characters of adjacent context` : ""}`;
    const contextBlocks = Number.isInteger(args.context_blocks) && Number(args.context_blocks) > 0
      ? Number(args.context_blocks) : 0;
    const context = contextBlocks
      ? ` with ${contextBlocks} adjacent context block${contextBlocks === 1 ? "" : "s"}`
      : "";
    const kind = activityText(args.locator_kind, 24);
    const locator = activityText(args.locator, 80);
    const end = activityText(args.end_locator, 80);
    if (kind && locator) {
      const first = activityLocatorLabel(locator, kind);
      const last = end ? activityLocatorLabel(end, kind) : undefined;
      const plural = Boolean(last && last !== first);
      return `Reading ${activityLocatorNoun(kind, plural)} ${first}${plural ? `–${last}` : ""} of ${title}${context}`;
    }
    const page = Number.isInteger(args.page) && Number(args.page) > 0
      ? Number(args.page) : 0;
    if (page) return `Reading page ${page} of ${title}${context}`;
    const section = activityText(args.section, 100);
    if (section) return `Reading section ${section} of ${title}${context}`;
    const handle = activityText(args.handle, 80);
    if (handle) return `Reading a saved passage of ${title}${context}`;
    const offset = Number.isInteger(args.offset) && Number(args.offset) > 0
      ? Number(args.offset) : 0;
    const limit = Number.isInteger(args.limit) && Number(args.limit) > 0
      ? Number(args.limit) : 0;
    if (offset || limit) {
      const start = offset || 1;
      return `Reading lines ${start}–${start + (limit || 2000) - 1} of ${title}`;
    }
    const startChar = Number.isInteger(args.start_char) && Number(args.start_char) >= 0
      ? Number(args.start_char) : null;
    if (startChar !== null) return `Reading from character ${startChar} of ${title}`;
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
      return resource.provider === "a2aj" || sourceName
        ? `Reading ${title} from ${labels[resource.provider] ?? resource.provider}`
        : `Reading a source from ${labels[resource.provider] ?? resource.provider}`;
    }
    return sourceName ? `Reading ${title}` : `Reading ${title} from your Library`;
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
    const place = province && province in a2ajLegalSourceProvider.jurisdictions
      ? a2ajLegalSourceProvider.jurisdictions[province as keyof typeof a2ajLegalSourceProvider.jurisdictions]
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

export function assistantReadEvidenceActivityLabel(
  evidence: readonly LegalEvidenceReceipt[],
  sourceName?: string,
  args: Record<string, unknown> = {},
) {
  const passages = evidence.filter(({ scope, span_text }) => scope === "passage" && span_text);
  const first = passages[0];
  const last = passages.at(-1);
  if (!first || !last) return null;
  const title = sourceName ?? first.name ?? first.citation;
  const labels = [...new Set(passages.map(({ locator }) =>
    activityLocatorLabel(locator.label, locator.kind)))];
  const firstLabel = activityText(labels[0], 80);
  const lastLabel = activityText(labels.at(-1), 80);
  const contextBlocks = Number.isInteger(args.context_blocks) && Number(args.context_blocks) > 0
    ? Number(args.context_blocks) : 0;
  const context = contextBlocks
    ? ` with ${contextBlocks} adjacent context block${contextBlocks === 1 ? "" : "s"}`
    : "";
  if (!firstLabel || !lastLabel) return `Reading ${title}${context}`;
  if (first.locator.kind !== last.locator.kind) {
    return `Reading ${activityLocatorNoun(first.locator.kind, false)} ${firstLabel} through ${activityLocatorNoun(last.locator.kind, false)} ${lastLabel} of ${title}${context}`;
  }
  // Collapsed display groups (nested provisions subsumed by their parent,
  // endpoint pairing per root section, paragraph run-lengths). Falls back
  // to plain enumeration when labels leave the locator grammar.
  const groups = collapseProvisionLabels(labels, first.locator.kind);
  if (!groups) {
    const plural = labels.length > 1 || /[–—-]/u.test(firstLabel);
    const scope = labels.length === 1 ? firstLabel : labels.join(", ");
    return `Reading ${activityLocatorNoun(first.locator.kind, plural)} ${scope} of ${title}${context}`;
  }
  const plural = groups.length > 1 || /[–—-]/u.test(groups[0]);
  return `Reading ${activityLocatorNoun(first.locator.kind, plural)} ${groups.join(", ")} of ${title}${context}`;
}
