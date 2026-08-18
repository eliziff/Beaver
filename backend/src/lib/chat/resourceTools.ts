import type { Tool } from "../llm";
import { RESOURCE_LOCATOR_KINDS } from "../resourceReferences";

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

const resource = "A document resource returned by Glob, or a unique filename.";

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
      path: { type: "string", description: resource },
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
      file_path: { type: "string", description: resource },
      mode: { type: "string", enum: ["text", "drafting", "redline"] },
      offset: { type: "integer", minimum: 1, description: "Starting line." },
      limit: { type: "integer", minimum: 1, maximum: 2000 },
      start_char: { type: "integer", minimum: 0 },
      section: { type: "string", description: "Exact structural handle." },
      pages: {
        type: "string",
        description: "Exact PDF or printed-page selector, such as 12-14.",
      },
      references: {
        type: "string",
        enum: ["none", "inbound", "outbound", "both"],
        description: "With a section, include its direct internal references.",
      },
      handle: {
        type: "string",
        description: "Evidence handle from an earlier Read of this resource.",
      },
      locator_kind: { type: "string", enum: [...RESOURCE_LOCATOR_KINDS] },
      locator: { type: "string", description: "Exact native locator." },
      end_locator: { type: "string", description: "Optional inclusive range end." },
      context_blocks: { type: "integer", minimum: 0, maximum: 2 },
      page: { type: "integer", minimum: 1 },
      occurrence: { type: "integer", minimum: 1 },
    },
    ["file_path"],
  ),
  tool(
    "Edit",
    "Replace exact text in the current version-pinned DOCX as tracked changes. old_string must be unique unless replace_all is true; load edit_docx_advanced for structural or formatting operations.",
    {
      file_path: { type: "string", description: resource },
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
