import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Highlighter, SlidersHorizontal } from "lucide-react";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { ResearchSelectionLabels } from "../shared/ResearchSelectionLabels";
import { Tabs } from "../ui/tabs";
import { Button } from "../ui/button";
import { researchLabelPath, researchHighlightCount, type ResearchAction, type ResearchEvidence, type ResearchLabel, type ResearchSelection,
  type ResearchSource } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { memoCitation as parseMemoCitation } from "./researchMemo";
import { ResearchCitationViewer } from "./ResearchCitationViewer";
import { ResearchChanges } from "./ResearchChanges";
import { ResearchHighlightTypes } from "./ResearchHighlightTypes";
import { ResearchSearchPanel } from "./ResearchSearchPanel";
import { ResearchTree, type ResearchRemoval } from "./ResearchTree";
import { ResearchWorkspacePicker } from "./ResearchWorkspacePicker";
import { sourceMatches, useSourceReader } from "./useSourceReader";

const ResearchMemoPane = lazy(() => import("./ResearchMemoPane"));

type Props = { projectId?: string;
  rail?: HTMLElement | null; sourceDropNonce?: number;
  onReadSource?: (source: ResearchSource, locator?: string) => void; selectedSourceId?: string };
export function ResearchFileBar(props: Props) {
  const { file } = useSourcesWorkspace();
  return <ResearchFileBarContent key={file?.document.id ?? "empty"} {...props} />;
}
function ResearchFileBarContent({ projectId, rail, sourceDropNonce, onReadSource, selectedSourceId }: Props) {
  const { file, mutations: commit, selection: workspaceSelection, setSelection,
    passages, evidence, highlight } = useSourcesWorkspace();
  const [scope, setScope] = useState<ResearchSelection>(() => workspaceSelection);
  const [tab, setTab] = useState<"labels" | "search" | "memo">("labels");
  const searchOpen = tab === "search", noteOpen = tab === "memo";
  const [labelId, setLabelId] = useState<string | null>(null);
  const [typeId, setTypeId] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [changesOpen, setChangesOpen] = useState(false), [filter, setFilter] = useState("");
  const [matches, setMatches] = useState<{ evidence: Set<string>; sources: Set<string> } | null>(null),
    [picked, setPicked] = useState<Set<string>>(() => new Set());
  const passagePages = matches ? evidence : passages;
  const [openedSources, setOpenedSources] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState(""), [removing, setRemoving] = useState<ResearchRemoval | null>(null);
  const handledDrop = useRef(0);
  const revealLabels = useCallback(() => setTab("labels"), []);
  const reader = useSourceReader({ file, passagePages, onReadSource, onStatus: setStatus });
  const labels = useMemo(() => file?.state.labels ?? {}, [file?.state.labels]);
  const allSources = useMemo(() => Object.values(file?.state.sources ?? {}).filter((source) => source.collected || matches?.sources.has(source.id)), [file?.state.sources, matches]);
  const pen = highlight.pen && labels[highlight.pen]?.scope === "highlight" ? highlight.pen : null;
  const activePen = pen ? labels[pen] : Object.values(labels).filter(({ scope }) => scope === "highlight")
    .sort((a, b) => a.order - b.order)[0];

  const within = useCallback((id: string, parent: string) => researchLabelPath(labels, id).some((label) => label.id === parent), [labels]);
  const selectedLabel = labelId && labels[labelId] ? labelId : null;
  const selectedType = typeId && labels[typeId] ? typeId : "";
  const scopedSourceLabels = scope.labelIds?.filter((id) => labels[id]?.scope === "source") ?? [];
  const scopedHighlightTypes = scope.labelIds?.filter((id) => labels[id]?.scope === "highlight") ?? [];
  // Intersect subtree filters; replacing a carried child with its parent would widen Chat/Search scope.
  const filteredTypes = selectedType ? scopedHighlightTypes.length
    ? scopedHighlightTypes.some((parent) => within(selectedType, parent)) ? [selectedType]
      : scopedHighlightTypes.filter((id) => within(id, selectedType))
    : [selectedType] : scopedHighlightTypes;
  const passageVisible = useCallback((item: ResearchEvidence) =>
    (!scopedHighlightTypes.length || item.labelIds.some((id) => scopedHighlightTypes.some((parent) => within(id, parent)))) &&
    (!selectedType || item.labelIds.some((id) => within(id, selectedType))) &&
    (!scope.evidenceIds || scope.evidenceIds.includes(item.receipt.evidence_id)) &&
    (!scope.members || scope.members.some((member) => member.sourceId === item.sourceId &&
      (!member.evidenceIds || member.evidenceIds.includes(item.receipt.evidence_id)))) &&
    (matches === null || matches.evidence.has(item.receipt.evidence_id)), [scope, matches, selectedType, within, labels]);
  useEffect(() => {
    for (const id of openedSources) {
      const page = passagePages.chains[id];
      if (!page) void passagePages.fetchPage(id, null, false);
      else if (!page.loading && !page.error && page.nextCursor &&
        !page.items.some((item) => (item.kind === "passage" || item.kind === "evidence") && passageVisible(item.value)))
        void passagePages.fetchPage(id, page.nextCursor, true);
    }
  }, [openedSources, passageVisible, passagePages.chains, passagePages.fetchPage]);

  const named = useMemo(() => allSources.filter((source) =>
    (!scope.sourceIds || scope.sourceIds.includes(source.id)) &&
    (!scope.members || scope.members.some(({ sourceId }) => sourceId === source.id)) &&
    (!scopedSourceLabels.length || source.labelIds.some((id) => scopedSourceLabels.some((parent) => within(id, parent)))) &&
    (!scopedHighlightTypes.length || Object.keys(source.passages?.labelCounts ?? {}).some((id) => scopedHighlightTypes.some((parent) => within(id, parent)))) &&
    sourceMatches(source, filter)), [allSources, scope, filter, labels, within]);
  const browsed = useMemo(() => named.filter((source) =>
    (!selectedLabel || source.labelIds.some((id) => within(id, selectedLabel))) &&
    (sourceFilter !== "no-labels" || !source.labelIds.length) &&
    (sourceFilter !== "highlights" || researchHighlightCount(source) > 0) &&
    (sourceFilter !== "no-highlights" || researchHighlightCount(source) === 0) &&
    (!selectedType || Object.keys(source.passages?.labelCounts ?? {}).some((id) => filteredTypes.some((parent) => within(id, parent))))),
    [named, selectedLabel, selectedType, sourceFilter, within, labels, scope]);
  const list = useMemo(() => browsed.filter((source) => matches === null || matches.sources.has(source.id)), [browsed, matches]);
  const constrain = (selection: ResearchSelection): ResearchSelection => ({ ...scope, ...selection,
    ...(scope.members ? { members: scope.members.filter(({ sourceId }) => selection.sourceIds?.includes(sourceId)), sourceIds: undefined } : {}),
    ...(scope.evidenceIds ? { evidenceIds: selection.evidenceIds ? selection.evidenceIds.filter((id) => scope.evidenceIds!.includes(id)) : scope.evidenceIds } : {}) });
  const viewSelection = constrain({ target: scope.target === "passages" || matches || selectedType ? "passages" : "sources",
    sourceIds: list.map(({ id }) => id),
    ...(selectedType ? { labelIds: filteredTypes } : {}),
    ...(matches ? { evidenceIds: [...matches.evidence] } : {}) });
  const selectionKey = JSON.stringify(viewSelection);
  useEffect(() => { setSelection(JSON.parse(selectionKey) as ResearchSelection); }, [selectionKey, setSelection]);
  useEffect(() => { if (sourceDropNonce && handledDrop.current !== sourceDropNonce) {
    handledDrop.current = sourceDropNonce; if (!noteOpen) revealLabels(); } }, [revealLabels, sourceDropNonce, noteOpen]);

  async function act(action: ResearchAction) {
    if (!file) return null; setStatus("");
    try { return await commit.act(action); }
    catch (reason) { setStatus(errorMessage(reason, "Could not update workspace")); return null; }
  }
  function showMatches(evidenceIds: string[], sourceIds: string[]) {
    setMatches({ evidence: new Set(evidenceIds), sources: new Set(sourceIds) }); setPicked(new Set());
    setOpenedSources((current) => new Set([...current, ...sourceIds])); setTab("search");
  }
  async function runHighlight() {
    setStatus("");
    try { if (await highlight.run() === "none") setStatus("Select text in a reader first"); }
    catch (reason) { setStatus(errorMessage(reason, "Could not save this highlight")); }
  }
  async function highlightPicked() {
    const evidenceIds = [...picked], sourceIds = allSources.filter(({ id }) => passagePages.chains[id]?.items
      .some((item) => (item.kind === "passage" || item.kind === "evidence") && picked.has(item.value.receipt.evidence_id))).map(({ id }) => id);
    let target = activePen?.id;
    if (!target) { target = crypto.randomUUID();
      if (!await act({ type: "label", id: target, name: "Highlight", parentId: null, scope: "highlight", color: "#d6b85a" })) return;
      highlight.setPen(target); }
    if (await act({ type: "label-selection", target: "passages", sourceIds, evidenceIds, assign: [target], mode: "replace" }))
      setPicked(new Set());
  }
  const handedOff = !!(scope.members || scope.sourceIds || scope.evidenceIds || scope.labelIds);
  const descendants = (id: string) => new Set(Object.keys(labels).filter((child) => within(child, id)));
  const removalMessage = (() => { if (!removing) return "";
    if (removing.kind === "source") { const source = file?.state.sources[removing.id], count = source ? researchHighlightCount(source) : 0;
      return `Remove “${removing.name}” and ${count} saved passage${count === 1 ? "" : "s"} from this workspace?`; }
    if (removing.kind === "evidence") return `Delete the saved passage at ${removing.name}?`;
    const ids = descendants(removing.id), prefix =
      `Delete “${removing.name}”${ids.size > 1 ? ` and ${ids.size - 1} nested label${ids.size === 2 ? "" : "s"}` : ""}?`;
    if (labels[removing.id]?.scope === "highlight") return `${prefix} Its highlights will be kept under Highlight.`;
    const affected = allSources.filter((item) => item.labelIds.some((id) => ids.has(id))).length;
    return `${prefix} ${affected} saved source${affected === 1 ? "" : "s"} will lose ${ids.size === 1 ? "this label" : "these labels"}.`;
  })();
  const penLabel = (label?: ResearchLabel) => label?.name ?? "Highlight";
  return <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden">
    <ResearchWorkspacePicker projectId={projectId} rail={rail} onHistory={() => setChangesOpen(true)} />
    {status && <span role="status" className="pointer-events-none absolute bottom-2 left-1/2 z-30 max-w-[calc(100%-1rem)] -translate-x-1/2 truncate rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 shadow-lg">{status}</span>}
    {file && <ResearchChanges file={file} mutations={commit} historyOpen={changesOpen} onCloseHistory={() => setChangesOpen(false)} />}
    {file && <>
      {!noteOpen && <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <Button size="compact" variant={highlight.armed ? "default" : "outline"} aria-label="Highlight"
          aria-pressed={highlight.armed} onClick={() => void runHighlight()} className="shrink-0 gap-1">
          <Highlighter aria-hidden="true" className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1"><ResearchHighlightTypes onRemove={setRemoving} onStatus={setStatus} /></div>
        <details className="relative" onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.open = false; }}>
          <summary aria-label="Filter sources" title="Filter sources" className={`grid size-8 cursor-pointer list-none place-items-center rounded border border-gray-300 text-gray-600 ${selectedType || sourceFilter !== "all" ? "bg-gray-100" : ""}`}>
            <SlidersHorizontal aria-hidden className="size-3.5" />
          </summary>
          <div className="absolute end-0 top-9 z-30 w-64 max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
            <label className="block text-xs text-gray-600">Sources
              <select aria-label="Source filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="mt-1 h-8 w-full rounded border border-gray-300 bg-white px-2 text-sm">
                <option value="all">All</option><option value="no-labels">No source labels</option>
                <option value="highlights">Has highlights</option><option value="no-highlights">No highlights</option>
              </select>
            </label>
            <label className="block text-xs text-gray-600">Highlight type
              <select aria-label="Filter by highlight type" value={selectedType} onChange={(event) => setTypeId(event.target.value)} className="mt-1 h-8 w-full rounded border border-gray-300 bg-white px-2 text-sm">
                <option value="">All highlights</option>
                {Object.values(labels).filter(({ scope }) => scope === "highlight").map((label) => <option key={label.id} value={label.id}>{researchLabelPath(labels, label.id).map(({ name }) => name).join(" / ")}</option>)}
              </select>
            </label>
            {(selectedType || sourceFilter !== "all") && <button type="button" onClick={() => { setTypeId(""); setSourceFilter("all"); }} className="text-xs text-gray-600 underline">Clear filters</button>}
          </div>
        </details>
        <input type="search" autoComplete="off" aria-label="Filter" placeholder="Filter" value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-8 min-w-0 w-full rounded-md border border-gray-300 px-2 text-sm" />
      </div>}
      <Tabs value={tab} onValueChange={setTab} ariaLabel="Workspace views" variant="subtab"
        className="min-h-0 flex-1" options={[{ value: "labels", label: "Research" },
          { value: "search", label: "Search" }, { value: "memo", label: "Memo" }]}>
        <div className={`relative min-h-0 flex-1 overflow-y-auto pt-2 ${noteOpen ? "hidden" : "block"}`}>
          <section hidden={!searchOpen} aria-label="Find in saved text" className="mb-2 min-w-0">
            <ResearchSearchPanel active={searchOpen} selection={constrain({ target: selectedType || scope.target === "passages" ? "passages" : "sources", sourceIds: browsed.map(({ id }) => id), ...(selectedType ? { labelIds: filteredTypes } : {}) })}
              matches={matches} onMatches={showMatches} onStatus={setStatus} />
          </section>
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-sm">
            {searchOpen && matches && <>
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input type="checkbox" aria-label="Select all matches" checked={picked.size > 0 && picked.size === matches.evidence.size}
                  onChange={(event) => setPicked(event.target.checked ? new Set(matches.evidence) : new Set())} />All matches</label>
              {picked.size > 0 && <Button size="compact" onClick={() => void highlightPicked()}>
                Highlight {picked.size} as {penLabel(activePen)}</Button>}
              <ResearchSelectionLabels label="Label sources" />
            </>}
            <span className="ms-auto flex flex-wrap items-center justify-end gap-1.5">
              {handedOff && <Button size="compact" variant="outline" onClick={() => setScope({ target: "sources" })}>Show all</Button>}
              {matches && <Button size="compact" variant="outline" onClick={() => { setMatches(null); setPicked(new Set()); }}>Clear matches</Button>}
            </span>
          </div>
          <ResearchTree reader={reader} passagePages={passagePages} sources={list} navigationSources={named} filter={filter} matches={matches}
            labelId={selectedLabel} onLabelChange={setLabelId}
            opened={openedSources} setOpened={setOpenedSources} passageVisible={passageVisible}
            selectedSourceId={selectedSourceId} picked={matches && searchOpen ? picked : undefined}
            onPick={matches && searchOpen ? (id, value) => setPicked((current) => { const next = new Set(current);
              if (value) next.add(id); else next.delete(id); return next; }) : undefined}
            onRemove={setRemoving} onStatus={setStatus}
            onSourceDrag={() => { if (!noteOpen) requestAnimationFrame(revealLabels); }} />
        </div>
        <div className={`${noteOpen ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}><Suspense fallback={<p role="status" className="py-3 text-sm text-gray-500">Opening memo…</p>}>
          <ResearchMemoPane file={file} mutations={commit}
            onOpenCitation={(href) => {
              const params = new URLSearchParams(href.slice(href.indexOf("?") + 1)), source = file.state.sources[params.get("research_source") ?? ""];
              if (source && reader.canRead(source)) void reader.readSource(source, params.get("locator") ?? undefined, params.get("evidence_id") ?? undefined);
              else if (href.startsWith("/library?")) { const citation = parseMemoCitation(href); if (citation) reader.setReading({ citation }); }
              else window.open(href, "_blank", "noopener,noreferrer");
            }} />
        </Suspense></div>
      </Tabs>
    </>}
    {reader.reading && <ResearchCitationViewer {...reader.reading} onClose={() => reader.setReading(null)} />}
    <ConfirmPopup open={!!removing} title={removing?.kind === "label" ? "Delete label?" : removing?.kind === "source" ? "Remove source?" : "Delete passage?"}
      message={removalMessage} confirmLabel={removing?.kind === "source" ? "Remove" : "Delete"}
      onCancel={() => setRemoving(null)} onConfirm={() => { if (removing) void act(removing.kind === "evidence"
        ? { type: "remove", kind: "evidence", id: removing.id, sourceId: removing.sourceId! }
        : { type: "remove", kind: removing.kind, id: removing.id }); setRemoving(null); }} />
  </div>;
}
