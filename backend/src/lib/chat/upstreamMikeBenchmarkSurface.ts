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
