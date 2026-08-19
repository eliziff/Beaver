import { compareDocxVersions } from "../../docxCompareVersions";
import type { DocumentScope, DocumentStore } from "../../documentStore";
import type { Tool } from "../../llm";
import { DOCUMENT_RESOURCE_PATTERN } from "../../resourceReferences";

export const COMPARE_VERSIONS_TOOLS: Tool[] = [{
  name: "compare_versions",
  description:
    "Compare two Library DOCX versions in memory (default: current against the prior version). Returns bounded changes and typed abstentions. Set save_redline only when the user asked for a durable Word redline.",
  inputSchema: {
    type: "object",
    properties: {
      document_id: {
        type: "string",
        pattern: DOCUMENT_RESOURCE_PATTERN,
        description: "Version-pinned document resource to compare.",
      },
      baseline: {
        type: "string",
        pattern: DOCUMENT_RESOURCE_PATTERN,
        description: "Earlier version-pinned resource of the same document; defaults to the prior version.",
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

export async function compareDocumentVersions(
  documents: DocumentStore,
  scope: DocumentScope,
  input: {
    documentId: string;
    newVersionId: string;
    oldVersionId?: string;
    saveRedline?: boolean;
  },
  projectId?: string | null,
): Promise<Record<string, unknown>> {
  const { documentId, newVersionId } = input;
  const listing = await documents.versions(scope, documentId);
  if (!listing) return { ok: false, error: "Document not found" };
  let oldVersionId = input.oldVersionId;
  if (!oldVersionId) {
    const index = listing.versions.findIndex(({ id }) => id === newVersionId);
    if (index < 0) return { ok: false, error: "version_not_found" };
    if (index === 0) {
      return {
        ok: false,
        error: "no_prior_version",
        detail: "The document has no earlier version; pass baseline.",
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
    baseline_version_id: oldVersionId,
    compared_version_id: newVersionId,
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
  if (!input.saveRedline) return summary;
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
    action: "created",
    document_id: redline.id,
    version_id: redline.current_version_id,
    version_number: redline.active_version_number,
    filename: redline.filename,
    file_type: redline.file_type,
    download_url:
      `/api/single-documents/${encodeURIComponent(redline.id)}/file` +
      `?version_id=${encodeURIComponent(redline.current_version_id)}`,
  };
}
