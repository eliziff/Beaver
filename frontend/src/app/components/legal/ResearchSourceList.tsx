import { useState, type Dispatch, type SetStateAction } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, Trash2 } from "lucide-react";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button, buttonClassName } from "../ui/button";
import { getResearchItems } from "@/app/lib/api/researchFiles";
import { legalSourceViewerHref, type ResearchEvidence, type ResearchFile, type ResearchPageItem,
  type ResearchSource } from "@/app/lib/researchFiles";
import { evidenceCitation } from "@/app/lib/groundedAnswers";
import type { Citation } from "@/app/lib/citations";
import { errorMessage } from "@/app/lib/utils";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import type { usePagedChains } from "@/app/hooks/usePagedChains";
import { ResearchLabelPicker } from "./ResearchLabelPicker";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { RESEARCH_PASSAGE_DRAG } from "./researchMemo";
import { ResearchSourceAnswers } from "./ResearchWorkspaceViews";

export const PAGE_SIZE = 50;
export const sourceName = (source: ResearchSource) => source.reference.title || source.reference.citation || source.reference.id;
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

type Removal = { kind: "source"; id: string; name: string } | { kind: "evidence"; id: string; sourceId: string; name: string };
export function ResearchSourceList({ sources, reader, opened, setOpened, passageVisible, selectedSourceId, picked, onPick,
  onCite, onRemove, onStatus, onSourceDrag, page, onPage }: {
  sources: ResearchSource[]; reader: SourceReader; opened: Set<string>; setOpened: Dispatch<SetStateAction<Set<string>>>;
  passageVisible: (item: ResearchEvidence) => boolean; selectedSourceId?: string;
  picked?: Set<string>; onPick?: (evidenceId: string, picked: boolean) => void;
  onCite: (source: ResearchSource, passage?: ResearchEvidence) => void; onRemove: (removal: Removal) => void;
  onStatus: (message: string) => void; onSourceDrag?: () => void; page: number; onPage: (page: number) => void;
}) {
  const { file, mutations: commit, passages: passagePages } = useSourcesWorkspace(), navigate = useNavigate();
  const toggle = (id: string, open?: boolean) => setOpened((current) => { const next = new Set(current);
    if (open ?? !next.has(id)) next.add(id); else next.delete(id); return next; });
  function link(source: ResearchSource, text: string, locator?: string, title = false) {
    const href = reader.sourceHref(source, locator), className = title
      ? "rounded text-left text-sm font-semibold leading-5 hover:text-brand focus-visible:outline focus-visible:outline-2"
      : buttonClassName({ variant: "outline", size: "compact", className: locator
        ? "h-auto min-h-7 min-w-0 max-w-full shrink whitespace-normal [overflow-wrap:anywhere]" : undefined });
    return reader.canRead(source)
      ? <button type="button" aria-current={title && selectedSourceId === source.id ? "true" : undefined}
      className={className} onClick={() => void reader.readSource(source, locator)}>{text}</button>
      : !href ? <span>{text}</span> : href.startsWith("/")
      ? <Link to={href} className={className}>{text}</Link> : <a href={href} className={className}>{text}</a>;
  }
  const openSource = (source: ResearchSource) => {
    const href = reader.sourceHref(source);
    if (reader.canRead(source)) void reader.readSource(source);
    else if (href?.startsWith("/")) navigate(href);
    else if (href) window.open(href, "_blank", "noopener,noreferrer");
  };
  if (!file) return null;
  const pages = Math.ceil(sources.length / PAGE_SIZE);
  return <>
    {sources.length ? <ol>{sources.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((source) => {
      const name = sourceName(source), open = opened.has(source.id), sourcePage = passagePages.chains[source.id],
        evidence = sourcePage?.items.flatMap((item) => item.kind === "passage" && passageVisible(item.value) ? [item.value] : []) ?? [];
      return <li key={source.id} className={`border-b border-gray-200 last:border-0 ${selectedSourceId === source.id ? "bg-gray-100" : ""}`}>
        <details open={open} className="group rounded hover:bg-gray-50" onToggle={(event) => toggle(source.id, event.currentTarget.open)}>
          <summary className="relative grid list-none grid-cols-[1.5rem_auto_minmax(0,1fr)] items-start gap-1.5 py-1.5 pe-1 text-sm"
            onClick={(event) => { if (!(event.target as Element).closest("button,a,input")) event.preventDefault(); }}>
            <button type="button" aria-label={`Passages in ${name}`} aria-expanded={open}
              onClick={(event) => { event.preventDefault(); toggle(source.id); }}
              className="grid size-6 shrink-0 place-items-center rounded hover:bg-gray-200">
              <ChevronRight aria-hidden="true" className="size-3 text-gray-500 group-open:rotate-90" /></button>
            <ResearchLabelPicker file={file} kind="source" itemId={source.id} labelIds={source.labelIds}
              badge={source.badge} badgeColor={source.badgeColor} note={source.note} title={name} size="sm"
              onError={onStatus} onSourceDrag={onSourceDrag} mutations={commit} />
            <span className="min-w-0 [overflow-wrap:anywhere]"><span className="block">{link(source, name, undefined, true)}</span>
              {source.reference.citation && source.reference.citation !== name && <span className="block text-xs text-gray-600">{source.reference.citation}</span>}
              {source.note && <span className="line-clamp-1 whitespace-pre-wrap text-xs text-gray-600 group-open:line-clamp-none">{source.note}</span>}</span>
            <span className="absolute end-1 top-1 flex items-center gap-0.5 rounded bg-white/90 opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:col-span-3 [@media(hover:none)]:opacity-100">
              <Button variant="outline" size="compact" aria-label={`Cite ${name}`} onClick={(event) => { event.preventDefault(); onCite(source); }}>Cite</Button>
              <MoreActionsMenu label={`${name} options`} items={[
                ...(reader.sourceHref(source) ? [{ label: "Open source", onSelect: () => openSource(source) }] : []),
                { label: "Remove source", onSelect: () => onRemove({ kind: "source", id: source.id, name }) },
              ]} />
            </span>
          </summary>
          {open && <div className="space-y-2 pb-2 pe-1 ps-6 text-sm leading-5">
            {sourcePage?.loading && !sourcePage.items.length && <p role="status" className="text-xs text-gray-500">Loading passages…</p>}
            {!!sourcePage?.error && <Button variant="outline" size="compact" onClick={() => void passagePages.fetchPage(source.id, null, false)}>Retry passages</Button>}
            {evidence.map((item) => { const locator = item.receipt.locator.label;
              return <div key={item.receipt.evidence_id} draggable
                onDragStart={(event) => { event.dataTransfer.setData(RESEARCH_PASSAGE_DRAG, JSON.stringify(item)); }}
                className="group/passage border-s-2 border-gray-200 ps-2">
                <div className="relative grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-1 pe-1">
                  {onPick ? <input type="checkbox" aria-label={`Select ${locator}`} checked={picked?.has(item.receipt.evidence_id) ?? false}
                    onChange={(event) => onPick(item.receipt.evidence_id, event.target.checked)} className="mt-1.5" /> : <span />}
                  <ResearchLabelPicker file={file} kind="evidence" itemId={item.receipt.evidence_id} sourceId={source.id}
                    labelIds={item.labelIds} note={item.note} title={locator} size="sm" onError={onStatus} mutations={commit} />
                  {link(source, locator, locator)}
                  <span className="absolute end-0 top-0 flex gap-0.5 rounded bg-white/90 opacity-0 focus-within:opacity-100 group-hover/passage:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:col-span-3 [@media(hover:none)]:opacity-100">
                    <Button variant="outline" size="compact" aria-label={`Cite ${locator}`} onClick={() => onCite(source, item)}>Cite</Button>
                    <button type="button" aria-label={`Delete ${locator}`}
                      onClick={() => onRemove({ kind: "evidence", id: item.receipt.evidence_id, sourceId: source.id, name: locator })}
                      className="grid size-7 place-items-center rounded text-gray-400 hover:bg-gray-200 hover:text-red-700"><Trash2 className="size-3" /></button>
                  </span>
                </div>
                <p className="line-clamp-3 text-gray-600 [overflow-wrap:anywhere]">{item.receipt.span_text}</p>
                {item.note && <p className="text-gray-700 [overflow-wrap:anywhere]">{item.note}</p>}
              </div>; })}
            {sourcePage?.nextCursor && <button type="button" aria-label={`Show more passages from ${name}`}
              disabled={sourcePage.loading} onClick={() => void passagePages.fetchPage(source.id, sourcePage.nextCursor, true)}
              className={buttonClassName({ variant: "outline", size: "compact", className: "w-full" })}>Show more passages</button>}
            <ResearchSourceAnswers sourceId={source.id} onCitation={reader.openAnswerCitation} />
          </div>}
        </details></li>;
    })}</ol> : <p className="p-2 text-xs text-gray-500">No sources in this view.</p>}
    {pages > 1 && <div className="mt-2 flex items-center justify-center gap-2 text-xs">
      <Button variant="outline" size="compact" disabled={!page} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page + 1} of {pages}</span>
      <Button variant="outline" size="compact" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>}
  </>;
}
