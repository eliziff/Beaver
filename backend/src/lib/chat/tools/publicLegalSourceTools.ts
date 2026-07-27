export const PUBLIC_LEGAL_SOURCE_TOOL_NAMES = {
  search: "public_legal_source_search",
  fetch: "public_legal_source_fetch",
  lookup: "public_legal_source_lookup",
} as const;

const PROVIDERS = ["tna", "govuk-et", "govinfo", "journal"] as const;

export const PUBLIC_LEGAL_SOURCE_TOOLS = [
  {
    type: "function",
    function: {
      name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.search,
      description:
        "Search local journal-article metadata in public_endpoint.db. Results are candidates only; fetch or look up the returned article_id before relying on text.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: ["journal"],
          },
          query: {
            type: "string",
            description: "Article title, author, journal, or citation terms.",
          },
          size: {
            type: "integer",
            minimum: 1,
            maximum: 25,
          },
        },
        required: ["provider", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch,
      description:
        "Fetch one exact public legal source from UK Find Case Law, GOV.UK Employment Tribunal decisions, US GovInfo, or the local journal corpus. For journals, pass an article_id returned by search. URLs are retained by Beaver; do not supply or construct one.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: PROVIDERS,
            description:
              "tna for a UK neutral citation, govuk-et for an Employment Tribunal case number, govinfo for a US federal docket, or journal for a public_endpoint.db article.",
          },
          identifier: {
            type: "string",
            description:
              'Exact provider identifier, such as "[2024] UKSC 1", "2200123/2024", "1:22-cv-00930", or a journal article_id.',
          },
        },
        required: ["provider", "identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
      description:
        "Look up one paragraph, section/subsection, page, or journal footnote. Beaver preserves native locators and page maps, reconstructs structure only when necessary, and retains the final URL privately. To rehydrate exact TNA evidence from an earlier turn, pass its evidence_handle with the same provider and identifier instead of locator fields.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: PROVIDERS,
          },
          identifier: {
            type: "string",
            description:
              "Exact neutral citation, Employment Tribunal case number, or federal docket.",
          },
          evidence_handle: {
            type: "string",
            description:
              "Optional mike-provider-evidence:v1 handle returned by an earlier exact TNA lookup.",
          },
          locator_type: {
            type: "string",
            enum: ["paragraph", "section", "page", "footnote"],
          },
          locator: {
            type: "string",
            description:
              "Exact locator, including nested forms such as 2(1)(a), para 24, or page 7.",
          },
          context_blocks: {
            type: "integer",
            minimum: 0,
            maximum: 2,
          },
        },
        required: ["provider", "identifier"],
      },
    },
  },
];

export const PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT = `PUBLIC LEGAL SOURCES:
Use public_legal_source_fetch and public_legal_source_lookup for:
- UK Find Case Law (provider "tna") using an exact neutral citation.
- GOV.UK Employment Tribunal decisions (provider "govuk-et") using an exact case number.
- US GovInfo court opinions (provider "govinfo") using an exact federal docket.
- Local journal articles (provider "journal"): search first, then fetch or look up using the returned article_id.
Prefer lookup for a requested paragraph, section/subsection, page, or journal footnote. Search/FTS results are candidates only. Base claims only on fetched or returned text, not search metadata, embeddings, or memory. Provider URLs and native anchors are private server evidence: never invent, request, copy, or include a URL in citation data.
Preserve an exact lookup's evidence.handle when its passage may be needed after compaction. Rehydrate it with public_legal_source_lookup using evidence_handle plus the same provider and identifier; do not expose the handle to the user.
When relying on one of these sources, include [N] and a matching <CITATIONS> entry: {"ref": N, "source": "public_legal", "provider": "tna", "identifier": "[2024] UKSC 1", "quotes": [{"quote": "exact returned text"}]}. Beaver verifies the quote against fetched full text and attaches the trusted provider link automatically.`;
