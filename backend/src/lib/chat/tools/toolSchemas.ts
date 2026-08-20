import type { Tool } from "../../llm";
import { DOCUMENT_OR_DRAFT_PATTERN } from "../../resourceReferences";

const object = (
  properties: Record<string, object>,
  required: string[] = [],
) => ({
  type: "object" as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const TABULAR_TOOLS: Tool[] = [{
  name: "read_table_cells",
  annotations: { readOnlyHint: true },
  description:
    "Read extracted cells from the tabular review. Pass zero-based column or row indices for a subset; omit either to read all.",
  inputSchema: object({
    col_indices: { type: "array", items: { type: "integer" } },
    row_indices: { type: "array", items: { type: "integer" } },
  }),
}];

export const ASK_INPUTS_TOOL: Tool = {
  name: "ask_inputs",
  description:
    "Stop and ask for genuine blockers only: an instruction only the user can give or a missing document. Ask every blocker at once, then wait.",
  inputSchema: object({
    items: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: object({
        id: { type: "string", description: "Unique short id." },
        kind: { type: "string", enum: ["choice", "documents"] },
        question: { type: "string", description: "Question for a choice." },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: object({ value: { type: "string" } }, ["value"]),
        },
        document_types: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string" },
        },
      }, ["id", "kind"]),
    },
  }, ["items"]),
};

export const WRITE_TOOL: Tool = {
  name: "Write",
  annotations: { readOnlyHint: false, destructiveHint: false },
  description:
    "Create one durable .docx, .xlsx, or .pptx artifact from concise semantic markup. The filename extension selects the deterministic renderer; returns an artifact handle, not the document body.",
  inputSchema: object({
    filename: {
      type: "string",
      description: "Artifact filename ending in .docx, .xlsx, or .pptx.",
    },
    content: {
      type: "string",
      description:
        "For DOCX: Beaver Markdown with headings, lists, pipe tables, native [^note] footnotes, {{field_id}} controls, [@citation_id] evidence markers, and <!-- pagebreak -->. Reuse a field id wherever one value repeats. For XLSX: # workbook title, ## sheet names, then one pipe table per sheet. For PPTX: # deck title, ## slide titles, bullets, and an optional fenced notes block labelled notes.",
    },
    document_type: {
      type: "string",
      enum: ["memo", "factum", "letter", "other"],
      description: "DOCX only; defaults to other.",
    },
    landscape: { type: "boolean", description: "DOCX only." },
    fields: {
      type: "array",
      maxItems: 100,
      description:
        "DOCX initial values for {{field_id}} markers. Every occurrence of one id shares the same Word value.",
      items: object({
        id: { type: "string" },
        value: { type: "string" },
      }, ["id", "value"]),
    },
    citations: {
      type: "array",
      maxItems: 100,
      description:
        "DOCX evidence bindings for [@id] markers; use the narrowest visible evidence blocks supporting that unit.",
      items: object({
        id: { type: "string" },
        evidence_ids: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: "string" },
        },
      }, ["id", "evidence_ids"]),
    },
    citation_style: {
      type: "string",
      enum: ["footnotes", "inline", "after-paragraph", "none"],
      description: "DOCX only; override only when explicitly requested.",
    },
    citation_hyperlinks: { type: "boolean", description: "DOCX only." },
    number_headings: { type: "boolean", description: "DOCX only." },
    memo_header: {
      ...object({
        to: { type: "string" },
        from: { type: "string" },
        date: { type: "string" },
      }),
      description: "DOCX memo only.",
    },
  }, ["filename", "content"]),
};

const ADVANCED_OPS = [
  "uppercase", "lowercase", "sentence_case", "capitalize_each_word",
  "toggle_case", "title_case", "replace_text", "insert_blocks",
  "sentence_spacing", "check_spelling", "straighten_quotes", "curl_quotes",
  "collapse_double_spaces", "normalize_dashes", "normalize_ellipses",
  "nonbreaking_section_refs", "remove_trailing_whitespace",
];

export const ADVANCED_DOCX_EDIT_TOOL: Tool = {
  name: "edit_docx_advanced",
  annotations: { readOnlyHint: false, destructiveHint: false },
  description:
    "Apply deterministic structural or mechanical DOCX operations as tracked changes. Load only when ordinary exact-text Edit is insufficient.",
  inputSchema: object({
    file_path: {
      type: "string",
      pattern: DOCUMENT_OR_DRAFT_PATTERN,
      description: "Current version-pinned DOCX resource returned by Glob.",
    },
    ops: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: object({
        op: { type: "string", enum: ADVANCED_OPS },
        scope: object({
          kind: {
            type: "string",
            enum: ["whole_document", "at", "find_text", "range"],
          },
          at: { type: "string" },
          follow: { type: "string", enum: ["none", "out", "in", "both"] },
          depth: { type: "integer", minimum: 1, maximum: 3 },
          text: { type: "string" },
          occurrence: { type: "integer", minimum: 1 },
          from_text: { type: "string" },
          to_text: { type: "string" },
        }, ["kind"]),
        find: { type: "string" },
        replace: { type: "string" },
        blocks: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string" },
        },
        position: { type: "string", enum: ["before", "after"] },
        match_case: { type: "boolean" },
        whole_word: { type: "boolean" },
        occurrence: { type: "integer", minimum: 1 },
        style: { type: "string" },
      }, ["op", "scope"]),
    },
  }, ["file_path", "ops"]),
};
