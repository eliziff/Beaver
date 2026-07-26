export const PUBLIC_LEGAL_SOURCE_TOOL_NAMES = {
  fetch: "public_legal_source_fetch",
  lookup: "public_legal_source_lookup",
} as const;

const PROVIDERS = ["tna", "govuk-et", "govinfo"] as const;

export const PUBLIC_LEGAL_SOURCE_TOOLS = [
  {
    type: "function",
    function: {
      name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch,
      description:
        "Fetch one exact public legal source from the UK National Archives Find Case Law, GOV.UK Employment Tribunal decisions, or US GovInfo. URLs are resolved and retained by Mike; do not supply or construct one.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: PROVIDERS,
            description:
              "tna for a UK neutral citation, govuk-et for an Employment Tribunal case number, or govinfo for a US federal docket.",
          },
          identifier: {
            type: "string",
            description:
              'Exact provider identifier, such as "[2024] UKSC 1", "2200123/2024", or "1:22-cv-00930".',
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
        "Look up one paragraph, section/subsection, or page in an exact TNA, GOV.UK Employment Tribunal, or GovInfo source. Mike fetches and indexes the source if needed, preserves provider-native locators, and reconstructs structure only when native structure is absent.",
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
          locator_type: {
            type: "string",
            enum: ["paragraph", "section", "page"],
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
        required: ["provider", "identifier", "locator_type", "locator"],
      },
    },
  },
];

export const PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT = `PUBLIC LEGAL SOURCES:
Use public_legal_source_fetch and public_legal_source_lookup for:
- UK Find Case Law (provider "tna") using an exact neutral citation.
- GOV.UK Employment Tribunal decisions (provider "govuk-et") using an exact case number.
- US GovInfo court opinions (provider "govinfo") using an exact federal docket.
Prefer lookup for a requested paragraph, section/subsection, or page. Base claims only on fetched or returned text, not search metadata or memory. Provider URLs and native anchors are private server evidence: never invent, request, copy, or include a URL in citation data.
When relying on one of these sources, include [N] and a matching <CITATIONS> entry: {"ref": N, "source": "public_legal", "provider": "tna", "identifier": "[2024] UKSC 1", "quotes": [{"quote": "exact returned text"}]}. Mike verifies the quote against fetched full text and attaches the trusted provider link automatically.`;
