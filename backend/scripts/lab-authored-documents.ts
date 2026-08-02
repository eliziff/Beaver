export type LabSseEvent = { type?: string; [key: string]: unknown };

/** Keep the latest downloadable version of every document authored in a turn. */
export function latestAuthoredDocuments(events: LabSseEvent[]) {
  const documents = new Map<
    string,
    { filename: string; downloadUrl: string }
  >();
  events.forEach((event, index) => {
    if (event.type !== "doc_created" && event.type !== "doc_edited") return;
    const filename = String(event.filename ?? "").trim();
    const downloadUrl = String(event.download_url ?? "").trim();
    if (!filename || !downloadUrl) return;
    const documentId = String(event.document_id ?? "").trim();
    documents.set(documentId || `event:${index}`, { filename, downloadUrl });
  });
  return [...documents.values()];
}
