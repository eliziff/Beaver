import type { OpenAIToolSchema } from "../llm";

/**
 * Benchmark-only snapshot of Will Chen's upstream Mike project-retrieval
 * contract. Production Beaver does not select this surface unless an explicit
 * LAB environment flag requests it.
 *
 * Source: origin/main at UPSTREAM_MIKE_COMMIT
 *   backend/src/lib/chat/tools/toolSchemas.ts
 *   backend/src/lib/chat/prompts.ts
 */
export const UPSTREAM_MIKE_COMMIT =
  "2266446b0d26f735865b8cd3bb153b28e7d11b17";
export const UPSTREAM_MIKE_SOURCE_BLOBS = {
  "backend/src/lib/chat/tools/toolSchemas.ts":
    "302ceb9e66b7c1950d89522c59e6f1597d9d2b14",
  "backend/src/lib/chat/prompts.ts":
    "6b3f2fc3d44051b4e4ae0d4d65ec2cbfd621f39f",
  "backend/src/lib/chat/streaming.ts":
    "f6ddacb2d904e7d2fe8ad49b6fdb0bc6763e5e58",
  "backend/src/lib/chat/tools/toolDispatcher.ts":
    "3e6f674478fca8961b0c05afb374b04f923833c7",
  "backend/src/lib/chat/tools/documentOps.ts":
    "1ca2a55468efbb1a5bd1b9463d9f8fcb0cbbbcec",
} as const;
export const UPSTREAM_MIKE_SCHEMA_SHA256 =
  "78f2e1dfaa7f2c5a62dcc52531804373e998ee002fe783e7767a10113e7a87fc";

const declarations: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: "list_documents",
      description:
        "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_documents",
      description:
        "Read the full text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once. In one response, fetch each document/version at most once; after it has been fetched, use the prior tool result or find_in_document for targeted checks.",
      parameters: {
        type: "object",
        properties: {
          doc_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
          },
        },
        required: ["doc_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read the full text content of a document attached by the user. Always call this before answering questions about, summarising, citing from, or editing a document, but call it at most once per document/version in a single response. After this returns, use the prior tool result or find_in_document for targeted checks instead of reading the same document/version again.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to read (e.g. 'doc-0', 'doc-1')",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_in_document",
      description:
        "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, or a specific phrase) rather than reading the whole document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to search (e.g. 'doc-0').",
          },
          query: {
            type: "string",
            description:
              "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'.",
          },
          max_results: {
            type: "integer",
            description:
              "Maximum number of matches to return (default 20). Use a smaller value for common terms.",
          },
          context_chars: {
            type: "integer",
            description:
              "Characters of surrounding context to include on each side of a match (default 80).",
          },
        },
        required: ["doc_id", "query"],
      },
    },
  },
];

const byName = new Map(
  declarations.map((entry) => [entry.function.name, entry]),
);

// Upstream sends base tools before project-extra tools. Preserve that order;
// schema order affects both tool selection and provider prompt-cache identity.
export const UPSTREAM_MIKE_RETRIEVAL_TOOLS = [
  "read_document",
  "find_in_document",
  "list_documents",
  "fetch_documents",
].map((name) => {
  const entry = byName.get(name);
  if (!entry) throw new Error(`missing frozen upstream tool ${name}`);
  return entry;
});

export const UPSTREAM_MIKE_GENERATE_DOCX_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "generate_docx",
    description:
      "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a legal document. Returns a download URL for the generated file.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Document title (used as filename and heading)",
        },
        landscape: {
          type: "boolean",
          description:
            "Set to true for landscape page orientation. Default is portrait.",
        },
        sections: {
          type: "array",
          description:
            "List of document sections. Each section may contain a heading, prose content, or a table.",
          items: {
            type: "object",
            properties: {
              heading: {
                type: "string",
                description: "Optional section heading",
              },
              level: {
                type: "integer",
                description: "Heading level: 1, 2, or 3",
              },
              content: {
                type: "string",
                description:
                  "Prose text content (paragraphs separated by double newlines)",
              },
              pageBreak: {
                type: "boolean",
                description:
                  "Set to true to start this section on a new page. Use for contract signature pages.",
              },
              table: {
                type: "object",
                description: "Optional table to render in this section",
                properties: {
                  headers: {
                    type: "array",
                    items: { type: "string" },
                    description: "Column header labels",
                  },
                  rows: {
                    type: "array",
                    items: {
                      type: "array",
                      items: { type: "string" },
                    },
                    description:
                      "Array of rows, each row is an array of cell strings matching the headers order",
                  },
                },
                required: ["headers", "rows"],
              },
            },
          },
        },
      },
      required: ["title", "sections"],
    },
  },
};

export const UPSTREAM_MIKE_LAB_TOOLS = [
  ...UPSTREAM_MIKE_RETRIEVAL_TOOLS,
  UPSTREAM_MIKE_GENERATE_DOCX_TOOL,
];

/** Small, explicit delta from the frozen comparator. */
export const ADAPTIVE_MIKE_DELTA =
  "inventory-bounded-read-terminal-generate-v1";

export const ADAPTIVE_MIKE_READ_DOCUMENT_TOOL: OpenAIToolSchema = {
  ...byName.get("read_document")!,
  function: {
    ...byName.get("read_document")!.function,
    description:
      "Read a project document. With only doc_id, returns the complete text. For large supporting sources, optionally select one legal section, one or more 1-based pages, or a character offset and max_chars. Bounded reads never prevent a later complete or bounded read.",
    parameters: {
      type: "object",
      properties: {
        doc_id: {
          type: "string",
          description: "Document ID from list_documents (for example doc-0).",
        },
        section: {
          type: "string",
          description:
            "Optional section locator such as Section 8.01, Article IV, or Schedule A.",
        },
        pages: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          maxItems: 20,
          description:
            "Optional 1-based page ordinals. Available only when list_documents reports pages greater than zero.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Optional character offset, relative to the selected section/pages or the full document.",
        },
        max_chars: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description:
            "Maximum characters to return. Defaults to 24000 for a bounded read; omitted on an unscoped read means the complete document.",
        },
      },
      required: ["doc_id"],
    },
  },
};

export const ADAPTIVE_MIKE_GENERATE_DOCX_TOOL: OpenAIToolSchema = {
  ...UPSTREAM_MIKE_GENERATE_DOCX_TOOL,
  function: {
    ...UPSTREAM_MIKE_GENERATE_DOCX_TOOL.function,
    description:
      `${UPSTREAM_MIKE_GENERATE_DOCX_TOOL.function.description} ` +
      "Call only when every requested deliverable is final. A successful call ends the turn without another model round.",
  },
};

export const ADAPTIVE_MIKE_LAB_TOOLS = [
  ADAPTIVE_MIKE_READ_DOCUMENT_TOOL,
  ...UPSTREAM_MIKE_RETRIEVAL_TOOLS.filter(
    (tool) => tool.function.name !== "read_document",
  ),
  ADAPTIVE_MIKE_GENERATE_DOCX_TOOL,
];

export const UPSTREAM_MIKE_RETRIEVAL_PROMPT = `PROJECT RETRIEVAL (pinned upstream Mike):
- Use at most 10 tool-use rounds per response. Batch independent tool calls and leave room for the final answer.
- Read each relevant document/version at most once per response. After read_document or fetch_documents returns a document's full text, do not call either tool again for that same document/version in the same response; use the prior result, call find_in_document for targeted checks, or proceed to the next required tool.
- Use list_documents to discover project documents. Use fetch_documents when several documents are relevant; otherwise use read_document. find_in_document is a targeted, whitespace-tolerant Ctrl+F check, not a substitute for the required whole-document read.`;

/** Only clauses from the pinned upstream prompt that describe tools present in
 * the LAB surface. Omitting absent upstream tools avoids teaching a callable
 * name that the model cannot actually use. */
export const UPSTREAM_MIKE_LAB_SYSTEM_PROMPT = `You are Mike, an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.

CORE RULES:
- Be precise, professional, and evidence-aware.
- Do not fabricate document content.
- Use at most 10 tool-use rounds per response. Batch independent tool calls and leave room for the final answer.
- Read each relevant document/version at most once per response. After read_document or fetch_documents returns a document's full text, do not call either tool again for that same document/version in the same response; use the prior result, call find_in_document for targeted checks, or proceed to the next required tool.

PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

DOCX GENERATION:
- If the user asks you to create or draft a document, call generate_docx and provide the downloadable Word document rather than only displaying text inline.
- Use heading levels in order; do not skip from Heading 1 to Heading 3.
- Numbering starts at 1, never 0. The generator applies legal numbering automatically. Do not type numbering prefixes into headings.
- Do not repeat the document title as the first section heading.
- Contract preambles, party blocks, recitals, and WHEREAS clauses are unnumbered. Begin numbering at the first operative clause or section.
- Contracts and agreements must end with an unnumbered signature block on a fresh page. Set pageBreak: true on the final section and include signature lines such as By, Name, Title, and Date for each party.

DOCUMENT NAMES IN PROSE:
- Document IDs are internal. Use them only in tool arguments.
- Refer to documents by filename or a natural description.

GENERAL GUIDANCE:
- Cite the exact document passage for evidence-backed claims.
- Do not use emojis.`;

export const ADAPTIVE_MIKE_LAB_SYSTEM_PROMPT = `${UPSTREAM_MIKE_LAB_SYSTEM_PROMPT}

ADAPTIVE READING:
- list_documents reports exact extracted sizes and page counts. Whole-document reads remain the simplest path when the relevant material fits comfortably. For large supporting sources, use read_document section/pages/offset/max_chars to retrieve only the needed evidence; follow its exact continuation recipe when necessary.

TERMINAL DOCUMENT CREATION:
- Call generate_docx only after every requested deliverable is final. A successful generate_docx call completes the turn; do not plan a later read_document or acknowledgement round.`;
