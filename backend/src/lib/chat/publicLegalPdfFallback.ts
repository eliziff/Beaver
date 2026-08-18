import type { PublicLegalDocument } from "../publicLegalSources";
import { summarizeLegalSourceDoc } from "../sourceDocNativeMarkup";
import { queueProviderPdfAttachment } from "../providerPdfLibraryBridge";
import { resourceReference } from "../resourceReferences";

function pdfAttachments(document: PublicLegalDocument) {
  const unique = new Map<string, PublicLegalDocument["attachments"][number]>();
  for (const attachment of document.attachments) {
    try {
      const url = new URL(attachment.url);
      url.hash = "";
      const mediaType = attachment.contentType?.toLowerCase().split(";", 1)[0];
      const pathname = url.pathname.toLowerCase();
      if (
        mediaType === "application/pdf" ||
        attachment.filename?.toLowerCase().endsWith(".pdf") ||
        pathname.endsWith(".pdf") ||
        pathname.endsWith("/pdf")
      ) unique.set(url.toString(), attachment);
    } catch {
      // Optional malformed attachments are not usable fallbacks.
    }
  }
  return [...unique.values()];
}

export async function publicLegalPdfFallbacks(
  document: PublicLegalDocument,
  userId?: string,
) {
  const provider = document.provider;
  if (
    !userId ||
    provider === "journal" ||
    summarizeLegalSourceDoc(document.structure).source !== "flat_text"
  ) return [];
  return (
    await Promise.all(
      pdfAttachments(document).map(async (attachment) => {
        try {
          const queued = await queueProviderPdfAttachment({
            provider,
            identity: document.identity,
            structureSource: "flat_text",
            url: attachment.url,
            canonicalUrl: document.url,
            filename: attachment.filename,
            title: attachment.title || document.title,
          });
          return queued
            ? {
                ...queued,
                resource: resourceReference.source("pdf", queued.reference_id),
                attachment_title: attachment.title || document.title,
                attachment_filename: attachment.filename,
              }
            : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((item): item is NonNullable<typeof item> => item !== null);
}
