import { useRef, useState } from "react";
import { ExternalLink, Eye, FileCheck2, FilePlus2, FileType2,
  FolderSearch, Pencil, Plus, Upload } from "lucide-react";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { FileInputButton } from "./FileInputButton";
import { TabFormatModal } from "./TabFormatModal";
import { authorityName, authorityCitationForms, requiresBilingualSources,
  requiresPdf, sourceLanguageLabel, sourceAction, relinkable } from "./authorityPresentation";
import type { AuthoritiesAction, AuthoritiesDraft, AuthoritiesProduct,
  AuthorityIdentity, AuthorityOccurrence } from "./types";
import type { AuthoritiesSourceIssue } from "./host";
import type { ScannedPdf, SourceOcrStatus } from "./sourceOcr";

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
  state: AuthoritiesDraft; occurrences: AuthorityOccurrence[];
  onPickMany?: () => void; onLibraryAdd?: () => void; onFiles?: (files: File[]) => void;
  ocr?: SourceOcrPanel;
};
export function Sources({ draft, ...props }: Omit<PanelProps, "state"> & { draft: AuthoritiesProduct }) {
  return <SourcePanel {...props} state={draft.state} />;
}

function SourcePanel({ state, authorities, tabs, occurrences, busy, sourceIssues,
  onAction, onAdd, onPickMany, onLibraryAdd, onFiles, onPick, onLibrary,
  sourceLabel = "Library", onAttach, onRelink, onOpenSource, onEditIdentity,
  ocr }: PanelProps) {
  const [tabSettings, setTabSettings] = useState(false);
  return <><section className="mt-3 rounded-xl border border-gray-300 bg-white shadow-sm">
    <div className="p-3 sm:p-4"
      onDragOver={(event) => { if (!busy && onFiles && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => {
        if (!busy && onFiles && event.dataTransfer.files.length) {
          event.preventDefault(); onFiles(Array.from(event.dataTransfer.files));
        }
      }}>
      {(state.outputMode !== "table" || onFiles || onLibraryAdd) && <div className="mb-3 flex flex-wrap justify-end gap-2">
        {state.outputMode !== "table" && <Button type="button" variant="outline" className={control}
          disabled={busy} onClick={() => setTabSettings(true)}>Tab labels</Button>}
        {onFiles && (onPickMany ? <Button type="button" variant="outline" className={control}
          disabled={busy} onClick={onPickMany}><FilePlus2 /> Upload</Button>
          : <FileInputButton multiple disabled={busy} label="Upload" accept=".pdf,application/pdf"
            onFiles={onFiles} variant="outline" compact />)}
        {onLibraryAdd && <Button type="button" variant="outline" className={control} disabled={busy}
          onClick={onLibraryAdd}><FolderSearch /> {sourceLabel}</Button>}
      </div>}
      <div role="list" aria-label="Authority tab slots"
        className="divide-y divide-gray-200 rounded-lg border border-gray-300">
        {authorities.map((authority) => <AuthorityRow key={authority.id} authority={authority} busy={busy}
          order={state.authorityOrder}
          tab={authority.excluded ? "Excluded" : tabs.get(authority.id)}
          citations={authorityCitationForms(authority, occurrences)}
          needsPdf={!authority.excluded && requiresPdf(state, authority)}
          requireLanguages={requiresBilingualSources(state, authority)} sourceIssues={sourceIssues}
          editableIdentity={state.import.kind === "manual" || !!authority.userAdded}
          rebuildsFromText={state.settings.sourceMode !== "manual-originals"}
          removable={!occurrences.some(({ authorityId }) => authorityId === authority.id)}
          onAction={onAction} onPick={onPick ? () => onPick(authority.id) : undefined}
          onLibrary={onLibrary ? () => onLibrary(authority.id) : undefined} sourceLabel={sourceLabel}
          onAttach={(file) => onAttach(authority.id, file)} onRelink={onRelink}
          onOpen={onOpenSource} onEditIdentity={() => onEditIdentity(authority)} ocr={ocr} />)}
        {!authorities.length && <p className="px-4 py-8 text-center text-sm text-gray-500">Add authorities to begin.</p>}
      </div>
      <Button type="button" variant="ghost" className="mt-2 h-9" disabled={busy} onClick={onAdd}><Plus /> Add authority</Button>
    </div>
  </section>
  {tabSettings && <TabFormatModal settings={state.settings} busy={busy} onClose={() => setTabSettings(false)}
    onSave={(settings) => onAction({ type: "set-settings", settings })} />}</>;
}

function AuthorityRow({ authority, tab, citations, busy, needsPdf, requireLanguages, sourceIssues,
  editableIdentity, rebuildsFromText, removable, sourceLabel, onAction, onPick, onLibrary, onAttach,
  onRelink, onOpen, onEditIdentity, ocr, order }: {
  order: string[];
  authority: AuthorityIdentity; tab?: string; citations: string[]; busy: boolean; needsPdf: boolean;
  requireLanguages: boolean; sourceIssues: Record<string, AuthoritiesSourceIssue>;
  editableIdentity: boolean; rebuildsFromText: boolean; removable: boolean; sourceLabel: string;
  onAction: (action: AuthoritiesAction) => void; onPick?: () => void; onLibrary?: () => void;
  onAttach: (file?: File) => void; onRelink: (role: string) => void;
  onOpen?: (role: string) => void; onEditIdentity: () => void; ocr?: SourceOcrPanel;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const styleOfCause = authority.displayName || authority.name || "";
  const [editing, setEditing] = useState(false);
  const sources = authority.source.kind === "attached" ? authority.source.sources : [];
  const title = authorityName(authority), citationLine = citations.filter((citation) =>
    !styleOfCause.toLocaleLowerCase().includes(citation.toLocaleLowerCase())).join("; ");
  const pick = () => { if (onPick) onPick(); else fileInput.current?.click(); };
  const replacement = sources.length && !requireLanguages ? "Replace" : "Upload";
  const rowControl = cn(control, "w-28 justify-center");
  const issue = sources.find(({ bindingRole }) => relinkable(sourceIssues[bindingRole]));
  const loaded = sources.length && sources.every(({ bindingRole }) => !sourceIssues[bindingRole]);
  const fromText = sources.length ? sources.every(({ origin }) => origin === "reconstructed")
    : rebuildsFromText && authority.source.kind === "resolved";
  const mark = fromText ? { Icon: FileType2, tone: "text-indigo-700",
      label: loaded ? "Built from source text" : "Will be built from source text" }
    : loaded ? { Icon: FileCheck2, tone: "text-green-700",
      label: sources.map(({ filename }) => filename).join("\n") || "PDF loaded" } : null;
  const edit = () => setEditing(true);
  const save = (name: string) => { setEditing(false);
    if (name.trim() !== styleOfCause) onAction({ type: "rename-authority",
      authorityId: authority.id, displayName: name.trim() || null }); };
  return <article role="listitem" data-authority-id={authority.id}
    className={cn("group/row grid min-h-12 min-w-0 grid-cols-[2.25rem_1.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-2 py-1.5 sm:grid-cols-[2.75rem_1.25rem_minmax(0,1fr)_11rem_16.5rem]",
      authority.excluded && "opacity-65")}
    onDragOver={(event) => { if (!busy && (event.dataTransfer.types.includes("application/x-authority") ||
      needsPdf && event.dataTransfer.types.includes("Files"))) event.preventDefault(); }}
    onDrop={(event) => {
      const id = event.dataTransfer.getData("application/x-authority");
      if (!busy && order.includes(id)) { event.preventDefault(); event.stopPropagation();
        onAction({ type: "move-authority", authorityId: id, toIndex: order.indexOf(authority.id) }); return; }
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation();
      if (!busy && needsPdf) onAttach(event.dataTransfer.files[0]);
    }}>
    <button type="button" draggable={!busy} disabled={busy} title="Drag to reorder, or use arrow keys"
      aria-label={`Reorder ${title}`} className="cursor-grab truncate rounded py-2 text-xs font-semibold text-gray-600 focus-visible:ring-2 focus-visible:ring-red-600"
      onDragStart={event => event.dataTransfer.setData("application/x-authority", authority.id)}
      onKeyDown={event => { if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault(); onAction({ type: "move-authority", authorityId: authority.id,
          toIndex: Math.max(0, Math.min(order.length - 1, order.indexOf(authority.id) + (event.key === "ArrowUp" ? -1 : 1))) }); }}>{tab}</button>
    <span className="flex h-4 w-4 items-center justify-center">
      {mark && <mark.Icon role="img" aria-label={mark.label} className={cn("h-4 w-4", mark.tone)}>
        <title>{mark.label}</title></mark.Icon>}
    </span>
    {editing ? <StyleOfCause value={styleOfCause} onSave={save} onCancel={() => setEditing(false)} /> : <>
      <div className="flex min-w-0 items-center gap-1">
        {styleOfCause ? <h3 className="truncate text-sm font-medium text-gray-950" title={title}>{styleOfCause}</h3>
          : <span className="truncate text-sm italic text-gray-500">Add style of cause</span>}
        <button type="button" disabled={busy} onClick={edit} aria-label={`Edit style of cause for ${title}`}
          className={cn("shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-red-600 group-hover/row:opacity-100",
            styleOfCause && "opacity-0")}><Pencil className="h-3.5 w-3.5" /></button>
      </div>
      <span className="hidden truncate text-xs font-normal text-gray-500 sm:block"
        title={citationLine}>{citationLine}</span>
    </>}
    <div className="col-span-3 flex items-center justify-end gap-1 sm:col-span-1">
      {needsPdf && (authority.source.kind === "pending-canlii"
        ? <a href={authority.source.pdfUrl} target="_blank" rel="noopener noreferrer"
            className={cn(rowControl, "inline-flex items-center gap-1 rounded-md border text-red-800 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600")}>
            <ExternalLink className="h-3.5 w-3.5" />CanLII</a>
        : issue ? <Button type="button" variant="outline" className={cn(rowControl, "text-red-800")}
            disabled={busy} onClick={() => onRelink(issue.bindingRole)}><FilePlus2 />
            <span className="truncate">{sourceAction(sourceIssues[issue.bindingRole], "PDF")}</span></Button>
        : sources.length && !loaded ? <span className={cn(rowControl, "grid place-items-center text-red-800")}>PDF unavailable</span>
        : sources.length && onOpen ? (sources.length === 1
          ? <Button type="button" variant="outline" className={rowControl} disabled={busy || !loaded}
              aria-label={`View PDF for ${title}`} onClick={() => onOpen(sources[0].bindingRole)}><Eye /> View</Button>
          : <ActionMenu label={`View PDFs for ${title}`} triggerClassName={cn(rowControl, "inline-flex items-center gap-1 rounded-md border")}
              items={sources.map((source) => ({ label: sourceLanguageLabel(source.language),
                disabled: busy || !!sourceIssues[source.bindingRole], onSelect: () => onOpen(source.bindingRole) }))}>
              <Eye className="h-3.5 w-3.5" /> View</ActionMenu>)
        : <span className="w-28" />)}
      {needsPdf && (authority.source.kind === "pending-canlii"
        ? <Button type="button" variant="outline" className={rowControl} disabled={busy}
            aria-label={`Attach PDF for ${title}`} onClick={pick}><Upload />Attach PDF</Button>
        : <ActionMenu label={`${replacement} for ${title}`}
        triggerClassName={cn(rowControl, "inline-flex items-center gap-1 rounded-md border text-gray-800 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600")}
        items={[{ label: "Upload from computer", disabled: busy, onSelect: pick },
          ...(onLibrary ? [{ label: `Choose from ${sourceLabel}`, disabled: busy, onSelect: onLibrary }] : [])]}>
        <Upload className="h-3.5 w-3.5" />{replacement}</ActionMenu>)}
      <MoreActionsMenu label={`Options for ${title}`} triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600"
        items={[{ label: editableIdentity ? "Edit details" : "Edit title", disabled: busy,
          onSelect: () => { if (editableIdentity) onEditIdentity(); else edit(); } },
          ...(sources.length ? [{ label: sources.length === 1 ? "Remove PDF" : "Remove PDFs", disabled: busy,
            onSelect: () => onAction({ type: "clear-authority-source", authorityId: authority.id }) }] : []),
          { label: authority.excluded ? "Include in book" : "Leave out of book", disabled: busy,
            onSelect: () => onAction({ type: "exclude-authority", authorityId: authority.id, excluded: !authority.excluded }) },
          { label: "Delete entry", disabled: busy || !removable,
            onSelect: () => onAction({ type: "remove-authority", authorityId: authority.id }) }]} />
    </div>
    {sources.flatMap(({ bindingRole }) => ocr?.tracked[bindingRole]
      ? [<SourceOcrProgress key={bindingRole} ocr={ocr} status={ocr.tracked[bindingRole]} />] : [])}
    <input ref={fileInput} className="sr-only" tabIndex={-1} type="file" accept=".pdf,application/pdf"
      disabled={busy} aria-label={`Upload PDF for ${title}`} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) onAttach(file);
      }} />
  </article>;
}

function StyleOfCause({ value, onSave, onCancel }: {
  value: string; onSave: (value: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(value), finished = useRef(false);
  return <Input autoFocus aria-label="Style of cause" placeholder="Add style of cause" value={name}
    onChange={(event) => setName(event.target.value)}
    onBlur={() => { if (!finished.current) { finished.current = true; onSave(name); } }}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { finished.current = true; onCancel(); }
    }} className="col-span-1 h-8 min-w-0 border-gray-400 text-sm sm:col-span-2" />;
}

export type SourceOcrPanel = Pick<ReturnType<typeof import("./sourceOcr").useSourceOcr>, "tracked" | "begin" | "stop">;

export function SourceRecognition({ file, ocr, disabled }: { file: ScannedPdf; ocr: SourceOcrPanel; disabled?: boolean }) {
  const [pages, setPages] = useState("");
  return <form className="my-2 flex flex-wrap items-center gap-2" onSubmit={event => {
    event.preventDefault();
    void ocr.begin([file], pages.trim() ? [...new Set(pages.split(",").map(Number))] : undefined);
  }}>
    <label className="text-sm text-gray-700">Pages to recognize <input value={pages}
      onChange={event => setPages(event.target.value)} placeholder="All scanned pages"
      pattern="\s*[1-9][0-9]*\s*(,\s*[1-9][0-9]*\s*)*" title="Enter page numbers separated by commas, or leave blank for all scanned pages."
      className="ms-2 h-8 w-40 rounded border border-gray-400 px-2 text-sm" /></label>
    <Button type="submit" variant="outline" className="h-8" disabled={disabled}>Recognize</Button>
    {ocr.tracked[file.role] && <SourceOcrProgress status={ocr.tracked[file.role]} ocr={ocr} />}
  </form>;
}

/** Text recognition for one scanned source, watched where the source lives. */
function SourceOcrProgress({ status, ocr }: { status: SourceOcrStatus; ocr: SourceOcrPanel }) {
  const action = (label: string, act: () => void) => <button type="button"
    className="min-h-6 rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600"
    onClick={act}>{label}</button>;
  return <div className="col-span-full flex flex-wrap items-center gap-2 text-xs">
    <span className={cn("min-w-0 truncate", status.state === "done" ? "text-green-800"
      : status.state === "failed" ? "text-red-800" : "text-gray-600")}>
      {status.state === "done" ? "Text recognition complete"
        : status.state === "failed" ? status.error || "Text recognition failed"
        : status.state === "paused" ? "Text recognition paused"
        : status.state === "cancelled" ? "Text recognition cancelled"
        : `Recognizing text${status.page ? ` on page ${status.page}` : ""}`}</span>
    <span className="ms-auto flex shrink-0 gap-1">
      {status.state === "running" && action("Pause", () => ocr.stop([status.role], true))}
      {["paused", "failed", "cancelled"].includes(status.state) && action("Resume", () => void ocr.begin([status]))}
      {["running", "paused"].includes(status.state) && action("Cancel", () => void ocr.stop([status.role], false))}
    </span>
  </div>;
}
