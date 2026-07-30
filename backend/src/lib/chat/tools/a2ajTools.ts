import {
  fetchA2AJDocument,
  lookupA2AJLocator,
  searchA2AJ,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../../a2aj";
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
  evidence?: LegalEvidenceReceipt;
};

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

function optionalNumber(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

export async function executeA2AJTool(
  name: string,
  args: Record<string, unknown>,
): Promise<A2AJToolExecution | null> {
  if (!Object.values(A2AJ_TOOL_NAMES).includes(name as never)) return null;

  try {
    if (name === A2AJ_TOOL_NAMES.search) {
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
    return {
      lookup: lookup ?? undefined,
      evidence: evidence ?? undefined,
      payload: lookup
        ? {
            ok: lookup.status === "found",
            source: "A2AJ",
            ...(evidence ? { evidence_id: evidence.evidence_id } : {}),
            ...lookup,
            url: undefined,
            ...(evidence
              ? {
                  next_required_action:
                    "Call submit_grounded_answer now with prose-only support units and this evidence_id; do not answer separately.",
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
        },
        required: ["citation", "locator_type", "locator"],
      },
    },
  },
  ...legalEvidenceExperimentTools(),
];
