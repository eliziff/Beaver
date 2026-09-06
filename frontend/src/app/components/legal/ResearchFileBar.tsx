import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { ResearchSelectionLabels } from "../shared/ResearchSelectionLabels";
import { ActionMenu, type ActionMenuItem } from "../ui/action-menu";
import { Tabs } from "../ui/tabs";
import { Button } from "../ui/button";
import { getResearchCitation } from "@/app/lib/api/researchFiles";
import { type ResearchAction, type ResearchEvidence, type ResearchLabel, type ResearchSource, type ResearchSelection } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { memoCitation as parseMemoCitation } from "./researchMemo";
import { WorkspaceOrganize } from "./ResearchWorkspaceViews";
import { ResearchCitationViewer } from "./ResearchCitationViewer";
import { ResearchChanges } from "./ResearchChanges";
import { ResearchLabelsPanel, UNSORTED, type LabelSelection } from "./ResearchLabelsPanel";
import { ResearchWorkspacePicker } from "./ResearchWorkspacePicker";
import { ResearchSearchPanel } from "./ResearchSearchPanel";
import { PAGE_SIZE, ResearchSourceList, sourceName, useSourceReader } from "./ResearchSourceList";

const ResearchMemoPane = lazy(() => import("./ResearchMemoPane"));

type Scope = ResearchLabel["scope"];
type Facet = "kind" | "year" | "collection";
const SORTS = [["saved", "Saved order"], ["az", "A–Z"], ["date", "Date"]] as const;
const expandSelection = (selected: LabelSelection, children: Map<string | null, ResearchLabel[]>) => {
  if (selected === null) return null; const ids = new Set(selected);
  for (const id of ids) if (id !== UNSORTED) children.get(id)?.forEach(({ id: child }) => ids.add(child)); return ids;
};
const itemSelected = (ids: string[], selected: LabelSelection) => selected === null ||
  selected.has(UNSORTED) && !ids.length || ids.some((id) => selected.has(id));
const passageSelected = (source: ResearchSource, selected: LabelSelection) => selected === null ||
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
  const [tab, setTab] = useState<"labels" | "search" | "memo">("labels");
  const labelsOpen = tab === "labels", searchOpen = tab === "search", noteOpen = tab === "memo";
  const [changesOpen, setChangesOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(() => !!file && !Object.keys(file.state.labels).length &&
    !!Object.keys(file.state.sources).length);
  const [memoCitation, setMemoCitation] = useState<{ href: string; sequence: number }>();
  const [selected, setSelected] = useState<Record<Scope, LabelSelection>>({ source: null, highlight: null }),
    [matches, setMatches] = useState<{ evidence: Set<string>; sources: Set<string> } | null>(null),
    [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [openedSources, setOpenedSources] = useState<Set<string>>(() => new Set());
  const [listSearch, setListSearch] = useState(""), [sort, setSort] = useState<(typeof SORTS)[number][0]>("saved"),
    [facets, setFacets] = useState<Record<Facet, Set<string>>>({ kind: new Set(), year: new Set(), collection: new Set() }),
    [page, setPage] = useState(0);
  const [target, setTarget] = useState<"sources" | "passages">(scope.target);
  const [status, setStatus] = useState("");
  const [removing, setRemoving] = useState<{ kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string } | null>(null);
  const handledDrop = useRef(0);
  const revealLabels = useCallback(() => setTab("labels"), []);
  const reader = useSourceReader({ file, passagePages, onReadSource, onStatus: setStatus });
  const labels = useMemo(() => file?.state.labels ?? {}, [file?.state.labels]);
  const allSources = useMemo(() => Object.values(file?.state.sources ?? {}), [file?.state.sources]);
  const children = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).forEach((label) => { const values = map.get(label.parentId) ?? [];
      values.push(label); map.set(label.parentId, values); });
    map.forEach((values) => values.sort((a, b) => a.order - b.order)); return map; }, [labels]);
  const sourceLabelIds = useMemo(() => expandSelection(selected.source, children), [selected.source, children]);
  const highlightLabelIds = useMemo(() => expandSelection(selected.highlight, children), [selected.highlight, children]);
  const passageInScope = useCallback((item: ResearchEvidence) => (!scope.evidenceIds || scope.evidenceIds.includes(item.receipt.evidence_id)) &&
    (!scope.members || scope.members.some((member) => member.sourceId === item.sourceId &&
      (!member.evidenceIds || member.evidenceIds.includes(item.receipt.evidence_id)))), [scope]);
  const passageVisible = useCallback((item: ResearchEvidence) => passageInScope(item) && itemSelected(item.labelIds, highlightLabelIds) &&
    (matches === null || matches.evidence.has(item.receipt.evidence_id)), [passageInScope, highlightLabelIds, matches]);
  useEffect(() => {
    for (const id of openedSources) {
      const sourcePage = passagePages.chains[id];
      if (!sourcePage) void passagePages.fetchPage(id, null, false);
      else if (!sourcePage.loading && !sourcePage.error && sourcePage.nextCursor && !sourcePage.items.some((item) => item.kind === "passage" && passageVisible(item.value)))
        void passagePages.fetchPage(id, sourcePage.nextCursor, true);
    }
  }, [openedSources, passageVisible, passagePages.chains, passagePages.fetchPage]);
  const scopedSources = useMemo(() => allSources.filter((source) =>
    (!scope.sourceIds || scope.sourceIds.includes(source.id)) && (!scope.members || scope.members.some((member) => member.sourceId === source.id)) &&
    itemSelected(source.labelIds, sourceLabelIds) && passageSelected(source, highlightLabelIds)), [allSources, scope, sourceLabelIds, highlightLabelIds]);
  const facetValues = useMemo<Record<Facet, string[]>>(() => ({
    kind: [...new Set(allSources.map(({ reference }) => reference.kind))].sort(),
    year: [...new Set(allSources.map(({ reference }) => reference.date?.slice(0, 4)).filter((value): value is string => !!value))].sort().reverse(),
    collection: [...new Set(allSources.map(({ reference }) => reference.collection).filter((value): value is string => !!value))].sort(),
  }), [allSources]);
  const filteredSources = useMemo(() => scopedSources.filter((source) => { const haystack = [source.reference.title, source.reference.citation,
    source.reference.collection, source.note].join(" ").toLowerCase(); return haystack.includes(listSearch.toLowerCase()) &&
      (!facets.kind.size || facets.kind.has(source.reference.kind)) && (!facets.year.size || facets.year.has(source.reference.date?.slice(0, 4) ?? "")) &&
      (!facets.collection.size || facets.collection.has(source.reference.collection ?? "")); })
    .sort((a, b) => sort === "az" ? sourceName(a).localeCompare(sourceName(b)) : sort === "date"
      ? String(b.reference.date ?? "").localeCompare(String(a.reference.date ?? "")) : 0),
    [scopedSources, listSearch, facets, sort]);
  const list = useMemo(() => filteredSources.filter((source) => matches === null || matches.sources.has(source.id)),
    [filteredSources, matches]);
  const viewTarget = searchOpen ? target : selected.highlight !== null ? "passages" : "sources";
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
  useEffect(() => setPage(0), [listSearch, facets, selected]);
  useEffect(() => setPage((current) => Math.min(current, Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1))), [list.length]);

  async function act(action: ResearchAction) {
    if (!file) return null; setStatus("");
    try { return await commit.act(action); }
    catch (reason) { setStatus(errorMessage(reason, "Could not update workspace")); return null; }
  }
  function showMatches(evidenceIds: string[], sourceIds: string[]) {
    setMatches({ evidence: new Set(evidenceIds), sources: new Set(sourceIds) }); setPicked(new Set());
    setOpenedSources((current) => new Set([...current, ...sourceIds])); setTab("search"); setPage(0);
  }
  function querySelection(target: "sources" | "passages"): ResearchSelection {
    const chosen = target === "passages" ? selected.highlight : selected.source;
    return constrain({ target, sourceIds: filteredSources.map(({ id }) => id),
      ...(chosen === null ? {} : { labelIds: [...chosen].filter((id) => id !== UNSORTED), unlabelled: chosen.has(UNSORTED) }) });
  }
  const cite = async (source: ResearchSource, passage?: ResearchEvidence) => {
    if (!file) return;
    try { const { href } = await getResearchCitation(file.document.id, source.id, passage?.receipt.evidence_id);
      setMemoCitation((current) => ({ href, sequence: (current?.sequence ?? 0) + 1 })); setTab("memo");
    } catch (reason) { setStatus(errorMessage(reason, "Could not add citation")); }
  };
  const savePicked = async (labelId: string) => {
    const evidenceIds = [...picked], sourceIds = allSources.filter(({ id }) => passagePages.chains[id]?.items
      .some((item) => item.kind === "passage" && picked.has(item.value.receipt.evidence_id))).map(({ id }) => id);
    if (await act({ type: "label-selection", target: "passages", sourceIds, evidenceIds, assign: [labelId], mode: "add" })) setPicked(new Set());
  };
  const facetItems = (name: Facet, title: string): ActionMenuItem[] => facetValues[name].length > 1
    ? facetValues[name].map((value) => ({ label: `${title}: ${name === "kind" ? value.replace(/^./u, (letter) => letter.toUpperCase()) : value}`,
      checked: facets[name].has(value), keepOpen: true, onSelect: () => setFacets((current) => { const next = new Set(current[name]);
        if (next.has(value)) next.delete(value); else next.add(value); return { ...current, [name]: next }; }) })) : [];
  const listOptions: ActionMenuItem[] = [
    ...SORTS.map(([value, label]) => ({ label: `Sort: ${label}`, checked: sort === value, onSelect: () => setSort(value) })),
    ...facetItems("kind", "Type"), ...facetItems("year", "Year"), ...facetItems("collection", "Collection")];
  const activeFacets = facets.kind.size + facets.year.size + facets.collection.size;
  const handedOff = !!(scope.members || scope.sourceIds || scope.evidenceIds);
  const categories = Object.values(labels).filter(({ scope }) => scope === "highlight").sort((a, b) => a.order - b.order);
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
        {labelsOpen && <ResearchLabelsPanel selected={selected}
          onSelect={(scope, update) => setSelected((current) => ({ ...current, [scope]: typeof update === "function" ? update(current[scope]) : update }))}
          onDelete={(label) => setRemoving({ kind: "label", id: label.id, name: label.name })} onError={setStatus} />}
        <section hidden={!searchOpen} aria-label="Search Saved sources" className="mb-2 min-w-0">
          <ResearchSearchPanel active={searchOpen} target={target} setTarget={setTarget}
            selections={{ sources: querySelection("sources"), passages: querySelection("passages") }}
            matches={matches} onMatches={showMatches} onStatus={setStatus} />
        </section>
        <section aria-label="Saved sources" className="min-w-0">
          <div className="mb-1.5 flex items-center gap-1.5">
            <input type="search" autoComplete="off" value={listSearch} onChange={(event) => setListSearch(event.target.value)} aria-label="Search list"
              placeholder="Filter sources" className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm" />
            <ActionMenu label="List options" items={listOptions} triggerClassName={`h-8 shrink-0 items-center gap-1 rounded-md border border-gray-300 bg-white px-2 text-sm ${activeFacets ? "font-semibold text-gray-900" : "text-gray-700"} hover:bg-gray-50`}>
              <SlidersHorizontal aria-hidden="true" className="size-3.5" />{activeFacets || null}<ChevronDown aria-hidden="true" className="size-3" />
            </ActionMenu>
          </div>
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-sm">
            <span role="status" className="tabular-nums text-gray-600">{list.length} {list.length === 1 ? "source" : "sources"}</span>
            {matches && searchOpen && <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" aria-label="Select all matches" checked={picked.size > 0 && picked.size === matches.evidence.size}
                onChange={(event) => setPicked(event.target.checked ? new Set(matches.evidence) : new Set())} />All matches</label>}
            <span className="ms-auto flex flex-wrap items-center justify-end gap-1.5">
              {picked.size > 0 && <ActionMenu label="Save selected passages" triggerClassName="h-7 items-center gap-1 rounded-md bg-gray-900 px-2 text-xs font-medium text-white hover:bg-gray-700"
                items={categories.length ? categories.map((label) => ({ label: `Save as ${label.name}`, onSelect: () => void savePicked(label.id) }))
                  : [{ label: "Add a passage category first", disabled: true, onSelect() {} }]}>
                Save {picked.size} as<ChevronDown aria-hidden="true" className="size-3" /></ActionMenu>}
              {!!list.length && <><ResearchSelectionLabels />
                <Button size="compact" variant="outline" aria-expanded={organizeOpen} onClick={() => setOrganizeOpen((open) => !open)}>Organize</Button></>}
              {handedOff && <Button size="compact" variant="outline" onClick={() => setScope({ target: "sources" })}>Show all</Button>}
              {matches && <Button size="compact" variant="outline" onClick={() => { setMatches(null); setPicked(new Set()); }}>Clear search matches</Button>}
            </span>
          </div>
          <WorkspaceOrganize open={organizeOpen} onClose={() => setOrganizeOpen(false)} />
          <ResearchSourceList sources={list} reader={reader} opened={openedSources} setOpened={setOpenedSources} passageVisible={passageVisible}
            selectedSourceId={selectedSourceId} picked={matches && searchOpen ? picked : undefined}
            onPick={matches && searchOpen ? (id, value) => setPicked((current) => { const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; }) : undefined}
            onCite={cite} onRemove={setRemoving} onStatus={setStatus} onSourceDrag={() => { if (!noteOpen) requestAnimationFrame(revealLabels); }}
            page={page} onPage={setPage} />
        </section>
      </div>
    <div className={`${noteOpen ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}><Suspense fallback={<p role="status" className="py-3 text-sm text-gray-500">Opening memo…</p>}>
      <ResearchMemoPane file={file} mutations={commit} citation={memoCitation}
        onOpenCitation={(href) => {
          const params = new URLSearchParams(href.slice(href.indexOf("?") + 1)), source = file.state.sources[params.get("research_source") ?? ""];
          if (source && reader.canRead(source)) void reader.readSource(source, params.get("locator") ?? undefined, params.get("evidence_id") ?? undefined);
          else if (href.startsWith("/library?")) { const citation = parseMemoCitation(href); if (citation) reader.setReading({ citation }); }
          else window.open(href, "_blank", "noopener,noreferrer");
        }} />
    </Suspense></div>
    </Tabs>}
    {reader.reading && <ResearchCitationViewer {...reader.reading} onClose={() => reader.setReading(null)} />}
    <ConfirmPopup open={!!removing} title={removing?.kind === "label" ? "Delete label?" : removing?.kind === "source" ? "Remove source?" : "Delete passage?"}
      message={removalMessage} confirmLabel={removing?.kind === "source" ? "Remove" : "Delete"}
      onCancel={() => setRemoving(null)} onConfirm={() => { if (removing) void act(removing.kind === "evidence"
        ? { type: "remove", kind: "evidence", id: removing.id, sourceId: removing.sourceId! }
        : { type: "remove", kind: removing.kind, id: removing.id }); setRemoving(null); }} />
  </div>;
}
