import { useState } from "react";
import { getResearchItems } from "@/app/lib/api/researchFiles";
import { getDirectLegalSourceDocument } from "@/app/lib/api/legalSources";
import { legalSourceViewerHref, type ResearchFile, type ResearchPageItem,
  type ResearchSource, type ResearchSourceReference } from "@/app/lib/researchFiles";
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
type ReadSource = (source: ResearchSource, locator?: string, evidenceId?: string) => void;

/** The reader tab's own request for a saved source, so hovering warms exactly what opening asks for. */
let warming = 0;
function prefetchLegalSource(reference: ResearchSourceReference) {
  // A pointer sweeping the tree can outrun the reads; keep at most two speculative documents in flight.
  if (warming >= 2 || reference.kind === "document" ||
      reference.provider !== "a2aj" && reference.provider !== "journal") return;
  warming += 1;
  void getDirectLegalSourceDocument({
    provider: reference.provider,
    citation: reference.citation ?? reference.id,
    sourceId: reference.id,
    docType: reference.kind === "legislation" ? "laws" : reference.kind === "journal" ? "articles" : "cases",
    language: reference.language ?? "en",
    dataset: reference.collection ?? null,
  }).catch(() => undefined).finally(() => { warming -= 1; });
}

/** Opens saved sources and passages in the reader, resolving the exact saved passage first. */
export function useSourceReader({ file, passagePages, onReadSource, onStatus }: { file: ResearchFile | null;
  passagePages: PassagePages; onReadSource?: ReadSource; onStatus: (message: string) => void }) {
  const [reading, setReading] = useState<Reading | null>(null);
  function sourceHref(source: ResearchSource, locator?: string) {
    if (source.reference.kind === "document") return `/library?${new URLSearchParams({ document_id: source.reference.id,
      version_id: source.reference.versionId, ...(locator ? { locator } : {}) })}`;
    if (source.reference.provider !== "a2aj" && source.reference.provider !== "journal")
      return safeAssistantUrl(source.reference.url, { relative: false });
    const href = legalSourceViewerHref(source.reference, file ? { fileId: file.document.id, sourceId: source.id } : undefined);
    return locator ? `${href}&locator=${encodeURIComponent(locator)}` : href;
  }
  const canRead = (source: ResearchSource) => source.reference.kind === "document" ||
    source.reference.provider === "a2aj" || source.reference.provider === "journal";
  /** A host with its own reader takes the source; otherwise it opens here. Reading never navigates
   *  the panel away, so the workspace beside it keeps its place. */
  async function readSource(source: ResearchSource, locator?: string, evidenceId?: string) {
    if (source.reference.kind !== "document") {
      if (onReadSource) return onReadSource(source, locator, evidenceId);
      const reference = source.reference;
      return setReading({ reference, citation: reference.provider === "journal"
        ? { kind: "public_legal", ref: 1, provider: "journal", identifier: reference.id, title: reference.title ?? null,
            citation: reference.citation ?? null, quotes: [], locator: locator ?? null }
        : { kind: "a2aj", ref: 1, citation: reference.citation ?? reference.id, name: reference.title ?? null,
            dataset: reference.collection ?? null, quotes: [], locator: locator ?? null } });
    }
    let items = passagePages.chains[source.id]?.items ?? [], receipt = items.find((item) => (item.kind === "passage" || item.kind === "evidence") &&
      (evidenceId ? item.value.receipt.evidence_id === evidenceId : item.value.receipt.locator.label === locator));
    try {
      if (evidenceId && !receipt && file) { let cursor: string | null = null;
        do { const page = await getResearchItems(file.document.id, { kind: "evidence", sourceId: source.id, cursor, limit: 200 });
          items = page.items; receipt = items.find((item) => (item.kind === "passage" || item.kind === "evidence") && item.value.receipt.evidence_id === evidenceId); cursor = page.next_cursor;
        } while (!receipt && cursor);
        if (!receipt) throw new Error("The original saved passage is unavailable");
      }
      const citation = receipt && (receipt.kind === "passage" || receipt.kind === "evidence") ? evidenceCitation(receipt.value.receipt, 1) : null;
      setReading({ reference: source.reference, citation: citation ?? { kind: "document", ref: 1,
        document_id: source.reference.id, version_id: source.reference.versionId, filename: sourceName(source), quotes: [] } });
    } catch (reason) { onStatus(errorMessage(reason, "Could not open saved passage")); }
  }
  return { reading, setReading, readSource, prefetch: (source: ResearchSource) => prefetchLegalSource(source.reference),
    sourceHref, canRead };
}
export type SourceReader = ReturnType<typeof useSourceReader>;
