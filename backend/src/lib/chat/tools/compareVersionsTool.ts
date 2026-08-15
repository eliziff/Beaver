// compare_docx_versions — the tracked-changes word action over
// lib/docxCompareVersions.ts. The model receives change counts, typed
// abstentions, and the id of a saved redline document — never the diff
// text itself: the redline lives in the Library where the user opens it
// in Word, and the model reasons over the typed summary.
import { compareDocxVersions } from "../../docxCompareVersions";
import type { DocumentScope, DocumentStore } from "../../documentStore";
import type { OpenAIToolSchema } from "../../llm";

const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAIToolSchema => ({
  type: "function",
  function: { name, description, parameters },
});

export const COMPARE_VERSIONS_TOOLS: OpenAIToolSchema[] = [
  tool(
    "compare_docx_versions",
    "Word tracked-changes redline between two versions of a Library DOCX (default: current against the one before), saved as a new Library document. Returns change counts plus typed abstentions for what the diff cannot honestly represent (tables, content controls, headers/footers, fields). The redline document is the deliverable; the diff text is never returned.",
    {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "Filename from Glob, or document_id when Glob reports a duplicate filename.",
        },
        old_version_id: {
          type: "string",
          description:
            "Baseline version. Default: the version immediately before new_version_id.",
        },
        new_version_id: {
          type: "string",
          description: "Version whose text the redline shows. Default: current.",
        },
      },
      required: ["document_id"],
    },
  ),
];

const MAX_REPORTED_ABSTENTIONS = 20;
const MAX_REPORTED_CHANGES = 12;

const trimmed = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** Handles compare_docx_versions; returns null for other tool names. */
export async function executeCompareVersionsTool(
  documents: DocumentStore,
  scope: DocumentScope,
  name: string,
  args: Record<string, unknown>,
  projectId?: string | null,
): Promise<Record<string, unknown> | null> {
  if (name !== "compare_docx_versions") return null;
  const documentId = trimmed(args.document_id);
  if (!documentId) return { ok: false, error: "document_id is required" };
  const listing = await documents.versions(scope, documentId);
  if (!listing) return { ok: false, error: "Document not found" };
  const newVersionId = trimmed(args.new_version_id) || listing.current_version_id;
  let oldVersionId = trimmed(args.old_version_id);
  if (!oldVersionId) {
    const index = listing.versions.findIndex(
      (version) => version.id === newVersionId,
    );
    if (index < 0) return { ok: false, error: "version_not_found" };
    if (index === 0) {
      return {
        ok: false,
        error: "no_prior_version",
        detail:
          "The document has no earlier version; pass old_version_id explicitly.",
      };
    }
    oldVersionId = listing.versions[index - 1].id;
  }
  if (oldVersionId === newVersionId) {
    return { ok: false, error: "same_version" };
  }
  const [oldFile, newFile] = await Promise.all([
    documents.read(scope, documentId, oldVersionId, false),
    documents.read(scope, documentId, newVersionId, false),
  ]);
  if (!oldFile || !newFile) return { ok: false, error: "version_not_found" };
  if (
    oldFile.fileType.toLowerCase() !== "docx" ||
    newFile.fileType.toLowerCase() !== "docx"
  ) {
    return {
      ok: false,
      error: "docx_only",
      detail: `file types are ${oldFile.fileType} and ${newFile.fileType}`,
    };
  }
  const comparison = await compareDocxVersions(oldFile.bytes, newFile.bytes, {
    author: "Beaver compare",
  });
  const baseName = newFile.filename.replace(/\.docx$/iu, "");
  const redline = await documents.create(scope, {
    filename: `${baseName} (redline).docx`,
    fileType: "docx",
    bytes: comparison.bytes,
    projectId,
    libraryKind: "file",
    provenance: { schemaVersion: 1, actor: "assistant", action: "created" },
  });
  return {
    ok: true,
    redline_document_id: redline.id,
    redline_filename: redline.filename,
    old_version_id: oldVersionId,
    new_version_id: newVersionId,
    changes_total: comparison.changes.length,
    changes: comparison.changes.slice(0, MAX_REPORTED_CHANGES).map((change) => ({
      kind: change.kind,
      deleted: change.deletedText.slice(0, 120),
      inserted: change.insertedText.slice(0, 120),
    })),
    abstentions_total: comparison.abstentions.length,
    abstentions: comparison.abstentions
      .slice(0, MAX_REPORTED_ABSTENTIONS)
      .map((abstention) => ({
        reason: abstention.reason,
        excerpt: abstention.excerpt.slice(0, 120),
      })),
  };
}
