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

const CONSOLE_HELP = `Write a synchronous JavaScript function body. Native calls suspend automatically; return a small result.
doc is the current Writer document; guest code has no Node, filesystem, network, imports or Python eval.
object.get(name|[names]) reads up to 32 properties; set(values) writes them; call(method,...args) invokes UNO.
object.items(offset=0,limit=20) returns {items:[{name,value}],next_offset,total}. Follow next_offset; total may be null.
object.describe(filter='',offset=0,limit=50) discovers native signatures. writable describes the native property, not permission to mutate an inspect program.
word.target(address) resolves an inspected object; retain it before structural edits and reinspect indexes afterward.
word.inspect({family:'paragraph',limit:20,properties:['ParaStyleName'],include_text:false}) omits prose.
word.create(service), word.constant(name), word.enum(type,value), word.struct(type,fields), word.any(type,value) supply native factories and typed arguments.
word.mm(n)/word.pt(n) convert geometry to hundredths of a millimetre; font heights already use points.
textObject.find(literal) returns one exact range in a paragraph/cell/note/header; missing or ambiguous text fails.
Example: word.target('footnote:0').find('paragraph 12').set({String:'paragraph 15'});
For tables use getCellRangeByName and getDataArray/setDataArray, not one call per cell.
object.expect(values) checks now and after export/reopen. Checks follow retained objects through insertions; selected ranges and attached notes are supported. Removed/unaddressable objects fail.
String includes native redline deletions; assert that raw value or use ordinary Read for final prose.
word.review(target|[targets],'accept'|'reject') reviews named revisions in a separate program from new edits.
Review mode rejects edits that cannot be undone by rejecting their native revisions; it never silently switches to Direct.
Handles live only within a program and are not legal evidence identities.`;

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
