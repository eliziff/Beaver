import type { Citation } from "@/app/lib/citations";
import { expandCitationToEntries, getDocumentCitationQuotes } from "@/app/lib/citations";
import { isDocxFilename, isSpreadsheetFilename } from "@/app/lib/documentFilename";
import type { ResearchSourceReference } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { DocumentViewer } from "../shared/views/DocumentViewer";
import { Modal } from "../modals/Modal";
import { LegalSourceViewer } from "./LegalSourceViewer";

export function ResearchCitationViewer({ citation, reference, onClose }: {
  citation: Citation; reference?: ResearchSourceReference; onClose: () => void;
}) {
  const title = citation.kind === "document" ? citation.filename : reference?.title ?? reference?.citation ?? "Source";
  return <Modal open onClose={onClose} size="2xl" breadcrumbs={[title]}>
    <ResearchCitationContent citation={citation} reference={reference} />
  </Modal>;
}
export function ResearchCitationContent({ citation, reference, document }: {
  citation?: Citation; reference?: ResearchSourceReference; document?: Document;
}) {
  const quoted = citation?.kind === "document" ? citation : null, source = reference?.kind === "document" ? reference : null,
    title = quoted?.filename ?? reference?.title ?? document?.filename ?? "Source",
    filename = `${title}.${document?.file_type ?? ""}`, url = safeAssistantUrl(citation?.external_url ?? reference?.url, { relative: false });
  return quoted || source || document && !reference ? <DocumentViewer
      documentId={quoted?.document_id ?? source?.id ?? document!.id} versionId={quoted?.version_id ?? source?.versionId ?? document?.current_version_id}
      kind={isSpreadsheetFilename(title) || isSpreadsheetFilename(filename) ? "spreadsheet" : document?.pdf_storage_path ? "pdf"
        : isDocxFilename(title) || isDocxFilename(filename) ? "docx" : /\.(txt|md|csv|json)$/iu.test(filename.replace(/\.$/u, "")) ? "text" : "pdf"}
      quotes={quoted ? expandCitationToEntries(quoted) : []} highlightCells={quoted ? getDocumentCitationQuotes(quoted).map(({ sheet, cell }) => ({ sheet, cell })) : undefined} />
      : reference && (reference.provider === "a2aj" || reference.provider === "journal") ? <LegalSourceViewer
        provider={reference.provider} citation={reference.citation ?? reference.id} sourceId={reference.id}
        dataset={reference.collection} language={reference.language} docType={reference.kind === "legislation" ? "laws" : reference.kind === "journal" ? "articles" : "cases"}
        initialLocator={citation && "locator" in citation ? citation.locator ?? undefined : undefined} quotes={citation?.quotes} citationRef={citation?.ref} compact />
      : url && <a href={url} target="_blank" rel="noopener noreferrer" className="m-auto text-sm underline">Open source</a>;
}
