// The always-on half of the prompt contract: WHAT the user has.
//
// A newborn model instance knows the Library tools exist, because the system
// prompt says so — but not that any document exists, so a vaguely worded
// request ("the lease", "my client's email") can be answered with "I don't
// have access to your Library" even though the prompt tells it to call
// library_list first. Measured on the lean smoke: same model, same effort,
// same two documents, only the user's wording changed, and tool calls went
// from five to zero.
//
// Naming the documents up front costs ~20 tokens each and removes a whole
// discovery round trip, since the ids the tools require are right there.
// Per-document STRUCTURE stays on demand (library_outline) — this is an
// inventory, not an outline.
import { listLocalLibrary } from "../localDocumentStore";

const MAX_LISTED_DOCUMENTS = 20;

/**
 * A compact roster of the Library documents in scope, or "" when there are
 * none (or the store is unavailable — an inventory is an optimization, never
 * a precondition for answering).
 */
export async function libraryInventoryPrompt(
  userId: string,
  allowedDocumentIds: ReadonlySet<string> | null,
): Promise<string> {
  if (process.env.MIKE_LIBRARY_INVENTORY === "0") return "";
  try {
    const collection = await listLocalLibrary(userId, "file");
    const inScope = collection.documents.filter(
      (document) => !allowedDocumentIds || allowedDocumentIds.has(document.id),
    );
    if (!inScope.length) return "";
    const listed = inScope.slice(0, MAX_LISTED_DOCUMENTS);
    const lines = listed.map(
      (document) => `- ${document.filename} — document_id ${document.id}`,
    );
    const remaining = inScope.length - listed.length;
    return (
      `\n\nThese documents are already in the user's Library and available to you now. ` +
      `Use the document_id shown here directly instead of calling library_list. ` +
      `Match a loose reference ("the lease", "her email") to one of these rather than saying you have no access.\n` +
      `${lines.join("\n")}\n` +
      (remaining > 0
        ? `- (${remaining} more; call library_list to see the rest.)\n`
        : "")
    );
  } catch {
    return "";
  }
}
