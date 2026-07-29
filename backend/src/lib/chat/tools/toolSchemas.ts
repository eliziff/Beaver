export const PROJECT_EXTRA_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_documents",
      description:
        "List all documents available in the project. Returns each document's ID, filename, type, lightweight metadata/notes, and deterministic Beaver app_url. Call this to discover what documents are available before deciding which ones to read.",
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
];

export const TABULAR_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_table_cells",
      description:
        "Read the extracted cell content and Beaver app_url from the tabular review. Each cell contains the value extracted for a specific column from a specific document. Pass col_indices and/or row_indices (0-based) to read a subset; omit either to read all columns or all rows.",
      parameters: {
        type: "object",
        properties: {
          col_indices: {
            type: "array",
            items: { type: "integer" },
            description:
              "0-based column indices to read (e.g. [0, 2]). Omit to read all columns.",
          },
          row_indices: {
            type: "array",
            items: { type: "integer" },
            description:
              "0-based document (row) indices to read (e.g. [0, 1]). Omit to read all rows.",
          },
        },
      },
    },
  },
];

export const WORKFLOW_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_workflows",
      description:
        "List all workflows available to the user. Returns each workflow's ID, title, and deterministic Beaver app_url. Call this when the user asks to run a workflow, apply a template, or you need to discover what workflows exist.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_workflow",
      description:
        "Read the full instructions (prompt) of a workflow by its ID. Call this after list_workflows to load a specific workflow's prompt, then follow those instructions.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "The workflow ID to read",
          },
        },
        required: ["workflow_id"],
      },
    },
  },
];

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "ask_inputs",
      description:
        "Stop the turn and ask the user only for what blocks the work. A blocker is an instruction only the user can give, or a document that was never provided, where proceeding would produce work that is wrong or wasted. Ambiguity you can resolve on the most reasonable reading is not a blocker: proceed, and state the assumption in your answer. Never ask the user to confirm an instruction already given, or for permission to do the work requested. Put every blocking question in one items array, then stop and wait.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description:
              "The list of user inputs needed before continuing. Use choice items for decisions/clarifications and documents items for required uploads.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable short ID for this input, unique within this tool call.",
                },
                kind: {
                  type: "string",
                  enum: ["choice", "documents"],
                },
                question: {
                  type: "string",
                  description:
                    "For choice items only: the concise question to show to the user.",
                },
                options: {
                  type: "array",
                  description:
                    "For choice items only: selectable choices to show. Each choice has a single user-facing value, which is also sent back if selected.",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      value: {
                        type: "string",
                        description: "The user-facing choice text.",
                      },
                    },
                    required: ["value"],
                  },
                },
                allow_other: {
                  type: "boolean",
                  description:
                    "For choice items only: whether to show an Other option with a text field. Defaults to true.",
                },
                other_label: {
                  type: "string",
                  description:
                    "For choice items only: label for the free-text option. Defaults to Other.",
                },
                document_types: {
                  type: "array",
                  description:
                    "For documents items only: readable labels for the types of documents you need the user to attach.",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "string",
                  },
                },
                response_prefix: {
                  type: "string",
                  description:
                    "Optional prefix the UI should include when sending this response back as the next message.",
                },
              },
              required: ["id", "kind"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read a document attached by the user. Use mode=drafting once when adapting a DOCX precedent; it returns bounded structure-preserving HTML so you can choose headings, genericize matter-specific terms as {{fields}}, preserve native note pairing, and call generate_docx. Otherwise use text mode before analysing, citing, or editing.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to read (e.g. 'doc-0', 'doc-1')",
          },
          mode: {
            type: "string",
            enum: ["text", "drafting"],
            description:
              "Defaults to text. Drafting is DOCX-only and returns version/hash-bound semantic HTML as untrusted document data.",
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
  {
    type: "function",
    function: {
      name: "generate_docx",
      description:
        "Create a durable Word document from concise semantic Markdown. Use this for requested agreements, contracts, memos, briefs, letters, and other drafts; return the artifact instead of dumping the full draft in chat. Word styling, numbering, footnote mechanics, fields, and OOXML are deterministic.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Document title, rendered once and also used for the filename. Do not repeat it in markdown.",
          },
          landscape: {
            type: "boolean",
            description:
              "Set to true for landscape page orientation. Default is portrait.",
          },
          markdown: {
            type: "string",
            description:
              "Document body. Use #, ##, or ### for heading hierarchy. The renderer numbers plain headings; do not also type a number. For a fixed legal label such as 'Part 1' or '1. Definitions', include that label and the renderer will not add another. Put {-} at the end of the same heading line to suppress numbering, never on its own line. Put every (a), (b), or nested list item on its own line and indent nested items by two spaces. Ordinary paragraphs, *italics*, **bold**, lists, and simple pipe tables are supported. Use labelled lines and {{field_id}} controls for signatures, not a pipe table. Put [^1] where a native Word footnote belongs and define it with [^1]: text. Use lowercase {{field_id}} for an editable field; capitalization and surrounding spaces are normalized, while malformed markers fail. A marker alone on its line becomes a rich editable clause. Use <!-- pagebreak --> only for an intentional page break.",
          },
          fields: {
            type: "array",
            maxItems: 100,
            description:
              "Optional initial values for {{field_id}} markers. Omit unresolved fields for a labelled Word placeholder; empty values are allowed. An id without a matching marker fails.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable lowercase field identifier used by a {{field_id}} marker.",
                },
                value: {
                  type: "string",
                  description:
                    "Initial text placed in the native Word content control.",
                },
              },
              required: ["id", "value"],
            },
          },
          sources: {
            type: "array",
            maxItems: 100,
            description:
              "Optional verified legal sources expanded by [@source_id] markers. The generator creates the link and ordered pinpoints; write the marker once instead of repeating the citation for each pinpoint.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable lowercase identifier used by one or more [@source_id] markers.",
                },
                citation: {
                  type: "string",
                  description:
                    "Visible citation text without a URL or repeated pinpoint list.",
                },
                handles: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "One to sixteen ordered evidence handles returned by exact legal-source lookups.",
                },
                source_reference: {
                  type: "string",
                  description:
                    "Required only for cached provider-PDF evidence: the SHA-qualified mike-provider-pdf source_reference returned with the handle.",
                },
                quotes: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional exact quote per handle. Omit when the evidence unit itself identifies the pinpoint.",
                },
              },
              required: ["id", "citation", "handles"],
            },
          },
        },
        required: ["title", "markdown"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_excel",
      description:
        "Generate an Excel (.xlsx) workbook from structured sheet data. Use this when the user asks for a spreadsheet, tracker, matrix, checklist, schedule, or Excel file. Returns a download URL for the generated file.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Workbook title, used as the filename.",
          },
          sheets: {
            type: "array",
            description:
              "Workbook sheets. Each sheet has a name, columns, and rows. Row values should follow the columns order.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Sheet tab name. Keep it short.",
                },
                columns: {
                  type: "array",
                  items: { type: "string" },
                  description: "Column header labels.",
                },
                rows: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: "string" },
                  },
                  description:
                    "Array of rows, each row an array of cell strings matching the columns order.",
                },
              },
              required: ["name", "columns", "rows"],
            },
          },
        },
        required: ["title", "sheets"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_ppt",
      description:
        "Generate a PowerPoint (.pptx) presentation from structured slides. Use this when the user asks for slides, a deck, presentation, or PowerPoint file. Returns a download URL for the generated file.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Presentation title, used as the filename.",
          },
          slides: {
            type: "array",
            description:
              "Slides in order. Each slide may have a title, bullets, and optional speaker notes.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Slide title.",
                },
                bullets: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Main bullet points for the slide. Keep each bullet concise.",
                },
                notes: {
                  type: "string",
                  description:
                    "Optional speaker notes. Included as text on a notes slide placeholder is not supported; use only for generation context.",
                },
              },
              required: ["title", "bullets"],
            },
          },
        },
        required: ["title", "slides"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_document",
      description:
        "Apply requested edits, revisions, or redlines to a user-attached .docx as tracked changes and return the edited Word artifact. Use this for action requests instead of replying with proposed or suggested changes in prose. Each edit is a precise, minimal substitution of specific words/characters, NOT a whole-line or paragraph replacement. Use read_document first unless this same document/version has already been read in the current response. Anchor each edit with short before/after context so it can be located unambiguously. Returns per-edit annotations the UI will render as Accept/Reject cards and a download link to the edited document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "Document slug (e.g. 'doc-0').",
          },
          edits: {
            type: "array",
            description: "List of precise substitutions.",
            items: {
              type: "object",
              properties: {
                find: {
                  type: "string",
                  description:
                    "Exact substring to replace (keep it as short as possible — ideally just the words/chars being changed).",
                },
                replace: {
                  type: "string",
                  description:
                    "Replacement text. Empty string = pure deletion.",
                },
                context_before: {
                  type: "string",
                  description:
                    "~40 chars immediately preceding `find`, used to disambiguate.",
                },
                context_after: {
                  type: "string",
                  description: "~40 chars immediately following `find`.",
                },
                reason: {
                  type: "string",
                  description:
                    "Short explanation shown to the user on the card.",
                },
              },
              required: ["find", "replace", "context_before", "context_after"],
            },
          },
        },
        required: ["doc_id", "edits"],
      },
    },
  },
];

export const TEXT_OPS_TOOLS = [
  {
    type: "function",
    function: {
      name: "library_apply_text_ops",
      description:
        "Apply deterministic mechanical text operations to a local Library DOCX as native tracked changes: change case, find/replace, sentence spacing, quote/dash/ellipsis normalization, whitespace cleanup, and a flag-only spelling review. The server resolves the scope against the pinned version and executes the transform itself - NEVER retype, quote back, or re-supply document text for these transforms, and never use library_revise_docx for them. Returns a new version with per-change Accept/Reject cards plus per-op replacement counts and skipped-site notes for anything left unchanged. check_spelling only reports; corrections happen through explicit replace_text calls.",
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "Exact document_id returned by library_list.",
          },
          version_id: {
            type: "string",
            description:
              "Optional exact Library version id. Omit for the active version; a non-active version fails without changing the document.",
          },
          ops: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description:
              "Operations applied in order. All scopes are resolved once against the pinned version's text before any change; two ops may not touch the same characters.",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: [
                    "uppercase",
                    "lowercase",
                    "sentence_case",
                    "capitalize_each_word",
                    "toggle_case",
                    "title_case",
                    "replace_text",
                    "sentence_spacing",
                    "check_spelling",
                    "straighten_quotes",
                    "curl_quotes",
                    "collapse_double_spaces",
                    "normalize_dashes",
                    "normalize_ellipses",
                    "nonbreaking_section_refs",
                    "remove_trailing_whitespace",
                  ],
                  description:
                    "Case ops mirror Word's Change Case menu plus conventional title_case (small words lowercased unless first/last, acronyms preserved). replace_text is Word-style find/replace over the scope. check_spelling NEVER changes text: it reports possible misspellings (Canadian English dictionary) with context and suggestions; to correct one, make a follow-up call using replace_text with that exact word.",
                },
                scope: {
                  type: "object",
                  description:
                    "Where the op applies. whole_document; find_text (that exact text, every occurrence unless occurrence is given); or range (from the start of from_text through the end of to_text).",
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["whole_document", "find_text", "range"],
                    },
                    text: {
                      type: "string",
                      description:
                        "find_text only: exact text copied from the document.",
                    },
                    occurrence: {
                      type: "integer",
                      minimum: 1,
                      description:
                        "find_text only: 1-based occurrence. Omit to scope every occurrence.",
                    },
                    from_text: {
                      type: "string",
                      description: "range only: exact text where the scope starts.",
                    },
                    to_text: {
                      type: "string",
                      description:
                        "range only: exact text where the scope ends (first occurrence after from_text).",
                    },
                  },
                  required: ["kind"],
                },
                find: {
                  type: "string",
                  description: "replace_text only: literal text to find.",
                },
                replace: {
                  type: "string",
                  description:
                    "replace_text only: replacement text. Empty string deletes the match.",
                },
                match_case: {
                  type: "boolean",
                  description:
                    "replace_text only: exact-case matching. Defaults to false, like Word.",
                },
                whole_word: {
                  type: "boolean",
                  description:
                    "replace_text only: match whole words only. Defaults to false.",
                },
                occurrence: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "replace_text only: replace just the Nth match within the scope. Omit to replace every match.",
                },
                style: {
                  type: "string",
                  description:
                    'sentence_spacing: "one" or "two" spaces after sentence-ending punctuation. normalize_ellipses: "character" (... becomes the single … character, default) or "periods" (the reverse).',
                },
              },
              required: ["op", "scope"],
            },
          },
        },
        required: ["document_id", "ops"],
      },
    },
  },
];
