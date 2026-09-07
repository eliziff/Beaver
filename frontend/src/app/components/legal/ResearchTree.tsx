import { useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, FileText, Scale } from "lucide-react";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button } from "../ui/button";
import { researchLabelPath, researchHighlightCount, type ResearchEvidence, type ResearchLabel, type ResearchSource } from "@/app/lib/researchFiles";
import { researchLabelColor } from "./ResearchLabelCircle";
import { ResearchLabelEditor, RESEARCH_SOURCE_DRAG, type ResearchLabelTarget } from "./ResearchLabelPicker";
import { ResearchLabelTree } from "./ResearchLabelTree";
import { RESEARCH_PASSAGE_DRAG } from "./researchMemo";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { sourceName, type SourceReader } from "./useSourceReader";

export type ResearchRemoval = { kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string };
export type ResearchTreePreview = { labels: Record<string, ResearchLabel>; marks: Record<string, "added" | "changed"> };
type Row = { depth: number } & ({ kind: "source"; source: ResearchSource }
  | { kind: "passage"; source: ResearchSource; item: ResearchEvidence }
  | { kind: "extra"; source: ResearchSource });
const NO_ROWS = new Set<string>();

/** Virtual folders navigate one source list. A source never needs an exclusive location. */
export function ResearchTree({ reader, sources, navigationSources = sources, filter = "", matches = null,
  labelId = null, onLabelChange = () => undefined, picked, onPick, selectedSourceId,
  opened = NO_ROWS, setOpened = () => undefined, passageVisible = () => true,
  onRemove = () => undefined, onStatus = () => undefined, onSourceDrag, preview, passagePages: suppliedPages }: {
  reader?: SourceReader; sources: ResearchSource[]; navigationSources?: ResearchSource[]; filter?: string;
  labelId?: string | null; onLabelChange?: (id: string | null) => void;
  passagePages?: ReturnType<typeof useSourcesWorkspace>["passages"];
  matches?: { evidence: Set<string>; sources: Set<string> } | null;
  picked?: Set<string>; onPick?: (evidenceId: string, picked: boolean) => void; selectedSourceId?: string;
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
  const markClass = (id: string) => mark(id) ? "font-semibold underline decoration-gray-400" : "";
  const rowClass = (active: boolean) => `group relative flex min-h-10 w-full min-w-0 items-center gap-1.5 rounded pe-1 py-1 ${active ? "bg-gray-100" : "hover:bg-gray-50"}`;
  const openSource = (id: string) => setOpened((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const chevron = (open: boolean, label: string, onClick: () => void) => <button type="button"
    aria-label={label} aria-expanded={open} onClick={onClick} className="grid size-6 shrink-0 place-items-center rounded">
    <ChevronRight aria-hidden className={`size-3.5 text-gray-500 ${open ? "rotate-90" : ""}`} /></button>;
  const spacer = <span className="size-6 shrink-0" />;
  /** Readable sources open in place; anything else keeps its safe link. */
  function openLink(source: ResearchSource, text: string, locator: string | undefined,
    className: string, current?: boolean, evidenceId?: string) {
    const href = reader?.sourceHref(source, locator);
    if (preview) return <span className={className}>{text}</span>;
    if (reader?.canRead(source)) return <button type="button" className={className}
      aria-current={current ? "true" : undefined}
      onClick={() => void reader.readSource(source, locator, evidenceId)}>{text}</button>;
    if (!href) return <span className={className}>{text}</span>;
    return href.startsWith("/") ? <Link to={href} className={className}>{text}</Link>
      : <a href={href} className={className}>{text}</a>;
  }
  function sourceRow(row: Extract<Row, { kind: "source" }>) {
    const { source } = row, name = sourceName(source), open = opened.has(source.id);
    const href = reader?.sourceHref(source), Icon = source.reference.kind === "document" ? FileText : Scale;
    const openIt = () => { if (reader?.canRead(source)) void reader.readSource(source);
      else if (href) window.open(href, "_blank", "noopener,noreferrer"); };
    return <div className={rowClass(selectedSourceId === source.id)} draggable={!preview}
      onDragStart={(event) => { onSourceDrag?.(); event.dataTransfer.setData(RESEARCH_SOURCE_DRAG, source.id); }}
      style={{ paddingInlineStart: 4 + row.depth * 16 }}>
      {preview ? spacer : chevron(open, `Passages in ${name}`, () => openSource(source.id))}
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-gray-500" />
      <span data-mark={mark(source.id)} title={name} className="min-w-0 flex-1 truncate">
        {openLink(source, name, undefined, `max-w-full truncate text-start text-sm ${markClass(source.id)}`,
          selectedSourceId === source.id)}
      </span>
      {!!researchHighlightCount(source) && <span className="ms-auto shrink-0 tabular-nums text-xs text-gray-500">{researchHighlightCount(source)}</span>}
      {!preview && <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <MoreActionsMenu label={`${name} options`} items={[
          ...(href || reader?.canRead(source) ? [{ label: "Open", onSelect: openIt }] : []),
          { label: "Labels", onSelect: () => setLabelTarget({ file: file!, kind: "source", itemId: source.id,
            labelIds: source.labelIds, note: source.note, title: name }) },
          { label: "Remove", onSelect: () => onRemove({ kind: "source", id: source.id, name }) },
        ]} /></span>}
    </div>;
  }

  function passageRow(row: Extract<Row, { kind: "passage" }>) {
    const { source, item } = row, locator = item.receipt.locator.label;
    const typeName = item.labelIds[0] ? researchLabelPath(labels, item.labelIds[0]).map(({ name }) => name).join(" / ") : "";
    const color = item.labelIds[0] ? researchLabelColor(labels[item.labelIds[0]]) : "#d1d5db";
    return <div draggable onDragStart={(event) => event.dataTransfer.setData(RESEARCH_PASSAGE_DRAG, JSON.stringify(item))}
      className={`${rowClass(false)} !h-auto items-start py-1`} style={{ paddingInlineStart: 4 + row.depth * 16 }}>
      {onPick ? <input type="checkbox" aria-label={`Select ${locator}`} checked={picked?.has(item.receipt.evidence_id) ?? false}
        onChange={(event) => onPick(item.receipt.evidence_id, event.target.checked)} className="mt-1.5 shrink-0" /> : spacer}
      <span className="min-w-0 flex-1 border-s-2 ps-2" style={{ borderColor: color }}>
        {openLink(source, typeName ? `${typeName} · ${locator}` : locator, locator, "block max-w-full truncate text-start text-xs font-medium text-gray-700", false, item.receipt.evidence_id)}
        <span className="line-clamp-2 text-xs text-gray-600 [overflow-wrap:anywhere]">{item.receipt.span_text}</span>
        {item.note && <span className="block text-xs text-gray-700 [overflow-wrap:anywhere]">{item.note}</span>}
      </span>
      <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <MoreActionsMenu label={`${locator} options`} items={[
          { label: "Highlight type", onSelect: () => setLabelTarget({ file: file!, kind: "evidence", itemId: item.receipt.evidence_id,
            sourceId: source.id, labelIds: item.labelIds, note: item.note, title: locator }) },
          { label: "Delete", onSelect: () => onRemove({ kind: "evidence", id: item.receipt.evidence_id, sourceId: source.id, name: locator }) },
        ]} /></span>
    </div>;
  }

  function extraRow(row: Extract<Row, { kind: "extra" }>) {
    const { source } = row, page = passagePages.chains[source.id];
    return <div className="space-y-1 py-1" style={{ paddingInlineStart: 4 + row.depth * 16 }}>
      {source.note && <p className="whitespace-pre-wrap text-xs text-gray-600 [overflow-wrap:anywhere]">{source.note}</p>}
      {page?.loading && !page.items.length && <p role="status" className="text-xs text-gray-500">Loading passages…</p>}
      {!!page?.error && <Button variant="outline" size="compact" onClick={() => void passagePages.fetchPage(source.id, null, false)}>Retry passages</Button>}
      {page?.nextCursor && <Button variant="outline" size="compact" disabled={page.loading}
        aria-label={`Show more passages from ${sourceName(source)}`}
        onClick={() => void passagePages.fetchPage(source.id, page.nextCursor, true)}>Show more</Button>}
    </div>;
  }


  /** One tree: labels nest, and each source hangs under every label it carries. */
  const sourceNode = (source: ResearchSource, depth: number, key: string) =>
    <div key={key} role="treeitem" aria-label={sourceName(source)}
      aria-expanded={opened.has(source.id)} aria-selected={selectedSourceId === source.id}>
      {sourceRow({ kind: "source", source, depth })}
      {opened.has(source.id) && !preview && <div role="group">
        {passagePages.chains[source.id]?.items.flatMap((item) => (item.kind === "passage" || item.kind === "evidence") && passageVisible(item.value)
          ? [<div key={item.value.receipt.evidence_id} role="treeitem" aria-label={item.value.receipt.locator.label}>
              {passageRow({ kind: "passage", source, item: item.value, depth: depth + 1 })}
            </div>] : [])}
        {extraRow({ kind: "extra", source, depth: depth + 1 })}
      </div>}
    </div>;
  const under = (labelId: string | null) => sources.filter((source) => labelId
    ? source.labelIds.includes(labelId)
    : !source.labelIds.some((id) => labels[id]?.scope === "source"));

  return <>
    <ResearchLabelTree scope="source" sources={navigationSources} selectedId={labelId} onSelect={onLabelChange}
      onRemove={onRemove} onStatus={onStatus} preview={preview}
      renderSources={(id) => under(id).map((source) => sourceNode(source, id ? 1 : 0, `${id ?? ""}:${source.id}`))} />
    {!sources.length && <p className="p-2 text-xs text-gray-500">{filter || matches || labelId ? "No matching sources." : "No sources yet."}</p>}
    {labelTarget && <ResearchLabelEditor target={labelTarget} mutations={commit} onError={onStatus} onClose={() => setLabelTarget(null)} />}
  </>;
}
