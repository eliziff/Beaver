import { createLibreOfficeApplication } from "../libreOfficeApplication";
import { DOCUMENT_OR_DRAFT_PATTERN } from "../resourceReferences";
import type { AssistantToolsDependencies } from "./assistantTools";
import type { ChatToolContext } from "./turnEngine";
import { objectSchema, toolText, type BeaverTool } from "./toolRegistry";

type Dependencies = Parameters<typeof createLibreOfficeApplication>[0] & Pick<AssistantToolsDependencies, "artifactFor" | "resolveArtifact">;

const CONSOLE_HELP = `Write a synchronous JavaScript function body. Native calls suspend automatically; return a small result.
doc is the current Writer document; guest code has no Node, filesystem, network, imports or Python eval.
object.get(name|[names]) reads up to 32 properties; set(values) writes a final property state in native groups. Use separate calls for order-sensitive edits.
Handles also expose native UNO members: UpperCamel names are properties (p.String, p.String = 'x'), lowerCamel names are methods (text.insertTextContent(cursor, table, false)); call(method,...args) is equivalent.
object.reset(name|[names]) removes direct formatting and verifies inherited defaults after export; a later set on the same object/property supersedes that reset.
Styles expose ParentStyle and getParentStyle/setParentStyle; create derived styles instead of repeating formatting.
object.items(offset=0,limit=20,properties=[]) returns {items:[{name,value,properties?}],next_offset,total}. Request property names to read the whole page in one call; value remains a usable handle.
object.describe(filter='',offset=0,limit=50) discovers native signatures; filter matches name substrings separated by |. writable describes the native property, not permission to mutate an inspect program.
word.target(address|[addresses]) resolves one object or up to 1000 in input order, scanning paragraphs once. Retain handles before structural edits; reinspect indexes afterward.
word.inspect({family:'paragraph',limit:20,properties:['ParaStyleName'],include_text:false}) omits prose. header/footer select default/right stories; -left/-first families list only enabled independent variants. Page-style HeaderIsShared, FooterIsShared and FirstIsShared control sharing.
word.create(service), word.constant(name), word.enum(type,value), word.struct(type,fields), word.any(type,value) supply native factories and typed arguments.
word.mm(n)/word.pt(n) convert geometry to hundredths of a millimetre; font heights already use points.
textObject.find(literal) returns one exact range in a paragraph/cell/note/header/footer; missing or ambiguous text fails.
Example: word.target('footnote:0').find('paragraph 12').set({String:'paragraph 15'});
Tables: create, initialize(rows,cols), then doc.getText().insertTextContent(nextParagraph.getStart(), table, false) places it before that paragraph (inserting at a paragraph's end splits it, leaving an empty paragraph). Only then fill cells with getCellRangeByName('A1:C4').setDataArray(rows), not one call per cell.
Number paragraphs as one list by setting the same NumberingStyleName on each, e.g. p.NumberingStyleName = 'Numbering 123' (1., 2., 3.); separate NumberingRules objects each restart at 1.
Word sections are the page styles in use; inspect family 'page-style' lists them with in_use and word_margins (Word's top/bottom margins include an enabled header/footer).
Set margins as Word shows them with word.margins(pageStyle,{top:word.mm(25.4),bottom,left,right}) in hundredths of a mm; it keeps an enabled header/footer's edge distance, whereas TopMargin/BottomMargin move the header/footer.
word.section(paragraph,values) starts a Word section on a new page at that paragraph with a copy of the current layout, header and footer, applies values and returns its page style, e.g. word.section('paragraph:15',{IsLandscape:true}) (orientation swaps the page size).
Previews that change page layout report word_sections as Word will show them; check them against the request.
object.expect(values) checks now and after export/reopen. Checks follow retained objects through insertions; selected ranges and attached notes are supported. Removed/unaddressable objects fail.
Inspected paragraph text is the accepted reading; tracked shows {-deleted-}{+inserted+}. The String property includes deletions.
word.review(target|[targets],'accept'|'reject') reviews named revisions in a separate program from new edits.
Review mode rejects edits that cannot be undone by rejecting their native revisions; it never silently switches to Direct.
Handles live only within a program and are not legal evidence identities. Follow next_offset; total may be null.
Preview receipts contain operation summaries and revision counts, not text diffs. Inspect the candidate or page its revision family for details.`;

export function createLibreOfficeTool(options: Dependencies): BeaverTool<ChatToolContext> {
  const run = createLibreOfficeApplication(options);
  return {
    name: "word_uno", specialist: true, sequential: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    activity: input => input.action === "apply" ? "Publishing reviewed Word candidate" : "Inspecting or editing Word structures",
    description: "Rich Word document access without Microsoft Word. Use Read/Edit/Write for ordinary content. " +
      "help returns the programmable console API. inspect/describe provide native objects and properties; " +
      "inspect with program runs read-only JavaScript for exploration; preview runs an editing program on the current document and saves a verified candidate without changing it. " +
      "apply with file_path set to that candidate publishes its exact bytes to the original. " +
      "Tracked/direct mode follows the user's setting; untrackable Review edits fail.",
    inputSchema: objectSchema({
      action: { type: "string", enum: ["help", "inspect", "describe", "preview", "apply"] },
      file_path: { type: "string", pattern: DOCUMENT_OR_DRAFT_PATTERN },
      family: { type: "string", enum: ["document", "paragraph", "table", "footnote", "endnote", "frame", "bookmark",
        "body", "header", "header-left", "header-first", "footer", "footer-left", "footer-first",
        "field", "section", "drawing", "index", "control", "revision", "page-style", "paragraph-style", "character-style", "numbering-style"] },
      target: { type: "string", maxLength: 500 },
      filter: { type: "string", maxLength: 500, description: "describe: case-insensitive member-name substrings separated by |." },
      snapshot: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Optional: fail if the document changed since this inspected snapshot." },
      offset: { type: "integer", minimum: 0, maximum: 100000 }, limit: { type: "integer", minimum: 1, maximum: 100 },
      program: { type: "string", minLength: 1, maxLength: 100000 },
      properties: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", maxLength: 100 } },
      include_text: { type: "boolean", description: "False for property-only inspection." },
    }, ["action"]),
    async execute(input, context, signal) {
      try {
        if (input.action === "help") return { result: toolText(CONSOLE_HELP) };
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
