import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, Highlighter } from "lucide-react";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { Tabs } from "../ui/tabs";
import { Button } from "../ui/button";
import { researchLabelPath, researchHighlightCount, type ResearchAction, type ResearchEvidence, type ResearchSelection,
  type ResearchSource } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { memoCitation as parseMemoCitation } from "./researchMemo";
import { ResearchCitationViewer } from "./ResearchCitationViewer";
import { ResearchChanges } from "./ResearchChanges";
import { ResearchHighlightTypes } from "./ResearchLabelPicker";
import { ResearchSearchPanel } from "./ResearchSearchPanel";
import { ResearchTree, type ResearchRemoval } from "./ResearchTree";
import { ResearchWorkspacePicker } from "./ResearchWorkspacePicker";
import { sourceMatches, useSourceReader } from "./useSourceReader";
import ResearchMemoPane from "./ResearchMemoPane";

const FILTER_CHIP = "h-7 shrink-0 rounded-md border border-gray-200 px-2 text-xs text-gray-700 aria-pressed:border-gray-500 aria-pressed:bg-gray-100 aria-pressed:font-medium";
const SOURCE_FILTERS = [{ value: "all", label: "All" }, { value: "no-labels", label: "Unfiled" },
  { value: "highlights", label: "Highlighted" }, { value: "no-highlights", label: "Not highlighted" }];

type Props = { projectId?: string;
  rail?: HTMLElement | null; sourceDropNonce?: number;
  onReadSource?: (source: ResearchSource, locator?: string) => void; selectedSourceId?: string };
export function ResearchFileBar(props: Props) {
  const { file } = useSourcesWorkspace();
  return <ResearchFileBarContent key={file?.document.id ?? "empty"} {...props} />;
}
function ResearchFileBarContent({ projectId, rail, sourceDropNonce, onReadSource, selectedSourceId }: Props) {
  const { file, mutations: commit, selection: workspaceSelection, setSelection,
    passages, highlight } = useSourcesWorkspace();
  const [scope, setScope] = useState<ResearchSelection>(() => workspaceSelection);
  const [tab, setTab] = useState<"labels" | "search" | "memo">("labels");
  const searchOpen = tab === "search", noteOpen = tab === "memo";
  const [labelId, setLabelId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState(0);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [changesOpen, setChangesOpen] = useState(false), [filter, setFilter] = useState("");
  const passagePages = passages;
  const [openedSources, setOpenedSources] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState(""), [removing, setRemoving] = useState<ResearchRemoval | null>(null);
  const handledDrop = useRef(0);
  const revealLabels = useCallback(() => setTab("labels"), []);
  const reader = useSourceReader({ file, passagePages, onReadSource, onStatus: setStatus });
  const labels = useMemo(() => file?.state.labels ?? {}, [file?.state.labels]);
  const allSources = useMemo(() => Object.values(file?.state.sources ?? {}).filter((source) => source.collected), [file?.state.sources]);

  const within = useCallback((id: string, parent: string) => researchLabelPath(labels, id).some((label) => label.id === parent), [labels]);
  const selectedLabel = labelId && labels[labelId] ? labelId : null;
  const scopedSourceLabels = scope.labelIds?.filter((id) => labels[id]?.scope === "source") ?? [];
  const scopedHighlightTypes = scope.labelIds?.filter((id) => labels[id]?.scope === "highlight") ?? [];
  const passageVisible = useCallback((item: ResearchEvidence) =>
    (!scopedHighlightTypes.length || item.labelIds.some((id) => scopedHighlightTypes.some((parent) => within(id, parent)))) &&
    (!scope.evidenceIds || scope.evidenceIds.includes(item.receipt.evidence_id)) &&
    (!scope.members || scope.members.some((member) => member.sourceId === item.sourceId &&
      (!member.evidenceIds || member.evidenceIds.includes(item.receipt.evidence_id)))), [scope, within, labels]);
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
    (sourceFilter !== "no-highlights" || researchHighlightCount(source) === 0)),
    [named, selectedLabel, sourceFilter, within, labels]);
  const constrain = (selection: ResearchSelection): ResearchSelection => ({ ...scope, ...selection,
    ...(scope.members ? { members: scope.members.filter(({ sourceId }) => selection.sourceIds?.includes(sourceId)), sourceIds: undefined } : {}),
    ...(scope.evidenceIds ? { evidenceIds: selection.evidenceIds ? selection.evidenceIds.filter((id) => scope.evidenceIds!.includes(id)) : scope.evidenceIds } : {}) });
  const viewSelection = constrain({ target: scope.target === "passages" ? "passages" : "sources",
    sourceIds: browsed.map(({ id }) => id),
    ...(selectedLabel ? { labelIds: [selectedLabel, ...scopedHighlightTypes] } : {}) });
  const selectionKey = JSON.stringify(viewSelection);
  useEffect(() => { setSelection(JSON.parse(selectionKey) as ResearchSelection); }, [selectionKey, setSelection]);
  useEffect(() => { if (sourceDropNonce && handledDrop.current !== sourceDropNonce) {
    handledDrop.current = sourceDropNonce; if (!noteOpen) revealLabels(); } }, [revealLabels, sourceDropNonce, noteOpen]);

  async function act(action: ResearchAction) {
    if (!file) return null; setStatus("");
    try { return await commit.act(action); }
    catch (reason) { setStatus(errorMessage(reason, "Could not update workspace")); return null; }
  }
  async function runHighlight() {
    setStatus("");
    try { if (await highlight.run() === "none") highlight.arm(!highlight.armed); }
    catch (reason) { setStatus(errorMessage(reason, "Could not save this highlight")); }
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
  return <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden">
    <ResearchWorkspacePicker projectId={projectId} rail={rail} onHistory={() => setChangesOpen(true)} />
    {status && <span role="status" className="pointer-events-none absolute bottom-2 left-1/2 z-30 max-w-[calc(100%-1rem)] -translate-x-1/2 truncate rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 shadow-lg">{status}</span>}
    {file && <ResearchChanges file={file} mutations={commit} historyOpen={changesOpen} onCloseHistory={() => setChangesOpen(false)} />}
    {file && <>
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <Button size="compact" variant={highlight.armed ? "default" : "outline"} aria-label="Highlight"
          aria-pressed={highlight.armed} onClick={() => void runHighlight()} className="shrink-0 gap-1">
          <Highlighter aria-hidden="true" className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1"><ResearchHighlightTypes onRemove={setRemoving} onStatus={setStatus} /></div>
        <Button size="compact" variant="outline" aria-label="New label" title="New label"
          onClick={() => { setTab("labels"); setNewLabel((count) => count + 1); }} className="shrink-0">
          <FolderPlus aria-hidden className="size-3.5" />
        </Button>
        <div role="group" aria-label="Filter sources" className="flex min-w-0 flex-wrap items-center gap-1">
          {SOURCE_FILTERS.map(({ value, label }) => <button key={value} type="button" aria-pressed={sourceFilter === value}
            onClick={() => setSourceFilter(value)} className={FILTER_CHIP}>{label}</button>)}
        </div>
        <input type="search" autoComplete="off" aria-label="Filter" placeholder="Filter" value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-8 min-w-0 w-full rounded-md border border-gray-300 px-2 text-sm" />
      </div>
      <Tabs value={tab} onValueChange={setTab} ariaLabel="Workspace views" variant="subtab"
        className="min-h-0 flex-1" options={[{ value: "labels", label: "Labels" },
          { value: "search", label: "Search" }, { value: "memo", label: "Memo" }]}>
        <div className={`relative min-h-0 flex-1 overflow-y-auto pt-2 ${searchOpen ? "block" : "hidden"}`}>
          <ResearchSearchPanel active={searchOpen} onStatus={setStatus} reader={reader}
            selection={constrain({ target: scope.target === "passages" ? "passages" : "sources",
              sourceIds: browsed.map(({ id }) => id) })} />
        </div>
        <div className={`relative min-h-0 flex-1 overflow-y-auto pt-2 ${noteOpen || searchOpen ? "hidden" : "block"}`}>
          {handedOff && <Button size="compact" variant="outline" className="mb-1 ms-auto flex"
            onClick={() => setScope({ target: "sources" })}>Show all</Button>}
          <ResearchTree reader={reader} passagePages={passagePages} sources={browsed} navigationSources={named} filter={filter}
            labelId={selectedLabel} onLabelChange={setLabelId} addSignal={newLabel}
            opened={openedSources} setOpened={setOpenedSources} passageVisible={passageVisible}
            selectedSourceId={selectedSourceId}
            onRemove={setRemoving} onStatus={setStatus}
            onSourceDrag={() => { if (!noteOpen) requestAnimationFrame(revealLabels); }} />
        </div>
        <div className={`${noteOpen ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
          <ResearchMemoPane file={file} mutations={commit}
            onOpenCitation={(href) => {
              const params = new URLSearchParams(href.slice(href.indexOf("?") + 1)), source = file.state.sources[params.get("research_source") ?? ""];
              if (source && reader.canRead(source)) void reader.readSource(source, params.get("locator") ?? undefined, params.get("evidence_id") ?? undefined);
              else if (href.startsWith("/library?")) { const citation = parseMemoCitation(href); if (citation) reader.setReading({ citation }); }
              else window.open(href, "_blank", "noopener,noreferrer");
            }} />
        </div>
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
