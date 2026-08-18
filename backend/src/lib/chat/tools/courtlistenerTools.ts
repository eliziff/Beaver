import type { Tool } from "../../llm";

export type CourtlistenerToolEvent =
  | {
      type: "courtlistener_find_in_case";
      cluster_id: number | null;
      query: string;
      total_matches: number;
      case_name?: string | null;
      citation?: string | null;
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
  findInCase: "find_in_case",
  verifyCitations: "verify_citations",
} as const;

export const COURTLISTENER_SYSTEM_PROMPT = `US CASE LAW RESEARCH:
Use search_sources for discovery and Read the returned source resources. Use verify_citations for clean reporter citations, never case names. After reading a case resource, find_in_case can locate short terms in that case.

Citation rules:
- Cite a case only from opinion text or snippets supplied in this turn — never from memory, metadata, search results, citationLinks, or verification results. If you have no text for a useful case, fetch or read it, or say you could not read it and do not rely on it.
- Use the returned evidence_ids in submit_grounded_answer. Do not construct or repeat a CourtListener link, marker, citation JSON, or plaintext pinpoint.
- On any rate-limit/throttling/429 error, stop all CourtListener calls for that turn and answer from what you already have.`;

export const COURTLISTENER_FIND_TOOL: Tool = {
  name: COURTLISTENER_TOOL_NAMES.findInCase,
  annotations: { readOnlyHint: true },
  description:
    "Search a CourtListener case already opened with Read for keywords or phrases. Returns matches with surrounding opinion context. At most 3 calls per turn.",
  inputSchema: {
    type: "object",
    properties: {
      clusterId: {
        type: "integer",
        description: "Cluster ID from the case resource opened with Read.",
      },
      query: {
        type: "string",
        description:
          "Short 1-3 word term likely to appear verbatim in the opinion. Case-insensitive and whitespace-tolerant.",
      },
      max_results: { type: "integer", minimum: 1, maximum: 50 },
      context_chars: { type: "integer", minimum: 40, maximum: 2000 },
    },
    required: ["clusterId", "query"],
    additionalProperties: false,
  },
};

export const COURTLISTENER_VERIFY_TOOL: Tool = {
  name: COURTLISTENER_TOOL_NAMES.verifyCitations,
  annotations: { readOnlyHint: true },
  description:
    "Verify reporter citations through CourtListener's citation lookup. Returns citation metadata and case resources for matched citations.",
  inputSchema: {
    type: "object",
    properties: {
      citations: {
        type: "array",
        maxItems: 250,
        items: { type: "string" },
        description:
          'One clean reporter citation per item, e.g. ["467 U.S. 837", "323 U.S. 134"]. Never case names.',
      },
    },
    required: ["citations"],
    additionalProperties: false,
  },
};

export const COURTLISTENER_TOOLS = [
  COURTLISTENER_FIND_TOOL,
  COURTLISTENER_VERIFY_TOOL,
] satisfies Tool[];
