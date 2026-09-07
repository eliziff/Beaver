import { useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink, Eye, FileCheck2,
  FilePlus2, FolderSearch, Plus, RefreshCw, Upload } from "lucide-react";
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
import type { SourceOcrStatus } from "./sourceOcr";

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
  onRetry?: () => void; ocr?: Record<string, SourceOcrStatus>;
  onOcrPause?: (role: string) => void; onOcrResume?: (role: string) => void;
  onOcrCancel?: (role: string) => void;
};
export function ManualDraft(props: Omit<PanelProps, "occurrences">) {
  return <SourcePanel {...props} occurrences={[]} />;
}
export function Sources({ draft, ...props }: Omit<PanelProps, "state"> & { draft: AuthoritiesProduct }) {
  return <SourcePanel {...props} state={draft.state} />;
}

function SourcePanel({ state, authorities, tabs, occurrences, busy, sourceIssues,
  onAction, onAdd, onPickMany, onLibraryAdd, onFiles, onRetry, onPick, onLibrary,
  sourceLabel = "Library", onAttach, onRelink, onOpenSource, onEditIdentity, forceOpen,
  ocr, onOcrPause, onOcrResume, onOcrCancel }: PanelProps) {
  const active = state.stage === "sources" || state.stage === undefined || !!forceOpen;
  const [expanded, setExpanded] = useState(active), [tabSettings, setTabSettings] = useState(false);
  useEffect(() => { setExpanded(active); }, [active]);
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
      <div className="mb-3 flex flex-wrap justify-end gap-2">
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
      <div role="list" aria-label="Authority tab slots"
        className="divide-y divide-gray-200 rounded-lg border border-gray-300">
        {authorities.map((authority) => <AuthorityRow key={authority.id} authority={authority} busy={busy}
          tab={authority.excluded ? "Excluded" : tabs.get(authority.id)}
          citations={authorityCitationForms(authority, occurrences)}
          needsPdf={!authority.excluded && requiresPdf(state, authority)}
          requireLanguages={requiresBilingualSources(state, authority)} sourceIssues={sourceIssues}
          editableIdentity={state.import.kind === "manual" || !!authority.userAdded}
          removable={!occurrences.some(({ authorityId }) => authorityId === authority.id)}
          onAction={onAction} onPick={onPick ? () => onPick(authority.id) : undefined}
          onLibrary={onLibrary ? () => onLibrary(authority.id) : undefined} sourceLabel={sourceLabel}
          onAttach={(file) => onAttach(authority.id, file)} onRelink={onRelink}
          onOpen={onOpenSource} onEditIdentity={() => onEditIdentity(authority)}
          ocr={ocr} onOcrPause={onOcrPause} onOcrResume={onOcrResume} onOcrCancel={onOcrCancel} />)}
        {!authorities.length && <p className="px-4 py-8 text-center text-sm text-gray-500">Add authorities to begin.</p>}
      </div>
      <Button type="button" variant="ghost" className="mt-2 h-9" disabled={busy} onClick={onAdd}><Plus /> Add authority</Button>
    </div>
  </details>
  {tabSettings && <TabFormatModal settings={state.settings} busy={busy} onClose={() => setTabSettings(false)}
    onSave={(settings) => onAction({ type: "set-settings", settings })} />}</>;
}

function AuthorityRow({ authority, tab, citations, busy, needsPdf, requireLanguages, sourceIssues,
  editableIdentity, removable, sourceLabel, onAction, onPick, onLibrary, onAttach, onRelink,
  onOpen, onEditIdentity, ocr, onOcrPause, onOcrResume, onOcrCancel }: {
  authority: AuthorityIdentity; tab?: string; citations: string[]; busy: boolean; needsPdf: boolean;
  requireLanguages: boolean; sourceIssues: Record<string, AuthoritiesSourceIssue>;
  editableIdentity: boolean; removable: boolean; sourceLabel: string;
  onAction: (action: AuthoritiesAction) => void; onPick?: () => void; onLibrary?: () => void;
  onAttach: (file?: File) => void; onRelink: (role: string) => void;
  onOpen?: (role: string) => void; onEditIdentity: () => void;
  ocr?: Record<string, SourceOcrStatus>; onOcrPause?: (role: string) => void;
  onOcrResume?: (role: string) => void; onOcrCancel?: (role: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(authorityName(authority));
  const sources = authority.source.kind === "attached" ? authority.source.sources : [];
  const title = authorityName(authority), citationLine = citations.filter((citation) =>
    !title.toLocaleLowerCase().includes(citation.toLocaleLowerCase())).join("; ");
  const pick = () => { if (onPick) onPick(); else fileInput.current?.click(); };
  const replacement = sources.length && !requireLanguages ? "Replace" : "Add PDF";
  const issue = sources.find(({ bindingRole }) => relinkable(sourceIssues[bindingRole]));
  const loaded = sources.length && sources.every(({ bindingRole }) => !sourceIssues[bindingRole]);
  return <article role="listitem" data-authority-id={authority.id}
    className={cn("grid min-h-12 min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-2 py-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]",
      authority.excluded && "opacity-65")}
    onDragOver={(event) => { if (!busy && needsPdf && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={(event) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation();
      if (!busy && needsPdf) onAttach(event.dataTransfer.files[0]);
    }}>
    <span className="truncate text-xs font-semibold text-gray-600" title={tab}>{tab}</span>
    {editing ? <form onSubmit={(event) => {
      event.preventDefault(); onAction({ type: "rename-authority", authorityId: authority.id,
        displayName: name.trim() || null }); setEditing(false);
    }} className="flex min-w-0 gap-1">
      <Input autoFocus aria-label="Authority title" value={name} onChange={(event) => setName(event.target.value)}
        className="h-8 min-w-0 border-gray-400 text-sm" />
      <Button type="submit" className="h-8" disabled={busy}>Save</Button>
    </form> : <div className="flex min-w-0 items-center gap-2">
      {!!loaded && <span role="img" aria-label="PDF loaded" className="shrink-0 text-green-700"
        title={sources.map(({ filename }) => filename).join("\n")}><FileCheck2 className="h-4 w-4" /></span>}
      <h3 className="truncate text-sm font-medium text-gray-950" title={title}>{title}</h3>
      {!!citationLine && <span className="hidden shrink truncate text-xs text-gray-500 sm:block"
        title={citationLine}>{citationLine}</span>}
    </div>}
    <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
      {needsPdf && (authority.source.kind === "pending-canlii"
        ? <a href={authority.source.pdfUrl} target="_blank" rel="noopener noreferrer"
            className={cn(control, "inline-flex items-center gap-1 rounded-md border text-red-800 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600")}>
            <ExternalLink className="h-3.5 w-3.5" />Get from CanLII</a>
        : issue ? <Button type="button" variant="outline" className={cn(control, "text-red-800")}
            disabled={busy} onClick={() => onRelink(issue.bindingRole)}><FilePlus2 />
            <span className="truncate">{sourceAction(sourceIssues[issue.bindingRole], "PDF")}</span></Button>
        : sources.length && !loaded ? <span className="text-xs text-red-800">PDF unavailable</span>
        : sources.length && onOpen ? (sources.length === 1
          ? <Button type="button" variant="outline" className={control} disabled={busy || !loaded}
              aria-label={`View PDF for ${title}`} onClick={() => onOpen(sources[0].bindingRole)}><Eye /> View PDF</Button>
          : <ActionMenu label={`View PDFs for ${title}`} triggerClassName={cn(control, "inline-flex items-center gap-1 rounded-md border")}
              items={sources.map((source) => ({ label: sourceLanguageLabel(source.language),
                disabled: busy || !!sourceIssues[source.bindingRole], onSelect: () => onOpen(source.bindingRole) }))}>
              <Eye className="h-3.5 w-3.5" /> View PDFs</ActionMenu>)
        : null)}
      {needsPdf && <ActionMenu label={`${replacement} for ${title}`}
        triggerClassName={cn(control, "inline-flex items-center gap-1 rounded-md border text-gray-800 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600")}
        items={[{ label: "Upload from computer", disabled: busy, onSelect: pick },
          ...(onLibrary ? [{ label: `Choose from ${sourceLabel}`, disabled: busy, onSelect: onLibrary }] : [])]}>
        <Upload className="h-3.5 w-3.5" />{replacement}</ActionMenu>}
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
    {sources.flatMap((source) => {
      const status = ocr?.[source.bindingRole];
      return status ? [<SourceOcrProgress key={source.bindingRole} status={status}
        onPause={onOcrPause} onResume={onOcrResume} onCancel={onOcrCancel} />] : [];
    })}
    <input ref={fileInput} className="sr-only" tabIndex={-1} type="file" accept=".pdf,application/pdf"
      disabled={busy} aria-label={`Upload PDF for ${title}`} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) onAttach(file);
      }} />
  </article>;
}

/** Text recognition for one scanned source, watched where the source lives. */
function SourceOcrProgress({ status, onPause, onResume, onCancel }: {
  status: SourceOcrStatus; onPause?: (role: string) => void;
  onResume?: (role: string) => void; onCancel?: (role: string) => void;
}) {
  const total = status.textlessPages.length;
  const done = status.state === "done" ? total
    : status.page ? status.textlessPages.filter((page) => page < status.page!).length : 0;
  return <div className="col-span-2 flex items-center gap-2 ps-2 text-xs sm:col-span-3">
    {status.state === "done" ? <span className="text-green-800">Text recognized on {total} scanned page{total === 1 ? "" : "s"}</span>
      : status.state === "failed" ? <span className="text-red-800">{status.error || "Text recognition failed"}</span>
      : <>
        <span className="min-w-0 truncate text-gray-600">
          {status.state === "paused" ? "Recognition paused" : "Recognizing text"} — {done} of {total} scanned page{total === 1 ? "" : "s"}</span>
        <div aria-hidden="true" className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-gray-200">
          <div className="h-full bg-red-700" style={{ width: `${Math.round(100 * done / Math.max(total, 1))}%` }} /></div>
      </>}
    <span className="ms-auto flex shrink-0 gap-1">
      {status.state === "running" && onPause && <button type="button" className={ocrControl}
        onClick={() => onPause(status.role)}>Pause</button>}
      {status.state === "paused" && onResume && <button type="button" className={ocrControl}
        onClick={() => onResume(status.role)}>Resume</button>}
      {status.state !== "done" && onCancel && <button type="button" className={ocrControl}
        onClick={() => onCancel(status.role)}>Stop</button>}
    </span>
  </div>;
}
const ocrControl = "rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600";
