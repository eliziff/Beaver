import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink, Eye, FileCheck2,
  FilePlus2, FolderSearch, GripVertical, Plus, RefreshCw, Upload } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { FileInputButton } from "./FileInputButton";
import { TabFormatModal } from "./TabFormatModal";
import { authorityName, authorityCitationForms, hasRequiredSources, requiresBilingualSources,
  requiresPdf, sourceLanguageLabel, sourceAction, relinkable } from "./authorityPresentation";
import type { AuthoritiesAction, AuthoritiesDraft, AuthoritiesProduct,
  AuthorityIdentity, AuthorityOccurrence } from "./types";
import type { AuthoritiesSourceIssue } from "./host";

const DRAG_TYPE = "application/x-beaver-authority";
const control = "h-8 shrink-0 border-gray-400 px-2.5 text-xs";
export type AuthorityPanelProps = {
  authorities: AuthorityIdentity[]; tabs: ReadonlyMap<string, string>; busy: boolean;
  sourceIssues: Record<string, AuthoritiesSourceIssue>;
  onAction: (action: AuthoritiesAction) => void; onAdd: () => void;
  onPick?: (id: string) => void; onAttach: (id: string, file?: File) => void;
  onLibrary?: (id: string) => void; sourceLabel?: string;
  onRelink: (role: string) => void; onOpenSource?: (role: string) => void;
  onEditIdentity: (authority: AuthorityIdentity) => void;
};
type PanelProps = AuthorityPanelProps & {
  state: AuthoritiesDraft; occurrences: AuthorityOccurrence[]; forceOpen?: boolean;
  onPickMany?: () => void; onLibraryAdd?: () => void; onFiles?: (files: File[]) => void;
  onRetry?: () => void;
};
export function ManualDraft(props: Omit<PanelProps, "occurrences">) {
  return <SourcePanel {...props} occurrences={[]} />;
}
export function Sources({ draft, ...props }: Omit<PanelProps, "state"> & { draft: AuthoritiesProduct }) {
  return <SourcePanel {...props} state={draft.state} />;
}

function SourcePanel({ state, authorities, tabs, occurrences, busy, sourceIssues,
  onAction, onAdd, onPickMany, onLibraryAdd, onFiles, onRetry, onPick, onLibrary,
  sourceLabel = "Library", onAttach, onRelink, onOpenSource, onEditIdentity, forceOpen }: PanelProps) {
  const active = state.stage === "sources" || state.stage === undefined || !!forceOpen;
  const [expanded, setExpanded] = useState(active), [tabSettings, setTabSettings] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const list = useRef<HTMLDivElement>(null), pendingMove = useRef<string | null>(null);
  const order = authorities.map(({ id }) => id).join("\0");
  useEffect(() => { setExpanded(active); }, [active]);
  useLayoutEffect(() => {
    const id = pendingMove.current;
    if (!id) return;
    pendingMove.current = null;
    const handle = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-move-authority]") ?? [])]
      .find((item) => item.dataset.moveAuthority === id);
    handle?.focus({ preventScroll: true });
    handle?.scrollIntoView?.({ block: "nearest" });
    setAnnouncement(`Moved ${authorityName(authorities.find((item) => item.id === id)!)} to ${tabs.get(id)}.`);
  }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
  function move(authorityId: string, toIndex: number) {
    if (busy || toIndex < 0 || toIndex >= authorities.length ||
      !authorities.some(({ id }) => id === authorityId)) return;
    pendingMove.current = authorityId;
    onAction({ type: "move-authority", authorityId, toIndex });
  }
  const included = authorities.filter(({ excluded }) => !excluded);
  const ready = included.filter((authority) => hasRequiredSources(state, authority) && authority.source.kind === "attached" &&
    authority.source.sources.every(({ bindingRole }) => !sourceIssues[bindingRole])).length;
  return <><details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}
    className="group mt-3 rounded-xl border border-gray-300 bg-white shadow-sm">
    <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-t-xl px-4 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="h-4 w-4 text-red-700 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
      <h2 className="font-semibold text-gray-950">Sources</h2>
      <span className="ms-auto text-sm tabular-nums text-gray-500">{ready} / {included.length} PDFs</span>
    </summary>
    <div className="border-t border-gray-200 p-3 sm:p-4"
      onDragOver={(event) => { if (!busy && onFiles && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => {
        if (!busy && onFiles && event.dataTransfer.files.length) {
          event.preventDefault(); onFiles(Array.from(event.dataTransfer.files));
        }
      }}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p id="authority-move-help" className="text-xs text-gray-500">Move authorities between slots with the arrows or drag handle.</p>
        <div className="flex flex-wrap gap-2">
          {onRetry && <Button type="button" variant="outline" className={control} disabled={busy}
            onClick={onRetry}><RefreshCw /> Find missing PDFs</Button>}
          {state.outputMode !== "table" && <Button type="button" variant="outline" className={control}
            disabled={busy} onClick={() => setTabSettings(true)}>Tab labels</Button>}
          {onFiles && (onPickMany ? <Button type="button" variant="outline" className={control}
            disabled={busy} onClick={onPickMany}><FilePlus2 /> Add PDFs</Button>
            : <FileInputButton multiple disabled={busy} label="Add PDFs" accept=".pdf,application/pdf"
              onFiles={onFiles} variant="outline" compact />)}
          {onLibraryAdd && <Button type="button" variant="outline" className={control} disabled={busy}
            onClick={onLibraryAdd}><FolderSearch /> {sourceLabel}</Button>}
        </div>
      </div>
      <div ref={list} role="list" aria-label="Authority tab slots" className="space-y-2">
        {authorities.map((authority, index) => <div key={index} role="listitem"
          data-authority-slot={index + 1} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 sm:grid-cols-[5.5rem_minmax(0,1fr)]"
          onDragOver={(event) => {
            if (!busy && event.dataTransfer.types.includes(DRAG_TYPE)) {
              event.preventDefault(); event.dataTransfer.dropEffect = "move";
            }
          }} onDrop={(event) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault(); event.stopPropagation();
            move(event.dataTransfer.getData(DRAG_TYPE), index);
          }}>
          <div className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-gray-50 px-1">
            <span className="line-clamp-2 max-w-full text-center text-xs font-semibold text-gray-600"
              title={tabs.get(authority.id)}>{authority.excluded ? "Excluded" : tabs.get(authority.id)}</span>
            <div className="flex items-center">
              <Button type="button" variant="ghost" size="icon-sm" disabled={busy || index === 0}
                aria-label={`Move ${authorityName(authority)} up`} onClick={() => move(authority.id, index - 1)}><ArrowUp /></Button>
              <Button type="button" variant="ghost" size="icon-sm" disabled={busy || index === authorities.length - 1}
                aria-label={`Move ${authorityName(authority)} down`} onClick={() => move(authority.id, index + 1)}><ArrowDown /></Button>
            </div>
          </div>
          <AuthorityCard key={authority.id} authority={authority} busy={busy}
            citations={authorityCitationForms(authority, occurrences)}
            needsPdf={!authority.excluded && requiresPdf(state, authority)}
            requireLanguages={requiresBilingualSources(state, authority)} sourceIssues={sourceIssues}
            editableIdentity={state.import.kind === "manual" || !!authority.userAdded}
            removable={!occurrences.some(({ authorityId }) => authorityId === authority.id)}
            onAction={onAction} onPick={onPick ? () => onPick(authority.id) : undefined}
            onLibrary={onLibrary ? () => onLibrary(authority.id) : undefined} sourceLabel={sourceLabel}
            onAttach={(file) => onAttach(authority.id, file)} onRelink={onRelink}
            onOpen={onOpenSource} onEditIdentity={() => onEditIdentity(authority)}
            onMove={(direction) => move(authority.id, index + direction)} />
        </div>)}
        {!authorities.length && <p className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">Add authorities to begin.</p>}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <Button type="button" variant="ghost" className="mt-2 h-9" disabled={busy} onClick={onAdd}><Plus /> Add authority</Button>
    </div>
  </details>
  {tabSettings && <TabFormatModal settings={state.settings} busy={busy} onClose={() => setTabSettings(false)}
    onSave={(settings) => onAction({ type: "set-settings", settings })} />}</>;
}

function AuthorityCard({ authority, citations, busy, needsPdf, requireLanguages, sourceIssues,
  editableIdentity, removable, sourceLabel, onAction, onPick, onLibrary, onAttach, onRelink,
  onOpen, onEditIdentity, onMove }: {
  authority: AuthorityIdentity; citations: string[]; busy: boolean; needsPdf: boolean;
  requireLanguages: boolean; sourceIssues: Record<string, AuthoritiesSourceIssue>;
  editableIdentity: boolean; removable: boolean; sourceLabel: string;
  onAction: (action: AuthoritiesAction) => void; onPick?: () => void; onLibrary?: () => void;
  onAttach: (file?: File) => void; onRelink: (role: string) => void;
  onOpen?: (role: string) => void; onEditIdentity: () => void; onMove: (direction: number) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false), [canliiOpen, setCanliiOpen] = useState(false);
  const [name, setName] = useState(authorityName(authority));
  const sources = authority.source.kind === "attached" ? authority.source.sources : [];
  const title = authorityName(authority), citationLine = citations.filter((citation) =>
    !title.toLocaleLowerCase().includes(citation.toLocaleLowerCase())).join("; ");
  const pick = () => { if (onPick) onPick(); else fileInput.current?.click(); };
  const replacement = sources.length && !requireLanguages ? "Replace" : "Add PDF";
  const issue = sources.find(({ bindingRole }) => relinkable(sourceIssues[bindingRole]));
  const loaded = sources.length && sources.every(({ bindingRole }) => !sourceIssues[bindingRole]);
  return <><article data-authority-id={authority.id}
    className={cn("grid h-36 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-2 rounded-lg border bg-white p-3 sm:h-32",
      authority.excluded ? "border-gray-200 opacity-65" : "border-gray-300")}
    onDragOver={(event) => { if (!busy && needsPdf && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={(event) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation();
      if (!busy && needsPdf) onAttach(event.dataTransfer.files[0]);
    }}>
    <div className="flex min-w-0 items-start gap-2">
      <button type="button" disabled={busy} draggable={!busy} data-move-authority={authority.id}
        aria-label={`Move ${title}`} aria-describedby="authority-move-help"
        title="Drag to another slot, or use Alt + Up / Down"
        className="mt-0.5 flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded text-gray-400 outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-red-600 disabled:cursor-default"
        onKeyDown={(event) => {
          if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault(); onMove(event.key === "ArrowUp" ? -1 : 1);
          }
        }} onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, authority.id); event.dataTransfer.effectAllowed = "move";
          const card = event.currentTarget.closest("article");
          if (card) event.dataTransfer.setDragImage(card, 20, 20);
        }}><GripVertical className="h-4 w-4" /></button>
      <div className="min-w-0 flex-1">
        {editing ? <form onSubmit={(event) => {
          event.preventDefault(); onAction({ type: "rename-authority", authorityId: authority.id,
            displayName: name.trim() || null }); setEditing(false);
        }} className="flex gap-1">
          <Input autoFocus aria-label="Authority title" value={name} onChange={(event) => setName(event.target.value)}
            className="h-8 min-w-0 border-gray-400 text-sm" />
          <Button type="submit" className="h-8" disabled={busy}>Save</Button>
        </form> : <h3 className="line-clamp-2 text-sm font-medium leading-5 text-gray-950" title={title}>{title}</h3>}
        <p className="mt-0.5 min-h-4 truncate text-xs leading-4 text-gray-500" title={citationLine}>{citationLine}</p>
      </div>
      {!!loaded && <span role="img" aria-label="PDF loaded" title={sources.map(({ filename }) => filename).join("\n")}
        className="mt-0.5 shrink-0 text-green-700"><FileCheck2 className="h-4 w-4" /></span>}
    </div>
    <div className="grid grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-1.5">
      <div className="min-w-0">
        {needsPdf && (authority.source.kind === "pending-canlii"
          ? <Button type="button" variant="outline" className={cn(control, "max-w-full text-red-800")}
              disabled={busy} onClick={() => setCanliiOpen(true)}><ExternalLink /><span className="truncate">Get from CanLII</span></Button>
          : issue ? <Button type="button" variant="outline" className={cn(control, "max-w-full text-red-800")}
              disabled={busy} onClick={() => onRelink(issue.bindingRole)}><FilePlus2 /><span className="truncate">{sourceAction(sourceIssues[issue.bindingRole], "PDF")}</span></Button>
          : sources.length && !loaded ? <span className="text-xs text-red-800">PDF unavailable</span>
          : sources.length && onOpen ? (sources.length === 1
            ? <Button type="button" variant="outline" className={control} disabled={busy || !loaded}
                aria-label={`View PDF for ${title}`} onClick={() => onOpen(sources[0].bindingRole)}><Eye /> View PDF</Button>
            : <ActionMenu label={`View PDFs for ${title}`} triggerClassName={cn(control, "inline-flex items-center gap-1 rounded-md border")}
                items={sources.map((source) => ({ label: sourceLanguageLabel(source.language),
                  disabled: busy || !!sourceIssues[source.bindingRole], onSelect: () => onOpen(source.bindingRole) }))}>
                <Eye className="h-3.5 w-3.5" /> View PDFs</ActionMenu>)
          : <span className="text-xs text-gray-500">PDF needed</span>)}
      </div>
      {needsPdf ? <ActionMenu label={`${replacement} for ${title}`}
        triggerClassName={cn(control, "inline-flex items-center gap-1 rounded-md border text-gray-800 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600")}
        items={[{ label: "Upload from computer", disabled: busy, onSelect: pick },
          ...(onLibrary ? [{ label: `Choose from ${sourceLabel}`, disabled: busy, onSelect: onLibrary }] : [])]}>
        <Upload className="h-3.5 w-3.5" />{replacement}</ActionMenu> : <span />}
      <MoreActionsMenu label={`Options for ${title}`} triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600"
        items={[{ label: editableIdentity ? "Edit details" : "Edit title", disabled: busy,
          onSelect: () => { if (editableIdentity) onEditIdentity(); else { setName(title); setEditing(true); } } },
          ...(sources.length ? [{ label: sources.length === 1 ? "Remove PDF" : "Remove PDFs", disabled: busy,
            onSelect: () => onAction({ type: "clear-authority-source", authorityId: authority.id }) }] : []),
          { label: authority.excluded ? "Include in book" : "Leave out of book", disabled: busy,
            onSelect: () => onAction({ type: "exclude-authority", authorityId: authority.id, excluded: !authority.excluded }) },
          { label: "Delete entry", disabled: busy || !removable,
            onSelect: () => onAction({ type: "remove-authority", authorityId: authority.id }) }]} />
    </div>
    <input ref={fileInput} className="sr-only" tabIndex={-1} type="file" accept=".pdf,application/pdf"
      disabled={busy} aria-label={`Upload PDF for ${title}`} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) { setCanliiOpen(false); onAttach(file); }
      }} />
  </article>
  {canliiOpen && authority.source.kind === "pending-canlii" && <Modal open onClose={() => setCanliiOpen(false)}
    size="lg" breadcrumbs={["Download this source"]} className="!h-fit max-h-[calc(100dvh-2rem)]"
    secondaryAction={{ label: "Close", onClick: () => setCanliiOpen(false) }}
    primaryAction={{ label: "Choose downloaded PDF", disabled: busy, onClick: pick }}>
    <p className="font-medium text-gray-950">{title}</p>
    <p className="mt-2 text-sm leading-6 text-gray-600">Open CanLII, download the PDF using its controls, then return here to add it. The file stays assigned to this authority.</p>
    <div aria-hidden="true" className="my-4 flex items-center justify-center gap-4 rounded-md bg-gray-50 p-4 text-gray-500">
      <ExternalLink /><span>→</span><FilePlus2 /><span>→</span><Upload />
    </div>
    <a href={authority.source.pageUrl} target="_blank" rel="noopener noreferrer"
      className="mb-4 inline-flex min-h-10 w-fit items-center gap-2 rounded-md bg-red-700 px-4 text-sm font-medium text-white outline-none hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2">
      Open CanLII<ExternalLink className="h-4 w-4" /></a>
  </Modal>}</>;
}
