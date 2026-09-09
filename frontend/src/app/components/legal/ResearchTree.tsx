import { useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChevronRight } from "lucide-react";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button } from "../ui/button";
import { researchHighlightCount, researchLabelPath, type ResearchEvidence, type ResearchLabel, type ResearchSource } from "@/app/lib/researchFiles";
import { researchLabelColor, ResearchLabelMarker } from "./ResearchLabelMarker";
import { ResearchLabelEditor, RESEARCH_SOURCE_DRAG, type ResearchLabelTarget } from "./ResearchLabelPicker";
import { ResearchLabelTree } from "./ResearchLabelTree";
import { passageLabel, trimPassageMarker } from "@/app/lib/researchPassage";
import { RESEARCH_PASSAGE_DRAG } from "./researchMemo";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { sourceName, type SourceReader } from "./useSourceReader";

export type ResearchRemoval = { kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string };
export type ResearchTreePreview = { labels: Record<string, ResearchLabel>; marks: Record<string, "added" | "changed"> };
const NO_ROWS = new Set<string>();
const NEWLINE = "\n";
/** File-explorer row: one fixed-height line, chevron, glyph, name, actions, number.
 *  Nothing wraps, so a row can never grow into the one above it. */
export const ROW = "group flex h-7 min-w-0 items-center gap-1 rounded px-1";
export const ROW_ACTIONS = "flex w-14 shrink-0 items-center justify-end gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100";
export const ROW_COUNT = "w-6 shrink-0 text-end text-xs tabular-nums text-gray-500";

/** Virtual folders navigate one source list. A source never needs an exclusive location. */
export function ResearchTree({ scope = "source", reader, sources, navigationSources = sources, filter = "",
  labelId = null, onLabelChange = () => undefined, selectedSourceId,
  opened = NO_ROWS, setOpened = () => undefined, passageVisible = () => true,
  onRemove = () => undefined, onStatus = () => undefined, onSourceDrag, preview, passagePages: suppliedPages }: {
  scope?: "source" | "highlight"; reader?: SourceReader; sources: ResearchSource[]; navigationSources?: ResearchSource[]; filter?: string;
  labelId?: string | null; onLabelChange?: (id: string | null) => void;
  passagePages?: ReturnType<typeof useSourcesWorkspace>["passages"]; selectedSourceId?: string;
  opened?: Set<string>; setOpened?: Dispatch<SetStateAction<Set<string>>>;
  passageVisible?: (item: ResearchEvidence) => boolean;
  onRemove?: (removal: ResearchRemoval) => void; onStatus?: (message: string) => void;
  onSourceDrag?: () => void; preview?: ResearchTreePreview;
}) {
  const { file, mutations: commit, passages } = useSourcesWorkspace();
  const passagePages = suppliedPages ?? passages, labels = preview?.labels ?? file?.state.labels ?? {};
  const [selectedHighlight, setSelectedHighlight] = useState<string | null>(null);
  const [labelTarget, setLabelTarget] = useState<ResearchLabelTarget | null>(null);
  if (!file) return null;
  const mark = (id: string) => preview?.marks[id];
  const openSource = (id: string) => setOpened((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const chevron = (open: boolean, label: string, onClick: () => void) => <button type="button"
    aria-label={label} aria-expanded={open} onClick={onClick} className="grid size-6 shrink-0 place-items-center rounded">
    <ChevronRight aria-hidden className={`size-3.5 text-gray-500 ${open ? "rotate-90" : ""}`} /></button>;
  /** Opening is always a deliberate control, never a side effect of touching the row. */
  function openControl(source: ResearchSource, name: string, locator?: string, evidenceId?: string, spoken?: string) {
    if (preview) return null;
    const href = reader?.sourceHref(source, locator),
      className = "grid size-6 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
      inner = <BookOpen aria-hidden className="size-3.5" />, label = `Open ${[spoken ?? locator, name].filter(Boolean).join(" in ")}`;
    if (reader?.canRead(source)) return <button type="button" aria-label={label} title="Open" className={className}
      onClick={() => void reader.readSource(source, locator, evidenceId)}>{inner}</button>;
    if (!href) return null;
    return href.startsWith("/") ? <Link to={href} aria-label={label} title="Open" className={className}>{inner}</Link>
      : <a href={href} aria-label={label} title="Open" className={className}>{inner}</a>;
  }
  function sourceRow(source: ResearchSource, count: number) {
    const name = sourceName(source), open = opened.has(source.id);
    return <div className={`${ROW} ${selectedSourceId === source.id ? "bg-gray-100" : "hover:bg-gray-50"}`} draggable={!preview}
      onDragStart={(event) => { onSourceDrag?.(); event.dataTransfer.setData(RESEARCH_SOURCE_DRAG, source.id); }}>
      {preview ? <span className="size-6 shrink-0" /> : chevron(open, `Passages in ${name}`, () => openSource(source.id))}
      <button type="button" data-source-marker={source.id} disabled={!!preview} aria-label={`Label ${name}`} onClick={(event) => setLabelTarget({ file: file!, kind: "source", itemId: source.id,
        labelIds: source.labelIds, note: source.note, title: name, anchor: event.currentTarget.getBoundingClientRect(), returnFocus: event.currentTarget })} className="grid min-h-6 shrink-0 place-items-center rounded">
        <ResearchLabelMarker labels={labels} labelIds={source.labelIds} size="sm" /></button>
      <button type="button" disabled={!!preview} onClick={() => openSource(source.id)} title={[name, source.note].filter(Boolean).join(NEWLINE)}
        aria-current={selectedSourceId === source.id ? "true" : undefined} data-mark={mark(source.id)}
        className={`min-w-0 flex-1 truncate text-start text-sm text-gray-700 ${mark(source.id) ? "font-semibold underline decoration-gray-400" : ""}`}>{name}</button>
      <span className={ROW_ACTIONS}>
        {openControl(source, name)}
        {!preview && <MoreActionsMenu label={`${name} options`} items={[
          { label: "Remove", onSelect: () => onRemove({ kind: "source", id: source.id, name }) },
        ]} />}
      </span>
      <span className={ROW_COUNT}>{count || ""}</span>
    </div>;
  }

  function passageRow(source: ResearchSource, item: ResearchEvidence) {
    const locator = passageLabel(item.receipt.locator), id = item.highlightId ?? item.receipt.evidence_id;
    const color = labels[item.labelIds[0]] ? researchLabelColor(labels[item.labelIds[0]]) : "#d1d5db";
    const quote = trimPassageMarker(item.receipt.span_text ?? "", item.receipt.locator);
    return <div draggable onDragStart={(event) => event.dataTransfer.setData(RESEARCH_PASSAGE_DRAG, JSON.stringify(item))}
      title={[locator, quote, item.note].filter(Boolean).join(NEWLINE)}
      className={`${ROW} ${selectedHighlight === id ? "bg-gray-100" : "hover:bg-gray-50"}`}>
      <span className="size-6 shrink-0" />
      <span className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <button type="button" onClick={() => setSelectedHighlight(id)} className="min-w-0 flex-1 truncate text-start text-xs text-gray-600">
        <span className="font-medium text-gray-700">{locator}</span> {quote}
      </button>
      <span className={ROW_ACTIONS}>
        {openControl(source, sourceName(source), item.receipt.locator.label, item.receipt.evidence_id, locator)}
        <MoreActionsMenu label={`${locator} options`} items={[
          { label: "Highlight type", onSelect: () => setLabelTarget({ file: file!, kind: "evidence", itemId: id,
            sourceId: source.id, labelIds: item.labelIds, note: item.note, title: locator, anchor: document.activeElement?.getBoundingClientRect() }) },
          { label: "Delete", onSelect: () => onRemove({ kind: "evidence", id, sourceId: source.id, name: locator }) },
        ]} />
      </span>
      <span className={ROW_COUNT} />
    </div>;
  }

  /** One tree: labels nest, and each source hangs under every label it carries. */
  const sourceNode = (source: ResearchSource, labelId: string | null) => {
    const page = passagePages.chains[source.id], path = (id: string) => JSON.stringify(researchLabelPath(labels, id).map(({ name }) => name)),
      matched = labelId === null ? [] : scope === "highlight" ? [labelId] : Object.values(labels).filter((label) => label.scope === "highlight" && path(label.id) === path(labelId)).map(({ id }) => id),
      types = matched.length ? new Set(matched) : null,
      count = types ? [...types].reduce((sum, id) => sum + (source.passages?.labelCounts[id] ?? 0), 0) : researchHighlightCount(source);
    return <div key={`${labelId ?? ""}:${source.id}`} role="treeitem" aria-label={sourceName(source)}
      aria-expanded={opened.has(source.id)} aria-selected={selectedSourceId === source.id}>
      {sourceRow(source, count)}
      {opened.has(source.id) && !preview && <div role="group" className="ms-4">
        {page?.items.flatMap((item) => (item.kind === "passage" || item.kind === "evidence") && passageVisible(item.value) && (!types || item.value.labelIds.some((id) => types.has(id)))
          ? [<div key={item.value.highlightId ?? item.value.receipt.evidence_id} role="treeitem" aria-selected={selectedHighlight === (item.value.highlightId ?? item.value.receipt.evidence_id)} aria-label={item.value.receipt.locator.label}>
              {passageRow(source, item.value)}
            </div>] : [])}
        {page?.loading && !page.items.length && <p role="status" className={`${ROW} text-xs text-gray-500`}>Loading passages…</p>}
        {!!page?.error && <Button variant="outline" size="compact" className="my-1" onClick={() => void passagePages.fetchPage(source.id, null, false)}>Retry passages</Button>}
        {page?.nextCursor && <Button variant="outline" size="compact" className="my-1" disabled={page.loading}
          aria-label={`Show more passages from ${sourceName(source)}`}
          onClick={() => void passagePages.fetchPage(source.id, page.nextCursor, true)}>Show more</Button>}
      </div>}
    </div>;
  };
  // Ancestors count inherited membership; rows appear only at the deepest explicit filing in each branch.
  const under = (labelId: string | null) => sources.filter((source) => scope === "highlight"
    ? !!labelId && !!source.passages?.labelCounts[labelId] : labelId
    ? source.labelIds.includes(labelId) && !source.labelIds.some((id) => id !== labelId &&
        researchLabelPath(labels, id).some(({ id: ancestor }) => ancestor === labelId))
    : !source.labelIds.some((id) => labels[id]?.scope === "source"));

  return <>
    <ResearchLabelTree scope={scope} sources={navigationSources} selectedId={labelId} onSelect={onLabelChange}
      onRemove={onRemove} onStatus={onStatus} preview={preview}
      renderSources={(id) => under(id).map((source) => sourceNode(source, id))} />
    {!sources.length && <p className="p-2 text-xs text-gray-500">{filter || labelId ? "No matching sources." : "No sources yet."}</p>}
    {labelTarget && <ResearchLabelEditor target={labelTarget} mutations={commit} onError={onStatus} onClose={() => setLabelTarget(null)} />}
  </>;
}
