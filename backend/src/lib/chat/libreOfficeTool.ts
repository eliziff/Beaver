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

export function createLibreOfficeTool(options: Dependencies): BeaverTool<ChatToolContext> {
  const run = createLibreOfficeApplication(options);
  return {
    name: "word_uno", specialist: true, sequential: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    activity: (input) => input.action === "apply" ? "Publishing reviewed Word candidate" : "Inspecting or editing Word structures",
    description: "Inspect real Writer objects and typed properties, or preview a coordinated DOCX batch. " +
      "Use Read/Edit/Write for ordinary content work. inspect returns snapshot and targets; describe exposes properties. " +
      "preview requires that snapshot and operations [{target,set:{UNOProperty:value}}] or " +
      "[{target,replace:{find:exactText,text:replacement}}]. Enum values use {enum:type,value:name}; " +
      "structs use {struct:type,fields:{...}}. Only properties described as writable are allowed. " +
      "Preview saves a separate direct-edit candidate, NOT native tracked changes; inspect its changes and DOCX " +
      "before apply. apply requires Direct editing mode and the exact preview resource. The original is untouched " +
      "until apply. Handles belong only to the inspected snapshot. No arbitrary Python/UNO method execution.",
    inputSchema: objectSchema({
      action: { type: "string", enum: ["inspect", "describe", "preview", "apply"] },
      file_path: { type: "string", pattern: DOCUMENT_RESOURCE_PATTERN },
      family: { type: "string", enum: ["paragraph", "table", "footnote", "endnote", "frame", "page-style", "paragraph-style", "character-style"] },
      target: { type: "string", maxLength: 500 }, filter: { type: "string", maxLength: 80 },
      snapshot: { type: "string", pattern: "^[a-f0-9]{64}$" },
      offset: { type: "integer", minimum: 0, maximum: 100000 }, limit: { type: "integer", minimum: 1, maximum: 100 },
      operations: { type: "array", minItems: 1, maxItems: 50, items: objectSchema({
        target: { type: "string", minLength: 1, maxLength: 500 },
        set: { type: "object", minProperties: 1, maxProperties: 20 },
        replace: objectSchema({ find: { type: "string", minLength: 1, maxLength: 10000 },
          text: { type: "string", maxLength: 10000 } }, ["find", "text"]),
      }, ["target"]) },
      preview_resource: { type: "string", pattern: DOCUMENT_RESOURCE_PATTERN },
    }, ["action", "file_path"]),
    async execute(input, context, signal) {
      try {
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
