import { compareDocxVersions } from "../../docxCompareVersions";
import type { DocumentScope, DocumentStore } from "../../documentStore";
import type { Tool } from "../../llm";

export const COMPARE_VERSIONS_TOOLS: Tool[] = [{
  name: "compare_versions",
  description:
    "Compare two Library DOCX versions in memory (default: current against the prior version). Returns bounded changes and typed abstentions. Set save_redline only when the user asked for a durable Word redline.",
  inputSchema: {
    type: "object",
    properties: {
      document_id: {
        type: "string",
        description:
          "Filename from Glob, or document_id when Glob reports a duplicate.",
      },
      old_version_id: {
        type: "string",
        description: "Baseline version; defaults to the version before new_version_id.",
      },
      new_version_id: {
        type: "string",
        description: "Compared version; defaults to current.",
      },
      save_redline: {
        type: "boolean",
        description:
          "Persist a durable Word redline. Omit unless the user requested it.",
      },
    },
    required: ["document_id"],
    additionalProperties: false,
  },
}];

const MAX_REPORTED_ABSTENTIONS = 20;
const MAX_REPORTED_CHANGES = 12;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** Handles compare_versions; returns null for other tool names. */
export async function executeCompareVersionsTool(
  documents: DocumentStore,
  scope: DocumentScope,
  name: string,
  args: Record<string, unknown>,
  projectId?: string | null,
): Promise<Record<string, unknown> | null> {
  if (name !== "compare_versions") return null;
  const documentId = text(args.document_id);
  if (!documentId) return { ok: false, error: "document_id is required" };
  const listing = await documents.versions(scope, documentId);
  if (!listing) return { ok: false, error: "Document not found" };
  const newVersionId = text(args.new_version_id) || listing.current_version_id;
  let oldVersionId = text(args.old_version_id);
  if (!oldVersionId) {
    const index = listing.versions.findIndex(({ id }) => id === newVersionId);
    if (index < 0) return { ok: false, error: "version_not_found" };
    if (index === 0) {
      return {
        ok: false,
        error: "no_prior_version",
        detail: "The document has no earlier version; pass old_version_id.",
      };
    }
    oldVersionId = listing.versions[index - 1].id;
  }
  if (oldVersionId === newVersionId) return { ok: false, error: "same_version" };
  const [oldFile, newFile] = await Promise.all([
    documents.read(scope, documentId, oldVersionId, false),
    documents.read(scope, documentId, newVersionId, false),
  ]);
  if (!oldFile || !newFile) return { ok: false, error: "version_not_found" };
  if ([oldFile.fileType, newFile.fileType].some((kind) => kind.toLowerCase() !== "docx")) {
    return {
      ok: false,
      error: "docx_only",
      detail: `file types are ${oldFile.fileType} and ${newFile.fileType}`,
    };
  }
  const comparison = await compareDocxVersions(oldFile.bytes, newFile.bytes, {
    author: "Beaver compare",
  });
  const summary: Record<string, unknown> = {
    ok: true,
    old_version_id: oldVersionId,
    new_version_id: newVersionId,
    changes_total: comparison.changes.length,
    changes: comparison.changes.slice(0, MAX_REPORTED_CHANGES).map((change) => ({
      kind: change.kind,
      deleted: change.deletedText.slice(0, 120),
      inserted: change.insertedText.slice(0, 120),
    })),
    abstentions_total: comparison.abstentions.length,
    abstentions: comparison.abstentions.slice(0, MAX_REPORTED_ABSTENTIONS)
      .map((item) => ({
        reason: item.reason,
        excerpt: item.excerpt.slice(0, 120),
      })),
  };
  if (args.save_redline !== true) return summary;
  const redline = await documents.create(scope, {
    filename: `${newFile.filename.replace(/\.docx$/iu, "")} (redline).docx`,
    fileType: "docx",
    bytes: comparison.bytes,
    projectId,
    libraryKind: "file",
    provenance: { schemaVersion: 1, actor: "assistant", action: "created" },
  });
  return {
    ...summary,
    receipt: "mike-document:v1",
    action: "created",
    document_id: redline.id,
    version_id: redline.current_version_id,
    version_number: redline.active_version_number,
    filename: redline.filename,
    file_type: redline.file_type,
    download_url:
      `/single-documents/${encodeURIComponent(redline.id)}/file` +
      `?version_id=${encodeURIComponent(redline.current_version_id)}`,
  };
}
