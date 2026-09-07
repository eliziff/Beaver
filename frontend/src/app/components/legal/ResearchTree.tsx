import { useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChevronRight, FileText, Scale } from "lucide-react";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button } from "../ui/button";
import { researchHighlightCount, type ResearchEvidence, type ResearchLabel, type ResearchSource } from "@/app/lib/researchFiles";
import { researchLabelColor } from "./ResearchLabelMarker";
import { ResearchLabelEditor, ResearchLabelPicker, RESEARCH_SOURCE_DRAG, type ResearchLabelTarget } from "./ResearchLabelPicker";
import { ResearchLabelTree } from "./ResearchLabelTree";
import { RESEARCH_PASSAGE_DRAG } from "./researchMemo";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { sourceName, type SourceReader } from "./useSourceReader";

export type ResearchRemoval = { kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string };
export type ResearchTreePreview = { labels: Record<string, ResearchLabel>; marks: Record<string, "added" | "changed"> };
const NO_ROWS = new Set<string>();
/** Every row shares one shape: chevron, glyph, name, actions, number. Nothing moves when a mark appears. */
export const ROW = "group flex min-h-8 min-w-0 items-center gap-1 rounded px-1";
export const ROW_ACTIONS = "flex w-7 shrink-0 items-center justify-end gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 @[22rem]:w-14";
export const ROW_COUNT = "w-6 shrink-0 text-end text-xs tabular-nums text-gray-500";

/** Virtual folders navigate one source list. A source never needs an exclusive location. */
export function ResearchTree({ reader, sources, navigationSources = sources, filter = "",
  labelId = null, onLabelChange = () => undefined, selectedSourceId, addSignal,
  opened = NO_ROWS, setOpened = () => undefined, passageVisible = () => true,
  onRemove = () => undefined, onStatus = () => undefined, onSourceDrag, preview, passagePages: suppliedPages }: {
  reader?: SourceReader; sources: ResearchSource[]; navigationSources?: ResearchSource[]; filter?: string;
  labelId?: string | null; onLabelChange?: (id: string | null) => void; addSignal?: number;
  passagePages?: ReturnType<typeof useSourcesWorkspace>["passages"]; selectedSourceId?: string;
  opened?: Set<string>; setOpened?: Dispatch<SetStateAction<Set<string>>>;
  passageVisible?: (item: ResearchEvidence) => boolean;
  onRemove?: (removal: ResearchRemoval) => void; onStatus?: (message: string) => void;
  onSourceDrag?: () => void; preview?: ResearchTreePreview;
}) {
  const { file, mutations: commit, passages } = useSourcesWorkspace();
  const passagePages = suppliedPages ?? passages, labels = preview?.labels ?? file?.state.labels ?? {};
  const [labelTarget, setLabelTarget] = useState<ResearchLabelTarget | null>(null);
  if (!file) return null;
  const mark = (id: string) => preview?.marks[id];
  const openSource = (id: string) => setOpened((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const chevron = (open: boolean, label: string, onClick: () => void) => <button type="button"
    aria-label={label} aria-expanded={open} onClick={onClick} className="grid size-6 shrink-0 place-items-center rounded">
    <ChevronRight aria-hidden className={`size-3.5 text-gray-500 ${open ? "rotate-90" : ""}`} /></button>;
  /** Opening is always a deliberate control, never a side effect of touching the row. */
  function openControl(source: ResearchSource, name: string, locator?: string, evidenceId?: string) {
    if (preview) return null;
    const href = reader?.sourceHref(source, locator),
      className = "hidden size-6 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-200 @[22rem]:grid",
      inner = <BookOpen aria-hidden className="size-3.5" />, label = `Open ${locator ?? name}`;
    if (reader?.canRead(source)) return <button type="button" aria-label={label} title="Open" className={className}
      onClick={() => void reader.readSource(source, locator, evidenceId)}>{inner}</button>;
    if (!href) return null;
    return href.startsWith("/") ? <Link to={href} aria-label={label} title="Open" className={className}>{inner}</Link>
      : <a href={href} aria-label={label} title="Open" className={className}>{inner}</a>;
  }
  function sourceRow(source: ResearchSource) {
    const name = sourceName(source), open = opened.has(source.id), count = researchHighlightCount(source);
    const Icon = source.reference.kind === "document" ? FileText : Scale;
    return <div className={`${ROW} ${selectedSourceId === source.id ? "bg-gray-100" : "hover:bg-gray-50"}`} draggable={!preview}
      onDragStart={(event) => { onSourceDrag?.(); event.dataTransfer.setData(RESEARCH_SOURCE_DRAG, source.id); }}>
      {preview ? <span className="size-6 shrink-0" /> : chevron(open, `Passages in ${name}`, () => openSource(source.id))}
      {preview ? <span className="grid size-5 shrink-0 place-items-center"><Icon aria-hidden className="size-3.5 text-gray-500" /></span>
        : <ResearchLabelPicker file={file} kind="source" itemId={source.id} labelIds={source.labelIds} note={source.note}
            title={name} size="sm" mutations={commit} onError={onStatus} onSourceDrag={onSourceDrag} />}
      <button type="button" disabled={!!preview} onClick={() => openSource(source.id)} title={name}
        aria-current={selectedSourceId === source.id ? "true" : undefined} data-mark={mark(source.id)}
        className={`min-w-0 flex-1 truncate text-start text-sm text-gray-700 ${mark(source.id) ? "font-semibold underline decoration-gray-400" : ""}`}>{name}</button>
      <span className={ROW_ACTIONS}>
        {openControl(source, name)}
        {!preview && <MoreActionsMenu label={`${name} options`} items={[
          ...(reader?.canRead(source) ? [{ label: "Open", onSelect: () => void reader.readSource(source) }] : []),
          { label: "Labels", onSelect: () => setLabelTarget({ file: file!, kind: "source", itemId: source.id,
            labelIds: source.labelIds, note: source.note, title: name }) },
          { label: "Remove", onSelect: () => onRemove({ kind: "source", id: source.id, name }) },
        ]} />}
      </span>
      <span className={ROW_COUNT}>{count || ""}</span>
    </div>;
  }

  function passageRow(source: ResearchSource, item: ResearchEvidence) {
    const locator = item.receipt.locator.label;
    const color = item.labelIds[0] ? researchLabelColor(labels[item.labelIds[0]]) : "#d1d5db";
    return <div draggable onDragStart={(event) => event.dataTransfer.setData(RESEARCH_PASSAGE_DRAG, JSON.stringify(item))}
      className={`${ROW} items-start py-1 hover:bg-gray-50`}>
      <span className="size-6 shrink-0" />
      <span className="mt-1 h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-gray-700">{locator}</span>
        <span className="line-clamp-2 text-xs text-gray-600 [overflow-wrap:anywhere]">{item.receipt.span_text}</span>
        {item.note && <span className="block text-xs text-gray-700 [overflow-wrap:anywhere]">{item.note}</span>}
      </span>
      <span className={ROW_ACTIONS}>
        {openControl(source, sourceName(source), locator, item.receipt.evidence_id)}
        <MoreActionsMenu label={`${locator} options`} items={[
          { label: "Highlight type", onSelect: () => setLabelTarget({ file: file!, kind: "evidence", itemId: item.receipt.evidence_id,
            sourceId: source.id, labelIds: item.labelIds, note: item.note, title: locator }) },
          { label: "Delete", onSelect: () => onRemove({ kind: "evidence", id: item.receipt.evidence_id, sourceId: source.id, name: locator }) },
        ]} />
      </span>
      <span className={ROW_COUNT} />
    </div>;
  }

  /** One tree: labels nest, and each source hangs under every label it carries. */
  const sourceNode = (source: ResearchSource, key: string) => {
    const page = passagePages.chains[source.id];
    return <div key={key} role="treeitem" aria-label={sourceName(source)}
      aria-expanded={opened.has(source.id)} aria-selected={selectedSourceId === source.id}>
      {sourceRow(source)}
      {opened.has(source.id) && !preview && <div role="group" className="ms-4">
        {page?.items.flatMap((item) => (item.kind === "passage" || item.kind === "evidence") && passageVisible(item.value)
          ? [<div key={item.value.receipt.evidence_id} role="treeitem" aria-label={item.value.receipt.locator.label}>
              {passageRow(source, item.value)}
            </div>] : [])}
        {source.note && <p className="px-1 py-1 text-xs text-gray-600 [overflow-wrap:anywhere]">{source.note}</p>}
        {page?.loading && !page.items.length && <p role="status" className="px-1 py-1 text-xs text-gray-500">Loading passages…</p>}
        {!!page?.error && <Button variant="outline" size="compact" className="my-1" onClick={() => void passagePages.fetchPage(source.id, null, false)}>Retry passages</Button>}
        {page?.nextCursor && <Button variant="outline" size="compact" className="my-1" disabled={page.loading}
          aria-label={`Show more passages from ${sourceName(source)}`}
          onClick={() => void passagePages.fetchPage(source.id, page.nextCursor, true)}>Show more</Button>}
      </div>}
    </div>;
  };
  const under = (labelId: string | null) => sources.filter((source) => labelId
    ? source.labelIds.includes(labelId)
    : !source.labelIds.some((id) => labels[id]?.scope === "source"));

  return <>
    <ResearchLabelTree scope="source" sources={navigationSources} selectedId={labelId} onSelect={onLabelChange}
      onRemove={onRemove} onStatus={onStatus} preview={preview} addSignal={addSignal}
      renderSources={(id) => under(id).map((source) => sourceNode(source, `${id ?? ""}:${source.id}`))} />
    {!sources.length && <p className="p-2 text-xs text-gray-500">{filter || labelId ? "No matching sources." : "No sources yet."}</p>}
    {labelTarget && <ResearchLabelEditor target={labelTarget} mutations={commit} onError={onStatus} onClose={() => setLabelTarget(null)} />}
  </>;
}
