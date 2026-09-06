import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Highlighter } from "lucide-react";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { ResearchSelectionLabels } from "../shared/ResearchSelectionLabels";
import { Tabs } from "../ui/tabs";
import { Button } from "../ui/button";
import { isResearchHighlight, isResearchSource, researchHighlightCount, type ResearchAction, type ResearchEvidence, type ResearchLabel, type ResearchSelection,
  type ResearchSource } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { memoCitation as parseMemoCitation } from "./researchMemo";
import { researchLabelColor } from "./ResearchLabelCircle";
import { ResearchCitationViewer } from "./ResearchCitationViewer";
import { ResearchChanges } from "./ResearchChanges";
import { ResearchPens } from "./ResearchPens";
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
    passages: savedPassages, evidence: readEvidence, highlight } = useSourcesWorkspace();
  const [scope, setScope] = useState<ResearchSelection>(() => workspaceSelection);
  const [tab, setTab] = useState<"labels" | "search" | "memo">("labels");
  const searchOpen = tab === "search", noteOpen = tab === "memo";
  const [changesOpen, setChangesOpen] = useState(false), [filter, setFilter] = useState("");
  const [matches, setMatches] = useState<{ evidence: Set<string>; sources: Set<string> } | null>(null),
    [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [openedSources, setOpenedSources] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState(""), [removing, setRemoving] = useState<ResearchRemoval | null>(null);
  const handledDrop = useRef(0);
  const revealLabels = useCallback(() => setTab("labels"), []);
  const passagePages = searchOpen && matches ? readEvidence : savedPassages;
  const reader = useSourceReader({ file, passagePages, onReadSource, onStatus: setStatus });
  const labels = useMemo(() => file?.state.labels ?? {}, [file?.state.labels]);
  const allSources = useMemo(() => Object.values(file?.state.sources ?? {}).filter(isResearchSource), [file?.state.sources]);
  const pen = highlight.pen && labels[highlight.pen]?.scope === "highlight" ? highlight.pen : null;
  const activePen = pen ? labels[pen] : Object.values(labels).filter(({ scope }) => scope === "highlight")
    .sort((a, b) => a.order - b.order)[0];

  const passageVisible = useCallback((item: ResearchEvidence) =>
    (!scope.evidenceIds || scope.evidenceIds.includes(item.receipt.evidence_id)) &&
    (!scope.members || scope.members.some((member) => member.sourceId === item.sourceId &&
      (!member.evidenceIds || member.evidenceIds.includes(item.receipt.evidence_id)))) &&
    (searchOpen && matches ? matches.evidence.has(item.receipt.evidence_id) : isResearchHighlight(item)), [scope, searchOpen, matches]);
  useEffect(() => {
    for (const id of openedSources) {
      const page = passagePages.chains[id];
      if (!page) void passagePages.fetchPage(id, null, false);
      else if (!page.loading && !page.error && page.nextCursor &&
        !page.items.some((item) => item.kind === "passage" && passageVisible(item.value)))
        void passagePages.fetchPage(id, page.nextCursor, true);
    }
  }, [openedSources, passageVisible, passagePages.chains, passagePages.fetchPage]);

  const named = useMemo(() => allSources.filter((source) =>
    (!scope.sourceIds || scope.sourceIds.includes(source.id)) &&
    (!scope.members || scope.members.some(({ sourceId }) => sourceId === source.id)) &&
    sourceMatches(source, filter)), [allSources, scope, filter]);
  const list = useMemo(() => named.filter((source) => matches === null || matches.sources.has(source.id)),
    [named, matches]);
  const constrain = (selection: ResearchSelection): ResearchSelection => ({ ...scope, ...selection,
    ...(scope.members ? { members: scope.members.filter(({ sourceId }) => selection.sourceIds?.includes(sourceId)), sourceIds: undefined } : {}),
    ...(scope.evidenceIds ? { evidenceIds: selection.evidenceIds ? selection.evidenceIds.filter((id) => scope.evidenceIds!.includes(id)) : scope.evidenceIds } : {}) });
  const viewSelection = constrain({ target: scope.target === "passages" || matches ? "passages" : "sources",
    sourceIds: list.map(({ id }) => id),
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
      .some((item) => item.kind === "passage" && picked.has(item.value.receipt.evidence_id))).map(({ id }) => id);
    let target = activePen?.id;
    if (!target) { target = crypto.randomUUID();
      if (!await act({ type: "label", id: target, name: "Highlight", parentId: null, scope: "highlight", color: "#d6b656" })) return;
      highlight.setPen(target); }
    if (await act({ type: "label-selection", target: "passages", sourceIds, evidenceIds, assign: [target], mode: "replace" }))
      setPicked(new Set());
  }
  const handedOff = !!(scope.members || scope.sourceIds || scope.evidenceIds);
  const descendants = (id: string) => { const ids = new Set([id]);
    for (const label of Object.values(labels)) if (label.parentId && ids.has(label.parentId)) ids.add(label.id);
    return ids; };
  const removalMessage = (() => { if (!removing) return "";
    if (removing.kind === "source") { const source = file?.state.sources[removing.id], count = source ? researchHighlightCount(source) : 0;
      return `Remove “${removing.name}” and ${count} saved passage${count === 1 ? "" : "s"} from this workspace?`; }
    if (removing.kind === "evidence") return `Delete the saved passage at ${removing.name}?`;
    const ids = descendants(removing.id), prefix =
      `Delete “${removing.name}”${ids.size > 1 ? ` and ${ids.size - 1} nested label${ids.size === 2 ? "" : "s"}` : ""}?`;
    if (labels[removing.id]?.scope === "highlight") return `${prefix} Its passages will keep their highlights using the default Highlight type.`;
    const affected = allSources.filter((item) => item.labelIds.some((id) => ids.has(id))).length;
    return `${prefix} ${affected} saved source${affected === 1 ? "" : "s"} will lose ${ids.size === 1 ? "this label" : "these labels"}.`;
  })();
  const penLabel = (label?: ResearchLabel) => label?.name ?? "Highlight";
  return <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden">
    <ResearchWorkspacePicker projectId={projectId} rail={rail} onHistory={() => setChangesOpen(true)} />
    {status && <span role="status" className="pointer-events-none absolute bottom-2 left-1/2 z-30 max-w-[calc(100%-1rem)] -translate-x-1/2 truncate rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 shadow-lg">{status}</span>}
    {file && <ResearchChanges file={file} mutations={commit} historyOpen={changesOpen} onCloseHistory={() => setChangesOpen(false)} />}
    {file && <>
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <Button size="compact" variant={highlight.armed ? "default" : "outline"} aria-label="Highlight"
          aria-pressed={highlight.armed} onClick={() => void runHighlight()} className="shrink-0 gap-1">
          <span aria-hidden="true" className="size-2.5 rounded-full"
            style={{ backgroundColor: activePen ? researchLabelColor(activePen) : "#eab308" }} />
          <Highlighter aria-hidden="true" className="size-3.5" />
        </Button>
        <ResearchPens onRemove={setRemoving} onStatus={setStatus} />
        <input type="search" autoComplete="off" aria-label="Filter" placeholder="Filter" value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-8 min-w-0 flex-1 basis-32 rounded-md border border-gray-300 px-2 text-sm" />
      </div>
      <Tabs value={tab} onValueChange={setTab} ariaLabel="Workspace views" variant="subtab"
        className="min-h-0 flex-1" options={[{ value: "labels", label: "Labels" },
          { value: "search", label: "Search" }, { value: "memo", label: "Memo" }]}>
        <div className={`relative min-h-0 flex-1 overflow-y-auto pt-2 ${noteOpen ? "hidden" : "block"}`}>
          <section hidden={!searchOpen} aria-label="Find in saved text" className="mb-2 min-w-0">
            <ResearchSearchPanel active={searchOpen} selection={constrain({ target: "sources", sourceIds: named.map(({ id }) => id) })}
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
          <ResearchTree passagePages={passagePages} reader={reader} sources={list} filter={filter} matches={matches}
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
