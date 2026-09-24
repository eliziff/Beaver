import { createWordEditApplication } from "../wordEditApplication";
import { DOCUMENT_OR_DRAFT_PATTERN } from "../resourceReferences";
import type { AssistantToolsDependencies } from "./assistantTools";
import type { ChatToolContext } from "./turnEngine";
import { objectSchema, toolText, type BeaverTool } from "./toolRegistry";

type Dependencies = Parameters<typeof createWordEditApplication>[0] & Pick<AssistantToolsDependencies, "artifactFor" | "resolveArtifact">;

const HELP = `A program is Python statements run top to bottom as a function body (no def needed); return a small JSON-serializable value (print output is returned too).
doc is the python-docx 1.2 Document of the current version. Any OOXML is reachable with lxml: paragraph._p, table._tbl, run._r, qn(), OxmlElement(), parse_xml(). No network, subprocesses or files outside the document.
inspect without program pages the body: b=block, p=doc.paragraphs index, t=doc.tables index, style, text, list, sections. target 'paragraph:N' | 'table:N' | 'section:N' | 'styles' | 'part:word/<name>.xml' shows detail and XML. inspect with program is read-only.
preview runs the program on the current document and saves a verified candidate without changing it; apply with file_path set to that candidate publishes its exact bytes to the original.
Review mode (the user's setting) records every change as a native Word revision: edit normally; removed, inserted or moved content and changed paragraph, run, table, row and section properties become w:del/w:ins/w:*PrChange. Pending revisions compose: edit the accepted text, including earlier insertions, normally. Style definitions and existing list definitions cannot be tracked, so those edits fail in Review mode; use direct formatting or a new list. Rejecting all revisions must reproduce the source.
paragraph.text reads the accepted view; assigning it replaces every run and its formatting, so prefer replace_text.
Helpers:
text(obj); find(needle, container=None, regex=False) -> [Paragraph] (body and table cells); isolate(p, needle, occurrence=0) -> [Run] covering exactly needle
replace_text(p, old, new, count=0); delete(paragraph|table|row|run); insert_paragraph_after(anchor, text='', style=None); insert_table_after(anchor, rows, cols, style=None); move_after(obj, anchor)
numbered_list(paragraphs or [(p, level)], kind='decimal'|'legal'|'bullet'|'upperLetter'|'lowerLetter'|'upperRoman', start=1) makes ONE list across the items -> numId
section_range(first, last, start='new_page'|'continuous'|'odd_page') -> Section for exactly those blocks; set_page(section, orientation='landscape', size='letter'|'legal'|'a4'|(w_mm, h_mm), margins_mm=20 or {top, bottom, left, right, header, footer}, columns=2)
add_field(p, 'PAGE'|'NUMPAGES'|'DATE \\@ "d MMMM yyyy"'|'REF name \\h', result=''); add_toc(anchor, levels='1-3', title='Contents'); page_numbers(section, 'Page {PAGE} of {NUMPAGES}', align='center', where='footer')
add_footnote(p, text, after=None, kind='footnote'|'endnote'); content_control(paragraph or runs, tag=None, alias=None); xml(obj)
Native python-docx covers the rest: doc.add_comment(isolate(p, 'phrase'), text='...', author='Beaver'); doc.styles['Normal'].font.name = 'Arial'; p.style = 'Heading 1'; run.bold = True; p.paragraph_format.page_break_before = True; table.cell(r, c).text; section.header; doc.sections.
Examples:
p = find('within 30 days')[0]; replace_text(p, '30 days', '45 days')
t = insert_table_after(find('fees are set out')[0], 3, 3, style='Table Grid'); t.cell(0, 0).text = 'Item'
set_page(section_range(t, t), orientation='landscape', margins_mm=15)
numbered_list([p for p in doc.paragraphs if p.style.name == 'Heading 1'], 'legal')
Preview receipts summarize changed blocks, sections, styles, lists and revision counts; inspect the candidate for detail.`;

/** word_python: model-written python-docx/lxml programs, verified candidates and exact-byte publication. */
export function createWordPythonTool(options: Dependencies): BeaverTool<ChatToolContext> {
  const run = createWordEditApplication(options);
  return {
    name: "word_python", specialist: true, sequential: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    activity: input => input.action === "apply" ? "Publishing reviewed Word candidate" : "Inspecting or editing Word structures",
    description: "Rich Word document editing with Python (python-docx + lxml) without Microsoft Word. Use Read/Edit/Write for ordinary content. " +
      "help returns the programming API. inspect pages paragraphs, tables and sections (or runs a read-only program); " +
      "preview runs Python on the current document and saves a verified candidate without changing it. " +
      "apply with file_path set to that candidate publishes its exact bytes to the original. " +
      "Tracked/direct mode follows the user's setting; Review mode records every change as a native revision.",
    inputSchema: objectSchema({
      action: { type: "string", enum: ["help", "inspect", "preview", "apply"] },
      file_path: { type: "string", pattern: DOCUMENT_OR_DRAFT_PATTERN },
      snapshot: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Optional: fail if the document changed since this inspected snapshot." },
      program: { type: "string", minLength: 1, maxLength: 100000,
        description: "Python statements run top to bottom with doc (python-docx) and the help helpers in scope; return a small result." },
      target: { type: "string", maxLength: 300, description: "paragraph:N, table:N, section:N, styles or part:word/<name>.xml" },
      offset: { type: "integer", minimum: 0, maximum: 100000 }, limit: { type: "integer", minimum: 1, maximum: 100 },
    }, ["action"]),
    async execute(input, context, signal) {
      try {
        if (input.action === "help") return { result: toolText(HELP) };
        if (typeof input.file_path !== "string") throw new Error("file_path is required for document operations");
        const file_path = options.resolveArtifact(input.file_path) ?? input.file_path;
        const { report, publication } = await run({ ...input, file_path }, signal, !!context.research?.restricted);
        if (!publication) return { result: toolText(report) };
        const { id, version, number, filename, action } = publication;
        return { result: toolText({ ...report, artifact: options.artifactFor(id, version) }), mutated: true,
          events: [{ type: "document_artifact", action, document_id: id, version_id: version,
            version_number: number, filename,
            download_url: `/api/single-documents/${encodeURIComponent(id)}/file?version_id=${encodeURIComponent(version)}` }],
        };
      } catch (error) {
        return { result: toolText({ ok: false, error: error instanceof Error ? error.message : "Word operation failed" }, true) };
      }
    },
  };
}
