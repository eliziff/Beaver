export type CourtlistenerToolEvent =
  | {
      type: "courtlistener_search_case_law";
      query: string;
      result_count: number;
      error?: string;
    }
  | {
      type: "courtlistener_get_cases";
      cluster_ids: number[];
      case_count: number;
      opinion_count: number;
      cases?: {
        cluster_id: number;
        case_name: string | null;
        citation: string | null;
        dateFiled?: string | null;
        url?: string | null;
      }[];
      error?: string;
    }
  | {
      type: "courtlistener_find_in_case";
      cluster_id: number | null;
      query: string;
      total_matches: number;
      case_name?: string | null;
      citation?: string | null;
      searches?: {
        cluster_id: number | null;
        query: string;
        total_matches: number;
        case_name?: string | null;
        citation?: string | null;
        error?: string;
      }[];
      error?: string;
    }
  | {
      type: "courtlistener_read_case";
      cluster_id: number | null;
      case_name?: string | null;
      citation?: string | null;
      opinion_count: number;
      error?: string;
    }
  | {
      type: "courtlistener_lookup_case_locator";
      cluster_id: number | null;
      locator_type: "paragraph" | "page" | "section" | "footnote";
      locator: string;
      status: string;
      error?: string;
    }
  | {
      type: "courtlistener_verify_citations";
      citation_count: number;
      match_count: number;
      error?: string;
    };

export type CaseCitationEvent = {
  type: "case_citation";
  cluster_id: number | null;
  case_name: string | null;
  citation: string | null;
  url: string;
  pdfUrl?: string | null;
  dateFiled?: string | null;
};

export const COURTLISTENER_TOOL_NAMES = {
  searchCaseLaw: "courtlistener_search_case_law",
  getCases: "courtlistener_get_cases",
  findInCase: "find_in_case",
  readCase: "courtlistener_read_case",
  lookupCaseLocator: "courtlistener_lookup_case_locator",
  verifyCitations: "verify_citations",
} as const;

export const COURTLISTENER_SYSTEM_PROMPT = `US CASE LAW RESEARCH:
Use search_sources for discovery and Read the returned source resources. Use verify_citations for clean reporter citations, never case names. After reading a case resource, find_in_case can locate short terms in that case.

Citation rules:
- Cite a case only from opinion text or snippets supplied in this turn — never from memory, metadata, search results, citationLinks, or verification results. If you have no text for a useful case, fetch or read it, or say you could not read it and do not rely on it.
- Use the returned evidence_ids in submit_grounded_answer. Do not construct or repeat a CourtListener link, marker, citation JSON, or plaintext pinpoint.
- On any rate-limit/throttling/429 error, stop all CourtListener calls for that turn and answer from what you already have.`;

export const COURTLISTENER_TOOLS = [
  {
    type: "function",
    function: {
      name: COURTLISTENER_TOOL_NAMES.searchCaseLaw,
      description:
        "Search CourtListener case law by terms or case name. Returns metadata only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          court: { type: "string" },
          filedAfter: { type: "string" },
          filedBefore: { type: "string" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: COURTLISTENER_TOOL_NAMES.getCases,
      description:
        "Fetch and cache CourtListener case clusters and their opinions by cluster ID. Returns metadata and counts only, not opinion text.",
      parameters: {
        type: "object",
        properties: {
          clusterIds: {
            type: "array",
            items: { type: "integer" },
            description:
              "Cluster IDs from verify_citations or case metadata already in the conversation.",
          },
        },
        required: ["clusterIds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: COURTLISTENER_TOOL_NAMES.findInCase,
      description:
        "Search a CourtListener case already opened with Read for keywords or phrases. Returns matches with surrounding opinion context. At most 3 calls per turn.",
      parameters: {
        type: "object",
        properties: {
          clusterId: {
            type: "integer",
            description:
              "Cluster ID from the case resource opened with Read.",
          },
          query: {
            type: "string",
            description:
              "Short 1-3 word term likely to appear verbatim in the opinion. Case-insensitive, whitespace-tolerant.",
          },
          max_results: {
            type: "integer",
            description: "Maximum matches to return. Default 20.",
          },
          context_chars: {
            type: "integer",
            description: "Context characters on each side of a match. Default 160.",
          },
        },
        required: ["clusterId", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: COURTLISTENER_TOOL_NAMES.lookupCaseLocator,
      description:
        "Look up one provider-backed paragraph, page, section, or footnote in an already-fetched CourtListener case. Returns only that block plus optional neighboring context.",
      parameters: {
        type: "object",
        properties: {
          clusterId: {
            type: "integer",
            description:
              "Cluster ID previously fetched with courtlistener_get_cases.",
          },
          opinionId: {
            type: "integer",
            description:
              "Optional opinion ID when the cluster contains multiple opinions.",
          },
          locator_type: {
            type: "string",
            enum: ["paragraph", "page", "section", "footnote"],
          },
          locator: {
            type: "string",
            description:
              "Locator such as paragraph 54, page 410, section 2, or footnote 3.",
          },
          context_blocks: {
            type: "integer",
            minimum: 0,
            maximum: 2,
          },
        },
        required: ["clusterId", "locator_type", "locator"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: COURTLISTENER_TOOL_NAMES.readCase,
      description:
        "Read selected opinion text from an already-fetched CourtListener cluster, after find_in_case when snippets are insufficient. Pass only the opinionId/opinionIds needed.",
      parameters: {
        type: "object",
        properties: {
          clusterId: {
            type: "integer",
            description:
              "Cluster ID previously fetched with courtlistener_get_cases.",
          },
          opinionId: {
            type: "integer",
            description:
              "Specific opinion ID to read. Use when one opinion is enough.",
          },
          opinionIds: {
            type: "array",
            items: { type: "integer" },
            description:
              "Opinion IDs to read. Use the smallest set the question requires.",
          },
        },
        required: ["clusterId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: COURTLISTENER_TOOL_NAMES.verifyCitations,
      description:
        "Verify reporter citations through CourtListener's citation lookup. Returns citation metadata and case resources for matched citations.",
      parameters: {
        type: "object",
        properties: {
          citations: {
            type: "array",
            items: { type: "string" },
            description:
              'One clean reporter citation per item, e.g. ["467 U.S. 837", "323 U.S. 134"]. Never case names. Up to 250 items.',
          },
        },
        required: ["citations"],
      },
    },
  },
];
