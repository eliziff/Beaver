import type { Tool } from "../llm";
import type { DocIndex } from "./types";
import { objectSchema } from "./toolRegistry";
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
  inputSchema: objectSchema(properties, required),
});

const resource = "A version-pinned document resource returned by Glob.";

export const RESOURCE_TOOLS = [
  tool(
    "Glob",
    'List matching workspace resources. Follow next_offset for more matches. Use "workflow://*" for workflows. This does not search legal-source corpora.',
    {
      pattern: {
        type: "string",
        maxLength: 256,
        description: 'Filename glob such as "*.docx". Defaults to "*".',
      },
      offset: { type: "integer", minimum: 1, description: "First matching row; defaults to 1." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum rows; defaults to 50." },
    },
  ),
  tool(
    "Grep",
    "Search document text when the request depends on a saved document. Filter by one resource or a filename glob; return matching resources, counts, or bounded matching lines.",
    {
      pattern: { type: "string", maxLength: 256, description: "Regular expression to search." },
      path: {
        type: "string",
        pattern: DOCUMENT_RESOURCE_PATTERN,
        description: resource,
      },
      glob: { type: "string", maxLength: 256, description: 'Filename glob such as "*.docx".' },
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
    "Read a document, legal source, saved evidence_id or query_id. A run of paragraphs is one call: give locator and end_locator, and every unit in the run returns its own evidence_id, so never read a run one unit per call. To find where a source you already hold says something, Read it with pattern instead of searching again. Reuse the passages and evidence_ids you hold; request independent reads together. Follow returned next inputs for more text, and read within the returned extent rather than probing past it. List prior receipts with file_path evidence or queries, selected inputs with selection, or saved chat and table results with findings. Use drafting for semantic DOCX Markdown or redline for editorial markup.",
    {
      file_path: {
        type: "string",
        pattern: READABLE_RESOURCE_PATTERN,
        description: "Resource from Glob or search_sources, a saved evidence_id or query_id, or selection/findings.",
      },
      mode: { type: "string", enum: ["text", "drafting", "redline"] },
      offset: { type: "integer", minimum: 1, maximum: 100_000_000, description: "Starting line or item." },
      limit: { type: "integer", minimum: 1, maximum: 2000 },
      start_char: { type: "integer", minimum: 0, maximum: 100_000_000 },
      section: { type: "string", description: "Exact structural handle, or the section returned by a findings read." },
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
        description: "Use paragraph or section for legal text. Use page only for a known physical PDF page or an existing reporter-page label.",
      },
      locator: {
        type: "string",
        description: "First unit to read: 58 for paragraph 58, 5 for PDF page 5, or a section label.",
      },
      end_locator: { type: "string", description: "Last unit of the run, inclusive: locator 58 with end_locator 63 reads paragraphs 58 to 63 in one call." },
      context_blocks: { type: "integer", minimum: 0, maximum: 2, description: "Neighbouring units returned on each side of the run." },
      page: { type: "integer", minimum: 1 },
      occurrence: { type: "integer", minimum: 1 },
      pattern: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "Literal phrase to find inside the source; each hit returns its unit's evidence_id. Or an exact support ID returned by a findings read.",
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
  const queue = [pattern], result: string[] = [];
  while (queue.length) {
    const current = queue.pop()!, match = /\{([^{}]+)\}/u.exec(current);
    if (!match?.[1].includes(",")) { result.push(current); continue; }
    const values = match[1].split(",").map((value) => value.trim());
    if (values.some((value) => !value) || result.length + queue.length + values.length > 32)
      return [pattern];
    queue.push(...values.map((value) =>
      `${current.slice(0, match.index)}${value}${current.slice(match.index + match[0].length)}`));
  }
  return result;
}

const globSource = (pattern: string) => pattern
  .replace(/^(?:\.\/)?(?:\*\*\/)+/u, "")
  .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
  .replace(/\*\*/gu, "\u0000")
  .replace(/\*/gu, "[^/]*")
  .replace(/\?/gu, ".")
  .replace(/\u0000/gu, ".*");

export function availableDocumentsPrompt(docIndex: DocIndex,
  records: ReadonlyMap<string, Record<string, unknown>>, selectedIds: readonly string[] = []) {
  const entries = Object.entries(docIndex);
  if (!entries.length) return "";
  const selected = new Set(selectedIds), header = `AVAILABLE DOCUMENTS (${entries.length}):`,
    footer = "Names and inventory may be shortened. Use Glob to find all matches or resolve a doc-N alias, then Read the versioned resource.",
    lines: string[] = [];
  let chars = header.length + footer.length + 2;
  for (const [alias, info] of [...entries.filter(([, info]) => selected.has(info.document_id)),
    ...entries.filter(([, info]) => !selected.has(info.document_id))]) {
    const focused = selected.has(info.document_id),
      path = focused ? "" : String(records.get(info.document_id)?.folder_path ?? "").slice(0, 100),
      line = `- ${alias}: ${path ? `${path} / ` : ""}${info.filename.slice(0, focused ? 120 : 160)}`;
    if (chars + line.length + 1 > 8_000) break;
    lines.push(line); chars += line.length + 1;
  }
  return [header, ...lines, footer].join("\n");
}

export const globPattern = (pattern = "*") => {
  if (pattern.length > 256) throw new Error("Glob pattern exceeds 256 characters.");
  return new RegExp(`^(?:${globAlternatives(pattern).map(globSource).join("|")})$`, "iu");
};
