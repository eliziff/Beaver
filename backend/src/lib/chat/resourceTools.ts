import type { Tool } from "../llm";
import {
  DOCUMENT_OR_DRAFT_PATTERN,
  DOCUMENT_RESOURCE_PATTERN,
  READABLE_RESOURCE_PATTERN,
  RESOURCE_LOCATOR_KINDS,
} from "../resourceReferences";

const tool = (
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[] = [],
  readOnly = true,
): Tool => ({
  name,
  description,
  annotations: { readOnlyHint: readOnly },
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
});

const resource = "A version-pinned document resource returned by Glob.";

export const RESOURCE_TOOLS = [
  tool(
    "Glob",
    'List matching workspace resources when the request requires locating a saved document. Use "workflow://*" for workflows. This does not search legal-source corpora.',
    {
      pattern: {
        type: "string",
        description: 'Filename glob such as "*.docx". Defaults to "*".',
      },
    },
  ),
  tool(
    "Grep",
    "Search document text when the request depends on a saved document. Filter by one resource or a filename glob; return matching resources, counts, or bounded matching lines.",
    {
      pattern: { type: "string", description: "Regular expression to search." },
      path: {
        type: "string",
        pattern: DOCUMENT_RESOURCE_PATTERN,
        description: resource,
      },
      glob: { type: "string", description: 'Filename glob such as "*.docx".' },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Defaults to files_with_matches.",
      },
      "-i": { type: "boolean", description: "Case-insensitive search." },
      "-n": { type: "boolean", description: "Include line numbers; defaults true." },
      "-A": { type: "integer", minimum: 0, maximum: 10 },
      "-B": { type: "integer", minimum: 0, maximum: 10 },
      "-C": { type: "integer", minimum: 0, maximum: 10 },
      head_limit: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
        description: "Maximum returned lines or resources; defaults to 250.",
      },
      section: { type: "string", description: "Exact structural handle." },
    },
    ["pattern"],
  ),
  tool(
    "Read",
    "Read a bounded range from one document resource when the request depends on its contents. Use drafting for semantic DOCX Markdown or redline for visible editorial markup.",
    {
      file_path: {
        type: "string",
        pattern: READABLE_RESOURCE_PATTERN,
        description: resource,
      },
      mode: { type: "string", enum: ["text", "drafting", "redline"] },
      offset: { type: "integer", minimum: 1, maximum: 100_000_000, description: "Starting line." },
      limit: { type: "integer", minimum: 1, maximum: 2000 },
      start_char: { type: "integer", minimum: 0, maximum: 100_000_000 },
      section: { type: "string", description: "Exact structural handle." },
      references: {
        type: "string",
        enum: ["none", "inbound", "outbound", "both"],
        description: "With a section, include its direct internal references.",
      },
      handle: {
        type: "string",
        description: "Evidence handle from an earlier Read of this resource.",
      },
      locator_kind: {
        type: "string",
        enum: [...RESOURCE_LOCATOR_KINDS],
        description: "Kind of exact locator. Use page with a physical PDF page number.",
      },
      locator: {
        type: "string",
        description: "Exact locator value; required with locator_kind (for example, 5 for PDF page 5).",
      },
      end_locator: { type: "string", description: "Optional inclusive range end." },
      context_blocks: { type: "integer", minimum: 0, maximum: 2 },
      page: { type: "integer", minimum: 1 },
      occurrence: { type: "integer", minimum: 1 },
      pattern: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "Literal phrase to locate within a legal-source resource.",
      },
      max_results: { type: "integer", minimum: 1, maximum: 50 },
      context_chars: { type: "integer", minimum: 40, maximum: 2000 },
    },
    ["file_path"],
  ),
  tool(
    "Edit",
    "Replace exact text in the current version-pinned DOCX as tracked changes. old_string must be unique unless replace_all is true; load edit_docx_advanced for structural or formatting operations.",
    {
      file_path: {
        type: "string",
        pattern: DOCUMENT_OR_DRAFT_PATTERN,
        description: resource,
      },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    ["file_path", "old_string", "new_string"],
    false,
  ),
] satisfies Tool[];

function globAlternatives(pattern: string): string[] {
  const match = /\{([^{}]+)\}/u.exec(pattern);
  if (!match?.[1].includes(",")) return [pattern];
  const values = match[1].split(",").map((value) => value.trim());
  return !values.length || values.length > 32 || values.some((value) => !value)
    ? [pattern]
    : values.flatMap((value) => globAlternatives(
        `${pattern.slice(0, match.index)}${value}${pattern.slice(match.index + match[0].length)}`,
      ));
}

const globSource = (pattern: string) => pattern
  .replace(/^(?:\.\/)?(?:\*\*\/)+/u, "")
  .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
  .replace(/\*\*/gu, "\u0000")
  .replace(/\*/gu, "[^/]*")
  .replace(/\?/gu, ".")
  .replace(/\u0000/gu, ".*");

export const globPattern = (pattern = "*") => new RegExp(
  `^(?:${globAlternatives(pattern).map(globSource).join("|")})$`,
  "iu",
);
