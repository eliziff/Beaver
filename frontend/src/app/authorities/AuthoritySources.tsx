import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, ExternalLink, Eye, FileCheck2, FilePlus2, FileType2, FileX2, LockKeyhole,
  ChevronDown, FolderInput, FolderSearch, Loader2, Pencil, Plus, RotateCw, ScrollText, SlidersHorizontal, Square, Upload } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { FileInputButton } from "./FileInputButton";
import { FileCard } from "./OptionCards";
import { TabFormatModal } from "./TabFormatModal";
import { authorityName, authorityLabel, authorityCitationLine, requiresBilingualSources,
  requiresPdf, sourceLanguageLabel, relinkable } from "./authorityPresentation";
import type { AuthoritiesAction, AuthoritiesBookSupplement, AuthoritiesDraft, AuthoritiesProduct,
  AuthorityIdentity, AuthorityOccurrence } from "./types";
import type { AuthoritiesBookSlot, AuthoritiesSourceIssue } from "./host";
import { SourceOcrInline } from "./AuthoritiesHighlightEditor";
import type { SourceOcrPanel } from "./sourceOcr";
import type { StatuteCopy } from "./statuteExcerpts";
import canliiLogo from "./canlii.ico";

const control = "h-8 shrink-0 border-gray-300 px-2.5 text-[0.8125rem]";
/** A row's action: quiet, as the citation bar's, one width and icon size wherever a list of sources
 *  or book parts shows them, an icon alone where the list (a `@container/sources`) is narrow. */
export const rowControl = "inline-flex h-8 w-10 shrink-0 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-1 text-[0.8125rem] font-medium text-gray-700 outline-none hover:bg-gray-50 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-red-600 disabled:pointer-events-none disabled:text-gray-400 [&_svg]:size-3.5 [&_svg]:shrink-0 @min-[44rem]/sources:w-[5.625rem] @min-[44rem]/sources:px-2";
export const rowLabel = "hidden @min-[44rem]/sources:inline";
type LookupFailure = NonNullable<AuthorityIdentity["sourceLookupFailure"]>;
const lookupReason = ({ reason, detail }: LookupFailure) => ({
  "rate-limited": "A2AJ is limiting requests", timeout: "A2AJ took too long to answer", unreachable: "A2AJ couldn't be reached",
  error: "A2AJ answered with an error", defect: `Authorities failed with an error of its own (${detail ?? "no message"})`,
})[reason];
/** Why the publisher's original is not there, when its download did not bring it. */
const publisherReason = ({ sourceDownloadFailure }: AuthorityIdentity) => sourceDownloadFailure === "refused"
  ? "Automatic downloads don't work from this page's address." : sourceDownloadFailure === "failed"
    ? "Couldn't download the PDF from the publisher." : "The publisher blocked the automatic download.";
const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const MINUTE = 60_000;
export type AuthorityPanelProps = {
  authorities: AuthorityIdentity[]; tabs: ReadonlyMap<string, string>; busy: boolean;
  sourceIssues: Record<string, AuthoritiesSourceIssue>;
  onAction: (action: AuthoritiesAction) => void; onAdd: () => void;
  onPick?: (id: string) => void; onAttach: (id: string, file?: File) => void;
  onLibrary?: (id: string) => void; sourceLabel?: string;
  onRelink: (role: string) => void; onOpenSource?: (role: string) => void;
  onRetrySource?: (id: string) => void;
  onEditIdentity: (authority: AuthorityIdentity) => void;
  onWatchFolder?: () => void; watchedFolder?: string;
  /** Each statute's book copy, by authority: every statute row has its line. */
  statuteCopies?: ReadonlyMap<string, StatuteCopy>;
  /** Each authority's group in the book ("Cases", "Legislation", ...), by authority. */
  groups?: ReadonlyMap<string, string>;
};
/** The book's own PDFs, chosen from a file, a picker or the library. */
export type BookFiles = {
  onFiles: (slot: AuthoritiesBookSlot, files: File[], supplementId?: string) => void;
  onPick?: (slot: AuthoritiesBookSlot, multiple: boolean, supplementId?: string) => void;
  onLibrary?: (slot: AuthoritiesBookSlot, supplementId?: string) => void;
};
type PanelProps = AuthorityPanelProps & {
  state: AuthoritiesDraft; occurrences: AuthorityOccurrence[];
  onPickMany?: () => void; onLibraryAdd?: () => void; onFiles?: (files: File[]) => void;
  ocr?: SourceOcrPanel;
  /** Any other PDF in the book, each under a tab of its own after the authorities: listed with them,
   *  and added here where the authorities come from a brief. */
  others?: BookFiles & { parts: Array<{ part: AuthoritiesBookSupplement; tab: string }> };
  /** The import's choices about sources, shown above the list. */
  settings?: ReactNode;
};
export function Sources({ draft, ...props }: Omit<PanelProps, "state"> & { draft: AuthoritiesProduct }) {
  return <SourcePanel {...props} state={draft.state} />;
}

function SourcePanel({ state, authorities, tabs, occurrences, busy, sourceIssues,
  onAction, onAdd, onPickMany, onLibraryAdd, onFiles, onPick, onLibrary,
  sourceLabel = "Library", onAttach, onRelink, onOpenSource, onRetrySource, onEditIdentity, onWatchFolder, watchedFolder,
  ocr, statuteCopies, groups, others, settings }: PanelProps) {
  const [tabSettings, setTabSettings] = useState(false), [settingsOpen, setSettingsOpen] = useState(false);
  const shown = authorities.map(({ id }) => id);
  const headed = authorities.some(({ id }) => groups?.get(id) && groups.get(id) !== "Authorities");
  return <><section className="@container/sources mt-3 rounded-xl border border-gray-300 bg-white shadow-sm">
    <div className="p-3 sm:p-4"
      onDragOver={(event) => { if (!busy && onFiles && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => {
        if (!busy && onFiles && event.dataTransfer.files.length) {
          event.preventDefault(); onFiles(Array.from(event.dataTransfer.files));
        }
      }}>
      {/* The list's actions in one row, Settings first; its choices open under the row. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {settings && <Button type="button" variant="outline" aria-expanded={settingsOpen} className={cn(control,
          settingsOpen && "border-red-600 bg-red-50 text-red-800 hover:bg-red-50")} onClick={() => setSettingsOpen((open) => !open)}>
          <SlidersHorizontal /> Source settings <ChevronDown className={cn("transition-transform motion-reduce:transition-none", settingsOpen && "rotate-180")} /></Button>}
        {onWatchFolder && <Button type="button" variant="outline" className={control}
          disabled={busy && !watchedFolder} onClick={onWatchFolder}
          title={watchedFolder ? "Stop watching this folder"
            : "Choose the folder Chrome saves into, such as Downloads\\Authorities; Chrome won't share Downloads itself. PDFs saved there are added to the authorities that need them."}>
          {watchedFolder ? <><Loader2 className="motion-safe:animate-spin" />Watching {watchedFolder}<Square className="fill-current" /></>
            : <><FolderInput /> Auto-fetch from folder</>}</Button>}
        {state.outputMode !== "table" && <Button type="button" variant="outline" className={control}
          disabled={busy} onClick={() => setTabSettings(true)}>Tab labels</Button>}
        {onFiles && (onPickMany ? <Button type="button" variant="outline" className={control}
          disabled={busy} onClick={onPickMany}><FilePlus2 /> Upload</Button>
          : <FileInputButton multiple disabled={busy} label="Upload" accept=".pdf,application/pdf"
            onFiles={onFiles} variant="outline" compact />)}
        {onLibraryAdd && <Button type="button" variant="outline" className={control} disabled={busy}
          onClick={onLibraryAdd}><FolderSearch /> {sourceLabel}</Button>}
      </div>
      {settings && settingsOpen && <div className="mb-3 rounded-lg border border-gray-300 bg-gray-50 p-3">{settings}</div>}
      {onRetrySource && <LookupFailures authorities={authorities} busy={busy} onRetry={onRetrySource} />}
      {/* A list with statutes keeps room for their Excerpt and Whole beside the actions on every row. */}
      <div role="list" aria-label="Authority tab slots"
        className="grid grid-cols-[fit-content(8rem)_1rem_minmax(0,1fr)] gap-x-3 overflow-hidden rounded-lg border border-gray-300 bg-white @min-[30rem]/sources:grid-cols-[fit-content(8rem)_1rem_minmax(0,1fr)_auto]">
        {authorities.map((authority, index) => <Fragment key={authority.id}>
          {/* Each group under its heading, as the book and the table set them out. */}
          {headed && groups?.get(authority.id) !== groups?.get(authorities[index - 1]?.id) &&
            <p className={GROUP}>{groups?.get(authority.id)}</p>}
          <AuthorityRow authority={authority} busy={busy}
          order={shown} copy={statuteCopies?.get(authority.id)} statutes={!!statuteCopies?.size}
          tab={authority.excluded ? "Excluded" : tabs.get(authority.id)}
          citationLine={authorityCitationLine(state, authority)}
          needsPdf={!authority.excluded && requiresPdf(state, authority)}
          requireLanguages={requiresBilingualSources(state, authority)} sourceIssues={sourceIssues}
          editableIdentity={state.import.kind === "manual" || !!authority.userAdded}
          rebuildsFromText={state.settings.sourceMode !== "manual-originals"}
          removable={!occurrences.some(({ authorityId }) => authorityId === authority.id)}
          onAction={onAction} onPick={onPick ? () => onPick(authority.id) : undefined}
          onLibrary={onLibrary ? () => onLibrary(authority.id) : undefined} sourceLabel={sourceLabel}
          onAttach={(file) => onAttach(authority.id, file)} onRelink={onRelink}
          onOpen={onOpenSource} onRetry={onRetrySource ? () => onRetrySource(authority.id) : undefined}
          onEditIdentity={() => onEditIdentity(authority)} ocr={ocr} /></Fragment>)}
        {headed && !!others?.parts.length && <p className={GROUP}>Documents</p>}
        {others?.parts.map(({ part, tab }) => <OtherPdfRow key={part.id} part={part} tab={tab} busy={busy}
          issue={sourceIssues[part.bindingRole]} files={others} sourceLabel={sourceLabel}
          onAction={onAction} onRelink={onRelink} onOpen={onOpenSource} />)}
        {!authorities.length && !others?.parts.length && <p className="col-span-full px-4 py-8 text-center text-sm text-gray-500">Add sources to begin.</p>}
      </div>
      <Button type="button" variant="outline" className={cn(control, "mt-3")} disabled={busy} onClick={onAdd}><Plus /> Add source</Button>
    </div>
  </section>
  {tabSettings && <TabFormatModal settings={state.settings} busy={busy} onClose={() => setTabSettings(false)}
    onSave={(settings) => onAction({ type: "set-settings", settings })} />}</>;
}

function AuthorityRow({ authority, tab, citationLine, busy, needsPdf, requireLanguages, sourceIssues,
  editableIdentity, rebuildsFromText, removable, sourceLabel, onAction, onPick, onLibrary, onAttach,
  onRelink, onOpen, onRetry, onEditIdentity, order, ocr, copy, statutes }: {
  order: string[]; copy?: StatuteCopy; statutes: boolean;
  authority: AuthorityIdentity; tab?: string; citationLine: string; busy: boolean; needsPdf: boolean;
  requireLanguages: boolean; sourceIssues: Record<string, AuthoritiesSourceIssue>;
  editableIdentity: boolean; rebuildsFromText: boolean; removable: boolean; sourceLabel: string;
  onAction: (action: AuthoritiesAction) => void; onPick?: () => void; onLibrary?: () => void;
  onAttach: (file?: File) => void; onRelink: (role: string) => void;
  onOpen?: (role: string) => void; onEditIdentity: () => void;
  onRetry?: () => void;
  ocr?: SourceOcrPanel;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const name = authority.displayName || authority.name || "";
  const nameLabel = authority.kind === "case" ? "Style of cause" : "Title";
  const [editing, setEditing] = useState(false);
  const sources = authority.source.kind === "attached" ? authority.source.sources : [];
  const title = authorityName(authority);
  const pick = () => { if (onPick) onPick(); else fileInput.current?.click(); };
  const issue = sources.find(({ bindingRole }) => relinkable(sourceIssues[bindingRole]));
  const loaded = sources.length && sources.every(({ bindingRole }) => !sourceIssues[bindingRole]);
  const missingLanguage = requireLanguages && !sources.some(source => source.language === "bilingual") &&
    !(sources.some(source => source.language === "en") && sources.some(source => source.language === "fr"));
  // A court that files both languages takes another PDF until it has them; then a PDF replaces.
  const replacement = sources.length && !missingLanguage ? "Replace" : "Upload";
  // The original the publisher's download did not bring: its row opens the publisher while the PDF
  // is missing, and its options do beside a PDF built from source text.
  const publisher = needsPdf ? /\/robocop\/captcha\//iu.test(authority.sourceVerificationUrl ?? "")
    ? authority.sourceIdentity?.externalUrl ?? authority.sourceUrl : authority.sourceVerificationUrl : undefined;
  const publisherUrl = !sources.length || missingLanguage ? publisher : undefined;
  const fromText = sources.length ? sources.every(({ origin }) => origin === "reconstructed")
    : rebuildsFromText && authority.source.kind === "resolved";
  const missing = needsPdf && !loaded;
  const uploadHint = missing && !authority.sourceIdentity && !publisherUrl &&
    authority.source.kind !== "pending-canlii" && authority.citationFormat
    ? authority.citationFormat === "database"
      ? "Database citation. Upload a PDF of the decision."
      : "Unreported decision. Upload a PDF of the decision."
    : null;
  const missingIssue = sources.map(({ bindingRole }) => sourceIssues[bindingRole]).find(Boolean);
  const lookup = !sources.length ? authority.sourceLookupFailure : undefined;
  const missingLabel = issue ? "File access was denied. Allow access to this PDF to use it."
    : lookup ? `${lookupReason(lookup)}, so this authority wasn't checked. ${lookup.reason === "rate-limited"
      ? "Beaver will try again" : "Retry"}, or upload the PDF.`
    : missingIssue?.status === "changed" ? "The PDF changed. Its source is being refreshed."
    : missingIssue?.status === "missing" && missingIssue.reason === "deleted"
      ? "The PDF could not be found. Upload it again."
    : publisherUrl ? publisherReason(authority)
    : authority.source.kind === "pending-canlii"
      ? "CanLII doesn't allow automatic downloads. Download the PDF from CanLII, then upload it here."
    : sources.length ? "This PDF is unavailable. Upload it again."
    : uploadHint ? uploadHint
    : "No PDF attached. Upload a PDF for this authority.";
  const mark = missing ? { Icon: issue ? LockKeyhole
      : lookup || publisherUrl || authority.source.kind === "pending-canlii" ? CircleAlert : FileX2,
      tone: lookup ? "text-amber-700" : "text-red-700", label: missingLabel }
    : fromText ? { Icon: FileType2, tone: "text-indigo-700",
      label: !loaded ? "Will be built from source text"
        : `Built from source text${publisher ? `. ${publisherReason(authority)}` : ""}` }
    : loaded ? { Icon: FileCheck2, tone: "text-green-700",
      label: sources.map(({ filename }) => filename).join("\n") || "PDF loaded" } : null;
  // A scan being recognized reports in the citation's slot (on the actions line where the row is
  // narrow), so the row never grows. The one still running speaks for a bilingual pair.
  const recognitions = sources.flatMap(({ bindingRole }) => ocr?.tracked[bindingRole] ?? []);
  // Once every scan is recognized, the slot goes back to the citation: a finished job says nothing more.
  const recognition = recognitions.find(({ state }) => state !== "done");
  const edit = () => setEditing(true);
  // The citation and what of it goes in the book, beside the name; a row without either gives the name both columns.
  const subline = recognition ? "" : [name && citationLine, copy?.line].filter(Boolean).join(" · ");
  const save = (value: string) => { setEditing(false);
    if (value.trim() !== name) onAction({ type: "rename-authority",
      authorityId: authority.id, displayName: value.trim() || null }); };
  // A statute in the book as an excerpt or whole, chosen among the row's actions.
  const choose = (excerpt: boolean) => onAction({ type: "set-authority-excerpt", authorityId: authority.id, excerpt });
  const choice = <ActionMenu label={`${title} in the book`} triggerClassName={rowControl}
    items={[{ label: "Cited provisions only", disabled: busy || copy?.excerpt === true, onSelect: () => choose(true) },
      { label: "Whole statute", disabled: busy || copy?.excerpt === false, onSelect: () => choose(false) }]}>
    <ScrollText /><span className={rowLabel}>{copy?.excerpt === false ? "Whole" : "Excerpt"}</span></ActionMenu>;
  return <article role="listitem" data-authority-id={authority.id}
    className={cn("group/row col-span-full grid min-h-14 min-w-0 grid-cols-subgrid items-center gap-y-1 border-t border-gray-200 px-3 py-2 first:border-t-0 hover:bg-gray-50 [p+&]:border-t-0",
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
      aria-label={`Reorder ${title}`} className="min-w-6 cursor-grab truncate rounded py-2 text-left text-[0.8125rem] font-medium tabular-nums text-gray-600 focus-visible:ring-2 focus-visible:ring-red-600"
      onDragStart={event => event.dataTransfer.setData("application/x-authority", authority.id)}
      onKeyDown={event => { if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault(); onAction({ type: "move-authority", authorityId: authority.id,
          toIndex: Math.max(0, Math.min(order.length - 1, order.indexOf(authority.id) + (event.key === "ArrowUp" ? -1 : 1))) }); }}>{tab?.startsWith("Tab ") ? <><span className={rowLabel}>{tab}</span><span className="@min-[44rem]/sources:hidden">{tab.slice(4)}</span></> : tab}</button>
    <span className="flex h-4 w-4 items-center justify-center">
      {mark && <mark.Icon role="img" aria-label={mark.label} className={cn("h-4 w-4", mark.tone)}>
        <title>{mark.label}</title></mark.Icon>}
    </span>
    {/* Name and citation side by side where the list is wide, the citation under the name where not.
        Editing the name, or a scan being recognized, takes its own place in the same cells, so the
        row never changes size or moves its actions. */}
    <div className="min-w-0 @min-[44rem]/sources:grid @min-[44rem]/sources:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @min-[44rem]/sources:items-center @min-[44rem]/sources:gap-4">
      <div className={cn("flex min-h-8 min-w-0 items-center gap-1", !subline && !recognition && "@min-[44rem]/sources:col-span-2")}>
        {editing ? <AuthorityName value={name} label={nameLabel} onSave={save} onCancel={() => setEditing(false)} /> : <>
          <h3 className="truncate text-sm font-medium text-gray-950" title={title}>{name || citationLine}</h3>
          <button type="button" disabled={busy} onClick={edit} aria-label={`Edit ${nameLabel.toLocaleLowerCase()} for ${title}`}
            className="shrink-0 rounded p-1 text-gray-500 opacity-0 hover:bg-gray-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-red-600 group-hover/row:opacity-100">
            <Pencil className="h-3.5 w-3.5" /></button></>}
      </div>
      {recognition && ocr ? <SourceOcrInline status={recognition} ocr={ocr} className="w-full max-w-sm" />
        : subline && <p className="line-clamp-2 text-[0.8125rem] leading-5 text-gray-500" title={subline}>{subline}</p>}
    </div>
    <div className="col-span-3 row-start-1 flex items-center justify-end gap-1 @min-[30rem]/sources:col-span-1 @min-[30rem]/sources:col-start-4">
      {statutes && (copy?.choosable ? choice : <span className="w-10 @min-[44rem]/sources:w-[6.5rem]" />)}
      {!needsPdf && authority.sourceUrl && <a href={authority.sourceUrl} target="_blank" rel="noopener noreferrer"
        title={authority.sourceUrl} aria-label={`Open the link for ${title}`} className={rowControl}>
        <ExternalLink /><span className={rowLabel}>Link</span></a>}
      {needsPdf && (publisherUrl
        ? <a href={publisherUrl} target="_blank" rel="noopener noreferrer"
              title="Download the PDF from the publisher, then upload it here."
              aria-label={`Open publisher for ${title}`}
              // One line, as wide as its words where the row shows them; the actions stay right-aligned.
              className={cn(rowControl, "@min-[44rem]/sources:w-auto")}>
              <ExternalLink className="h-3.5 w-3.5" /><span className={rowLabel}>Open publisher</span></a>
        : authority.source.kind === "pending-canlii"
        ? <a href={authority.source.pdfUrl} target="_blank" rel="noopener noreferrer"
            aria-label={`CanLII PDF for ${title}`}
            className={rowControl}>
            <img src={canliiLogo} alt="" className="h-4 w-4" /><span className={rowLabel}>CanLII</span></a>
        : issue ? <Button type="button" variant="ghost" className={cn(rowControl, "text-red-800")}
            disabled={busy} onClick={() => onRelink(issue.bindingRole)}><FilePlus2 />
            <span className="truncate">Allow file access</span></Button>
        : sources.length && !loaded ? <span className={cn(rowControl, "text-red-800 hover:bg-transparent")}>Unavailable</span>
        : sources.length && onOpen ? (sources.length === 1
          ? <Button type="button" variant="ghost" className={rowControl} disabled={busy || !loaded}
              aria-label={`View PDF for ${title}`} title="View" onClick={() => onOpen(sources[0].bindingRole)}><Eye /><span className={rowLabel}>View</span></Button>
          : <ActionMenu label={`View PDFs for ${title}`} triggerClassName={rowControl}
              items={sources.map((source) => ({ label: sourceLanguageLabel(source.language),
                disabled: busy || !!sourceIssues[source.bindingRole], onSelect: () => onOpen(source.bindingRole) }))}>
              <Eye className="h-3.5 w-3.5" /><span className={rowLabel}>View</span></ActionMenu>)
        // A citation that prints its own link (a news story, a report online) opens it, as CanLII's do.
        : authority.sourceUrl ? <a href={authority.sourceUrl} target="_blank" rel="noopener noreferrer"
            title={authority.sourceUrl} aria-label={`Open the link for ${title}`} className={rowControl}>
            <ExternalLink /><span className={rowLabel}>Link</span></a>
        : <span className="w-10 @min-[44rem]/sources:w-[6.5rem]" />)}
      {needsPdf && (authority.source.kind === "pending-canlii"
        ? <Button type="button" variant="ghost" className={rowControl} disabled={busy}
            aria-label={`Upload PDF for ${title}`} title="Upload" onClick={pick}><Upload /><span className={rowLabel}>Upload</span></Button>
        : <ActionMenu label={`${replacement} for ${title}`}
        triggerClassName={rowControl}
        items={[{ label: "Upload from computer", disabled: busy, onSelect: pick },
          ...(onLibrary ? [{ label: `Choose from ${sourceLabel}`, disabled: busy, onSelect: onLibrary }] : [])]}>
        <Upload className="h-3.5 w-3.5" /><span className={rowLabel}>{replacement}</span></ActionMenu>)}
      <MoreActionsMenu label={`Options for ${title}`} triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600"
        items={[{ label: editableIdentity ? "Edit details" : "Edit title", disabled: busy,
          onSelect: () => { if (editableIdentity) onEditIdentity(); else edit(); } },
          ...(publisherUrl && onRetry && authority.sourceDownloadFailure !== "refused"
            ? [{ label: "Retry download", disabled: busy, onSelect: onRetry }] : []),
          ...(publisher && !publisherUrl ? [{ label: "Open publisher",
            onSelect: () => window.open(publisher, "_blank", "noopener,noreferrer") }] : []),
          ...(publisherUrl && onOpen ? sources.map(source => ({
            label: `View ${sourceLanguageLabel(source.language)} PDF`, disabled: busy || !!sourceIssues[source.bindingRole],
            onSelect: () => onOpen(source.bindingRole),
          })) : []),
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
        if (file) onAttach(file);
      }} />
  </article>;
}

/** Another PDF in the book, laid out as an authority's row: its tab, its file, View, Replace and Remove.
 *  Its name is the one the book's index gives it. */
function OtherPdfRow({ part, tab, busy, issue, files, sourceLabel, onAction, onRelink, onOpen }: {
  part: AuthoritiesBookSupplement; tab: string; busy: boolean; issue?: AuthoritiesSourceIssue;
  files: BookFiles; sourceLabel: string; onAction: (action: AuthoritiesAction) => void;
  onRelink: (role: string) => void; onOpen?: (role: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const name = part.filename.replace(/\.pdf$/iu, "").trim() || part.filename;
  const pick = () => { if (files.onPick) files.onPick("supplemental", false, part.id); else fileInput.current?.click(); };
  const mark = relinkable(issue) ? { Icon: LockKeyhole, tone: "text-red-700", label: "File access was denied. Allow access to this PDF to use it." }
    : issue ? { Icon: FileX2, tone: "text-red-700", label: "This PDF is unavailable. Upload it again." }
    : { Icon: FileCheck2, tone: "text-green-700", label: part.filename };
  return <article role="listitem" data-supplement-id={part.id}
    className="group/row col-span-full grid min-h-14 min-w-0 grid-cols-subgrid items-center gap-y-1 border-t border-gray-200 px-3 py-2 first:border-t-0 hover:bg-gray-50 [p+&]:border-t-0">
    <span className="min-w-6 truncate py-2 text-[0.8125rem] font-medium tabular-nums text-gray-600">{tab.startsWith("Tab ")
      ? <><span className={rowLabel}>{tab}</span><span className="@min-[44rem]/sources:hidden">{tab.slice(4)}</span></> : tab}</span>
    <span className="flex h-4 w-4 items-center justify-center">
      <mark.Icon role="img" aria-label={mark.label} className={cn("h-4 w-4", mark.tone)}><title>{mark.label}</title></mark.Icon>
    </span>
    <h3 className="min-w-0 truncate text-sm font-medium text-gray-950" title={part.filename}>{name}</h3>
    <div className="col-span-3 flex items-center justify-end gap-1 @min-[30rem]/sources:col-span-1">
      {relinkable(issue) ? <Button type="button" variant="ghost" className={cn(rowControl, "text-red-800")} disabled={busy}
          onClick={() => onRelink(part.bindingRole)}><FilePlus2 /><span className="truncate">Allow file access</span></Button>
        : onOpen ? <Button type="button" variant="ghost" className={rowControl} disabled={busy || !!issue}
          aria-label={`View ${part.filename}`} title="View" onClick={() => onOpen(part.bindingRole)}><Eye /><span className={rowLabel}>View</span></Button>
        : <span className="w-10 @min-[44rem]/sources:w-[6.5rem]" />}
      <ActionMenu label={`Replace ${part.filename}`}
        triggerClassName={rowControl}
        items={[{ label: "Upload from computer", disabled: busy, onSelect: pick },
          ...(files.onLibrary ? [{ label: `Choose from ${sourceLabel}`, disabled: busy, onSelect: () => files.onLibrary!("supplemental", part.id) }] : [])]}>
        <Upload className="h-3.5 w-3.5" /><span className={rowLabel}>Replace</span></ActionMenu>
      <MoreActionsMenu label={`${part.filename} options`} triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600"
        items={[{ label: "Remove from book", disabled: busy, onSelect: () => onAction({ type: "remove-book-supplement", id: part.id }) }]} />
    </div>
    <input ref={fileInput} className="sr-only" tabIndex={-1} type="file" accept=".pdf,application/pdf"
      disabled={busy} aria-label={`Replace ${part.filename} with a PDF`} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) files.onFiles("supplemental", [file], part.id);
      }} />
  </article>;
}

const GROUP = "col-span-full border-b border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-t-gray-300";

/** A2AJ's limit, asked again by Beaver itself. A page cannot read the Retry-After A2AJ sends with
 *  it, so Beaver waits about a minute (or until the time A2AJ named, where it could be read), asks
 *  once again, and waits twice as long each time A2AJ is still limiting. */
function useLimitRetry(limited: AuthorityIdentity[], busy: boolean, onRetry: (id: string) => void) {
  const first = limited[0]?.id, named = Math.max(0, ...limited.map(({ sourceLookupFailure }) =>
    Date.parse(sourceLookupFailure!.retryAfter ?? "") || 0));
  const [plan, setPlan] = useState<{ tries: number; due: number; named: boolean }>();
  useEffect(() => {
    const wait = (tries: number) => named > Date.now() ? { tries, due: named, named: true }
      : { tries, due: Date.now() + Math.min(MINUTE * 2 ** tries, 10 * MINUTE), named: false };
    if (!first) return setPlan(undefined);
    if (!plan || named > plan.due) return setPlan(wait(plan?.tries ?? 0));
    if (busy) return;
    const timer = setTimeout(() => { setPlan(wait(plan.tries + 1)); onRetry(first); },
      Math.max(0, plan.due - Date.now()));
    return () => clearTimeout(timer);
  }, [first, named, plan, busy, onRetry]);
  return !plan ? "" : plan.named ? `at ${clock(plan.due)}` : plan.tries ? `in about ${Math.min(2 ** plan.tries, 10)} minutes`
    : "in about a minute";
}

/** Authorities A2AJ left unchecked, by reason: its limit retried by Beaver, anything else on request. */
function LookupFailures({ authorities, busy, onRetry }: {
  authorities: AuthorityIdentity[]; busy: boolean; onRetry: (id: string) => void;
}) {
  const failed = authorities.filter((authority) => authority.sourceLookupFailure);
  const limited = failed.filter(({ sourceLookupFailure }) => sourceLookupFailure!.reason === "rate-limited");
  const again = useLimitRetry(limited, busy, onRetry);
  if (!failed.length) return null;
  const reasons = [...new Set(failed.map(({ sourceLookupFailure }) => lookupReason(sourceLookupFailure!)))];
  // Decisions sharing a style of cause in the book are told apart by their citations.
  const named = (authority: AuthorityIdentity) => authorities.filter((other) =>
    authorityName(other) === authorityName(authority)).length > 1 ? authorityLabel(authority) : authorityName(authority);
  return <div role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
    <CircleAlert className="h-4 w-4 shrink-0 text-amber-700" aria-hidden />
    <div className="min-w-0 flex-1">
      {reasons.map((reason) => {
        const items = failed.filter(({ sourceLookupFailure }) => lookupReason(sourceLookupFailure!) === reason);
        const names = items.map(named);
        // A few are named; more are left to their rows, each marked.
        return <p key={reason}>{reason}, so {names.length === 1 ? "this authority wasn't" : `${names.length} authorities weren't`} checked{names.length <= 3
          ? `: ${names.join("; ")}.` : ". Each is marked in the list."}
          {again && items[0].sourceLookupFailure!.reason === "rate-limited" && ` Beaver will try again ${again}.`}</p>;
      })}
    </div>
    {failed.length > limited.length && <Button type="button" variant="outline" className={cn(control, "bg-white")}
      disabled={busy} onClick={() => onRetry(failed[0].id)}><RotateCw />Retry</Button>}
  </div>;
}

function AuthorityName({ value, label, onSave, onCancel }: {
  value: string; label: string; onSave: (value: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(value), finished = useRef(false);
  return <Input autoFocus aria-label={label} placeholder={`Add ${label.toLocaleLowerCase()}`} value={name}
    onChange={(event) => setName(event.target.value)}
    onBlur={() => { if (!finished.current) { finished.current = true; onSave(name); } }}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { finished.current = true; onCancel(); }
    }} className="h-8 w-full min-w-0 border-gray-400 text-sm md:text-sm" />;
}

/** Shown once in a browser, the first time Sources settles with authorities still needing a PDF:
 *  what is left to add by hand, CanLII's button, and Auto-fetch from folder, as each one works. */
export function SourcesExplainer({ open, missing, folderKept, onClose, onChooseFolder }: {
  open: boolean; missing: number;
  /** Whether the folder Auto-fetch watches is kept for the next visit. */
  folderKept: boolean;
  onClose: () => void;
  /** The toolbar's Auto-fetch from folder, offered while no folder is watched. */
  onChooseFolder?: () => void;
}) {
  // Without folder access (Firefox, Safari) the folder chosen is read once, not watched.
  const watches = typeof window !== "undefined" && "showDirectoryPicker" in window;
  const icon = "size-4 shrink-0";
  return <Modal open={open} onClose={onClose} size="xl" breadcrumbs={["Sources to add by hand"]} fit
    secondaryAction={onChooseFolder && { label: <><FolderInput /> Choose folder</>, onClick: onChooseFolder }}
    primaryAction={{ label: "Got it", onClick: onClose }}>
    <div className="grid gap-2 pb-4">
      <FileCard icon={<FileX2 aria-hidden="true" className={cn(icon, "text-red-700")} />}
        label={`${missing === 1 ? "One authority needs" : `${missing} authorities need`} a PDF added by hand`}
        detail={`${missing === 1 ? "Its PDF" : "Their PDFs"} couldn't be fetched automatically. ${missing === 1
          ? "It is" : "Each is"} marked in the list with the reason, and Upload on its row adds the PDF.`} />
      <FileCard icon={<img src={canliiLogo} alt="" className={icon} />} label="CanLII"
        detail="CanLII doesn't allow automatic downloads. The CanLII button on a decision's row opens the decision's PDF on CanLII in a new tab; download the PDF from there. A downloaded PDF isn't added by itself: add it with Upload on its row, or save it into the folder Auto-fetch from folder watches." />
      <FileCard icon={<FolderInput aria-hidden="true" className={cn(icon, "text-gray-700")} />} label="Auto-fetch from folder"
        detail={watches
          ? `Choose the folder Chrome saves into, such as Downloads\\Authorities; Chrome won't share Downloads itself. While this page is open, the folder is checked every two seconds, and each PDF saved there that is a case still without a PDF is added to that case. Statutes and other authorities are added with Upload.${folderKept ? " The folder is kept for your next visit." : ""}`
          : "Choose the folder your downloads are saved in. Each PDF there that is a case still without a PDF is added to that case. This browser reads the folder once each time you choose it. Statutes and other authorities are added with Upload."} />
    </div>
  </Modal>;
}
