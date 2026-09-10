import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChevronRight, FileText, Gavel, Landmark, Newspaper, ScrollText } from "lucide-react";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button } from "../ui/button";
import { researchHighlightCount, researchLabelPath, type ResearchEvidence, type ResearchLabel, type ResearchSource } from "@/app/lib/researchFiles";
import { researchLabelColor } from "./ResearchLabelMarker";
import { ResearchLabelEditor, RESEARCH_SOURCE_DRAG, type ResearchLabelTarget } from "./ResearchLabelPicker";
import { ResearchLabelTree } from "./ResearchLabelTree";
import { passageLabel, trimPassageMarker } from "@/app/lib/researchPassage";
import { RESEARCH_PASSAGE_DRAG } from "./researchMemo";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { sourceName, type SourceReader } from "./useSourceReader";

export type ResearchRemoval = { kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string };
export type ResearchTreePreview = { labels: Record<string, ResearchLabel>; marks: Record<string, "added" | "changed"> };
const NO_ROWS = new Set<string>();
const KIND_ICON = { case: Gavel, legislation: ScrollText, journal: Newspaper, hansard: Landmark, document: FileText } as const;
const NEWLINE = "\n";
/** What the tree lists when a source opens: its chain is `kind: "passages"`, which the workspace
 *  serves as the typed passages only — an untyped one is never a row, so it never earns a caret. */
const passageTotal = researchHighlightCount;
/** File-explorer row: one fixed-height line, chevron, glyph, name, actions, number.
 *  Nothing wraps, so a row can never grow into the one above it. */
export const ROW = "group flex h-7 min-w-0 items-center gap-1 rounded px-1";
export const ROW_ACTIONS = "flex w-7 shrink-0 items-center justify-end opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100";

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
  // A highlight type lists its passages on request; nothing loads before that. `wanted` only grows,
  // so two open types never take the request list away from each other.
  const [wanted, setWanted] = useState<ReadonlySet<string>>(() => new Set());
  const [shownTypes, setShownTypes] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    for (const id of wanted) if (!passagePages.chains[id]) void passagePages.fetchPage(id, null, false);
  }, [wanted, passagePages.chains, passagePages.fetchPage]);
  if (!file) return null;
  const mark = (id: string) => preview?.marks[id];
  const openSource = (id: string) => setOpened((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const chevron = (open: boolean, label: string, onClick: () => void) => <button type="button"
    aria-label={label} aria-expanded={open} onClick={onClick} className="grid size-6 shrink-0 place-items-center rounded">
    <ChevronRight aria-hidden className={`size-3.5 text-gray-500 ${open ? "rotate-90" : ""}`} /></button>;
  /** Opening is always a deliberate control, never a side effect of touching the row. */
  function openControl(source: ResearchSource, name: string, locator?: string, evidenceId?: string, spoken?: string, icon?: ReactNode) {
    const href = reader?.sourceHref(source, locator),
      className = "grid size-6 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
      inner = icon ?? <BookOpen aria-hidden className="size-3.5" />, label = `Open ${[spoken ?? locator, name].filter(Boolean).join(" in ")}`;
    if (preview) return icon ? <span className={className}>{inner}</span> : null;
    if (reader?.canRead(source)) return <button type="button" aria-label={label} title="Open" className={className}
      onClick={() => void reader.readSource(source, locator, evidenceId)}>{inner}</button>;
    if (!href) return null;
    return href.startsWith("/") ? <Link to={href} aria-label={label} title="Open" className={className}>{inner}</Link>
      : <a href={href} aria-label={label} title="Open" className={className}>{inner}</a>;
  }
  function sourceRow(source: ResearchSource) {
    const name = sourceName(source), open = opened.has(source.id), expandable = !preview && passageTotal(source) > 0;
    return <div data-source-row={source.id} className={`${ROW} ${selectedSourceId === source.id ? "bg-gray-100" : "hover:bg-gray-50"}`} draggable={!preview}
      onDragStart={(event) => { onSourceDrag?.(); event.dataTransfer.setData(RESEARCH_SOURCE_DRAG, source.id); }}>
      {/* No caret where there is nothing to show: an empty group used to flash "Loading…" and vanish (Eli, 2026-09-09). */}
      {expandable ? chevron(open, `Passages in ${name}`, () => openSource(source.id)) : <span className="size-6 shrink-0" />}
      {(() => { const Icon = KIND_ICON[source.reference.kind] ?? FileText, icon = <Icon aria-hidden className="size-3.5" />;
        return openControl(source, name, undefined, undefined, undefined, icon) ?? <span className="grid size-6 shrink-0 place-items-center text-gray-500">{icon}</span>; })()}
      <button type="button" disabled={!!preview} onClick={() => { if (expandable) openSource(source.id); }} title={[name, source.note].filter(Boolean).join(NEWLINE)}
        aria-current={selectedSourceId === source.id ? "true" : undefined} data-mark={mark(source.id)}
        className={`min-w-0 flex-1 truncate text-start text-sm text-gray-700 ${mark(source.id) ? "font-semibold underline decoration-gray-400" : ""}`}>{name}</button>
      <span className={ROW_ACTIONS}>
        {!preview && <MoreActionsMenu label={`${name} options`} items={[
          { label: "Label", onSelect: () => { const row = document.querySelector<HTMLElement>(`[data-source-row="${source.id}"]`)!;
            setLabelTarget({ file: file!, kind: "source", itemId: source.id, labelIds: source.labelIds, note: source.note,
              title: name, anchor: row.getBoundingClientRect(), returnFocus: row }); } },
          { label: "Remove", onSelect: () => onRemove({ kind: "source", id: source.id, name }) },
        ]} />}
      </span>
    </div>;
  }

  function passageRow(source: ResearchSource, item: ResearchEvidence) {
    const locator = passageLabel(item.receipt.locator), id = item.highlightId ?? item.receipt.evidence_id;
    const color = labels[item.labelIds[0]] ? researchLabelColor(labels[item.labelIds[0]]) : "#d1d5db";
    const quote = trimPassageMarker(item.receipt.span_text ?? "", item.receipt.locator);
    // The other hierarchy flattens to one leaf name here: a type under source labels, a source under
    // highlight types. Neither tree ever mirrors the other's folders (Eli, 2026-09-09).
    const context = scope === "source" ? labels[item.labelIds[0]]?.name : sourceName(source);
    return <div draggable onDragStart={(event) => event.dataTransfer.setData(RESEARCH_PASSAGE_DRAG, JSON.stringify(item))}
      title={[locator, quote, item.note].filter(Boolean).join(NEWLINE)}
      className={`${ROW} ${selectedHighlight === id ? "bg-gray-100" : "hover:bg-gray-50"}`}>
      <span className="size-6 shrink-0" />
      <span className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {!!context && <span title={context} className="max-w-24 shrink-0 truncate text-[10px] text-gray-500">{context}</span>}
      {/* The passage row is the open action: it selects the passage and reads it (Eli, 2026-09-10). */}
      <button type="button" onClick={() => { setSelectedHighlight(id);
          if (!preview && reader?.canRead(source)) void reader.readSource(source, item.receipt.locator.label, item.receipt.evidence_id); }}
        className="min-w-0 flex-1 truncate text-start text-xs text-gray-600">
        <span className="font-medium text-gray-700">{locator}</span> {quote}
      </button>
      <span className={ROW_ACTIONS}>
        <MoreActionsMenu label={`${locator} options`} items={[
          { label: "Highlight type", onSelect: () => setLabelTarget({ file: file!, kind: "evidence", itemId: id,
            sourceId: source.id, labelIds: item.labelIds, note: item.note, title: locator, anchor: document.activeElement?.getBoundingClientRect() }) },
          { label: "Delete", onSelect: () => onRemove({ kind: "evidence", id, sourceId: source.id, name: locator }) },
        ]} />
      </span>
    </div>;
  }

  /** One tree: labels nest, and each source hangs under every label it carries. */
  const sourceNode = (source: ResearchSource, labelId: string | null) => {
    const page = passagePages.chains[source.id];
    return <div key={`${labelId ?? ""}:${source.id}`} role="treeitem" aria-label={sourceName(source)}
      aria-expanded={passageTotal(source) ? opened.has(source.id) : undefined} aria-selected={selectedSourceId === source.id}>
      {sourceRow(source)}
      {opened.has(source.id) && !preview && <div role="group" className="ms-4">
        {page?.items.flatMap((item) => (item.kind === "passage" || item.kind === "evidence") && passageVisible(item.value)
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
  const ofType = (typeId: string) => (id: string) => id === typeId || researchLabelPath(labels, id).some((label) => label.id === typeId);
  /** A highlight type owns its own hierarchy and nothing else: it lists the passages carrying it or a
   *  descendant type, flat, on request — never a second copy of the source folders (Eli, 2026-09-09). */
  const typePassages = (typeId: string) => {
    const counted = (source: ResearchSource) => Object.entries(source.passages?.labelCounts ?? {})
      .reduce((sum, [id, count]) => sum + (ofType(typeId)(id) ? count : 0), 0);
    const carrying = sources.filter((source) => counted(source) > 0), total = carrying.reduce((sum, source) => sum + counted(source), 0);
    if (!total) return [];
    const shown = shownTypes.has(typeId), typeName = labels[typeId]?.name ?? "type", plural = total === 1 ? "" : "s";
    const toggle = <button key={`${typeId}:toggle`} type="button" aria-expanded={shown}
      aria-label={`${shown ? "Hide" : "Show"} ${total} passage${plural} of ${typeName}`}
      onClick={() => setShownTypes((current) => { const next = new Set(current); if (!next.delete(typeId)) next.add(typeId); return next; })}
      className={`${ROW} w-full text-xs text-gray-500 hover:bg-gray-50`}>
      <span className="grid size-6 shrink-0 place-items-center">
        <ChevronRight aria-hidden className={`size-3.5 ${shown ? "rotate-90" : ""}`} /></span>
      <span className="min-w-0 flex-1 truncate text-start">{total} passage{plural}</span>
      <span className={ROW_ACTIONS} /></button>;
    if (!shown) return [toggle];
    const missing = carrying.filter((source) => !passagePages.chains[source.id] && !wanted.has(source.id)).map(({ id }) => id);
    if (missing.length) setWanted((current) => new Set([...current, ...missing]));
    const rows = carrying.flatMap((source) => (passagePages.chains[source.id]?.items ?? []).flatMap((item) => {
      const value = (item.kind === "passage" || item.kind === "evidence") && passageVisible(item.value) &&
        item.value.labelIds.some(ofType(typeId)) ? item.value : null;
      return value ? [<div key={`${typeId}:${value.highlightId ?? value.receipt.evidence_id}`} role="treeitem"
        aria-label={value.receipt.locator.label} aria-selected={selectedHighlight === (value.highlightId ?? value.receipt.evidence_id)}>
        {passageRow(source, value)}</div>] : [];
    }));
    if (rows.length) return [toggle, ...rows];
    // "Loading" only while a chain really is on its way, so an empty list never poses as a slow one.
    const pending = carrying.some((source) => !passagePages.chains[source.id] || passagePages.chains[source.id].loading);
    return pending ? [toggle, <p key={`${typeId}:loading`} role="status" className={`${ROW} text-xs text-gray-500`}>Loading passages…</p>] : [toggle];
  };
  const under = (labelId: string | null) => sources.filter((source) => scope === "highlight"
    ? false : labelId
    ? source.labelIds.includes(labelId) && !source.labelIds.some((id) => id !== labelId &&
        researchLabelPath(labels, id).some(({ id: ancestor }) => ancestor === labelId))
    : !source.labelIds.some((id) => labels[id]?.scope === "source"));

  return <>
    <ResearchLabelTree scope={scope} sources={navigationSources} selectedId={labelId} onSelect={onLabelChange}
      onRemove={onRemove} onStatus={onStatus} preview={preview}
      renderSources={(id) => scope === "highlight" ? (id ? typePassages(id) : []) : under(id).map((source) => sourceNode(source, id))} />
    {!sources.length && <p className="p-2 text-xs text-gray-500">{filter || labelId ? "No matching sources." : "No sources yet."}</p>}
    {labelTarget && <ResearchLabelEditor target={labelTarget} mutations={commit} onError={onStatus} onClose={() => setLabelTarget(null)} />}
  </>;
}
