import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { ResearchSelectionLabels } from "../shared/ResearchSelectionLabels";
import { ActionMenu } from "../ui/action-menu";
import { Tabs } from "../ui/tabs";
import { Button, buttonClassName } from "../ui/button";
import { getResearchCitation, getResearchItems } from "@/app/lib/api/researchFiles";
import { legalSourceViewerHref, type ResearchAction, type ResearchEvidence, type ResearchLabel,
  type ResearchSource, type ResearchSelection } from "@/app/lib/researchFiles";
import { evidenceCitation } from "@/app/lib/groundedAnswers";
import type { Citation } from "@/app/lib/citations";
import { errorMessage } from "@/app/lib/utils";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { ResearchLabelPicker } from "./ResearchLabelPicker";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { RESEARCH_PASSAGE_DRAG, memoCitation as parseMemoCitation } from "./researchMemo";
import { ResearchSourceAnswers, WorkspaceOrganize } from "./ResearchWorkspaceViews";
import { ResearchCitationViewer } from "./ResearchCitationViewer";
import { ResearchChanges } from "./ResearchChanges";
import { ResearchLabelsPanel } from "./ResearchLabelsPanel";
import { ResearchWorkspacePicker } from "./ResearchWorkspacePicker";
import { ResearchSearchPanel } from "./ResearchSearchPanel";
import { ChoiceMenu } from "./ResearchControls";

const ResearchMemoPane = lazy(() => import("./ResearchMemoPane"));

const UNSORTED = "__unsorted__", PAGE_SIZE = 50;
type Scope = ResearchLabel["scope"];
const sourceName = (source: ResearchSource) => source.reference.title || source.reference.citation || source.reference.id;
const expandSelection = (selected: Set<string> | null, children: Map<string | null, ResearchLabel[]>) => {
  if (selected === null) return null; const ids = new Set(selected);
  for (const id of ids) if (id !== UNSORTED) children.get(id)?.forEach(({ id: child }) => ids.add(child)); return ids;
};
const itemSelected = (ids: string[], selected: Set<string> | null) => selected === null ||
  selected.has(UNSORTED) && !ids.length || ids.some((id) => selected.has(id));
const passageSelected = (source: ResearchSource, selected: Set<string> | null) => selected === null ||
  !!source.passages && (selected.has(UNSORTED) && source.passages.unlabelledCount > 0 ||
    [...selected].some((id) => (source.passages?.labelCounts[id] ?? 0) > 0));

type Props = { projectId?: string;
  rail?: HTMLElement | null; sourceDropNonce?: number;
  onReadSource?: (source: ResearchSource, locator?: string) => void; selectedSourceId?: string };
export function ResearchFileBar(props: Props) {
  const { file } = useSourcesWorkspace();
  return <ResearchFileBarContent key={file?.document.id ?? "empty"} {...props} />;
}
function ResearchFileBarContent({ projectId, rail, sourceDropNonce, onReadSource, selectedSourceId }: Props) {
  const { file, mutations: commit, selection: workspaceSelection, setSelection, passages: passagePages } = useSourcesWorkspace();
  const [scope, setScope] = useState<ResearchSelection>(() => workspaceSelection);
  const [reading, setReading] = useState<{ citation: Citation; reference?: ResearchSource["reference"] } | null>(null);
  const [tab, setTab] = useState<"labels" | "search" | "memo">("labels");
  const labelsOpen = tab === "labels", searchOpen = tab === "search", noteOpen = tab === "memo";
  const [labelScope, setLabelScope] = useState<Scope>("source");
  const [changesOpen, setChangesOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(() => !!file && !Object.keys(file.state.labels).length &&
    !!Object.keys(file.state.sources).length);
  const [memoCitation, setMemoCitation] = useState<{ href: string; sequence: number }>();
  const [sourceSelected, setSourceSelected] = useState<Set<string> | null>(null),
    [highlightSelected, setHighlightSelected] = useState<Set<string> | null>(null), [highlightFilter, setHighlightFilter] = useState(false),
    [matches, setMatches] = useState<{ evidence: Set<string>; sources: Set<string> } | null>(null);
  const [openedSources, setOpenedSources] = useState<Set<string>>(() => new Set());
  const [listSearch, setListSearch] = useState("");
  const [sort, setSort] = useState("saved"), [kindFilter, setKindFilter] = useState<Set<string>>(() => new Set()),
    [yearFilter, setYearFilter] = useState<Set<string>>(() => new Set()), [collectionFilter, setCollectionFilter] = useState<Set<string>>(() => new Set()),
    [page, setPage] = useState(0);
  const [target, setTarget] = useState<"sources" | "passages">(scope.target);
  const [status, setStatus] = useState("");
  const [removing, setRemoving] = useState<{ kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string } | null>(null);
  const handledDrop = useRef(0);
  const revealLabels = useCallback(() => { setTab("labels"); setLabelScope("source"); }, []);
  const labels = useMemo(() => file?.state.labels ?? {}, [file?.state.labels]);
  const allSources = useMemo(() => Object.values(file?.state.sources ?? {}), [file?.state.sources]);
  const children = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).forEach((label) => { const values = map.get(label.parentId) ?? [];
      values.push(label); map.set(label.parentId, values); });
    map.forEach((values) => values.sort((a, b) => a.order - b.order)); return map; }, [labels]);
  const sourceLabelIds = useMemo(() => expandSelection(sourceSelected, children), [sourceSelected, children]);
  const highlightLabelIds = useMemo(() => expandSelection(highlightSelected, children), [highlightSelected, children]);
  const appliedHighlightIds = highlightFilter ? highlightLabelIds : null;
  const passageInScope = useCallback((item: ResearchEvidence) => (!scope.evidenceIds || scope.evidenceIds.includes(item.receipt.evidence_id)) &&
    (!scope.members || scope.members.some((member) => member.sourceId === item.sourceId &&
      (!member.evidenceIds || member.evidenceIds.includes(item.receipt.evidence_id)))), [scope]);
  useEffect(() => {
    for (const id of openedSources) {
      const page = passagePages.chains[id];
      if (!page) void passagePages.fetchPage(id, null, false);
      else if (!page.loading && !page.error && page.nextCursor && !page.items.some((item) => item.kind === "passage" &&
        passageInScope(item.value) && itemSelected(item.value.labelIds, appliedHighlightIds) && (matches === null || matches.evidence.has(item.value.receipt.evidence_id))))
        void passagePages.fetchPage(id, page.nextCursor, true);
    }
  }, [openedSources, appliedHighlightIds, matches, passageInScope, passagePages.chains, passagePages.fetchPage]);
  const scopedSources = useMemo(() => allSources.filter((source) =>
    (!scope.sourceIds || scope.sourceIds.includes(source.id)) && (!scope.members || scope.members.some((member) => member.sourceId === source.id)) &&
    itemSelected(source.labelIds, sourceLabelIds) && passageSelected(source, appliedHighlightIds)), [allSources, scope, sourceLabelIds, appliedHighlightIds]);
  const years = useMemo(() => [...new Set(allSources.map(({ reference }) => reference.date?.slice(0, 4))
    .filter((value): value is string => !!value))].sort().reverse(), [allSources]);
  const filteredSources = useMemo(() => scopedSources.filter((source) => { const haystack = [source.reference.title, source.reference.citation,
    source.reference.collection, source.note].join(" ").toLowerCase(); return haystack.includes(listSearch.toLowerCase()) &&
      (!kindFilter.size || kindFilter.has(source.reference.kind)) && (!yearFilter.size || yearFilter.has(source.reference.date?.slice(0, 4) ?? "")) &&
      (!collectionFilter.size || collectionFilter.has(source.reference.collection ?? "")); })
    .sort((a, b) => sort === "az" ? sourceName(a).localeCompare(sourceName(b)) : sort === "date"
      ? String(b.reference.date ?? "").localeCompare(String(a.reference.date ?? "")) : 0),
    [scopedSources, listSearch, kindFilter, yearFilter, collectionFilter, sort]);
  const list = useMemo(() => filteredSources.filter((source) => matches === null || matches.sources.has(source.id)),
    [filteredSources, matches]);
  const viewTarget = searchOpen ? target : labelScope === "highlight" ? "passages" : "sources";
  const constrain = (selection: ResearchSelection): ResearchSelection => ({ ...scope, ...selection,
    ...(scope.members ? { members: scope.members.filter(({ sourceId }) => selection.sourceIds?.includes(sourceId)), sourceIds: undefined } : {}),
    ...(scope.evidenceIds ? { evidenceIds: selection.evidenceIds ? selection.evidenceIds.filter((id) => scope.evidenceIds!.includes(id)) : scope.evidenceIds } : {}) });
  const viewSelection: ResearchSelection = constrain({ target: scope.target === "passages" ? "passages" : viewTarget, sourceIds: list.map(({ id }) => id),
    ...(viewTarget === "passages" && highlightLabelIds ? { labelIds: [...highlightLabelIds].filter((id) => id !== UNSORTED),
      unlabelled: highlightLabelIds.has(UNSORTED) } : {}), ...(matches && viewTarget === "passages" ? { evidenceIds: [...matches.evidence] } : {}) });
  const selectionKey = JSON.stringify(viewSelection);
  useEffect(() => { setSelection(JSON.parse(selectionKey) as ResearchSelection); }, [selectionKey, setSelection]);
  useEffect(() => { if (sourceDropNonce && handledDrop.current !== sourceDropNonce) {
    handledDrop.current = sourceDropNonce; if (!noteOpen) revealLabels(); } }, [revealLabels, sourceDropNonce, noteOpen]);
  useEffect(() => setPage(0), [listSearch, kindFilter, yearFilter, collectionFilter, sourceSelected, highlightSelected]);
  useEffect(() => setPage((current) => Math.min(current,
    Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1))), [list.length]);

  async function act(action: ResearchAction) {
    if (!file) return null; setStatus("");
    try { return await commit.act(action); }
    catch (reason) { setStatus(errorMessage(reason, "Could not update workspace")); return null; }
  }
  function showMatches(evidenceIds: string[], sourceIds: string[]) {
    setMatches({ evidence: new Set(evidenceIds), sources: new Set(sourceIds) }); setTab("search"); setPage(0);
  }
  function querySelection(target: "sources" | "passages"): ResearchSelection {
    const selected = target === "passages" ? highlightSelected : sourceSelected;
    return constrain({ target, sourceIds: filteredSources.map(({ id }) => id),
      ...(selected === null ? {} : { labelIds: [...selected].filter((id) => id !== UNSORTED), unlabelled: selected.has(UNSORTED) }) });
  }
  function sourceHref(source: ResearchSource, locator?: string) {
    if (source.reference.kind === "document") return `/library?${new URLSearchParams({ document_id: source.reference.id,
      version_id: source.reference.versionId, ...(locator ? { locator } : {}) })}`;
    if (source.reference.provider !== "a2aj" && source.reference.provider !== "journal")
      return safeAssistantUrl(source.reference.url, { relative: false });
    const href = legalSourceViewerHref(source.reference,
      file ? { fileId: file.document.id, sourceId: source.id } : undefined);
    return locator ? `${href}&locator=${encodeURIComponent(locator)}` : href;
  }
  function sourceLink(source: ResearchSource, text: string, locator?: string, title = false) {
    const href = sourceHref(source, locator), className = title
      ? "rounded text-left text-sm font-semibold leading-5 hover:text-brand focus-visible:outline focus-visible:outline-2"
      : buttonClassName({ variant: "outline", size: "compact", className: locator
        ? "h-auto min-h-8 min-w-0 max-w-full shrink whitespace-normal [overflow-wrap:anywhere]" : undefined });
    return source.reference.kind === "document" || onReadSource && (source.reference.provider === "a2aj" || source.reference.provider === "journal")
      ? <button type="button" aria-current={title && selectedSourceId === source.id ? "true" : undefined}
      className={className} onClick={() => void readSource(source, locator)}>{text}</button>
      : !href ? <span>{text}</span> : href.startsWith("/")
      ? <Link to={href} className={className}>{text}</Link> : <a href={href} className={className}>{text}</a>;
  }
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
    } catch (reason) { setStatus(errorMessage(reason, "Could not open saved passage")); }
  }
  function openAnswerCitation(citation: Citation) {
    const source = allSources.find(({ reference }) => citation.kind === "document" ? reference.kind === "document" && reference.id === citation.document_id
      : citation.kind === "public_legal" ? reference.provider === citation.provider && reference.id === citation.identifier
        : citation.kind === "a2aj" && reference.provider === "a2aj" && reference.citation === citation.citation);
    setReading({ citation, reference: source?.reference });
  }
  const filterItems = (values: string[], selected: Set<string>, change: (value: Set<string>) => void) =>
    values.map((value) => ({ label: value, checked: selected.has(value), keepOpen: true,
      onSelect: () => { const next = new Set(selected); if (next.has(value)) next.delete(value); else next.add(value); change(next); } }));
  const listPanel = () => <>
    <div className="mb-2 flex items-center gap-1.5">
      <input type="search" autoComplete="off" value={listSearch} onChange={(event) => setListSearch(event.target.value)} aria-label="Search list"
        placeholder="Filter sources" className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm" />
      <ChoiceMenu className="w-28 shrink-0" label="Sort sources" value={sort} onChange={setSort} options={[
        { value: "saved", label: "Saved order" }, { value: "az", label: "A–Z" }, { value: "date", label: "Date" }]} />
    </div>
    <details className="mb-2"><summary className={`${buttonClassName({ variant: "outline", size: "compact" })} w-fit cursor-pointer`}>Filters{kindFilter.size + yearFilter.size + collectionFilter.size > 0 ? ` (${kindFilter.size + yearFilter.size + collectionFilter.size})` : ""}</summary>
    <div className="mt-2 grid grid-cols-3 gap-2 text-sm text-gray-600">
      <ActionMenu label="Filter source type" items={filterItems([...new Set(allSources.map(({ reference }) => reference.kind))], kindFilter, setKindFilter)
        .map((item) => ({ ...item, label: item.label.replace(/^./u, (letter) => letter.toUpperCase()) }))}
        triggerClassName={`h-8 w-full min-w-0 items-center justify-between gap-1 overflow-hidden whitespace-nowrap rounded-md border border-gray-300 bg-white px-2 text-sm ${kindFilter.size ? "font-semibold text-gray-900" : ""}`}><span className="truncate">Type{kindFilter.size ? ` (${kindFilter.size})` : ""}</span><ChevronDown className="size-3 shrink-0" /></ActionMenu>
      <ActionMenu label="Filter year" items={filterItems(years, yearFilter, setYearFilter)}
        triggerClassName={`h-8 w-full min-w-0 items-center justify-between gap-1 overflow-hidden whitespace-nowrap rounded-md border border-gray-300 bg-white px-2 text-sm ${yearFilter.size ? "font-semibold text-gray-900" : ""}`}><span className="truncate">Year{yearFilter.size ? ` (${yearFilter.size})` : ""}</span><ChevronDown className="size-3 shrink-0" /></ActionMenu>
      <ActionMenu label="Filter collection" className="min-w-0" items={filterItems([...new Set(allSources.map(({ reference }) => reference.collection).filter((value): value is string => typeof value === "string"))], collectionFilter, setCollectionFilter)}
        triggerClassName={`h-8 w-full min-w-0 items-center justify-between gap-1 overflow-hidden whitespace-nowrap rounded-md border border-gray-300 bg-white px-2 text-sm ${collectionFilter.size ? "font-semibold text-gray-900" : ""}`}><span className="truncate">Collection{collectionFilter.size ? ` (${collectionFilter.size})` : ""}</span><ChevronDown className="size-3 shrink-0" /></ActionMenu>
    </div></details>
    <div className="mt-1 min-h-0">
    <div className="mb-1 flex items-center justify-between text-sm"><span role="status" className="tabular-nums text-gray-600">{list.length} {list.length === 1 ? "source" : "sources"}</span>
      {!!list.length && file && <span className="flex items-center gap-1.5"><ResearchSelectionLabels />
        <Button size="compact" variant="outline" aria-expanded={organizeOpen} onClick={() => setOrganizeOpen((open) => !open)}>Organize</Button></span>}</div>
    {file && <WorkspaceOrganize open={organizeOpen} onClose={() => setOrganizeOpen(false)} />}
    {list.length ? <ol>{list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((source) => {
      const sourcePage = passagePages.chains[source.id], evidence = (sourcePage?.items.flatMap((item) =>
        item.kind === "passage" && passageInScope(item.value) && itemSelected(item.value.labelIds, appliedHighlightIds) &&
          (matches === null || matches.evidence.has(item.value.receipt.evidence_id)) ? [item.value] : []) ?? []);
      return <li key={source.id} className={`border-b border-gray-200 last:border-0 ${selectedSourceId === source.id ? "bg-gray-100" : ""}`}><details open={openedSources.has(source.id)} className="group rounded hover:bg-gray-50" onToggle={(event) => {
        const isOpen = event.currentTarget.open; setOpenedSources((current) => { const next = new Set(current);
        if (isOpen) next.add(source.id); else next.delete(source.id); return next; }); }}><summary className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] list-none items-start gap-1.5 py-2 text-sm @xs:flex" onClick={(event) => {
          if (!(event.target as Element).closest("button,a")) event.preventDefault(); }}>
        <button type="button" aria-label={`Passages in ${sourceName(source)}`} aria-expanded={openedSources.has(source.id)}
          onClick={(event) => { event.preventDefault(); setOpenedSources((current) => { const next = new Set(current);
            if (next.has(source.id)) next.delete(source.id); else next.add(source.id); return next; }); }}
          className="grid size-6 shrink-0 place-items-center rounded hover:bg-gray-200"><ChevronRight aria-hidden="true" className="size-3 text-gray-500 group-open:rotate-90" /></button>
        <ResearchLabelPicker file={file} kind="source" itemId={source.id} labelIds={source.labelIds}
          badge={source.badge} badgeColor={source.badgeColor} note={source.note} title={sourceName(source)} size="sm"
          onError={setStatus} onSourceDrag={() => { if (!noteOpen) requestAnimationFrame(revealLabels); }} mutations={commit} />
        <span className="col-start-2 col-end-4 row-start-2 min-w-0 flex-1 [overflow-wrap:anywhere]"><span className="block">{sourceLink(source, sourceName(source), undefined, true)}</span>
          {source.reference.citation && source.reference.citation !== sourceName(source) && <span className="mt-0.5 block text-sm text-gray-600">{source.reference.citation}</span>}
          {source.note && <span className="mt-0.5 line-clamp-1 whitespace-pre-wrap font-normal text-gray-600 group-open:line-clamp-none">{source.note}</span>}</span>
        <Button variant="outline" size="compact" className="col-start-3 row-start-1" aria-label={`Cite ${sourceName(source)}`}
          onClick={(event) => { event.preventDefault(); void cite(source); }}>Cite</Button>
      </summary>{openedSources.has(source.id) && <div className="space-y-3 ps-6 pe-2 pb-3 text-sm leading-5">
        <div className="flex items-center justify-between text-gray-500"><span>{source.passages?.count ?? 0} passages</span>
          {sourceHref(source) && sourceLink(source, "Open source")}</div>
        {sourcePage?.loading && !sourcePage.items.length && <p role="status" className="text-xs text-gray-500">Loading passages…</p>}
        {!!sourcePage?.error && <Button variant="outline" size="compact" onClick={() => void passagePages.fetchPage(source.id, null, false)}>Retry passages</Button>}
        {evidence.map((item) => <div key={item.receipt.evidence_id} draggable
          onDragStart={(event) => { event.dataTransfer.setData(RESEARCH_PASSAGE_DRAG, JSON.stringify(item)); }}
          className="border-s-2 border-gray-200 ps-2">
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-1"><ResearchLabelPicker file={file} kind="evidence" itemId={item.receipt.evidence_id} sourceId={source.id}
            labelIds={item.labelIds} note={item.note} title={item.receipt.locator.label} size="sm"
            onError={setStatus} mutations={commit} />
            {sourceLink(source, item.receipt.locator.label, item.receipt.locator.label)}
            <button type="button" aria-label={`Delete ${item.receipt.locator.label}`} onClick={() => setRemoving({ kind: "evidence", id: item.receipt.evidence_id, sourceId: source.id, name: item.receipt.locator.label })}
              className="ms-auto grid size-6 place-items-center rounded text-gray-400 hover:bg-gray-200 hover:text-red-700"><Trash2 className="size-3" /></button></div>
          <p className="line-clamp-3 text-gray-600 [overflow-wrap:anywhere]">{item.receipt.span_text}</p>{item.note && <p className="mt-0.5 text-gray-700 [overflow-wrap:anywhere]">{item.note}</p>}
          <Button variant="outline" size="compact" onClick={() => void cite(source, item)} className="mt-1">Cite passage</Button>
        </div>)}
        {sourcePage?.nextCursor && <button type="button" aria-label={`Show more passages from ${sourceName(source)}`}
          disabled={sourcePage.loading} onClick={() => void passagePages.fetchPage(source.id, sourcePage.nextCursor, true)}
          className={buttonClassName({ variant: "outline", size: "compact", className: "w-full" })}>Show more passages</button>}
        <ResearchSourceAnswers sourceId={source.id} onCitation={openAnswerCitation} />
        <button type="button" onClick={() => setRemoving({ kind: "source", id: source.id, name: sourceName(source) })}
          className={buttonClassName({ variant: "outline", size: "compact" })}>Remove source</button>
      </div>}</details></li>;
    })}</ol> : <p className="p-2 text-xs text-gray-500">No sources in this view.</p>}
    {list.length > PAGE_SIZE && <div className="mt-2 flex items-center justify-center gap-2 text-xs"><Button variant="outline" size="compact" disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button>
      <span>Page {page + 1} of {Math.ceil(list.length / PAGE_SIZE)}</span><Button variant="outline" size="compact" disabled={(page + 1) * PAGE_SIZE >= list.length} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </div></>;
  const selection = labelScope === "source" ? sourceSelected : highlightSelected,
    selectedLabel = selection?.size === 1 ? [...selection][0] : null;

  const cite = async (source: ResearchSource, passage?: ResearchEvidence) => {
    if (!file) return;
    try { const { href } = await getResearchCitation(file.document.id, source.id, passage?.receipt.evidence_id);
      setMemoCitation((current) => ({ href, sequence: (current?.sequence ?? 0) + 1 })); setTab("memo");
    } catch (reason) { setStatus(errorMessage(reason, "Could not add citation")); }
  };
  const removalMessage = (() => { if (!removing) return "";
    if (removing.kind === "source") { const count = file?.state.sources[removing.id]?.passages?.count ?? 0;
      return `Remove “${removing.name}” and ${count} saved passage${count === 1 ? "" : "s"} from this workspace?`; }
    if (removing.kind === "evidence") return `Delete the saved passage at ${removing.name}?`;
    const ids = expandSelection(new Set([removing.id]), children)!, prefix =
      `Delete “${removing.name}”${ids.size > 1 ? ` and ${ids.size - 1} nested label${ids.size === 2 ? "" : "s"}` : ""}?`;
    if (labels[removing.id]?.scope === "highlight")
      return `${prefix} Saved passages using these categories will lose them.`;
    const affected = allSources.filter((item) => item.labelIds.some((id) => ids.has(id))).length;
    return `${prefix} ${affected} saved source${affected === 1 ? "" : "s"} will lose ${ids.size === 1 ? "this label" : "these labels"}.`;
  })();
  return <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden">
    <ResearchWorkspacePicker projectId={projectId} rail={rail} onHistory={() => setChangesOpen(true)} />
    {status && <span role="status" className="pointer-events-none absolute bottom-2 left-1/2 z-30 max-w-[calc(100%-1rem)] -translate-x-1/2 truncate rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 shadow-lg">{status}</span>}
    {file && <ResearchChanges file={file} mutations={commit} historyOpen={changesOpen} onCloseHistory={() => setChangesOpen(false)} />}
    {file && <Tabs value={tab} onValueChange={setTab} ariaLabel="Workspace views" variant="subtab"
      className="min-h-0 flex-1" options={[
        { value: "labels", label: "Labels" },
        { value: "search", label: "Search" }, { value: "memo", label: "Memo" }]}>
      <div className={`relative min-h-0 flex-1 overflow-y-auto pt-2 ${noteOpen ? "hidden" : "block"}`}>
        {labelsOpen && <aside aria-label="Label organizer"
          className="mb-3 border-b border-gray-200 pb-3">
          <div className="mb-2 flex items-center gap-1.5">
          <div role="group" aria-label="Label scope" className="grid flex-1 grid-cols-2 gap-1 rounded-md bg-gray-100 p-0.5">
            {(["source", "highlight"] as const).map((scope) => <button key={scope} type="button" aria-pressed={labelScope === scope}
              onClick={() => setLabelScope(scope)} className={`h-8 rounded text-sm font-medium ${labelScope === scope ? "bg-white shadow-sm" : "text-gray-600"}`}>
              {scope === "source" ? "Sources" : "Passages"}</button>)}
          </div><Button variant="outline" size="icon-sm" disabled={!selectedLabel || !labels[selectedLabel]}
            onClick={() => selectedLabel && setRemoving({ kind: "label", id: selectedLabel, name: labels[selectedLabel].name })}
            aria-label={labelScope === "source" ? "Delete selected label" : "Delete selected highlight category"}><Trash2 aria-hidden="true" /></Button>
          </div>
          <ResearchLabelsPanel scope={labelScope} selected={labelScope === "source" ? sourceSelected : highlightSelected}
            onSelectionChange={labelScope === "source" ? setSourceSelected : setHighlightSelected}
            highlightFilter={highlightFilter} setHighlightFilter={setHighlightFilter} onError={setStatus} />
        </aside>}
        <section hidden={!searchOpen} aria-label="Search Saved sources" className="mb-3 min-w-0">
          <ResearchSearchPanel active={searchOpen} target={target} setTarget={setTarget}
            selections={{ sources: querySelection("sources"), passages: querySelection("passages") }}
            matches={matches} onMatches={showMatches} onStatus={setStatus} />
        </section>
        <section aria-label="Saved sources" className="min-w-0">
          {(scope.members || scope.sourceIds || scope.evidenceIds) && <div className="mb-2 flex items-center justify-between gap-2 text-sm text-gray-600">
            <span>Selected material</span><Button size="compact" variant="outline" onClick={() => setScope({ target: "sources" })}>Show all sources</Button></div>}
          {matches && <div className="mb-3 flex items-center justify-between gap-2 text-sm"><span>Search matches</span>
            <button type="button" onClick={() => { setMatches(null); }} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50">Clear search matches</button></div>}
          {listPanel()}
        </section>
      </div>
    <div className={`${noteOpen ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}><Suspense fallback={<p role="status" className="py-3 text-sm text-gray-500">Opening memo…</p>}>
      <ResearchMemoPane file={file} mutations={commit} citation={memoCitation}
        onOpenCitation={(href) => {
          const params = new URLSearchParams(href.slice(href.indexOf("?") + 1)), source = file.state.sources[params.get("research_source") ?? ""];
          if (source && (source.reference.kind === "document" || onReadSource)) void readSource(source, params.get("locator") ?? undefined, params.get("evidence_id") ?? undefined);
          else if (href.startsWith("/library?")) { const citation = parseMemoCitation(href); if (citation) setReading({ citation }); }
          else window.open(href, "_blank", "noopener,noreferrer");
        }} />
    </Suspense></div>
    </Tabs>}
    {reading && <ResearchCitationViewer {...reading} onClose={() => setReading(null)} />}
    <ConfirmPopup open={!!removing} title={removing?.kind === "label" ? "Delete label?" : removing?.kind === "source" ? "Remove source?" : "Delete passage?"}
      message={removalMessage} confirmLabel={removing?.kind === "source" ? "Remove" : "Delete"}
      onCancel={() => setRemoving(null)} onConfirm={() => { if (removing) void act(removing.kind === "evidence"
        ? { type: "remove", kind: "evidence", id: removing.id, sourceId: removing.sourceId! }
        : { type: "remove", kind: removing.kind, id: removing.id }); setRemoving(null); }} />
  </div>;
}
