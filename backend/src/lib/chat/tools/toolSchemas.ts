
import { RESOURCE_TOOLS } from "../resourceTools";

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
  ...RESOURCE_TOOLS,
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
              "Document title and filename stem. For a memo, Beaver uses it only as the Re line. Do not repeat it in markdown.",
          },
          document_type: {
            type: "string",
            enum: ["memo", "factum", "letter", "other"],
            description:
              "Document kind. This selects the user's saved deterministic layout and citation style.",
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
              "Document body. #/##/### headings in order; never type automatic heading numbers, and {-} suppresses numbering. A blank line starts a paragraph; one newline is soft; a trailing backslash makes a hard line break. > starts an indented block and \\> prints a literal >. Lists, *italics*, **bold**, pipe tables, native [^note] footnotes, {{field_id}} controls, [@citation_id] grounded citation markers, and <!-- pagebreak --> are supported. For memos, omit the To/From/Date/Re block because Beaver writes it.",
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
          citations: {
            type: "array",
            maxItems: 100,
            description:
              "Grounded citations expanded by matching [@id] markers. Put each marker immediately after the narrowest claim it supports. Beaver supplies citation text, pinpoints, links, placement, numbering, and footnotes.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  description:
                    "Short lowercase identifier used by one or more [@id] markers.",
                },
                evidence_ids: {
                  type: "array",
                  minItems: 1,
                  maxItems: 16,
                  uniqueItems: true,
                  items: { type: "string" },
                  description:
                    "Exact passage evidence_ids returned by legal retrieval tools. Prefer the narrowest paragraph or paragraph range that supports this claim.",
                },
              },
              required: ["id", "evidence_ids"],
            },
          },
          citation_style: {
            type: "string",
            enum: ["footnotes", "inline", "after-paragraph", "none"],
            description:
              "Override saved placement only when the user explicitly requests it. after-paragraph is factum-only.",
          },
          citation_hyperlinks: {
            type: "boolean",
            description:
              "Set false only when the user explicitly requests citations without links.",
          },
          number_headings: {
            type: "boolean",
            description:
              "Override the saved heading-numbering preference only when explicitly requested.",
          },
          memo_header: {
            type: "object",
            additionalProperties: false,
            description:
              "Memo-only custom header override. Omit for the standard To: File, From: AI Assistant, current Date, and Re: title block.",
            properties: {
              to: { type: "string" },
              from: { type: "string" },
              date: { type: "string" },
            },
          },
        },
        required: ["title", "document_type", "markdown"],
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
];

export const ASK_INPUTS_TOOL = TOOLS[0];

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
