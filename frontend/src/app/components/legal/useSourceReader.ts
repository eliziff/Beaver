import { useState } from "react";
import { getResearchItems } from "@/app/lib/api/researchFiles";
import { legalSourceViewerHref, type ResearchFile, type ResearchPageItem,
  type ResearchSource } from "@/app/lib/researchFiles";
import { evidenceCitation } from "@/app/lib/groundedAnswers";
import type { Citation } from "@/app/lib/citations";
import { errorMessage } from "@/app/lib/utils";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import type { usePagedChains } from "@/app/hooks/usePagedChains";

export const sourceName = (source: ResearchSource) => source.reference.title || source.reference.citation || source.reference.id;
export const sourceMatches = (source: ResearchSource, filter: string) => !filter ||
  [source.reference.title, source.reference.citation, source.reference.collection, source.note]
    .join(" ").toLowerCase().includes(filter.toLowerCase());
type Reading = { citation: Citation; reference?: ResearchSource["reference"] };
type PassagePages = ReturnType<typeof usePagedChains<ResearchPageItem>>;
type ReadSource = (source: ResearchSource, locator?: string) => void;

/** Opens saved sources and passages in the reader, resolving the exact saved passage first. */
export function useSourceReader({ file, passagePages, onReadSource, onStatus }: { file: ResearchFile | null;
  passagePages: PassagePages; onReadSource?: ReadSource; onStatus: (message: string) => void }) {
  const [reading, setReading] = useState<Reading | null>(null);
  const sources = Object.values(file?.state.sources ?? {});
  function sourceHref(source: ResearchSource, locator?: string) {
    if (source.reference.kind === "document") return `/library?${new URLSearchParams({ document_id: source.reference.id,
      version_id: source.reference.versionId, ...(locator ? { locator } : {}) })}`;
    if (source.reference.provider !== "a2aj" && source.reference.provider !== "journal")
      return safeAssistantUrl(source.reference.url, { relative: false });
    const href = legalSourceViewerHref(source.reference, file ? { fileId: file.document.id, sourceId: source.id } : undefined);
    return locator ? `${href}&locator=${encodeURIComponent(locator)}` : href;
  }
  const canRead = (source: ResearchSource) => source.reference.kind === "document" ||
    !!onReadSource && (source.reference.provider === "a2aj" || source.reference.provider === "journal");
  async function readSource(source: ResearchSource, locator?: string, evidenceId?: string) {
    if (source.reference.kind !== "document") { onReadSource?.(source, locator); return; }
    let items = passagePages.chains[source.id]?.items ?? [], receipt = items.find((item) => item.kind === "passage" &&
      (evidenceId ? item.value.receipt.evidence_id === evidenceId : item.value.receipt.locator.label === locator));
    try {
      if (evidenceId && !receipt && file) { let cursor: string | null = null;
        do { const page = await getResearchItems(file.document.id, { kind: "passages", sourceId: source.id, cursor, limit: 200 });
          items = page.items; receipt = items.find((item) => item.kind === "passage" && item.value.receipt.evidence_id === evidenceId); cursor = page.next_cursor;
        } while (!receipt && cursor);
        if (!receipt) throw new Error("The original saved passage is unavailable");
      }
      const citation = receipt?.kind === "passage" ? evidenceCitation(receipt.value.receipt, 1) : null;
      setReading({ reference: source.reference, citation: citation ?? { kind: "document", ref: 1,
        document_id: source.reference.id, version_id: source.reference.versionId, filename: sourceName(source), quotes: [] } });
    } catch (reason) { onStatus(errorMessage(reason, "Could not open saved passage")); }
  }
  function openAnswerCitation(citation: Citation) {
    const source = sources.find(({ reference }) => citation.kind === "document" ? reference.kind === "document" && reference.id === citation.document_id
      : citation.kind === "public_legal" ? reference.provider === citation.provider && reference.id === citation.identifier
        : citation.kind === "a2aj" && reference.provider === "a2aj" && reference.citation === citation.citation);
    setReading({ citation, reference: source?.reference });
  }
  return { reading, setReading, readSource, sourceHref, canRead, openAnswerCitation };
}
export type SourceReader = ReturnType<typeof useSourceReader>;
