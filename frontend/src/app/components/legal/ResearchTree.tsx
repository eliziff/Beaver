import { useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button } from "../ui/button";
import { researchHighlightCount, researchLabelPath, type ResearchEvidence, type ResearchLabel, type ResearchSource } from "@/app/lib/researchFiles";
import { researchLabelColor } from "./ResearchLabelCircle";
import { ResearchLabelEditor, RESEARCH_SOURCE_DRAG, type ResearchLabelTarget } from "./ResearchLabelPicker";
import { RESEARCH_PASSAGE_DRAG } from "./researchMemo";
import { ResearchSourceAnswers } from "./ResearchWorkspaceViews";
import { ResearchHierarchy } from "./ResearchHierarchy";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { evidenceCitation } from "@/app/lib/groundedAnswers";
import { sourceName, type SourceReader } from "./useSourceReader";

export type ResearchRemoval = { kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string };
export type ResearchTreePreview = { labels: Record<string, ResearchLabel>; marks: Record<string, "added" | "changed"> };
const NO_ROWS = new Set<string>();

/** A source occurs once. Folder navigation lives above this list, never around its rows. */
export function ResearchTree({ reader, sources, filter = "", matches = null, picked, onPick, selectedSourceId,
  opened = NO_ROWS, setOpened = () => undefined, passageVisible = () => true, passagePages: suppliedPages,
  onRemove = () => undefined, onStatus = () => undefined, onSourceDrag, preview }: {
  reader?: SourceReader; sources: ResearchSource[]; filter?: string;
  matches?: { evidence: Set<string>; sources: Set<string> } | null;
  picked?: Set<string>; onPick?: (evidenceId: string, picked: boolean) => void; selectedSourceId?: string;
  opened?: Set<string>; setOpened?: Dispatch<SetStateAction<Set<string>>>;
  passageVisible?: (item: ResearchEvidence) => boolean;
  passagePages?: ReturnType<typeof useSourcesWorkspace>["passages"];
  onRemove?: (removal: ResearchRemoval) => void; onStatus?: (message: string) => void;
  onSourceDrag?: () => void; preview?: ResearchTreePreview;
}) {
  const { file, mutations, passages } = useSourcesWorkspace(), pages = suppliedPages ?? passages;
  const labels = preview?.labels ?? file?.state.labels ?? {};
  const [labelTarget, setLabelTarget] = useState<ResearchLabelTarget | null>(null);
  if (!file) return null;
  function openLink(source: ResearchSource, text: string, locator?: string, evidenceId?: string) {
    const href = reader?.sourceHref(source, locator, evidenceId);
    const className = "block max-w-full text-left text-sm leading-5 text-gray-800 [overflow-wrap:anywhere] hover:underline";
    if (preview) return <span>{text}</span>;
    if (reader?.canRead(source)) return <button type="button" className={className}
      aria-current={!locator && selectedSourceId === source.id ? "true" : undefined}
      onClick={() => void reader.readSource(source, locator, evidenceId)}>{text}</button>;
    if (!href) return <span className={className}>{text}</span>;
    return href.startsWith("/") ? <Link to={href} className={className}>{text}</Link>
      : <a href={href} className={className}>{text}</a>;
  }
  return <>
    {preview && <ResearchHierarchy scope="source" preview={preview} onRemove={onRemove} onStatus={onStatus} />}
    <ul aria-label={preview ? "Proposed sources" : "Research sources"} className="min-w-0 divide-y divide-gray-100">
      {sources.map((source) => {
        const name = sourceName(source), open = opened.has(source.id), page = pages.chains[source.id], count = researchHighlightCount(source);
        const paths = source.labelIds.filter((id) => !source.labelIds.some((other) => other !== id && researchLabelPath(labels, other).some((label) => label.id === id)))
          .map((id) => researchLabelPath(labels, id).map(({ name }) => name).join(" › ")).filter(Boolean).join(" · ");
        return <li key={source.id} data-source-id={source.id} aria-label={name} data-mark={preview?.marks[source.id]} className="py-1">
          <div draggable={!preview} onDragStart={(event) => { onSourceDrag?.(); event.dataTransfer.setData(RESEARCH_SOURCE_DRAG, source.id); }}
            className={`group flex min-h-11 min-w-0 items-start gap-1 rounded px-1 py-1.5 ${selectedSourceId === source.id ? "bg-gray-100" : "hover:bg-gray-50"}`}>
            {!preview && <button type="button" aria-label={`Passages in ${name}`} aria-expanded={open}
              onClick={() => setOpened((current) => { const next = new Set(current); if (open) next.delete(source.id); else next.add(source.id); return next; })}
              className="grid size-6 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-200">
              <ChevronRight aria-hidden="true" className={`size-3.5 ${open ? "rotate-90" : ""}`} /></button>}
            <div className="min-w-0 flex-1">
              {openLink(source, name)}
              {source.reference.citation && source.reference.citation !== name && <span className="block text-xs text-gray-500">{source.reference.citation}</span>}
              {paths && <span className="block truncate text-xs leading-5 text-gray-500" title={paths}>{paths}</span>}
            </div>
            {!!count && <span className="mt-1 shrink-0 text-xs tabular-nums text-gray-500" title={`${count} saved passages`}>{count}</span>}
            {!preview && <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
              <MoreActionsMenu label={`${name} options`} items={[
                { label: "Labels / note", onSelect: () => setLabelTarget({ file, kind: "source", itemId: source.id,
                  labelIds: source.labelIds, badge: source.badge, badgeColor: source.badgeColor, note: source.note, title: name }) },
                { label: "Remove", onSelect: () => onRemove({ kind: "source", id: source.id, name }) },
              ]} />
            </span>}
          </div>
          {open && !preview && <div className="space-y-2 pb-2 ps-7 pe-1">
            {page?.items.map((entry) => {
              if (entry.kind !== "passage" || !passageVisible(entry.value)) return null;
              const item = entry.value, receipt = item.receipt, type = labels[item.labelIds[0]];
              const path = type ? researchLabelPath(labels, type.id).map(({ name }) => name).join(" › ") : "";
              const location = evidenceCitation(receipt, 1)?.pinpoint ?? receipt.locator.label;
              return <div key={receipt.evidence_id} className="group flex min-w-0 items-start gap-1" draggable
                onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData(RESEARCH_PASSAGE_DRAG, JSON.stringify(item)); }}>
                {onPick && <input type="checkbox" aria-label={`Select ${receipt.locator.label}`} checked={picked?.has(receipt.evidence_id) ?? false}
                  onChange={(event) => onPick(receipt.evidence_id, event.target.checked)} className="mt-1" />}
                <div className="min-w-0 flex-1 border-s-2 ps-2" style={{ borderColor: type ? researchLabelColor(type) : "#d1d5db" }}>
                  <div className="flex min-w-0 items-center gap-2 text-xs text-gray-500"><span className="min-w-0 flex-1 truncate" title={path}>{path}</span><span className="shrink-0">{location}</span></div>
                  <div className="line-clamp-2">{openLink(source, receipt.span_text ?? location, receipt.locator.label, receipt.evidence_id)}</div>
                  {item.note && <p className="text-xs text-gray-600 [overflow-wrap:anywhere]">{item.note}</p>}
                </div>
                <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"><MoreActionsMenu label={`${receipt.locator.label} options`} items={[
                  { label: "Highlight type / note", onSelect: () => setLabelTarget({ file, kind: "evidence", itemId: receipt.evidence_id, sourceId: source.id, labelIds: item.labelIds, note: item.note, title: location }) },
                  { label: "Delete highlight", onSelect: () => onRemove({ kind: "evidence", id: receipt.evidence_id, sourceId: source.id, name: location }) },
                ]} /></span>
              </div>;
            })}
            {page?.loading && !page.items.length && <p role="status" className="text-xs text-gray-500">Loading passages…</p>}
            {!!page?.error && <Button variant="outline" size="compact" onClick={() => void pages.fetchPage(source.id, null, false)}>Retry passages</Button>}
            {page?.nextCursor && <Button variant="ghost" size="compact" disabled={page.loading} aria-label={`Show more passages from ${name}`}
              onClick={() => void pages.fetchPage(source.id, page.nextCursor, true)}>Show more</Button>}
            {source.note && <p className="text-sm text-gray-600 [overflow-wrap:anywhere]">{source.note}</p>}
            {reader && <ResearchSourceAnswers sourceId={source.id} onCitation={reader.openAnswerCitation} />}
          </div>}
        </li>;
      })}
    </ul>
    {!sources.length && <p className="p-2 text-xs text-gray-500">{filter || matches ? "No matches." : "No sources here."}</p>}
    {labelTarget && <ResearchLabelEditor target={labelTarget} mutations={mutations} onError={onStatus} onClose={() => setLabelTarget(null)} />}
  </>;
}
