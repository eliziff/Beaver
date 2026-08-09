import {
  fetchA2AJDocument,
  getA2AJDocumentSourceDoc,
  lookupA2AJLocator,
  searchA2AJ,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../../a2aj";
import {
  bakedCrossReferenceGraph,
  bakedSkeleton,
} from "../../legalStructureSidecar";
import { readSection, skeletonSubtreeLabels } from "../../legalTextSkeleton";
import {
  a2ajPassageLaneReady,
  searchLocalA2AJPassages,
} from "../../a2ajPassageSearch";
import {
  createA2AJDocumentEvidence,
  createA2AJLookupEvidence,
  legalEvidenceExperimentTools,
  type LegalEvidenceReceipt,
} from "../legalEvidenceExperiment";

export const A2AJ_TOOL_NAMES = {
  search: "a2aj_search",
  fetch: "a2aj_fetch",
  lookup: "a2aj_lookup",
} as const;

export type A2AJToolExecution = {
  payload: Record<string, unknown>;
  document?: A2AJDocument;
  lookup?: A2AJLocatorLookup;
  lookups?: A2AJLocatorLookup[];
  evidence?: LegalEvidenceReceipt;
  evidences?: LegalEvidenceReceipt[];
};

type ReferenceDirection = "none" | "inbound" | "outbound" | "both";

const MAX_REFERENCE_SECTIONS = 50;
const MAX_REFERENCE_TEXT_CHARS = 32_000;
const REFERENCE_NEIGHBORHOOD_ENABLED =
  !process.env.MIKE_RETRIEVAL_EXPERIMENT?.trim() ||
  process.env.MIKE_RETRIEVAL_EXPERIMENT === "h4-legal-grep";

async function referenceLookups(
  lookup: A2AJLocatorLookup,
  direction: ReferenceDirection,
) {
  if (
    direction === "none" ||
    lookup.status !== "found" ||
    !lookup.block ||
    lookup.requested.kind !== "section"
  ) {
    return {
      lookups: [] as A2AJLocatorLookup[],
      truncated: false,
      failures: [] as string[],
      omitted: [] as string[],
      limitReason: null as "characters" | "sections" | null,
    };
  }
  const document = await fetchA2AJDocument({
    citation: lookup.citation,
    docType: "laws",
    language: lookup.language,
    maxChars: 1,
  });
  const source = document ? getA2AJDocumentSourceDoc(document) : null;
  if (!source) {
    return {
      lookups: [] as A2AJLocatorLookup[],
      truncated: false,
      failures: ["reference graph source unavailable"],
      omitted: [] as string[],
      limitReason: null as "characters" | "sections" | null,
    };
  }
  const skeleton = await bakedSkeleton(source.text, source.id, {
    recoverExtraction: false,
  });
  const seed = readSection(skeleton, lookup.requested.locator);
  if (seed.status !== "found" || !seed.block) {
    return {
      lookups: [] as A2AJLocatorLookup[],
      truncated: false,
      failures: ["requested section is not addressable in the reference graph"],
      omitted: [] as string[],
      limitReason: null as "characters" | "sections" | null,
    };
  }
  const graph = await bakedCrossReferenceGraph(source.text, source.id, {
    recoverExtraction: false,
  });
  if (graph.documentAbstained) {
    return {
      lookups: [] as A2AJLocatorLookup[],
      truncated: false,
      failures: [graph.note ?? "reference graph abstained"],
      omitted: [] as string[],
      limitReason: null as "characters" | "sections" | null,
    };
  }
  const seedNode = skeleton.nodes.find(
    (node) =>
      node.label === seed.block!.label &&
      node.start === seed.block!.start &&
      node.end === seed.block!.end,
  );
  if (!seedNode) {
    return {
      lookups: [] as A2AJLocatorLookup[],
      truncated: false,
      failures: ["requested section is not addressable in the reference graph"],
      omitted: [] as string[],
      limitReason: null as "characters" | "sections" | null,
    };
  }
  const subtree = skeletonSubtreeLabels(skeleton, seedNode.label);
  const labels: string[] = [];
  if (direction === "inbound" || direction === "both") {
    for (const edge of graph.edges) {
      if (
        edge.status === "resolved" &&
        edge.targetLabel &&
        subtree.has(edge.targetLabel) &&
        edge.sourceLabel &&
        !subtree.has(edge.sourceLabel)
      ) {
        labels.push(edge.sourceLabel);
      }
    }
  }
  if (direction === "outbound" || direction === "both") {
    for (const edge of graph.edges) {
      if (
        edge.status === "resolved" &&
        edge.sourceLabel &&
        subtree.has(edge.sourceLabel) &&
        edge.targetLabel &&
        !subtree.has(edge.targetLabel) &&
        !edge.selfLoop
      ) {
        labels.push(edge.targetLabel);
      }
    }
  }
  const unique = [...new Set(labels)].filter(
    (label) => label.toLocaleLowerCase() !== seed.block!.label.toLocaleLowerCase(),
  );
  const selected = unique.slice(0, MAX_REFERENCE_SECTIONS);
  const lookups: A2AJLocatorLookup[] = [];
  const failures: string[] = [];
  let chars = 0;
  let limitReason: "characters" | "sections" | null =
    unique.length > selected.length ? "sections" : null;
  const omitted: string[] = unique.slice(selected.length);
  for (const label of selected) {
    const related = await lookupA2AJLocator({
      citation: lookup.citation,
      docType: "laws",
      language: lookup.language,
      dataset: lookup.dataset,
      kind: "section",
      locator: label,
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

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function activityText(value: unknown, maxLength: number) {
  const text = optionalString(value)?.replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function a2ajActivityLabel(
  name: string,
  args: Record<string, unknown>,
) {
  const isLaw = args.doc_type === "laws";
  if (name === A2AJ_TOOL_NAMES.search) {
    const scope = activityText(args.dataset, 24) ?? "Canadian";
    const query = activityText(args.query, 64);
    const sources = isLaw ? "legislation" : "cases";
    return query
      ? `Searching ${scope} ${sources} for “${query}”`
      : `Searching ${scope} ${sources}`;
  }

  const citation = activityText(args.citation, 80);
  if (name === A2AJ_TOOL_NAMES.fetch) {
    const section = activityText(args.section, 32);
    if (citation) {
      return section
        ? `Reading ${citation}, s. ${section}`
        : `Reading ${citation}`;
    }
    return isLaw ? "Reading Canadian legislation" : "Reading Canadian case";
  }

  if (name === A2AJ_TOOL_NAMES.lookup) {
    const locator = activityText(args.locator, 32);
    const endLocator = activityText(args.end_locator, 32);
    const locatorLabel =
      args.locator_type === "page"
        ? "p."
        : args.locator_type === "section"
          ? "s."
          : "para.";
    if (citation && locator)
      return `Looking up ${citation}, ${locatorLabel} ${locator}${
        endLocator ? `\u2013${endLocator}` : ""
      }`;
    if (citation) return `Looking up ${citation}`;
    return "Looking up Canadian legal passage";
  }

  return undefined;
}

export function assistantToolActivityLabel(
  name: string,
  args: Record<string, unknown>,
): string | null | undefined {
  if (name === "Glob") return null;
  if (name === "Grep") {
    const query = activityText(args.pattern, 80);
    const path = activityText(args.path, 80);
    const glob = activityText(args.glob, 48);
    const section = activityText(args.section, 48);
    const pages = activityText(args.pages, 32);
    const scope = path
      ? `${path} in your Library`
      : glob
        ? `documents matching ${glob} in your Library`
        : "all documents in your Library";
    const within = section
      ? ` in ${section}`
      : pages
        ? ` on pages ${pages}`
        : "";
    return query
      ? `Searching ${scope}${within} for “${query}”`
      : `Searching ${scope}${within}`;
  }
  if (name === "Read") {
    const file = activityText(args.file_path, 80);
    if (!file || file.startsWith(".mike/")) return null;
    return `Reading ${file.replace(/^.*[\\/]/u, "")} from your Library`;
  }
  const query = activityText(args.query, 80);
  if (name === "SearchSources") {
    const sourceLabels: Record<string, string> = {
      case: "case law",
      legislation: "legislation",
      journal: "journals",
      hansard: "Hansard",
    };
    const sourceTypes = Array.isArray(args.source_types)
      ? args.source_types
          .filter((value): value is string => typeof value === "string")
          .map((value) => sourceLabels[value] ?? value)
          .join(" and ")
      : "legal sources";
    const location = [
      activityText(args.jurisdiction, 40),
      activityText(args.collection, 40),
      activityText(args.court, 40),
      activityText(args.court_level, 24),
      activityText(args.speaker, 40),
    ].filter(Boolean);
    const dateRange = [
      activityText(args.date_from, 16),
      activityText(args.date_to, 16),
    ].filter(Boolean).join("–");
    const syntax = args.syntax === "boolean" ? "boolean query" : "";
    const sort =
      typeof args.sort === "string" && args.sort !== "relevance"
        ? `sorted ${args.sort.replaceAll("_", " ")}`
        : "";
    const scope = [sourceTypes, ...location, dateRange, syntax, sort]
      .filter(Boolean)
      .join(" · ");
    return query
      ? `Searching ${scope} for “${activityText(args.query, 160)}”`
      : `Searching ${scope}`;
  }
  if (name === "courtlistener_search_case_law")
    return query ? `Searching US case law for “${query}”` : "Searching US case law";
  if (name === "public_legal_source_search")
    return query
      ? `Searching public legal sources for “${query}”`
      : "Searching public legal sources";
  if (name === "hansard_search")
    return query ? `Searching Hansard for “${query}”` : "Searching Hansard";
  if (name === "library_find" || name === "find_in_document")
    return query
      ? `Searching the selected document for “${query}”`
      : "Searching the selected document";
  if (name === "submit_grounded_answer") return "Grounding findings";
  return a2ajActivityLabel(name, args);
}

function optionalNumber(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

/**
 * Opt-in passage lane for a2aj_search (MIKE_PASSAGE_SEARCH=1 plus a
 * built sidecar). Returns the model-facing search shape with the ranked
 * passage in `snippet` instead of a window around the first token hit.
 * Returns null — silent fall-back to the document-level lane — whenever
 * the lane is unavailable or cannot honour the request: the sidecar
 * indexes full text only, so name search and the dataset/date/sort
 * filters stay on the document lane rather than being dropped.
 */
async function passageLaneResults(
  args: Record<string, unknown>,
): Promise<A2AJToolExecution | null> {
  const query = optionalString(args.query)?.trim();
  const docType = args.doc_type === "laws" ? "laws" : "cases";
  if (
    !query ||
    args.search_type === "name" ||
    optionalString(args.dataset)?.trim() ||
    optionalString(args.start_date)?.trim() ||
    optionalString(args.end_date)?.trim() ||
    (args.sort_results && args.sort_results !== "default") ||
    !a2ajPassageLaneReady({ docType })
  )
    return null;
  try {
    const results = await searchLocalA2AJPassages({
      query,
      docType,
      language: args.search_language === "fr" ? "fr" : "en",
      size: optionalNumber(args.size),
    });
    if (!results.length) return null;
    return {
      payload: {
        ok: true,
        source: "A2AJ",
        result_count: results.length,
        results: results.map((result) => ({
          dataset: result.dataset,
          citation: result.citation,
          name: result.name,
          date: result.date,
          url: undefined,
          snippet: result.passage.text,
          passage_start: result.passage.start,
          passage_end: result.passage.end,
        })),
      },
    };
  } catch {
    return null;
  }
}

export async function executeA2AJTool(
  name: string,
  args: Record<string, unknown>,
): Promise<A2AJToolExecution | null> {
  if (!Object.values(A2AJ_TOOL_NAMES).includes(name as never)) return null;

  try {
    if (name === A2AJ_TOOL_NAMES.search) {
      const passages = await passageLaneResults(args);
      if (passages) return passages;
      const results = await searchA2AJ({
        query: optionalString(args.query) ?? "",
        docType: args.doc_type === "laws" ? "laws" : "cases",
        searchType: args.search_type === "name" ? "name" : "full_text",
        language: args.search_language === "fr" ? "fr" : "en",
        size: optionalNumber(args.size),
        dataset: optionalString(args.dataset),
        startDate: optionalString(args.start_date),
        endDate: optionalString(args.end_date),
        sortResults:
          args.sort_results === "newest_first" ||
          args.sort_results === "oldest_first"
            ? args.sort_results
            : "default",
      });
      return {
        payload: {
          ok: true,
          source: "A2AJ",
          result_count: results.length,
          results: results.map((result) => ({ ...result, url: undefined })),
        },
      };
    }

    if (name === A2AJ_TOOL_NAMES.fetch) {
      const document = await fetchA2AJDocument({
        citation: optionalString(args.citation) ?? "",
        docType: args.doc_type === "laws" ? "laws" : "cases",
        language: args.output_language === "fr" ? "fr" : "en",
        section: optionalString(args.section),
      });
      const evidence = document
        ? createA2AJDocumentEvidence(
            document,
            args.doc_type === "laws" ? "legislation" : "case",
          )
        : undefined;
      return {
        document: document ?? undefined,
        evidence,
        payload: document
          ? {
              ok: true,
              source: "A2AJ",
              evidence_id: evidence?.evidence_id,
              ...document,
              url: undefined,
              upstreamLicense: undefined,
              ...(document.truncated
                ? {
                    next_required_action: `Truncated: ${document.text.length} of ${document.total_chars} characters shown.`,
                  }
                : {}),
            }
          : {
              ok: false,
              source: "A2AJ",
              error: "A2AJ did not find an exact matching document.",
            },
      };
    }

    if (
      !REFERENCE_NEIGHBORHOOD_ENABLED &&
      Object.prototype.hasOwnProperty.call(args, "references")
    ) {
      return {
        payload: {
          ok: false,
          source: "A2AJ",
          error: "a2aj_lookup does not expose reference expansion in this arm",
        },
      };
    }
    const lookup = await lookupA2AJLocator({
      citation: optionalString(args.citation) ?? "",
      docType: args.doc_type === "laws" ? "laws" : "cases",
      language: args.output_language === "fr" ? "fr" : "en",
      kind:
        args.locator_type === "page"
          ? "page"
          : args.locator_type === "section"
            ? "section"
            : "paragraph",
      locator: optionalString(args.locator) ?? "",
      endLocator: optionalString(args.end_locator),
      contextBlocks: optionalNumber(args.context_blocks),
    });
    const evidence = lookup
      ? createA2AJLookupEvidence(
          lookup,
          args.doc_type === "laws" ? "legislation" : "case",
        )
      : null;
    const requestedReferences: ReferenceDirection =
      REFERENCE_NEIGHBORHOOD_ENABLED &&
      (args.references === "inbound" ||
      args.references === "outbound" ||
      args.references === "both")
        ? args.references
        : "none";
    if (requestedReferences !== "none" && args.doc_type !== "laws") {
      return {
        payload: {
          ok: false,
          source: "A2AJ",
          error: "references is available only for statutory sections",
        },
      };
    }
    const related = lookup
      ? await referenceLookups(lookup, requestedReferences)
      : {
          lookups: [] as A2AJLocatorLookup[],
          truncated: false,
          failures: [] as string[],
          omitted: [] as string[],
          limitReason: null as "characters" | "sections" | null,
        };
    const relatedEvidence = related.lookups
      .map((item) => createA2AJLookupEvidence(item, "legislation"))
      .filter((item): item is LegalEvidenceReceipt => Boolean(item));
    return {
      lookup: lookup ?? undefined,
      lookups: related.lookups,
      evidence: evidence ?? undefined,
      evidences: relatedEvidence,
      payload: lookup
        ? {
            ok: lookup.status === "found",
            source: "A2AJ",
            ...(evidence ? { evidence_id: evidence.evidence_id } : {}),
            ...lookup,
            url: undefined,
            ...(requestedReferences !== "none"
              ? {
                  reference_neighborhood: {
                    direction: requestedReferences,
                    depth: 1,
                    returned: related.lookups.length,
                    truncated: related.truncated,
                    limit_reason: related.limitReason,
                    omitted: related.omitted,
                    budget: {
                      sections: MAX_REFERENCE_SECTIONS,
                      text_chars: MAX_REFERENCE_TEXT_CHARS,
                    },
                    failures: related.failures,
                    sections: related.lookups.map((item, index) => ({
                      label: item.block?.label,
                      text: item.block?.text,
                      evidence_id: relatedEvidence[index]?.evidence_id,
                    })),
                  },
                }
              : {}),
          }
        : {
            ok: false,
            source: "A2AJ",
            error: "A2AJ did not find an exact matching document.",
          },
    };
  } catch (error) {
    const action =
      name === A2AJ_TOOL_NAMES.search
        ? "search"
        : name === A2AJ_TOOL_NAMES.fetch
          ? "fetch"
          : "lookup";
    return {
      payload: {
        ok: false,
        source: "A2AJ",
        error:
          error instanceof Error ? error.message : `A2AJ ${action} failed.`,
      },
    };
  }
}

export const A2AJ_TOOLS = [
  {
    type: "function",
    function: {
      name: A2AJ_TOOL_NAMES.search,
      description:
        "Search Canadian cases or legislation through the public A2AJ API by legal concept, case name, or statute title. With a citation in hand, use a2aj_fetch instead.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms, case name, or statute title.",
          },
          doc_type: {
            type: "string",
            enum: ["cases", "laws"],
            description: "Search cases or laws. Defaults to cases.",
          },
          search_type: {
            type: "string",
            enum: ["full_text", "name"],
            description:
              "Search document text or names. Defaults to full_text.",
          },
          search_language: {
            type: "string",
            enum: ["en", "fr"],
            description: "Search language. Defaults to en.",
          },
          size: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Number of results, up to 10.",
          },
          dataset: {
            type: "string",
            description: "Optional A2AJ dataset filter, such as SCC or ONCA.",
          },
          start_date: {
            type: "string",
            description: "Optional YYYY-MM-DD start date.",
          },
          end_date: {
            type: "string",
            description: "Optional YYYY-MM-DD end date.",
          },
          sort_results: {
            type: "string",
            enum: ["default", "newest_first", "oldest_first"],
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: A2AJ_TOOL_NAMES.fetch,
      description:
        "Fetch authoritative Canadian case or legislation text for a citation from A2AJ.",
      parameters: {
        type: "object",
        properties: {
          citation: {
            type: "string",
            description:
              "Canadian citation, e.g. 2020 SCC 5 or RSC 1985, c C-46.",
          },
          doc_type: {
            type: "string",
            enum: ["cases", "laws"],
            description: "Fetch a case or law. Defaults to cases.",
          },
          output_language: {
            type: "string",
            enum: ["en", "fr"],
            description: "Text language. Defaults to en.",
          },
          section: {
            type: "string",
            description: "Optional section for legislation/regulations.",
          },
        },
        required: ["citation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: A2AJ_TOOL_NAMES.lookup,
      description:
        "Look up one exact paragraph, reporter page, section, subsection, or subparagraph inside an A2AJ Canadian decision or law. Returns only the requested block, not the whole document.",
      parameters: {
        type: "object",
        properties: {
          citation: {
            type: "string",
            description:
              "Canadian citation, e.g. 2020 SCC 5 or RSC 1985, c C-46.",
          },
          doc_type: {
            type: "string",
            enum: ["cases", "laws"],
            description:
              "Use cases for decision paragraphs/pages and laws for provisions.",
          },
          locator_type: {
            type: "string",
            enum: ["paragraph", "page", "section"],
            description:
              "Structural locator family. Section includes all nested provisions.",
          },
          locator: {
            type: "string",
            description:
              "Exact locator such as 42, page 763, 34(1)(a)(i), or sec11.10(2).",
          },
          end_locator: {
            type: "string",
            description:
              "Optional ending paragraph for an inclusive paragraph range.",
          },
          output_language: {
            type: "string",
            enum: ["en", "fr"],
            description: "Text language. Defaults to en.",
          },
          context_blocks: {
            type: "integer",
            minimum: 0,
            maximum: 2,
            description:
              "Optionally include up to two neighboring blocks on each side.",
          },
          ...(REFERENCE_NEIGHBORHOOD_ENABLED
            ? {
                references: {
                  type: "string",
                  enum: ["none", "inbound", "outbound", "both"],
                  description:
                    "For an exact statutory section only, also return direct resolved internal provisions that cite it, that it cites, or both, up to the stated text budget. Reports any omitted labels. Defaults to none; not for case-law treatment.",
                },
              }
            : {}),
        },
        required: ["citation", "locator_type", "locator"],
      },
    },
  },
  ...legalEvidenceExperimentTools(),
];
