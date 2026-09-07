import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Circle, FileText, Scale } from "lucide-react";
import { InlineNameInput } from "../shared/InlineNameInput";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button } from "../ui/button";
import { researchLabelPath, researchHighlightCount, type ResearchAction, type ResearchEvidence, type ResearchLabel,
  type ResearchSource } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { researchLabelColor } from "./ResearchLabelCircle";
import { ResearchLabelEditor, RESEARCH_SOURCE_DRAG, RESEARCH_SOURCE_REFERENCE_DRAG,
  type ResearchLabelTarget } from "./ResearchLabelPicker";
import { RESEARCH_PASSAGE_DRAG } from "./researchMemo";
import { ResearchSourceAnswers } from "./ResearchWorkspaceViews";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { sourceMatches, sourceName, type SourceReader } from "./useSourceReader";

const LABEL_DRAG = "application/x-beaver-research-label";
const COLLAPSED = "beaver.research.collapsed.v1";
export type ResearchRemoval = { kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string };
/** Proposed labels and assignments rendered in place of the saved ones, marked where they differ. */
export type ResearchTreePreview = { labels: Record<string, ResearchLabel>;
  marks: Record<string, "added" | "changed"> };
type Row = { key: string; depth: number } & ({ kind: "label"; label: ResearchLabel; count: number }
  | { kind: "source"; source: ResearchSource }
  | { kind: "passage"; source: ResearchSource; item: ResearchEvidence }
  | { kind: "extra"; source: ResearchSource });
type Drop = { id: string; mode: "before" | "inside" | "after" };

const readCollapsed = (id?: string) => { try { const value = id
  ? JSON.parse(localStorage.getItem(`${COLLAPSED}:${id}`) ?? "null") : null;
  return new Set<string>(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch { return new Set<string>(); } };

const NO_ROWS = new Set<string>();
/** One tree: labels are nodes, sources leaves under every label they carry, passages under a source. */
export function ResearchTree({ reader, sources, filter = "", matches = null, picked, onPick, selectedSourceId,
  opened = NO_ROWS, setOpened = () => undefined, passageVisible = () => true,
  onRemove = () => undefined, onStatus = () => undefined, onSourceDrag, preview, passagePages: suppliedPages }: {
  reader?: SourceReader; sources: ResearchSource[]; filter?: string;
  passagePages?: ReturnType<typeof useSourcesWorkspace>["passages"];
  matches?: { evidence: Set<string>; sources: Set<string> } | null;
  picked?: Set<string>; onPick?: (evidenceId: string, picked: boolean) => void; selectedSourceId?: string;
  opened?: Set<string>; setOpened?: Dispatch<SetStateAction<Set<string>>>;
  passageVisible?: (item: ResearchEvidence) => boolean;
  onRemove?: (removal: ResearchRemoval) => void; onStatus?: (message: string) => void;
  onSourceDrag?: () => void; preview?: ResearchTreePreview;
}) {
  const { file, mutations: commit, passages } = useSourcesWorkspace();
  const passagePages = suppliedPages ?? passages;
  const labels = preview?.labels ?? file?.state.labels ?? {};
  const [collapsed, setCollapsed] = useState(() => readCollapsed(file?.document.id));
  const [renaming, setRenaming] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState<Drop | null>(null), dragged = useRef<string | null>(null);
  const [labelTarget, setLabelTarget] = useState<ResearchLabelTarget | null>(null);
  useEffect(() => { if (file && !preview) localStorage.setItem(`${COLLAPSED}:${file.document.id}`,
    JSON.stringify([...collapsed])); }, [collapsed, file, preview]);

  const children = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).filter(({ scope }) => scope === "source").forEach((label) => {
      const values = map.get(label.parentId) ?? []; values.push(label); map.set(label.parentId, values); });
    map.forEach((values) => values.sort((a, b) => a.order - b.order)); return map; }, [labels]);
  const counts = useMemo(() => { const totals: Record<string, number> = {};
    for (const source of sources) { const applied = new Set<string>();
      source.labelIds.forEach((id) => researchLabelPath(labels, id).forEach(({ id: item, scope }) => {
        if (scope === "source") applied.add(item); }));
      applied.forEach((id) => { totals[id] = (totals[id] ?? 0) + 1; }); }
    return totals; }, [labels, sources]);

  async function act(action: ResearchAction) {
    if (!file) return null;
    try { return await commit.act(action); }
    catch (reason) { onStatus(errorMessage(reason, "Could not update workspace")); return null; }
  }
  function canReparent(id: string, parentId: string | null) {
    const label = labels[id], parent = parentId ? labels[parentId] : null;
    return !!label && id !== parentId && !(parentId && (!parent || parent.scope !== label.scope ||
      researchLabelPath(labels, parentId).some((item) => item.id === id)));
  }
  async function reparent(id: string, parentId: string | null, order?: number) {
    const label = labels[id]; if (!label || !canReparent(id, parentId)) return;
    await act({ type: "label", ...label, parentId, order: order ?? label.order });
  }
  function keyMove(label: ResearchLabel, key: string) {
    const siblings = children.get(label.parentId) ?? [], index = siblings.findIndex(({ id }) => id === label.id);
    if (key === "ArrowUp" && index > 0) void reparent(label.id, label.parentId, siblings[index - 1].order - .5);
    else if (key === "ArrowDown" && index + 1 < siblings.length) void reparent(label.id, label.parentId, siblings[index + 1].order + .5);
    else if (key === "ArrowRight" && index > 0) void reparent(label.id, siblings[index - 1].id, children.get(siblings[index - 1].id)?.length ?? 0);
    else if (key === "ArrowLeft" && label.parentId) { const parent = labels[label.parentId];
      if (parent) void reparent(label.id, parent.parentId, parent.order + .5); }
    else return false;
    return true;
  }

  const needle = filter.trim().toLowerCase();
  const named = (label: ResearchLabel) => label.name.toLowerCase().includes(needle);
  const under = (id: string) => sources.filter(({ labelIds }) => labelIds.includes(id));
  const kept = (label: ResearchLabel): boolean => !needle || named(label) ||
    under(label.id).some((source) => sourceMatches(source, needle)) ||
    (children.get(label.id) ?? []).some(kept);
  const toggle = (id: string) => setCollapsed((current) => { const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const openSource = (id: string, open?: boolean) => setOpened((current) => { const next = new Set(current);
    if (open ?? !next.has(id)) next.add(id); else next.delete(id); return next; });

  const rows: Row[] = [];
  function pushSource(source: ResearchSource, parent: string, depth: number) {
    rows.push({ key: `${parent}:${source.id}`, depth, kind: "source", source });
    if (!opened.has(source.id) || preview) return;
    const page = passagePages.chains[source.id];
    page?.items.forEach((item) => { if ((item.kind === "passage" || item.kind === "evidence") && passageVisible(item.value))
      rows.push({ key: `${parent}:${source.id}:${item.value.receipt.evidence_id}`, depth: depth + 1,
        kind: "passage", source, item: item.value }); });
    rows.push({ key: `${parent}:${source.id}:extra`, depth: depth + 1, kind: "extra", source });
  }
  function pushLabels(parentId: string | null, depth: number, matched: boolean) {
    for (const label of children.get(parentId) ?? []) {
      if (!matched && !kept(label)) continue;
      rows.push({ key: label.id, depth, kind: "label", label, count: counts[label.id] ?? 0 });
      if (collapsed.has(label.id)) continue;
      const inside = matched || named(label);
      pushLabels(label.id, depth + 1, inside);
      for (const source of under(label.id)) if (inside || sourceMatches(source, needle))
        pushSource(source, label.id, depth + 1);
    }
  }
  pushLabels(null, 0, false);
  // Lack of classification is not a synthetic folder or label.
  for (const source of sources) if (!source.labelIds.some((id) => labels[id]?.scope === "source") && sourceMatches(source, needle))
    pushSource(source, "root", 0);

  if (!file) return null;
  const mark = (id: string) => preview?.marks[id];
  const markClass = (id: string) => mark(id) === "added" ? "text-green-800"
    : mark(id) === "changed" ? "text-amber-800" : "";
  const rowClass = (active: boolean, id?: string) => `group relative flex h-9 w-full min-w-0 items-center gap-1.5 rounded-md pe-1 ${
    drop && drop.id === id ? drop.mode === "inside" ? "bg-blue-50 ring-1 ring-inset ring-blue-300"
      : drop.mode === "before" ? "before:absolute before:inset-x-1 before:top-0 before:h-0.5 before:rounded before:bg-brand"
        : "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded after:bg-brand"
    : active ? "bg-gray-100" : "hover:bg-gray-50"}`;
  const chevron = (open: boolean, label: string, onClick: () => void) => <button type="button"
    aria-label={label} onClick={onClick} className="grid size-5 shrink-0 place-items-center rounded">
    <ChevronRight aria-hidden="true" className={`size-3.5 text-gray-500 ${open ? "rotate-90" : ""}`} /></button>;
  const spacer = <span className="size-5 shrink-0" />;

  function labelRow(row: Extract<Row, { kind: "label" }>) {
    const { label, count } = row, open = !collapsed.has(label.id);
    const expandable = !!children.get(label.id)?.length || !!under(label.id).length;
    return <div data-tree-drop-folder={label.id} draggable={!preview} tabIndex={0}
      onKeyDown={(event) => { if (event.target !== event.currentTarget || preview) return;
        if (event.altKey && keyMove(label, event.key)) { event.preventDefault(); event.stopPropagation(); } }}
      onDragStart={(event) => { if ((event.target as Element).closest("button,input,label,a")) { event.preventDefault(); return; }
        dragged.current = label.id; event.dataTransfer.setData(LABEL_DRAG, label.id); event.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => { dragged.current = null; setDrop(null); }}
      onDragOver={(event) => {
        const source = event.dataTransfer.types.includes(RESEARCH_SOURCE_DRAG) ||
          event.dataTransfer.types.includes(RESEARCH_SOURCE_REFERENCE_DRAG);
        const moving = labels[dragged.current ?? ""];
        if (!source && (!event.dataTransfer.types.includes(LABEL_DRAG) || !moving)) return setDrop(null);
        const box = event.currentTarget.getBoundingClientRect(), y = (event.clientY - box.top) / box.height,
          mode = source ? "inside" : event.clientX - box.left > Math.min(96, box.width * .55) ? "inside" : y < .5 ? "before" : "after";
        if (!source && !canReparent(moving.id, mode === "inside" ? label.id : label.parentId)) return setDrop(null);
        event.preventDefault(); setDrop({ id: label.id, mode }); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(null); }}
      onDrop={(event) => { event.preventDefault(); const mode = drop?.id === label.id ? drop.mode : "inside"; setDrop(null);
        const sourceId = event.dataTransfer.getData(RESEARCH_SOURCE_DRAG), source = file!.state.sources[sourceId];
        if (source) { void act({ type: "annotate", kind: "source", id: sourceId,
          labelIds: [label.id, ...source.labelIds.filter((id) => id !== label.id)] }); return; }
        const raw = event.dataTransfer.getData(RESEARCH_SOURCE_REFERENCE_DRAG);
        if (raw) { try { void act({ type: "source", reference: JSON.parse(raw), labelIds: [label.id] }); }
          catch { /* Invalid drag payload. */ } return; }
        dragged.current = null;
        void reparent(event.dataTransfer.getData(LABEL_DRAG), mode === "inside" ? label.id : label.parentId,
          mode === "inside" ? children.get(label.id)?.length ?? 0 : label.order + (mode === "before" ? -.5 : .5)); }}
      className={rowClass(false, label.id)} style={{ paddingInlineStart: 4 + row.depth * 16 }}>
      {expandable ? chevron(open, `${open ? "Collapse" : "Expand"} ${label.name}`, () => toggle(label.id)) : spacer}
      {preview ? <Circle aria-hidden="true" className="size-3 shrink-0" fill={researchLabelColor(label)}
        stroke={researchLabelColor(label)} />
        : <label title={`${label.name} colour`} className="relative grid size-5 shrink-0 cursor-pointer place-items-center rounded focus-within:outline focus-within:outline-2">
          <Circle aria-hidden="true" className="size-3" fill={researchLabelColor(label)} stroke={researchLabelColor(label)} />
          <input type="color" value={researchLabelColor(label)} aria-label={`${label.name} colour`}
            onChange={(event) => void act({ type: "label", ...label, color: event.target.value })}
            className="absolute inset-0 cursor-pointer opacity-0" />
        </label>}
      {renaming === label.id ? <InlineNameInput kind="folder" value={label.name} label="Label name" disabled={busy}
        onCancel={() => setRenaming(null)} onCommit={(value) => { setRenaming(null);
          if (value.trim() && value !== label.name) void act({ type: "label", ...label, name: value.trim() }); }} />
        : <><span className={`min-w-0 flex-1 truncate text-sm font-medium ${markClass(label.id)}`}
          data-mark={mark(label.id)}>{label.name}</span>
        <span className="ms-auto shrink-0 tabular-nums text-xs text-gray-500">{count}</span>
        {!preview && <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <MoreActionsMenu label={`${label.name} options`} items={[
            { label: "Rename", onSelect: () => setRenaming(label.id) },
            { label: "Add nested label", onSelect: () => void addLabel(label.id) },
            { label: "Delete", onSelect: () => onRemove({ kind: "label", id: label.id, name: label.name }) },
          ]} /></span>}</>}
    </div>;
  }

  async function addLabel(parentId: string | null) {
    setBusy(true);
    try { const id = crypto.randomUUID();
      if (parentId) setCollapsed((values) => { const next = new Set(values); next.delete(parentId); return next; });
      await commit.act({ type: "label", id, name: "New label", parentId, scope: "source", color: "#3498db" });
      setRenaming(id);
    } catch (reason) { onStatus(errorMessage(reason, "Could not add label")); }
    finally { setBusy(false); }
  }

  /** Readable sources open in place; anything else keeps its safe link. */
  function openLink(source: ResearchSource, text: string, locator: string | undefined,
    className: string, current?: boolean) {
    const href = reader?.sourceHref(source, locator);
    if (preview) return <span className={className}>{text}</span>;
    if (reader?.canRead(source)) return <button type="button" className={className}
      aria-current={current ? "true" : undefined}
      onClick={() => void reader.readSource(source, locator)}>{text}</button>;
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
          selectedSourceId === source.id)}</span>
      {!!researchHighlightCount(source) && <span className="ms-auto shrink-0 tabular-nums text-xs text-gray-500">{researchHighlightCount(source)}</span>}
      {!preview && <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <MoreActionsMenu label={`${name} options`} items={[
          ...(href || reader?.canRead(source) ? [{ label: "Open", onSelect: openIt }] : []),
          { label: "Labels", onSelect: () => setLabelTarget({ file: file!, kind: "source", itemId: source.id,
            labelIds: source.labelIds, badge: source.badge, badgeColor: source.badgeColor, note: source.note, title: name }) },
          { label: "Remove", onSelect: () => onRemove({ kind: "source", id: source.id, name }) },
        ]} /></span>}
    </div>;
  }

  function passageRow(row: Extract<Row, { kind: "passage" }>) {
    const { source, item } = row, locator = item.receipt.locator.label;
    const color = item.labelIds[0] ? researchLabelColor(labels[item.labelIds[0]]) : "#d1d5db";
    return <div draggable onDragStart={(event) => event.dataTransfer.setData(RESEARCH_PASSAGE_DRAG, JSON.stringify(item))}
      className={`${rowClass(false)} !h-auto items-start py-1`} style={{ paddingInlineStart: 4 + row.depth * 16 }}>
      {onPick ? <input type="checkbox" aria-label={`Select ${locator}`} checked={picked?.has(item.receipt.evidence_id) ?? false}
        onChange={(event) => onPick(item.receipt.evidence_id, event.target.checked)} className="mt-1.5 shrink-0" /> : spacer}
      <span className="min-w-0 flex-1 border-s-2 ps-2" style={{ borderColor: color }}>
        {openLink(source, locator, locator, "block max-w-full truncate text-start text-xs font-medium text-gray-700")}
        <span className="line-clamp-2 block text-xs text-gray-600 [overflow-wrap:anywhere]">{item.receipt.span_text}</span>
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
      {page?.loading && !page.items.length && <p role="status" className="text-xs text-gray-500">Loading passages…</p>}
      {!!page?.error && <Button variant="outline" size="compact" onClick={() => void passagePages.fetchPage(source.id, null, false)}>Retry passages</Button>}
      {page?.nextCursor && <Button variant="outline" size="compact" disabled={page.loading}
        aria-label={`Show more passages from ${sourceName(source)}`}
        onClick={() => void passagePages.fetchPage(source.id, page.nextCursor, true)}>Show more</Button>}
      {reader && <ResearchSourceAnswers sourceId={source.id} onCitation={reader.openAnswerCitation} />}
    </div>;
  }

  const body: ReactNode[] = rows.map((row) => {
    const content = row.kind === "label" ? labelRow(row) : row.kind === "source" ? sourceRow(row)
      : row.kind === "passage" ? passageRow(row) : extraRow(row);
    const name = row.kind === "label" ? `${row.label.name}, ${row.count} sources`
      : row.kind === "source" ? sourceName(row.source) : row.kind === "passage" ? row.item.receipt.locator.label : undefined;
    return <div key={row.key} role={row.kind === "extra" ? undefined : "treeitem"} aria-label={name} aria-level={row.depth + 1}
      aria-expanded={row.kind === "label" ? !collapsed.has(row.label.id) : row.kind === "source" ? opened.has(row.source.id) : undefined}
      aria-selected={row.kind === "source" ? selectedSourceId === row.source.id : undefined}>{content}</div>;
  });

  return <>
    <div role="tree" aria-label={preview ? "Proposed labels" : "Labels and sources"} className="min-w-0">
      {body}
      {!rows.length && <p className="p-2 text-xs text-gray-500">{needle || matches ? "No matches." : "No sources yet."}</p>}
    </div>
    {!preview && <button type="button" data-tree-drop-root disabled={busy} onClick={() => void addLabel(null)}
      onDragOver={(event) => { const moving = labels[dragged.current ?? ""];
        if (!moving || !canReparent(moving.id, null)) return setDrop(null);
        event.preventDefault(); setDrop({ id: "root", mode: "inside" }); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(null); }}
      onDrop={(event) => { event.preventDefault(); setDrop(null); dragged.current = null;
        const id = event.dataTransfer.getData(LABEL_DRAG);
        if (labels[id]) void reparent(id, null, children.get(null)?.length ?? 0); }}
      className={`mt-1 flex h-8 w-full items-center rounded-md border border-dashed px-2 text-start text-sm text-gray-500 hover:text-gray-800 ${
        drop?.id === "root" ? "border-brand bg-blue-50" : "border-gray-300 hover:border-gray-500"}`}>
      {drop?.id === "root" ? "Move to top level" : "Add label"}
    </button>}
    {labelTarget && <ResearchLabelEditor target={labelTarget} mutations={commit} onError={onStatus}
      onClose={() => setLabelTarget(null)} />}
  </>;
}
