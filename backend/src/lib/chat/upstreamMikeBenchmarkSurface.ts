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

export const MARKDOWN_SWAP_GENERATE_DOCX_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "generate_docx",
    description:
      "Generate a Word (.docx) document from Markdown. Use this when the user asks you to draft, create, or produce a legal document. Returns a download URL for the generated file.",
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
        markdown: {
          type: "string",
          description:
            "Complete document in Markdown. Use headings, paragraphs, lists, and tables as appropriate.",
        },
      },
      required: ["title", "markdown"],
    },
  },
};

export const UPSTREAM_MIKE_MARKDOWN_SWAP_LAB_TOOLS = [
  ...UPSTREAM_MIKE_RETRIEVAL_TOOLS,
  MARKDOWN_SWAP_GENERATE_DOCX_TOOL,
];

/** read_document for the SILO'D derived-section-index arm: the frozen upstream
 * schema reads a whole document only; the index arm's hypothesis needs scoped
 * reads so the model can orient by the SECT-INDEX and window-read sections
 * instead of whole-reading. offset/max_chars take a char window (feed them the
 * offset from find_in_document); head/tail probe the first/last lines cheaply. */
export const MARKDOWN_INDEX_READ_DOCUMENT_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_document",
    description:
      "Read a document attached by the user. Documents whose derived SECT-INDEX is addressable require SCOPED reads — an unscoped read of one is rejected. Orient with index=true (returns the SECT-INDEX alone: every numbered section with its body offset @N). Then read sections with offset/max_chars — a bounded character window into the document body (feed it the @N from the SECT-INDEX, or the offset a find_in_document match returns). head/tail return the first/last N lines of the body. Documents without a usable index read whole.",
    parameters: {
      type: "object",
      properties: {
        doc_id: {
          type: "string",
          description: "The document ID to read (e.g. 'doc-0').",
        },
        index: {
          type: "boolean",
          description:
            "true = return only the document's derived SECT-INDEX (cheap orientation: every numbered section with its @N body offset).",
        },
        offset: {
          type: "integer",
          description:
            "0-based character offset into the document BODY to start reading from (use an @N from the SECT-INDEX or a find_in_document offset).",
        },
        max_chars: {
          type: "integer",
          description:
            "Maximum characters to return in the window. Default 24000.",
        },
        head: {
          type: "integer",
          description:
            "Read only the first N lines of the document body (cheap orientation probe).",
        },
        tail: {
          type: "integer",
          description:
            "Read only the last N lines of the document body (cheap probe for signature blocks and endings).",
        },
      },
      required: ["doc_id"],
    },
  },
};

/** fetch_documents variant for the SILO'D derived-section-index arm: batch a
 * scoped window across several documents in ONE call, so the model can read
 * multiple sections from multiple documents in a single turn (e.g. head: 20 to
 * see every requested document's SECT-INDEX, or offset/max_chars for a window
 * of each). Without extra args it keeps the upstream whole-read behaviour. */
export const MARKDOWN_INDEX_FETCH_DOCUMENTS_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "fetch_documents",
    description:
      "Read several documents in a single call; the same scope (index=true, offset/max_chars, or head/tail) applies to EVERY requested document. Use index=true across documents to orient in one round (each document's SECT-INDEX with @N body offsets), then window-read the needed sections. An unscoped fetch serves documents without a usable index whole and refuses only the ones whose SECT-INDEX is addressable, per document.",
    parameters: {
      type: "object",
      properties: {
        doc_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
        },
        index: {
          type: "boolean",
          description:
            "true = return only each document's derived SECT-INDEX (cheap orientation across many documents in one round).",
        },
        offset: {
          type: "integer",
          description:
            "0-based character offset into each document's BODY to start reading from.",
        },
        max_chars: {
          type: "integer",
          description:
            "Maximum characters to return per document. Default 24000.",
        },
        head: {
          type: "integer",
          description:
            "Read only the first N lines of each requested document's body (cheap orientation probe).",
        },
        tail: {
          type: "integer",
          description:
            "Read only the last N lines of each requested document's body (cheap probe for signature blocks and endings).",
        },
      },
      required: ["doc_ids"],
    },
  },
};

export const MARKDOWN_INDEX_LAB_TOOLS: OpenAIToolSchema[] = [
  // Replace read_document/fetch_documents in place to preserve the upstream
  // tool ORDER — the backend's LAB preflight compares exact order.
  ...UPSTREAM_MIKE_RETRIEVAL_TOOLS.map((tool) => {
    const name = tool.function.name;
    if (name === "read_document") return MARKDOWN_INDEX_READ_DOCUMENT_TOOL;
    if (name === "fetch_documents") return MARKDOWN_INDEX_FETCH_DOCUMENTS_TOOL;
    return tool;
  }),
  MARKDOWN_SWAP_GENERATE_DOCX_TOOL,
];

export const MARKDOWN_SWAP_DELTA = "upstream-markdown-generate-swap-v1";
export const MARKDOWN_E2E_DELTA = "upstream-markdown-read-write-v1";
export const MARKDOWN_E2E_INDEX_DELTA = "derived-section-index-orient-first-v2";
export const MARKDOWN_E2E_FLOOR_DELTA =
  "upstream-markdown-read-write-completeness-floor-v1";
export const MARKDOWN_E2E_INDEX_FLOOR_DELTA =
  "derived-section-index-orient-first-completeness-floor-v2";

export const COMPACT_AUTHOR_MIKE_DELTA =
  "compact-markdown-terminal-v1";
export const LEAN_BATCH_DELTA =
  "inventory-grep-batch-read-compact-terminal-v1";
export const LEAN_BATCH_HARDREFS_DELTA =
  "inventory-grep-batch-read-literal-reference-hints-compact-terminal-v1";

export const COMPACT_GENERATE_DOCX_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "generate_docx",
    description:
      "Create the final Word document from Markdown. A successful call ends the turn.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Document title and filename.",
        },
        markdown: {
          type: "string",
          description:
            "Complete document in Markdown. Use headings, paragraphs, lists, tables, and a final signature block as appropriate.",
        },
        landscape: {
          type: "boolean",
          description: "True only when a wide table requires landscape pages.",
        },
      },
      required: ["title", "markdown"],
    },
  },
};

export const COMPACT_AUTHOR_MIKE_LAB_TOOLS = [
  ...UPSTREAM_MIKE_RETRIEVAL_TOOLS,
  COMPACT_GENERATE_DOCX_TOOL,
];

/** Small, explicit delta from the frozen comparator. */
export const ADAPTIVE_MIKE_DELTA =
  "inventory-bounded-read-terminal-generate-v1";

/** Exact pinned comparator surface; only the provider loop terminates after a
 * successful generate receipt. Prompt, tools, and retrieval stay byte-equal. */
export const UPSTREAM_TERMINAL_DELTA = "terminal-successful-generate-v1";

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

export const MIKE_GREP_DELTAS = {
  "mike-grep-v1":
    "sized-inventory-global-grep-bounded-read-dedup-terminal-v1",
  "mike-legal-v1":
    "sized-inventory-global-grep-bounded-read-legal-scopes-dedup-terminal-v1",
  "mike-legal-guided-v1":
    "sized-inventory-global-grep-bounded-read-legal-scopes-guidance-dedup-terminal-v1",
  "mike-structure-paths-v1":
    "sized-inventory-global-grep-immutable-structure-paths-bounded-read-dedup-terminal-v1",
} as const;

const MIKE_INVENTORY_TOOL: OpenAIToolSchema = {
  ...byName.get("list_documents")!,
  function: {
    ...byName.get("list_documents")!.function,
    description:
      "List the project documents with IDs, filenames, file types, and exact extracted character, line, and page counts.",
  },
};

const LEAN_BATCH_INVENTORY_TOOL: OpenAIToolSchema = {
  ...MIKE_INVENTORY_TOOL,
  function: {
    ...MIKE_INVENTORY_TOOL.function,
    description:
      "List project documents with filenames, types, exact extracted sizes, and a short opening line for orientation.",
  },
};

const MIKE_COMPLETE_READ_TOOL: OpenAIToolSchema = {
  ...byName.get("read_document")!,
  function: {
    ...byName.get("read_document")!.function,
    description:
      "Read the complete text of one project document. This is the simplest path when the document is broadly relevant; for localized evidence in a large source, Grep and bounded Read are also valid without a prior complete read.",
  },
};

function mikeGrepTool(
  legalScopes: boolean,
  structurePaths = false,
): OpenAIToolSchema {
  return {
    type: "function",
    function: {
      name: "Grep",
      description:
        "Search project-document contents with a regular expression across every document by default, or filter by filename or glob. Returns matching lines with bounded context." +
        (legalScopes
          ? " Optional section and page scopes bound long legal documents; ordinary unscoped Grep remains available."
          : structurePaths
            ? " Matches in verified legal units use immutable .mike/structure/... paths that can be passed unchanged to Read or Grep."
          : ""),
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression to search for.",
          },
          path: {
            type: "string",
            description:
              "Optional filename, or the doc-N label from list_documents when filenames are duplicated. Omit to search every document.",
          },
          glob: {
            type: "string",
            description: 'Optional filename filter such as "*.docx".',
          },
          output_mode: {
            type: "string",
            enum: [
              "content",
              "files_with_matches",
              "count",
              ...(legalScopes ? ["sections"] : []),
            ],
            description:
              "content returns matching lines; files_with_matches returns filenames; count returns match counts." +
              (legalScopes
                ? " sections returns executable Read recipes for the legal sections containing matches, without section prose."
                : ""),
          },
          "-i": { type: "boolean", description: "Case-insensitive search." },
          "-n": {
            type: "boolean",
            description: "Show line numbers in content mode; defaults to true.",
          },
          "-C": {
            type: "number",
            description: "Lines of context before and after each match.",
          },
          head_limit: {
            type: "number",
            minimum: 1,
            description: "Maximum returned lines or entries; defaults to 250.",
          },
          ...(legalScopes
            ? {
                section: {
                  type: "string",
                  description:
                    "Optional exact section, subsection, table row, or cell handle copied from Grep. Searches that unit and its children.",
                },
                pages: {
                  type: "string",
                  description:
                    'Optional page scope such as "pdf:12", "printed:47", "12-18", or "3,5,9". Never guess a page scheme.',
                },
              }
            : {}),
        },
        required: ["pattern"],
      },
    },
  };
}

function mikeReadTool(
  legalScopes: boolean,
  structurePaths = false,
): OpenAIToolSchema {
  return {
    type: "function",
    function: {
      name: "Read",
      description:
        "Read a project document in cat -n format. Reads up to 2000 lines by default; pass offset and limit for a bounded line window." +
        (legalScopes
          ? " A verified section handle or exact page scope can select a legal unit instead."
          : structurePaths
            ? " A .mike/structure/... path copied from Grep reads that exact immutable source unit."
          : ""),
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Filename from list_documents, or its doc-N label when filenames are duplicated.",
          },
          offset: {
            type: "number",
            minimum: 1,
            description: "Optional starting line.",
          },
          limit: {
            type: "number",
            minimum: 1,
            description: "Optional number of lines to read.",
          },
          ...(!legalScopes
            ? {
                start_char: {
                  type: "number",
                  minimum: 0,
                  description:
                    "Optional character offset into the first selected line. Use only for an exact long-line continuation recipe returned by Read or Grep.",
                },
              }
            : {}),
          ...(legalScopes
            ? {
                section: {
                  type: "string",
                  description:
                    "Verified structural handle copied from Grep, including an exact table row or cell. Do not infer handles.",
                },
                pages: {
                  type: "string",
                  description:
                    'Exact page or range such as "pdf:12", "printed:47", or "12-18". Do not combine with section or offset.',
                },
              }
            : {}),
        },
        required: ["file_path"],
      },
    },
  };
}

function mikeGrepTools(
  legalScopes: boolean,
  structurePaths = false,
): OpenAIToolSchema[] {
  return [
    MIKE_COMPLETE_READ_TOOL,
    byName.get("find_in_document")!,
    MIKE_INVENTORY_TOOL,
    byName.get("fetch_documents")!,
    mikeGrepTool(legalScopes, structurePaths),
    mikeReadTool(legalScopes, structurePaths),
    ADAPTIVE_MIKE_GENERATE_DOCX_TOOL,
  ];
}

export const MIKE_GREP_LAB_TOOLS = mikeGrepTools(false);
export const MIKE_LEGAL_LAB_TOOLS = mikeGrepTools(true);
export const MIKE_STRUCTURE_PATHS_LAB_TOOLS = mikeGrepTools(false, true);

export const LEAN_BATCH_READ_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "Read",
    description:
      "Read one or more project documents. Without offset or limit, returns every requested document completely in one batch. A bounded read accepts exactly one path and returns numbered lines.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Filenames from list_documents, or doc-N labels for duplicate filenames.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "Optional first line for a one-document bounded read.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional number of lines for a one-document bounded read.",
        },
      },
      required: ["paths"],
    },
  },
};

export const LEAN_BATCH_LAB_TOOLS = [
  LEAN_BATCH_INVENTORY_TOOL,
  mikeGrepTool(false),
  LEAN_BATCH_READ_TOOL,
  COMPACT_GENERATE_DOCX_TOOL,
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

const UPSTREAM_DOCX_PROMPT = `DOCX GENERATION:
- If the user asks you to create or draft a document, call generate_docx and provide the downloadable Word document rather than only displaying text inline.
- Use heading levels in order; do not skip from Heading 1 to Heading 3.
- Numbering starts at 1, never 0. The generator applies legal numbering automatically. Do not type numbering prefixes into headings.
- Do not repeat the document title as the first section heading.
- Contract preambles, party blocks, recitals, and WHEREAS clauses are unnumbered. Begin numbering at the first operative clause or section.
- Contracts and agreements must end with an unnumbered signature block on a fresh page. Set pageBreak: true on the final section and include signature lines such as By, Name, Title, and Date for each party.`;

const COMPACT_DOCX_PROMPT = `DOCX GENERATION:
- If the user asks for a document, call generate_docx with the complete final Markdown rather than only displaying it inline.
- Use clear headings, paragraphs, lists, and tables as the work product requires. Include a complete signature block when the requested genre requires one.
- Call generate_docx only after every requested deliverable is final. A successful call ends the turn.`;

export const COMPACT_AUTHOR_MIKE_LAB_SYSTEM_PROMPT =
  UPSTREAM_MIKE_LAB_SYSTEM_PROMPT.replace(
    UPSTREAM_DOCX_PROMPT,
    COMPACT_DOCX_PROMPT,
  );

/** Orient-first ablation on the markdown-e2e surface: a derived SECT-INDEX is
 * prepended to each docx read; the model is directed to orient by it and read
 * selectively instead of whole-reading.
 *
 * SECTION-ORIENTED READING:
 * - Source documents open with a derived SECT-INDEX of numbered sections.
 * - read_document takes offset/max_chars for a bounded window (feed it the
 *   offset a find_in_document match returns) and head/tail to probe the first
 *   or last lines of a document cheaply.
 * - Orient by the index, then window-read only the sections your deliverable
 *   requires instead of the whole document. */
export const MARKDOWN_E2E_INDEX_LAB_SYSTEM_PROMPT = `${UPSTREAM_MIKE_LAB_SYSTEM_PROMPT}

SECTION-ORIENTED READING:
- Orient first: source documents carry a derived SECT-INDEX naming every numbered section with its body offset (@N). Read it with read_document index=true, or fetch_documents index=true to orient across several documents in one round. Reading the index is orientation, not a body read.
- Read sections directly with read_document offset=<@N> max_chars=<window>; offsets address the document body. find_in_document returns the body offset of a phrase. head/tail read the first/last N lines of the body.
- Batch: in one round, issue all the independent reads the deliverable needs — several offset/max_chars windows, or one fetch_documents across documents — never one read per round.
- Documents with an addressable SECT-INDEX require scoped reads (index=true, offset/max_chars, or head/tail); documents without one read whole. Multiple windows of one document are allowed.
- Read every section the deliverable requires, and never guess an offset — use the @N from the SECT-INDEX, or find_in_document for a phrase inside a section.`;

/**
 * Write-discipline lever for the read-scope x write-discipline 2x2. The
 * clause is verbatim from LEAN_BATCH_LAB_SYSTEM_PROMPT — the only arm ever
 * carrying an explicit completeness check, and the best-ever scorer on the
 * covenants family (59/65). Mechanism-only: no task-specific enumeration.
 */
export const COMPLETENESS_FLOOR_ENABLED =
  process.env.MIKE_COMPLETENESS_FLOOR === "1";

export const COMPLETENESS_FLOOR_BLOCK = `

COMPLETENESS:
- After a complete Read, do not search that text again unless you can name a specific missing fact. Before drafting, make one internal completeness check for requested issues, parties, dates, numbers, exceptions, and conflicts.`;

export const MARKDOWN_E2E_FLOOR_LAB_SYSTEM_PROMPT = `${UPSTREAM_MIKE_LAB_SYSTEM_PROMPT}${COMPLETENESS_FLOOR_BLOCK}`;

export const MARKDOWN_E2E_INDEX_FLOOR_LAB_SYSTEM_PROMPT = `${MARKDOWN_E2E_INDEX_LAB_SYSTEM_PROMPT}${COMPLETENESS_FLOOR_BLOCK}`;

export const LEAN_BATCH_LAB_SYSTEM_PROMPT = `You are an AI legal assistant for lawyers and legal professionals. Produce precise, professional work from the project documents without fabricating content.

SOURCE WORK:
- Start with list_documents. If the relevant source set fits comfortably, Read all of it completely in one batch.
- For a large or many-document source set, use one or a few Grep searches to orient, then use coherent bounded Read windows for the evidence you need.
- After a complete Read, do not search that text again unless you can name a specific missing fact. Before drafting, make one internal completeness check for requested issues, parties, dates, numbers, exceptions, and conflicts.
- Refer to documents by filename or a natural description in prose, not by internal IDs.

DOCUMENT CREATION:
- If the user asks for a document, call generate_docx with the complete final Markdown rather than only displaying it inline.
- Match the requested professional genre and include all requested deliverables. Call generate_docx only when the work is final; a successful call ends the turn.

Do not use emojis.`;

/* ----------------------------------------------------------------------
 * CODING-MARKDOWN arm (2026-08-06, Eli): the pure-coding hypothesis. The
 * lean-batch tool surface (list_documents/Grep/Read/generate_docx),
 * function-identical to the coding tools the models were RL'd on, over
 * the pandoc-markdown drafting plane — with the SOURCE WORK navigation
 * prescriptions REMOVED. Run 1 observes which pathways the model selects
 * natively; guidance returns only if the observed trajectory is wasteful.
 * Write-side discipline stays: grounding, one completeness check,
 * terminal authoring, filename-in-prose.
 * ---------------------------------------------------------------------- */

/** Delta tag: the composite coding-markdown arm. */
export const CODING_MARKDOWN_DELTA = "coding-markdown-v1";
/** Delta tag: the navigation-neutral prompt mechanism. */
export const CODING_NEUTRAL_PROMPT_DELTA = "coding-neutral-prompt-v1";

export const CODING_MARKDOWN_LAB_SYSTEM_PROMPT = `You are an AI legal assistant for lawyers and legal professionals. Produce precise, professional work from the project documents without fabricating content.

SOURCE WORK:
- Ground the deliverable in document text you have retrieved this turn; quote names, figures, dates, and defined terms exactly as the sources state them.
- Before drafting, make one internal completeness check for requested issues, parties, dates, numbers, exceptions, and conflicts.
- Refer to documents by filename or a natural description in prose, not by internal IDs.

DOCUMENT CREATION:
- If the user asks for a document, call generate_docx with the complete final Markdown rather than only displaying it inline.
- Match the requested professional genre and include all requested deliverables. Call generate_docx only when the work is final; a successful call ends the turn.

Do not use emojis.`;

/* ----------------------------------------------------------------------
 * CODING-MARKDOWN v2 (parity pack; adversarial audit 2026-08-06). The v1
 * arm served lean-batch's real tools — no Glob, a paths[] batch Read with
 * two output formats, descriptions carrying none of the trained
 * environment's efficiency cues and one anti-native whole-batch
 * invitation. v2 serves a Claude-Code-shaped surface: Glob, a single
 * file_path Read (always cat -n, 2000-line default, "read only the part
 * you need"), Grep with files_with_matches default and -A/-B context,
 * plus the same terminal generate_docx. NEW constants on purpose: the
 * lean-batch schemas are frozen surfaces with byte-equality tests.
 * ---------------------------------------------------------------------- */

/** Delta tag: executor-level CC parity (regex fallback, -A/-B, grep
 * default mode, minima guard) gated on MIKE_CODING_PARITY. */
export const CODING_PARITY_DELTA = "coding-parity-v1";
/** Delta tag: the composite v2 coding arm. */
export const CODING_MARKDOWN_V2_DELTA = "coding-markdown-v2";

export const CODING_GLOB_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "Glob",
    description:
      'Fast file pattern matching over the project documents. Supports glob patterns like "*.docx" or "*.{docx,xlsx}". Returns matching files with their sizes on the same text plane Grep and Read address.',
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match filenames against",
        },
      },
      required: ["pattern"],
    },
  },
};

export const CODING_GREP_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "Grep",
    description:
      "Content search with regular expressions across every project document by default; filter with path or glob. Use it to locate evidence in large documents instead of reading them whole. Returns matching file names by default; use output_mode \"content\" for the matching lines with context.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "The regular expression pattern to search for in document contents",
        },
        path: {
          type: "string",
          description: "A single filename to search. Defaults to all documents.",
        },
        glob: {
          type: "string",
          description: 'Glob pattern to filter documents (e.g. "*.docx")',
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file names (default), "count" shows match counts.',
        },
        "-i": { type: "boolean", description: "Case insensitive search" },
        "-n": {
          type: "boolean",
          description:
            'Show line numbers in output. Requires output_mode: "content". Defaults to true.',
        },
        "-A": {
          type: "number",
          description:
            'Number of lines to show after each match. Requires output_mode: "content".',
        },
        "-B": {
          type: "number",
          description:
            'Number of lines to show before each match. Requires output_mode: "content".',
        },
        "-C": {
          type: "number",
          description:
            'Number of lines to show before and after each match. Requires output_mode: "content".',
        },
        head_limit: {
          type: "number",
          minimum: 1,
          description: "Limit output to the first N lines/entries. Defaults to 250.",
        },
      },
      required: ["pattern"],
    },
  },
};

export const CODING_READ_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "Read",
    description:
      "Reads a project document. Reads up to 2000 lines by default. Results are returned using cat -n format, with line numbers starting at 1. When you already know which part of the document you need — a Grep hit's line number, or a known section — pass offset and limit for that window; this matters for larger documents.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The filename to read",
        },
        offset: {
          type: "number",
          minimum: 1,
          description:
            "The line number to start reading from. Only provide if the document is too large to read at once.",
        },
        limit: {
          type: "number",
          minimum: 1,
          description:
            "The number of lines to read. Only provide if the document is too large to read at once.",
        },
      },
      required: ["file_path"],
    },
  },
};

/**
 * The compact authoring tool with its contract spelled out against the
 * coding-surface Write prior. The v1 acq pilot (2026-08-06) drafted the
 * full deliverable and called generate_docx with Claude Code's Write
 * shape ({filename, content}) ten times straight, despite this schema
 * being served — on a surface where every other tool is CC-native, the
 * one custom tool needs its keys named in prose, the way CC tool
 * descriptions state defaults and usage. Same name and schema otherwise.
 */
export const CODING_GENERATE_DOCX_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "generate_docx",
    description:
      "Create the final Word document from Markdown. A successful call ends" +
      " the turn. Input keys are exactly {title, markdown} — this is not a" +
      " file Write: do not pass filename/content; put the complete document" +
      " body in 'markdown'.",
    parameters: COMPACT_GENERATE_DOCX_TOOL.function.parameters,
  },
};

export const CODING_MARKDOWN_V2_LAB_TOOLS: OpenAIToolSchema[] = [
  CODING_GLOB_TOOL,
  CODING_GREP_TOOL,
  CODING_READ_TOOL,
  CODING_GENERATE_DOCX_TOOL,
];

export const ADAPTIVE_MIKE_LAB_SYSTEM_PROMPT = `${UPSTREAM_MIKE_LAB_SYSTEM_PROMPT}

ADAPTIVE READING:
- list_documents reports exact extracted sizes and page counts. Whole-document reads remain the simplest path when the relevant material fits comfortably. For large supporting sources, use read_document section/pages/offset/max_chars to retrieve only the needed evidence; follow its exact continuation recipe when necessary.

TERMINAL DOCUMENT CREATION:
- Call generate_docx only after every requested deliverable is final. A successful generate_docx call completes the turn; do not plan a later read_document or acknowledgement round.`;

export const MIKE_GREP_LAB_SYSTEM_PROMPT = `${UPSTREAM_MIKE_LAB_SYSTEM_PROMPT}

SOURCE NAVIGATION:
- list_documents reports exact extracted sizes and page counts. Complete reads remain the shortest path when the relevant source set fits comfortably. For a large or many-document source set, Grep plus bounded Read may supply exact evidence without a prior complete read.

TERMINAL DOCUMENT CREATION:
- Call generate_docx only after every requested deliverable is final. A successful generate_docx call completes the turn; do not plan a later read or acknowledgement round.`;

export const MIKE_LEGAL_GUIDED_LAB_SYSTEM_PROMPT = `${MIKE_GREP_LAB_SYSTEM_PROMPT}

SCOPED READING GUIDANCE:
- Use a section scope when Grep supplies an exact structural handle and the needed evidence is concentrated in that provision. Use a page scope when the source or request makes pagination the meaningful locator. Use ordinary cross-document Grep and bounded line reads for wording distributed across sources. Keep a primary draft or precedent whole when its overall structure matters, and scope supporting sources when only localized evidence is needed. Never guess a section handle or page scheme.`;

export const MIKE_STRUCTURE_PATHS_LAB_SYSTEM_PROMPT = `${MIKE_GREP_LAB_SYSTEM_PROMPT}

STRUCTURED SOURCE PATHS:
- When Grep returns a .mike/structure/... path, it is a verified immutable view of one exact source unit. Use it like any other file path in Read or Grep when the whole unit is useful; never invent one.`;

/** Prompt-only ablation: grounding changes the reasoning process, not the
 * requested work-product genre or the retrieval/tool contract. */
export const GROUNDED_STRUCTURE_LAB_SYSTEM_PROMPT = `${MIKE_STRUCTURE_PATHS_LAB_SYSTEM_PROMPT}

GROUNDING BEFORE DRAFTING:
- Before drafting, build a compact internal evidence map for every material requested conclusion. Ground it in an exact passage, table fact, clause relationship, calculation with sourced inputs, cross-document contradiction, or meaningful source absence; retain the filename and locator.
- Check that the evidence map covers the requested issues, parties, dates, numbers, jurisdictions, exceptions, and conflicting source versions before calling generate_docx. Resolve material conflicts or state them accurately in the work product.
- Quotations and citations belong in the deliverable only when the request or professional genre calls for them. Otherwise use the grounded facts to draft the native work product without exposing the research apparatus.`;

/** Delta tag for the H7 one-time outline + top-K cross-reference injection. */
export const GROUNDED_STRUCTURE_OUTLINE_DELTA =
  "grounded-structure-outline-injection-v1";

/** The H7 arm keeps the grounded structure-paths surface byte-identical and
 * additionally documents that the host injects a compact, one-time structure
 * block (see buildLabOutlineInjectionBlock). The model reads it once; no new
 * tools, no multi-turn churn. */
export const GROUNDED_STRUCTURE_OUTLINE_LAB_SYSTEM_PROMPT = `${GROUNDED_STRUCTURE_LAB_SYSTEM_PROMPT}

INJECTED SOURCE OUTLINES:
- The system context includes a compact per-document outline of numbered provisions and a most-referenced cross-reference summary, computed once by the host from the sources. Use it to orient before reading; a document with no outline entry has no usable numbered structure or was omitted as too large.
- Section labels in the outline match the section handles Grep returns. Grep supplies the immutable .mike/structure/... path to Read for exact evidence; never invent a handle.
- The outline is a one-time orientation aid, not a substitute for reading the exact provisions your deliverable quotes or relies on.`;

/* ------------------------------------------------------------------------
 * mike_upstream_native_v1 — the full pinned upstream chat surface
 *
 * Frozen at UPSTREAM_MIKE_COMMIT (2266446b). Nothing above this banner is
 * touched: other arms hash those constants, so every native constant is new.
 *
 * Prompt composition reproduced here is upstream's project-chat composition
 * with research tools off:
 *   buildSystemPrompt(false)            prompts.ts:81-87
 *   + "\n\n" + PROJECT_SYSTEM_PROMPT_EXTRA   projectChat.ts:27-33, wired :152
 * with the AVAILABLE DOCUMENTS block appended per request by the route
 * (contextBuilders.ts:144-152), exactly as upstream does.
 *
 * Phase 1 strip-list (spec §2.8 caveat, deviation D10) — clauses referencing
 * tools that have no executor on the LAB serving side:
 *   - COURTLISTENER_SYSTEM_PROMPT  (native switch: includeResearchTools=false)
 *   - the generate_excel bullet    (prompts.ts:48)
 *   - the generate_ppt bullet      (prompts.ts:49)
 *   - the REPLICATING A DOCUMENT: block (projectChat.ts:32-33)
 * Phase 2 restores the last three and re-pins to 461e218471918dd… /
 * 00642ff87f0ca95a… / 8617531e5a9d966c…
 * ---------------------------------------------------------------------- */

/** Delta tag for the native-surface arm. Must not collide with any other. */
export const UPSTREAM_NATIVE_DELTA = "upstream-native-full-surface-v1";

/** SYSTEM_PROMPT_BEFORE_RESEARCH + "\n\n" + SYSTEM_PROMPT_AFTER_RESEARCH,
 * verbatim from 2266446b:backend/src/lib/chat/prompts.ts:3-79, minus the two
 * Phase-1 DOCX GENERATION bullets. 6770 bytes,
 * sha256 39355be587e6d44dd35a65b5ceda2968d44a07d69886020a31b7d609f46e3228. */
export const UPSTREAM_NATIVE_MIKE_BASE_PROMPT = `You are Mike, an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.

CORE RULES:
- Be precise, professional, and evidence-aware.
- Do not fabricate document content.
- Use at most 10 tool-use rounds per response. Batch independent tool calls and leave room for the final answer.
- Read each relevant document/version at most once per response. After read_document or fetch_documents returns a document's full text, do not call either tool again for that same document/version in the same response; use the prior result, call find_in_document for targeted checks, or proceed to the next required tool.
- If the user selects a workflow with [Workflow: <title> (id: <id>)], immediately call read_workflow with that id and follow the workflow before doing anything else.
- If you need the user to choose between options, clarify a missing premise, or attach one or more documents before you can continue, call ask_inputs with all needed choice and document-upload items in a single tool call. For document-upload items, include a document_types array with short labels for the specific categories of documents you need. After asking, do not continue the substantive task until the user responds in a later message.

DOCUMENT CITATIONS:
Use document citations only for verbatim evidence from uploaded or generated documents.

In prose, put sequential markers [1], [2], etc. exactly where the cited claim appears. Assign citation refs in first-appearance order and increment by exactly 1 each time: [1], [2], [3], never [1], [2], [3], [4], [5], [8], [9]. The marker number is the citation "ref" value, not a page, footnote, section, clause, or document number.

At the very end of the response, append:
<CITATIONS>
[
  {"ref": 1, "doc_id": "doc-0", "quotes": [{"page": 3, "quote": "exact verbatim text"}]},
  {"ref": 2, "doc_id": "doc-1", "quotes": [{"page": "41-42", "quote": "text before page break [[PAGE_BREAK]] text after page break"}]}
]
</CITATIONS>

Citation rules:
- Every [N] marker must have exactly one matching entry with "ref": N.
- Citation refs must be contiguous with no skipped numbers. If the response uses N citations, the refs must be exactly 1 through N, and the <CITATIONS> array should list them in that order.
- Bracketed numbers like [1] are only citation annotation markers. Do not add brackets to section, clause, schedule, exhibit, paragraph, or list numbering.
- "doc_id" must be the exact chat-local label you were given, such as "doc-0". Never use a filename or document UUID in "doc_id".
- Use one citation entry per marker. If one marker needs several passages, use "quotes" with 1 quote by default and at most 3.
- Keep quotes short, ideally 25 words or fewer, and tightly matched to the claim.
- "page" means the sequential [Page N] marker in the provided text, not printed page numbers inside the document. Non-spreadsheet unpaginated files may have no [Page N] markers; omit "page" (or use 1) when none is present.
- For spreadsheet sources (content shown as "## Sheet: <name>" markdown tables with a "Row" column and column-letter headers), cite by cell instead of page: set "sheet" to the sheet name and "cell" to the A1 address or range you are quoting (e.g. "B7" or "B7:C9", combining the column-letter header with the "Row" number). Put the plain cell value in "quote" with no "Row"/column-letter labels or "|" separators. Omit "page" for spreadsheet citations.
- A cell tagged "⟨merged A1:C1⟩" spans that whole range: its value belongs to the anchor cell and the other covered cells are shown blank. When citing anything in a merged range, set "cell" to the full range from the tag (e.g. "A1:C1"), not a covered cell like "B1". Do not include the "⟨merged ...⟩" tag text in "quote".
- For a continuous quote crossing two pages, set "page" to "N-M" and include [[PAGE_BREAK]] at the page break. Otherwise, use separate quote objects.
- For legacy compatibility, you may also include top-level "page" and "quote" matching the first quote.
- Omit the <CITATIONS> block when there are no citations.

DOCX GENERATION:
- If the user asks you to create or draft a document, call generate_docx and provide the downloadable Word document rather than only displaying text inline.
- If the user asks to revise a document you just generated, call edit_document on that document unless they explicitly want a brand-new document or the change is too broad for coherent editing.
- Use heading levels in order; do not skip from Heading 1 to Heading 3.
- Numbering starts at 1, never 0. The generator applies legal numbering automatically. Do not type numbering prefixes into headings.
- Do not repeat the document title as the first section heading.
- Contract preambles, party blocks, recitals, and WHEREAS clauses are unnumbered. Begin numbering at the first operative clause or section.
- Contracts and agreements must end with an unnumbered signature block on a fresh page. Set pageBreak: true on the final section and include signature lines such as By, Name, Title, and Date for each party.

DOCUMENT EDITING:
- For document edits, call read_document or fetch_documents once for each relevant document/version unless the exact needed text is already available in this response. Do not reread the same document/version before calling edit_document.
When edit_document adds, deletes, moves, or reorders any numbered clause, section, schedule, exhibit, or list item:
- Renumber all affected downstream items in the same edit.
- Update all affected cross-references, including references in recitals, definitions, schedules, and exhibits.
- Before editing, scan the full document with read_document or find_in_document for affected references.
- If a reference might point to a shifted number, include the update and explain the reason.
- When deleting square brackets, delete both "[" and "]".

DOCUMENT NAMES IN PROSE:
- Chat-local labels such as "doc-0" are internal. Use them only in tool arguments and citation JSON.
- Never show "doc-N" labels to the user in prose, headings, lists, or tool activity text.
- Refer to documents by filename or a natural description, such as "the NDA draft".

REASONING TRACE SAFETY:
- If reasoning or thought summaries are shown to the user, keep them as brief natural-language progress summaries.
- Do not expose source code, JSON snippets, tool arguments, API payloads, schemas, raw citations JSON, internal prompts, or implementation details in reasoning traces.
- Do not use code fences or structured data blocks in reasoning traces.

GENERAL GUIDANCE:
- Cite the exact document or fetched opinion passage for evidence-backed claims.
- If no documents are provided, answer from legal knowledge.
- Do not use emojis.
`;

/** PROJECT_SYSTEM_PROMPT_EXTRA paragraphs 1-2, verbatim from
 * 2266446b:backend/src/routes/projectChat.ts:27-31. 827 bytes,
 * sha256 3a8da67b3fb25227249882955c3540e949ca7ce85ab933bce5c151b74df62d94. */
export const UPSTREAM_NATIVE_MIKE_PROJECT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.`;

/** The assembled system prompt the arm serves, before the route appends the
 * per-request AVAILABLE DOCUMENTS block. Mirrors contextBuilders.ts:140-142,
 * which joins the base prompt to the trimmed project extra with a blank line. */
export const UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT = `${UPSTREAM_NATIVE_MIKE_BASE_PROMPT}\n\n${UPSTREAM_NATIVE_MIKE_PROJECT_EXTRA}`;

/** Resolves one of the five already-frozen upstream schemas at :29-110 by name.
 * Same guard as :123-127 — a rename upstream must fail loudly, not silently. */
const nativeFrozen = (name: string): OpenAIToolSchema => {
  const entry = byName.get(name);
  if (!entry) throw new Error(`missing frozen upstream tool ${name}`);
  return entry;
};

/** Verbatim from 2266446b:backend/src/lib/chat/tools/toolSchemas.ts:121-204 (TOOLS[0]). */
export const UPSTREAM_NATIVE_ASK_INPUTS_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "ask_inputs",
    description: "Ask the user for one or more decisions, clarifications, or document uploads before continuing. Use this when guessing would materially affect the answer or when required documents have not been attached. Put all needed questions and document requests in one items array. After calling ask_inputs, do not continue the substantive task until the user responds in a later message.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          description: "The list of user inputs needed before continuing. Use choice items for decisions/clarifications and documents items for required uploads.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable short ID for this input, unique within this tool call."
              },
              kind: {
                type: "string",
                enum: [
                  "choice",
                  "documents"
                ]
              },
              question: {
                type: "string",
                description: "For choice items only: the concise question to show to the user."
              },
              options: {
                type: "array",
                description: "For choice items only: selectable choices to show. Each choice has a single user-facing value, which is also sent back if selected.",
                minItems: 1,
                maxItems: 8,
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "string",
                      description: "The user-facing choice text."
                    }
                  },
                  required: [
                    "value"
                  ]
                }
              },
              allow_other: {
                type: "boolean",
                description: "For choice items only: whether to show an Other option with a text field. Defaults to true."
              },
              other_label: {
                type: "string",
                description: "For choice items only: label for the free-text option. Defaults to Other."
              },
              document_types: {
                type: "array",
                description: "For documents items only: readable labels for the types of documents you need the user to attach.",
                minItems: 1,
                maxItems: 8,
                items: {
                  type: "string"
                }
              },
              response_prefix: {
                type: "string",
                description: "Optional prefix the UI should include when sending this response back as the next message."
              }
            },
            required: [
              "id",
              "kind"
            ]
          }
        }
      },
      required: [
        "items"
      ]
    }
  }
};

/** Verbatim from 2266446b:backend/src/lib/chat/tools/toolSchemas.ts:419-470. */
export const UPSTREAM_NATIVE_EDIT_DOCUMENT_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "edit_document",
    description: "Propose edits to a user-attached .docx as tracked changes. Each edit is a precise, minimal substitution of specific words/characters, NOT a whole-line or paragraph replacement. Use read_document first unless this same document/version has already been read in the current response. Anchor each edit with short before/after context so it can be located unambiguously. Returns per-edit annotations the UI will render as Accept/Reject cards and a download link to the edited document.",
    parameters: {
      type: "object",
      properties: {
        doc_id: {
          type: "string",
          description: "Document slug (e.g. 'doc-0')."
        },
        edits: {
          type: "array",
          description: "List of precise substitutions.",
          items: {
            type: "object",
            properties: {
              find: {
                type: "string",
                description: "Exact substring to replace (keep it as short as possible — ideally just the words/chars being changed)."
              },
              replace: {
                type: "string",
                description: "Replacement text. Empty string = pure deletion."
              },
              context_before: {
                type: "string",
                description: "~40 chars immediately preceding `find`, used to disambiguate."
              },
              context_after: {
                type: "string",
                description: "~40 chars immediately following `find`."
              },
              reason: {
                type: "string",
                description: "Short explanation shown to the user on the card."
              }
            },
            required: [
              "find",
              "replace",
              "context_before",
              "context_after"
            ]
          }
        }
      },
      required: [
        "doc_id",
        "edits"
      ]
    }
  }
};

/** Verbatim from 2266446b:backend/src/lib/chat/tools/toolSchemas.ts:91-100 (WORKFLOW_TOOLS[0]). */
export const UPSTREAM_NATIVE_LIST_WORKFLOWS_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "list_workflows",
    description: "List all workflows available to the user. Returns each workflow's ID and title. Call this when the user asks to run a workflow, apply a template, or you need to discover what workflows exist.",
    parameters: {
      type: "object",
      properties: {}
    }
  }
};

/** Verbatim from 2266446b:backend/src/lib/chat/tools/toolSchemas.ts:101-118 (WORKFLOW_TOOLS[1]). */
export const UPSTREAM_NATIVE_READ_WORKFLOW_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_workflow",
    description: "Read the full instructions (prompt) of a workflow by its ID. Call this after list_workflows to load a specific workflow's prompt, then follow those instructions.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID to read"
        }
      },
      required: [
        "workflow_id"
      ]
    }
  }
};

/** The nine Phase-1 native tools, in upstream's exact activation order
 * (streaming.ts:189-194: TOOLS, then WORKFLOW_TOOLS, then PROJECT_EXTRA_TOOLS),
 * minus generate_excel / generate_ppt / replicate_document (Phase 1, D10).
 * Order is load-bearing for reproducibility — same rule as :116-117.
 * sha256(JSON.stringify(...)) === ea440d44c5be6e55ceb3a453252994406c554c9a65295043ea6199d5d13116a4 */
export const UPSTREAM_NATIVE_MIKE_LAB_TOOLS: OpenAIToolSchema[] = [
  UPSTREAM_NATIVE_ASK_INPUTS_TOOL,
  nativeFrozen("read_document"),
  nativeFrozen("find_in_document"),
  UPSTREAM_MIKE_GENERATE_DOCX_TOOL,
  UPSTREAM_NATIVE_EDIT_DOCUMENT_TOOL,
  UPSTREAM_NATIVE_LIST_WORKFLOWS_TOOL,
  UPSTREAM_NATIVE_READ_WORKFLOW_TOOL,
  nativeFrozen("list_documents"),
  nativeFrozen("fetch_documents"),
];

/** The nine tool names in the same order, for the route leak guard and the
 * conformance gate. */
export const UPSTREAM_NATIVE_MIKE_LAB_TOOL_NAMES =
  UPSTREAM_NATIVE_MIKE_LAB_TOOLS.map((tool) => tool.function.name);

/* ------------------------------------------------------------------------
 * TREATMENT mechanisms — two independent, one-flag additions layered on an
 * existing arm's surface. Nothing above this banner is touched: every existing
 * arm hashes those constants, and both mechanisms are inert unless their own
 * env flag is set.
 *
 * They are deliberately separable (future ablation arms will run each alone),
 * so neither constant references the other and the compose helper below takes
 * one boolean per mechanism.
 * ---------------------------------------------------------------------- */

/** Delta tag: the requirements-echo mechanism. */
export const REQUIREMENTS_ECHO_DELTA = "requirements-echo-v1";
/** Delta tag: the citation-contract mechanism. */
export const CITATION_CONTRACT_DELTA = "citation-contract-v1";
/** Delta tag: the composite treatment arm. */
export const MARKDOWN_E2E_TREATMENT_DELTA = "markdown-e2e-treatment-v1";

/**
 * MIKE_REQUIREMENTS_ECHO=1 prompt addition. Mechanism-only: it names a tool and
 * a sequencing rule, and says nothing about any benchmark, task, or rubric.
 */
export const REQUIREMENTS_ECHO_PROMPT_LINE =
  "Before drafting the deliverable, call fetch_requirements once to re-read the task requirements; drafting tools are unavailable until you have.";

/**
 * MIKE_CITATION_CONTRACT=1 prompt addition, verbatim as specified. Describes
 * how to ground assertions; names no benchmark, task content, or rubric.
 */
export const CITATION_CONTRACT_PROMPT_BLOCK = `GROUNDING:
- When the deliverable asserts a fact drawn from a source document (a date, amount, party, obligation, definition, or the presence or absence of a provision), place the exact supporting language beside the assertion as a short verbatim quote (25 words or fewer) with the document name and, where available, the section or heading.
- Quote figures and dates exactly as the source writes them; when a needed value appears verbatim in a source, use that value rather than recalculating it.
- If the deliverable is itself a drafted or revised instrument (contract, agreement, or amendment text), do not add quotes, citation markers, or source annotations to its operative text.
- Never invent a quote. If you cannot locate exact language for an assertion, make the assertion without a quote.`;

/**
 * THE single definition of how the treatment mechanisms compose onto a base
 * prompt.
 *
 * Both the serving route (chat.ts) and the preflight/conformance reproducer
 * (lab-beaver-arm.ts) call this, so the arm's expected system_prompt_sha256 and
 * the served prompt cannot drift apart by construction — the order is fixed
 * here once: scoped-reread clause swap on the base first, then requirements
 * echo, citation contract, and no-deferral appended, each separated from the
 * base and from each other by a blank line. Every mechanism that edits the
 * prompt MUST be an option here rather than a wrapper applied on one side only
 * — the 2026-08-06 CoC re-pilot burned a full run when the clause swap lived
 * outside this helper and only the expectation carried it.
 */
export function withLabTreatmentPromptAdditions(
  base: string,
  options: {
    requirementsEcho: boolean;
    citationContract: boolean;
    citationContractV2?: boolean;
    noDeferral?: boolean;
    scopedReread?: boolean;
  },
): string {
  if (options.citationContract && options.citationContractV2)
    throw new Error(
      "citation contract v1 and v2 are mutually exclusive prompt additions",
    );
  let out = options.scopedReread ? withScopedRereadClause(base) : base;
  if (options.requirementsEcho) out += `\n\n${REQUIREMENTS_ECHO_PROMPT_LINE}`;
  if (options.citationContract) out += `\n\n${CITATION_CONTRACT_PROMPT_BLOCK}`;
  if (options.citationContractV2)
    out += `\n\n${CITATION_CONTRACT_V2_PROMPT_BLOCK}`;
  if (options.noDeferral) out += `\n\n${NO_DEFERRAL_PROMPT_BLOCK}`;
  return out;
}

/**
 * The requirements-echo tool. No required arguments: it re-serves the task's
 * own user message verbatim plus a read/unread split of the allowed documents,
 * so calling it can never depend on the model getting an argument right.
 */
export const FETCH_REQUIREMENTS_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "fetch_requirements",
    description:
      "Re-read the task requirements exactly as the user stated them, together with which of the available documents you have read so far in this response and which you have not. Call this once before drafting the deliverable.",
    parameters: { type: "object", properties: {} },
  },
};

/** e2e tools + fetch_requirements. A separate array so the e2e arm's own tool
 * list — and therefore its tool_schema_sha256 — is unchanged. */
export const MARKDOWN_E2E_TREATMENT_LAB_TOOLS: OpenAIToolSchema[] = [
  ...UPSTREAM_MIKE_MARKDOWN_SWAP_LAB_TOOLS,
  FETCH_REQUIREMENTS_TOOL,
];

/** The treatment arm's base prompt is the e2e arm's, with both mechanisms on. */
export const MARKDOWN_E2E_TREATMENT_LAB_SYSTEM_PROMPT =
  withLabTreatmentPromptAdditions(UPSTREAM_MIKE_LAB_SYSTEM_PROMPT, {
    requirementsEcho: true,
    citationContract: true,
  });

/* ----------------------------------------------------------------------
 * TREATMENT v2 (2026-08-06, docs/lab-treatment-v2-design-2026-08-06.md).
 * The showdown forensics falsified "echo supersedes floor" (the floor arm
 * recovered 7 of the treatment's 11 banking/employment criterion losses)
 * and exposed a reported-vs-recomputed figures defect plus in-quote
 * alteration residue in the v1 contract. v2 = the v1 chassis + the
 * completeness floor + an amended grounding contract. Effort policy is a
 * run config (high), not a prompt delta.
 * ---------------------------------------------------------------------- */

/** Delta tag: the amended citation contract. */
export const CITATION_CONTRACT_V2_DELTA = "citation-contract-v2";
/** Delta tag: the composite v2 treatment arm. */
export const MARKDOWN_E2E_TREATMENT_V2_DELTA = "markdown-e2e-treatment-v2";

/**
 * MIKE_CITATION_CONTRACT_V2=1 prompt addition. Amends v1 with: stated
 * figures reported verbatim and recomputations presented beside them,
 * labeled, never substituted; exact reproduction inside quotation marks
 * with ellipses for omissions and model-authored labels kept unquoted;
 * source named by title or filename; soft 25-word / hard 40-word quote
 * length. Mechanism-only: no benchmark, task, or rubric content.
 */
export const CITATION_CONTRACT_V2_PROMPT_BLOCK = `GROUNDING:
- When the deliverable asserts a fact drawn from a source document (a date, amount, party, obligation, definition, or the presence or absence of a provision), place the exact supporting language beside the assertion as a short verbatim quote (aim for 25 words or fewer; never more than 40) naming the source document by its title or filename and, where available, the section or heading.
- Report figures and dates exactly as the source states them. The deliverable's primary statement of a value that a source states is the source's own wording; if your independent recomputation disagrees with a stated value, present both figures, each labeled as stated or as computed — never substitute a recomputed value for the stated one.
- Inside quotation marks, reproduce the source exactly: never paraphrase, normalize, or reword quoted text, and mark any omission with an ellipsis. Your own labels, summaries, and characterizations belong outside quotation marks.
- If the deliverable is itself a drafted or revised instrument (contract, agreement, or amendment text), do not add quotes, citation markers, or source annotations to its operative text.
- Never invent a quote. If you cannot locate exact language for an assertion, make the assertion without a quote.`;

/**
 * The v2 treatment arm's prompt: the FLOOR base (e2e + completeness check)
 * with the echo line and the v2 grounding block appended by the same
 * helper chat.ts serves through — the sha gate holds by construction.
 */
export const MARKDOWN_E2E_TREATMENT_V2_LAB_SYSTEM_PROMPT =
  withLabTreatmentPromptAdditions(MARKDOWN_E2E_FLOOR_LAB_SYSTEM_PROMPT, {
    requirementsEcho: true,
    citationContract: false,
    citationContractV2: true,
  });

/** Delta tag: the no-deferral directive (TREATMENT mechanism 4). */
export const NO_DEFERRAL_DELTA = "no-deferral-v1";
/** Delta tag: the composite scoped-index treatment arm. */
export const MARKDOWN_E2E_INDEX_TREATMENT_DELTA =
  "markdown-e2e-index-treatment-v1";
/** Delta tag: exposure accounting (MIKE_EXPOSURE_ECHO). The echo's
 * read/unread split counts body exposure instead of tool touches, adds a
 * documents_oriented_only bucket, and arms a one-shot authoring-boundary
 * coverage check. Tool payloads only — no prompt text, so the v2 arm's
 * system_prompt_sha256 equals v1's by construction. */
export const EXPOSURE_ECHO_DELTA = "exposure-echo-v1";
/** Delta tag: the composite scoped-index treatment v2 arm (v1 + exposure
 * accounting). */
export const MARKDOWN_E2E_INDEX_TREATMENT_V2_DELTA =
  "markdown-e2e-index-treatment-v2";

/**
 * MIKE_NO_DEFERRAL=1 prompt addition. Motivated by the CoC index_floor pilot
 * (2026-08-06): 6 of 14 judged misses were the model deferring with
 * "recommend full text review of Section X" language while holding 55k tokens
 * of unused window and a live scoped-read tool. Mechanism-only: a conduct
 * norm; names no benchmark, task, or rubric content.
 */
export const NO_DEFERRAL_PROMPT_BLOCK = `COMPLETE ANALYSIS:
- Do not recommend documents, sections, or passages for further review unless the user explicitly asked for a recommendation of that nature; it is your job to conduct the complete analysis yourself. If a provision matters to the deliverable, read it with the tools and analyze it now, in this same response, rather than flagging it for someone else to read later.`;

/** Draft-time restatement of the same norm, appended to the
 *  fetch_requirements echo payload so it is in view at the moment deferral
 *  language would otherwise be written. */
export const NO_DEFERRAL_ECHO_NOTE =
  "Do not defer: do not recommend documents or passages for further review unless the user explicitly asked for that; if a provision matters, read and analyze it before drafting.";

/** The whole-read anti-re-read clause every mike arm inherits from the
 *  upstream base prompt, byte-exact. Correct discipline for whole-read arms;
 *  in a SCOPED arm it fights the design — multiple windows per document ARE
 *  the intended usage, the harness already enforces true duplicate
 *  suppression via interval-union refusals, and trace mining caught a model
 *  widening a window specifically to honor this clause ("I cannot read doc-1
 *  twice in this response... I should read a large enough window to capture
 *  both sections"). */
export const UPSTREAM_READ_ONCE_CLAUSE =
  "- Read each relevant document/version at most once per response. After read_document or fetch_documents returns a document's full text, do not call either tool again for that same document/version in the same response; use the prior result, call find_in_document for targeted checks, or proceed to the next required tool.";

/** Scoped-arm replacement: forbids re-requesting the SAME bytes, blesses
 *  multiple different windows, and tells the model to size windows to the
 *  section rather than widening one read to avoid a second call. */
export const SCOPED_REREAD_CLAUSE =
  "- Never re-request bytes you already have: once a document's full text or a window has been returned, use the prior result rather than fetching the same span again. Reading several different sections of the same document through separate read_document offset/max_chars windows is normal and expected — size each window to the section you need rather than widening one read to avoid a second call.";

/** Replace the read-once clause for a scoped arm, loudly: if the upstream
 *  base prompt ever changes the clause bytes, composing the arm throws at
 *  module load instead of silently serving the stale contradiction. */
function withScopedRereadClause(base: string): string {
  if (!base.includes(UPSTREAM_READ_ONCE_CLAUSE))
    throw new Error(
      "scoped arm prompt: read-once clause not found in base prompt — upstream wording changed; re-derive SCOPED_REREAD_CLAUSE",
    );
  return base.replace(UPSTREAM_READ_ONCE_CLAUSE, SCOPED_REREAD_CLAUSE);
}

/** Index tools + fetch_requirements — the scoped-index treatment arm's tool
 *  list, mirroring how the server composes it (echo tool appended LAST). A
 *  separate array so the index arms' own tool_schema_sha256 is unchanged. */
export const MARKDOWN_INDEX_TREATMENT_LAB_TOOLS: OpenAIToolSchema[] = [
  ...MARKDOWN_INDEX_LAB_TOOLS,
  FETCH_REQUIREMENTS_TOOL,
];

/**
 * The scoped-index treatment arm's prompt: the INDEX FLOOR base (SECT-INDEX
 * navigation + completeness check) with the echo line, the v2 grounding
 * block, and the no-deferral directive appended by the same helper chat.ts
 * serves through — the sha gate holds by construction.
 */
export const MARKDOWN_E2E_INDEX_TREATMENT_V1_LAB_SYSTEM_PROMPT =
  withLabTreatmentPromptAdditions(MARKDOWN_E2E_INDEX_FLOOR_LAB_SYSTEM_PROMPT, {
    requirementsEcho: true,
    citationContract: false,
    citationContractV2: true,
    noDeferral: true,
    scopedReread: true,
  });
