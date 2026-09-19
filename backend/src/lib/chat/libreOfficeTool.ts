import { createLibreOfficeApplication } from "../libreOfficeApplication";
import { DOCUMENT_RESOURCE_PATTERN } from "../resourceReferences";
import type { AssistantToolsDependencies } from "./assistantTools";
import type { ChatToolContext } from "./turnEngine";
import { objectSchema, toolText, type BeaverTool } from "./toolRegistry";

type Dependencies = Pick<AssistantToolsDependencies, "documents" | "userId" | "userEmail" |
  "matterId" | "docIndex" | "allowedDocumentIds" | "editMode" | "turnId" |
  "artifactFor" | "onMutationCommitted"> & {
    onPublished(documentId: string, versionId: string, workingRevision: number, sourceVersion: string): void;
  };

const CONSOLE_HELP = `Write a synchronous JavaScript function body; return only the needed result.
Native calls suspend automatically. Variables, loops and functions work within one program.
doc is the current Writer document. No Node, filesystem, network, imports or Python eval.
object.get(name) or object.get([names]) reads up to 32 properties in one call; object.set(values) writes properties.
object.items(offset=0,limit=20) pages any native collection as {items:[{name,value}],next_offset,total}.
Follow next_offset; total is null until enumeration reaches its end. object.call(method,...args) invokes methods.
object.describe(filter='',offset=0,limit=50) discover the actual native API.
word.target('paragraph:0') resolves an inspection target in this document.
word.inspect({family:'paragraph',limit:20,properties:['ParaStyleName'],include_text:false}) reads only selected properties.
word.create('com.sun.star.text.Footnote') creates a document-local native object.
word.constant(name) resolves a native named constant.
word.enum(type,value), word.struct(type,fields), word.any(type,value) construct typed UNO method arguments.
word.mm(n) and word.pt(n) convert to hundredths of a millimetre for geometry; font heights use points.
textObject.find(literal) returns the unique exact native range inside a paragraph/cell/note/header; missing or ambiguous matches fail.
Example: word.target('footnote:0').find('paragraph 12').set({String:'paragraph 15'});
For rectangular tables, call getCellRangeByName then getDataArray/setDataArray to read/write rows in bulk.
word.review('revision:0','accept'|'reject') resolves that revision; pass an array for a coordinated set.
Resolve revisions in a separate program from new edits. Inspect again after review.
object.expect({property:value}) registers export/reopen assertions for an inspection target.
Native object handles live only within the program. Resolve objects before structural edits and keep those objects;
reinspect to obtain current indexed addresses after inserting/removing objects. Do not reuse a previous version's addresses.
Use get/call/describe to traverse native collections; request selected properties rather than whole objects.
String is Writer's native redline text and can include deletions; inspect revisions or use ordinary Read for final prose.
Review mode requires native revisions whose rejection restores the no-edit round-trip control.
Untrackable changes (for example some section settings) fail rather than silently becoming direct edits.
Example: const t=word.target('table:Table1'); return t.describe('Header');
Example: const text=doc.get('Text'); const c=text.call('createTextCursor'); c.call('gotoStart',false);
const note=word.create('com.sun.star.text.Footnote'); text.call('insertTextContent',c,note,false);
note.set({String:'Source note.'}); return word.inspect({family:'footnote'});`;

export function createLibreOfficeTool(options: Dependencies): BeaverTool<ChatToolContext> {
  const run = createLibreOfficeApplication(options);
  return {
    name: "word_uno", specialist: true, sequential: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    activity: input => input.action === "apply" ? "Publishing reviewed Word candidate" : "Inspecting or editing Word structures",
    description: "Rich Word document access without Microsoft Word. Use Read/Edit/Write for ordinary content. " +
      "help returns the programmable console API. inspect/describe provide native objects and properties; " +
      "inspect with program runs read-only JavaScript. preview runs a JavaScript program " +
      "against the inspected snapshot, saves a verified separate DOCX, and leaves the original unchanged. " +
      "Native tracked/direct mode follows the user's setting; untrackable Review-mode edits are refused. " +
      "Inspect the candidate and receipts before apply, which publishes those exact bytes. " +
      "Methods and properties are discovered progressively, not a fixed formatting menu.",
    inputSchema: objectSchema({
      action: { type: "string", enum: ["help", "inspect", "describe", "preview", "apply"] },
      file_path: { type: "string", pattern: DOCUMENT_RESOURCE_PATTERN },
      family: { type: "string", enum: ["document", "paragraph", "table", "footnote", "endnote", "frame", "bookmark",
        "field", "section", "drawing", "index", "control", "revision", "page-style", "paragraph-style", "character-style", "numbering-style"] },
      target: { type: "string", maxLength: 500 }, filter: { type: "string", maxLength: 80 },
      snapshot: { type: "string", pattern: "^[a-f0-9]{64}$" },
      offset: { type: "integer", minimum: 0, maximum: 100000 }, limit: { type: "integer", minimum: 1, maximum: 100 },
      program: { type: "string", minLength: 1, maxLength: 100000 },
      properties: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", maxLength: 100 } },
      include_text: { type: "boolean", description: "False for property-only inspection." },
      preview_resource: { type: "string", pattern: DOCUMENT_RESOURCE_PATTERN },
    }, ["action"]),
    async execute(input, context, signal) {
      try {
        if (input.action === "help") return { result: toolText(CONSOLE_HELP) };
        if (!input.file_path) throw new Error("file_path is required for document operations");
        const { report, publication } = await run(input, signal, !!context.research?.restricted);
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
