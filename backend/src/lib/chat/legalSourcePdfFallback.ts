import type { RemoteLegalSourceDocument } from "../legalSources/remoteProvider";
import { summarizeLegalSourceDoc } from "../sourceDocNativeMarkup";
import { queueProviderPdfAttachment } from "../providerPdfLibraryBridge";
import { resourceReference } from "../resourceReferences";

function pdfAttachments(document: RemoteLegalSourceDocument) {
  const unique = new Map<
    string,
    RemoteLegalSourceDocument["attachments"][number]
  >();
  for (const attachment of document.attachments) {
    try {
      const url = new URL(attachment.url);
      url.hash = "";
      const mediaType = attachment.contentType?.toLowerCase().split(";", 1)[0];
      const pathname = url.pathname.toLowerCase();
      if (
        mediaType === "application/pdf" ||
        attachment.filename?.toLowerCase().endsWith(".pdf") ||
        pathname.endsWith(".pdf") || pathname.endsWith("/pdf")
      ) unique.set(url.toString(), attachment);
    } catch {
      // Optional malformed attachments are not usable fallbacks.
    }
  }
  return [...unique.values()];
}

export async function legalSourcePdfFallbacks(
  document: RemoteLegalSourceDocument,
  userId?: string,
) {
  if (
    !userId ||
    summarizeLegalSourceDoc(document.structure).source !== "flat_text"
  ) return [];
  return (
    await Promise.all(
      pdfAttachments(document).map(async (attachment) => {
        try {
          const queued = await queueProviderPdfAttachment({
            provider: document.provider,
            identity: document.identity,
            structureSource: "flat_text",
            url: attachment.url,
            canonicalUrl: document.url,
            filename: attachment.filename,
            title: attachment.title || document.title,
          });
          return queued ? {
            ...queued,
            resource: resourceReference.source("pdf", queued.reference_id),
            attachment_title: attachment.title || document.title,
            attachment_filename: attachment.filename,
          } : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((item): item is NonNullable<typeof item> => item !== null);
}
