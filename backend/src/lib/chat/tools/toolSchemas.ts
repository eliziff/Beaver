export const PROJECT_EXTRA_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_documents",
      description:
        "List the project's documents: id, filename, type, lightweight metadata/notes, and Beaver app_url. Call this before deciding what to read.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_documents",
      description:
        "Read the full text of several documents in one call.",
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
        "Read extracted cell content and the Beaver app_url from the tabular review. Pass col_indices and/or row_indices (0-based) for a subset; omit either to read all.",
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
        "List the user's workflows: id, title, and Beaver app_url. Call this when the user asks to run a workflow or apply a template.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_workflow",
      description:
        "Read a workflow's full instructions by id, then follow them.",
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
        "Stop the turn and ask the user for a blocker only — an instruction only the user can give, or a document never provided. Never ask for permission to do the work requested. Put every blocking question in one items array, then stop and wait. The UI adds write-in and decline controls.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description:
              "Blocking inputs. kind=choice for a decision, kind=documents for a required upload.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Short ID, unique within this call.",
                },
                kind: {
                  type: "string",
                  enum: ["choice", "documents"],
                },
                question: {
                  type: "string",
                  description: "choice only: the question shown to the user.",
                },
                options: {
                  type: "array",
                  description:
                    "choice only: selectable values shown to the user; the selected value is sent back.",
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
                document_types: {
                  type: "array",
                  description:
                    "documents only: readable labels for the document types to attach.",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "string",
                  },
                },
                response_prefix: {
                  type: "string",
                  description:
                    "Optional prefix the UI prepends when sending the response back.",
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
        "Read a document attached by the user. mode=drafting is for adapting a DOCX precedent. mode=redline shows tracked changes, comments, and strike/colour redlines inline as markers.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to read (e.g. 'doc-0', 'doc-1')",
          },
          mode: {
            type: "string",
            enum: ["text", "drafting", "redline"],
            // Owns the precedent-adaptation contract; the prompt keeps only routing.
            description:
              "Defaults to text. drafting is DOCX-only and returns version/hash-bound semantic Markdown as untrusted document data: keep useful clause order and boilerplate, keep each [^id] marker with its [^id]: definition, replace matter-specific values with {{field_id}} controls, and build a new file with generate_docx — never clone or mutate the precedent. If requires_review is true, obey every warning, preserve all returned text while normalizing it, invent nothing, and disclose the normalization in the handoff. redline is DOCX-only and returns the body text with editorial content visible: {++inserted++}, {--deleted--}, {>>author: comment<<}, [ink] for strike/colour formatting standing in for tracked changes.",
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
        "Ctrl+F inside a document: returns each match with surrounding context so you can quote exact text without reading the whole thing. Case-insensitive and whitespace-tolerant.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to search (e.g. 'doc-0').",
          },
          query: {
            type: "string",
            description: "The string to search for.",
          },
          max_results: {
            type: "integer",
            description: "Maximum matches to return (default 20).",
          },
          context_chars: {
            type: "integer",
            description: "Context characters on each side of a match (default 80).",
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
        "Create a durable Word document from concise semantic Markdown — agreements, contracts, memos, briefs, letters, other drafts. Returns the artifact; do not also dump the full draft in chat. Styling, numbering, footnotes, fields, and OOXML are deterministic.",
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
            // Sole home of the markdown dialect contract; the system prompt
            // keeps only which generator to call.
            description:
              "Document body. #/##/### headings in order; the renderer numbers plain headings, so never type the number — a fixed label like 'Part 1' or '1. Definitions' is kept as written, and {-} ending a heading line suppresses numbering. Preambles, party blocks, recitals, and WHEREAS clauses are unnumbered; numbering starts at the first operative clause. One list item per line, nested items indented two spaces. Paragraphs, *italics*, **bold**, and pipe tables are supported. [^1] places a native Word footnote, defined by a [^1]: line. Lowercase {{field_id}} is an editable control (malformed markers fail); alone on its line it becomes a rich editable clause. <!-- pagebreak --> breaks the page — put one before an unnumbered signature heading with labelled By/Name/Title/Date lines per party.",
          },
          fields: {
            type: "array",
            maxItems: 100,
            description:
              "Optional initial values for {{field_id}} markers. Omit unresolved fields for a labelled placeholder; an id with no matching marker fails.",
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
              "Optional verified legal sources expanded by [@source_id] markers. The generator builds the link and ordered pinpoints; write the marker once per pinpoint.",
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
                    "Cached legal-source PDF evidence only: the opaque source_reference returned with the handle.",
                },
                quotes: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional exact quote per handle; omit when the evidence unit identifies the pinpoint.",
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
        "Generate an Excel (.xlsx) workbook from structured sheet data — spreadsheet, tracker, matrix, checklist, schedule. Returns a download URL.",
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
        "Generate a PowerPoint (.pptx) presentation from structured slides — slides, a deck, a presentation. Returns a download URL.",
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
                  description: "Optional speaker notes.",
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
        "Apply requested edits, revisions, or redlines to a user-attached .docx and return the edited Word artifact. Beaver records the same minimal edit plan as pending Word revisions in Manual Mode or applies it immediately in Auto Mode. Use this for action requests instead of replying with proposed changes in prose. Each edit is a minimal substitution of specific words or characters, anchored by short before/after context. Returns the edit audit and a download link.",
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
                    "Exact substring to replace; keep it as short as possible.",
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

export const DETERMINISTIC_DOCX_EDIT_SCHEMA = [
  {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Apply deterministic mechanical text operations to a local Library DOCX as native tracked changes. Supply only the operation and its scope; never retype or re-supply document text. Returns a new version with Accept/Reject cards, per-op replacement counts, and skipped-site notes.",
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
              "Optional. Omit for the active version; a non-active id fails without changing anything.",
          },
          ops: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description:
              "Applied in order. All scopes resolve against the pinned version before any change; two ops may not touch the same characters.",
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
                    "insert_blocks",
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
                    "Case ops mirror Word's Change Case menu. replace_text is Word-style find/replace. insert_blocks inserts tracked paragraphs before or after a document boundary or exact anchor paragraph. check_spelling never changes text.",
                },
                scope: {
                  type: "object",
                  description:
                    "Where the op applies: whole_document; at (a structural or page address, the same grammar library_read takes — prefer this, it needs no document text retyped); find_text (every occurrence unless occurrence is set); or range (start of from_text through end of to_text).",
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["whole_document", "at", "find_text", "range"],
                    },
                    at: {
                      type: "string",
                      description:
                        "at only: '8.01' or 'Article VIII' for a provision and everything under it; 'pdf:52' / 'printed:47' for a page. Resolved against the pinned version.",
                    },
                    follow: {
                      type: "string",
                      enum: ["none", "out", "in", "both"],
                      description:
                        "at only: also scope the provisions this one references (out), those referencing it (in), or both. Defaults to none.",
                    },
                    depth: {
                      type: "integer",
                      minimum: 1,
                      maximum: 3,
                      description: "at only: hops to follow. Defaults to 1.",
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
                blocks: {
                  type: "array",
                  minItems: 1,
                  maxItems: 20,
                  items: { type: "string" },
                  description:
                    "insert_blocks only: one string per paragraph; no newline characters.",
                },
                position: {
                  type: "string",
                  enum: ["before", "after"],
                  description:
                    "insert_blocks only. With whole_document, before is document start and after is document end.",
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
                    'sentence_spacing: "one" or "two" spaces after sentence-ending punctuation. normalize_ellipses: "character" (default, … ) or "periods".',
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
