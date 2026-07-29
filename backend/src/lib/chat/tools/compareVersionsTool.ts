// library_compare_versions — the tracked-changes word action over
// lib/docxCompareVersions.ts. The model receives change counts, typed
// abstentions, and the id of a saved redline document — never the diff
// text itself: the redline lives in the Library where the user opens it
// in Word, and the model reasons over the typed summary.
import { readFile } from "node:fs/promises";
import { compareDocxVersions } from "../../docxCompareVersions";
import {
  createLocalDocument,
  getLocalVersionFile,
  listLocalVersions,
} from "../../localDocumentStore";
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
    "library_compare_versions",
    "Produce a Word tracked-changes redline between two versions of a Library DOCX (defaults: the current version against the one before it). Saves the redline as a new Library document and returns change counts plus typed abstentions for anything the diff cannot honestly represent (tables, content controls, headers/footers, fields). The redline document itself is the deliverable; this tool never returns the diff text.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
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

/** Handles library_compare_versions; returns null for other tool names. */
export async function executeCompareVersionsTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (name !== "library_compare_versions") return null;
  const documentId = trimmed(args.document_id);
  if (!documentId) return { ok: false, error: "document_id is required" };
  const listing = await listLocalVersions(userId, documentId);
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
    getLocalVersionFile(userId, documentId, oldVersionId),
    getLocalVersionFile(userId, documentId, newVersionId),
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
  const [oldBytes, newBytes] = await Promise.all([
    readFile(oldFile.path),
    readFile(newFile.path),
  ]);
  const comparison = await compareDocxVersions(oldBytes, newBytes, {
    author: "Beaver compare",
  });
  const baseName = newFile.document.filename.replace(/\.docx$/iu, "");
  const redline = await createLocalDocument({
    userId,
    kind: "file",
    filename: `${baseName} (redline).docx`,
    bytes: comparison.bytes,
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
