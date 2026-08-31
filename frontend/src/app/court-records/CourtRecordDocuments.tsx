import {
  ArrowDown,
  ArrowUp,
  FilePlus2,
  FileText,
  Files,
  FolderSearch,
  GripVertical,
  Loader2,
  ScanText,
  Trash2,
} from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn, formatBytes } from "@/app/lib/utils";
import { sourceAccept, sourceFormat } from "./formats";
import { exhibitIndex, exhibitName } from "./types";
import type { ComplianceFinding, CourtProfile, DocumentKind, RecordEntry } from "./types";

type Props = {
  profile: CourtProfile;
  entries: RecordEntry[];
  busyEntryId?: string;
  entryFindings: Map<string, ComplianceFinding[]>;
  onFiles: (kindId: string, files: File[]) => void;
  onDescription: (kindId: string) => void;
  onPick?: (kindId: string) => void;
  onLibrary?: (kindId: string) => void;
  onDraftOutput?: (kindId: string) => void;
  onEntry: (id: string, patch: Partial<RecordEntry>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, beforeId?: string) => void;
  onAssign: (id: string, label?: string) => void;
  onOcr?: (id: string) => void;
  onRelink?: (id: string) => void;
  kindIds?: string[];
  heading?: string;
};

export function CourtRecordDocuments(props: Props) {
  const permitted = props.profile.documentKinds
    .filter((kind) => kind.requirement !== "forbidden" && !kind.generated &&
      (!props.kindIds || props.kindIds.includes(kind.id)))
    .sort((left, right) => left.order - right.order);
  const headingId = props.kindIds ? `record-documents-${props.kindIds.join("-")}-heading` : "record-documents-heading";
  const exhibitPool = props.profile.family === "affidavit" &&
    props.kindIds?.includes("exhibit") && permitted.find((kind) => kind.id === "exhibit");
  const shown = exhibitPool ? permitted.filter((kind) => kind.id !== "exhibit") : permitted;
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-base font-semibold leading-6 text-gray-950">{props.heading ?? "2. Add documents"}</h2>

      <div className="mt-3 space-y-2.5">
        {exhibitPool && <ExhibitPool kind={exhibitPool} {...props} />}
        {shown.map((kind) => <DocumentSlot key={kind.id} kind={kind} {...props} />)}
      </div>
    </section>
  );
}

function DocumentSlot({ profile, kind, entries, busyEntryId, entryFindings, onFiles, onDescription, onPick, onLibrary, onDraftOutput, onEntry, onRemove, onMove, onAssign, onOcr, onRelink }: Props & { kind: DocumentKind }) {
  const matching = entries.filter((entry) => entry.kindId === kind.id);
  const canAdd = kind.repeatable || matching.length === 0;
  const canDrop = profile.family === "affidavit" && kind.id === "affidavit";
  return (
    <div
      data-kind-id={kind.id}
      data-requirement={kind.requirement}
      className={cn(
        "rounded-xl border bg-white",
        kind.requirement === "required" && !matching.length ? "border-gray-300" : "border-gray-200",
      )}
      onDragOver={(event) => { if (canDrop && canAdd) event.preventDefault(); }}
      onDrop={(event) => {
        if (!canDrop || !canAdd) return;
        event.preventDefault();
        onFiles(kind.id, [...event.dataTransfer.files]);
      }}
    >
      <div className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium leading-5 text-gray-900">
            {kind.label}
            {kind.requirement === "required" && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-600">Required</span>}
          </h3>
        </div>
        {canAdd && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {kind.descriptionOnly ? (
              <Button type="button" className="h-9 bg-gray-950 px-3 text-white hover:bg-gray-800" onClick={() => onDescription(kind.id)}><FilePlus2 /> Add description</Button>
            ) : <AddFileControls kind={kind} onFiles={onFiles} onPick={onPick}
              onLibrary={onLibrary} onDraftOutput={onDraftOutput} />}
          </div>
        )}
      </div>
      {!!matching.length && (
        <div className="space-y-2 border-t border-gray-100 bg-gray-50/50 p-2.5">
          {matching.map((entry, index) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              kind={kind}
              busy={busyEntryId === entry.id}
              findings={entryFindings.get(entry.id) ?? []}
              dateRequired={profile.technical.indexDate === "required"}
              descriptionLabel={profile.outputMode === "separate-files" ? "Document name" : "Contents description"}
              onEntry={onEntry}
              onRemove={onRemove}
              onMove={onMove}
              onAssign={onAssign}
              moveBefore={matching[index - 1]?.id}
              moveAfter={matching[index + 2]?.id}
              canMoveDown={index < matching.length - 1}
              onOcr={onOcr}
              onRelink={onRelink}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExhibitPool(props: Props & { kind: DocumentKind }) {
  const { kind, entries, onFiles, onAssign } = props;
  const exhibits = entries.filter((entry) => entry.kindId === kind.id);
  const detected = entries.find((entry) => entry.kindId === "affidavit")
    ?.sourceFields?.exhibitLabels ?? [];
  const named = [...detected, ...exhibits.flatMap((entry) =>
    entry.exhibitLabel?.trim() ? [entry.exhibitLabel.trim().toUpperCase()] : [])];
  const highest = Math.max(-1, ...named.map(exhibitIndex));
  const labels = Array.from({ length: highest + 2 }, (_, index) => exhibitName(index));
  const pool = exhibits.filter((entry) => !entry.exhibitLabel?.trim());
  return <section data-kind-id="exhibit" className="rounded-xl border border-gray-200 bg-white">
    <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
      <h3 className="text-sm font-medium text-gray-900">Exhibits</h3>
      <div className="flex flex-wrap gap-2"><AddFileControls {...props} /></div>
    </div>
    {!!labels.length && <div className="grid gap-2 border-t border-gray-100 bg-gray-50/50 p-2.5">
      {labels.map((label) => {
        const entry = exhibits.find((item) => item.exhibitLabel?.trim().toUpperCase() === label);
        return <section key={label} aria-label={`Exhibit ${label} slot`}
          className="min-w-0 rounded-lg border border-gray-200 bg-white p-2"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { const id = event.dataTransfer.getData("text/x-court-record-entry");
            if (id) { event.preventDefault(); event.stopPropagation(); onAssign(id, label); } }}>
          <h4 className="px-1 pb-2 text-sm font-semibold text-gray-950">Exhibit {label}</h4>
          {entry ? <EntryRow {...props} entry={entry} busy={props.busyEntryId === entry.id}
            findings={props.entryFindings.get(entry.id) ?? []} dateRequired={false}
            descriptionLabel="Contents description" assignmentLabel={label}
            dragEnabled moveBefore={undefined} moveAfter={undefined} canMoveDown={false} /> :
            <p className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center text-sm text-gray-500">
              Drop a file here, or assign one from unassigned files.
            </p>}
        </section>;
      })}
    </div>}
    <div className="border-t border-gray-100 p-2.5"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const id = event.dataTransfer.getData("text/x-court-record-entry");
        if (id) { event.preventDefault(); onAssign(id); }
        else if (event.dataTransfer.files.length) onFiles(kind.id, [...event.dataTransfer.files]);
      }}>
      <h4 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Unassigned files
      </h4>
      {pool.length ? <div className="grid gap-2">{pool.map((entry, index) =>
        <EntryRow key={entry.id} {...props} entry={entry}
          busy={props.busyEntryId === entry.id} findings={props.entryFindings.get(entry.id) ?? []}
          dateRequired={false} descriptionLabel="Contents description"
          dragEnabled
          moveBefore={pool[index - 1]?.id} moveAfter={pool[index + 2]?.id}
          canMoveDown={index < pool.length - 1} />)}</div> :
        <p className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center text-sm text-gray-500">
          Drop several exhibit files here or use Add files.
        </p>}
    </div>
  </section>;
}

function AddFileControls({ kind, onFiles, onPick, onLibrary, onDraftOutput }:
  Pick<Props, "onFiles" | "onPick" | "onLibrary" | "onDraftOutput"> & { kind: DocumentKind }) {
  const multiple = !!kind.repeatable, label = `Add file${multiple ? "s" : ""}`;
  const id = `court-record-${kind.id}-file`;
  return <>
    {onLibrary && <Button type="button" variant="outline" className="h-9 border-gray-500/80 px-3"
      onClick={() => onLibrary(kind.id)}><FolderSearch /> Library</Button>}
    {onDraftOutput && <Button type="button" variant="outline" className="h-9 border-gray-500/80 px-3"
      onClick={() => onDraftOutput(kind.id)}><Files /> Draft output</Button>}
    {onPick ? <Button id={id} type="button" className="h-9 bg-gray-950 px-3 text-white hover:bg-gray-800"
      onClick={() => onPick(kind.id)}><FilePlus2 /> {label}</Button> :
      <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md bg-gray-950 px-3 text-sm font-medium text-white outline-none hover:bg-gray-800 focus-within:ring-3 focus-within:ring-gray-400">
        <FilePlus2 className="h-4 w-4" aria-hidden="true" /> {label}
        <input id={id} className="sr-only" type="file" accept={sourceAccept(kind)} multiple={multiple}
          aria-required={kind.requirement === "required" || undefined} onChange={(event) => {
            onFiles(kind.id, [...(event.target.files ?? [])]); event.target.value = "";
          }} />
      </label>}
  </>;
}

function EntryRow({ entry, kind, busy, findings, dateRequired, descriptionLabel, onEntry, onRemove, onMove, onAssign, assignmentLabel, dragEnabled = false, moveBefore, moveAfter, canMoveDown, onOcr, onRelink }: {
  entry: RecordEntry;
  kind: DocumentKind;
  busy: boolean;
  findings: ComplianceFinding[];
  dateRequired: boolean;
  descriptionLabel: string;
  onEntry: Props["onEntry"];
  onRemove: Props["onRemove"];
  onMove: Props["onMove"];
  onAssign: Props["onAssign"];
  assignmentLabel?: string;
  dragEnabled?: boolean;
  moveBefore?: string;
  moveAfter?: string;
  canMoveDown: boolean;
  onOcr?: Props["onOcr"];
  onRelink?: Props["onRelink"];
}) {
  const needsOcr = entry.searchable === false || (entry.textlessPageCount ?? 0) > 0;
  const isPdf = sourceFormat(entry.file) === "pdf";
  const dateMissing = findings.some((finding) => finding.id === `date-${entry.id}`);
  const titleMissing = findings.some((finding) => finding.id === `description-${entry.id}`);
  return (
    <article
      className={cn("min-w-0", assignmentLabel
        ? "p-1"
        : "rounded-lg border border-gray-200 bg-white p-3")}
      data-entry-id={entry.id}
      aria-busy={busy}
      draggable={dragEnabled}
      onDragStart={(event) => event.dataTransfer.setData("text/x-court-record-entry", entry.id)}
      onDragOver={(event) => { if (dragEnabled) event.preventDefault(); }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData("text/x-court-record-entry");
        if (id) { event.preventDefault(); event.stopPropagation();
          if (assignmentLabel) onAssign(id, assignmentLabel);
          else onMove(id, entry.id); }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-3 sm:flex-nowrap sm:gap-y-0">
        {dragEnabled && <GripVertical className="mt-2 h-4 w-4 shrink-0 cursor-grab text-gray-400" aria-hidden="true" />}
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700"><FileText className="h-4 w-4" /></span>
        <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
          <label className="block text-xs font-medium text-gray-600">
            {descriptionLabel}
            <Input value={entry.title} required={entry.descriptionOnly || undefined}
              aria-invalid={titleMissing || undefined}
              onChange={(event) => onEntry(entry.id, { title: event.target.value })}
              className={cn("mt-1 h-9 border-gray-500/80 font-medium md:text-base",
                titleMissing && "border-red-500")} />
          </label>
          {!entry.descriptionOnly && <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
            <span className="max-w-full truncate" title={entry.file.name}>{entry.file.name}</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(entry.lastSeen?.size ?? entry.file.size)}</span>
            {entry.pageCount !== null && <><span aria-hidden="true">·</span><span>{entry.pageCount} page{entry.pageCount === 1 ? "" : "s"}</span></>}
          </div>}
        </div>
        {(moveBefore || canMoveDown) && <div className="flex shrink-0">
          <Button type="button" variant="ghost" size="icon-sm" disabled={!moveBefore}
            onClick={() => onMove(entry.id, moveBefore)} aria-label={`Move ${entry.file.name} up`}><ArrowUp /></Button>
          <Button type="button" variant="ghost" size="icon-sm" disabled={!canMoveDown}
            onClick={() => onMove(entry.id, moveAfter)} aria-label={`Move ${entry.file.name} down`}><ArrowDown /></Button>
        </div>}
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => onRemove(entry.id)} aria-label={`Remove ${entry.descriptionOnly ? entry.title || kind.label : entry.file.name}`} title="Remove">
          <Trash2 />
        </Button>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        {dateRequired && <label className="block w-full max-w-52 text-xs font-medium text-gray-600">
          Document date <span className="text-red-600" aria-hidden="true">*</span>
          <Input value={entry.date ?? ""} placeholder="May 31, 2023" required aria-invalid={dateMissing || undefined} onChange={(event) => onEntry(entry.id, { date: event.target.value })} className={cn("mt-1 h-9 border-gray-500/80 md:text-base", dateMissing && "border-red-500")} />
        </label>}
        {kind.id === "exhibit" && (
          <label className="block min-w-0 flex-1 text-xs font-medium text-gray-600">
            Exhibit label
            <Input value={entry.exhibitLabel ?? ""} placeholder="A" onChange={(event) => onAssign(entry.id, event.target.value)} className="mt-1 h-9 border-gray-500/80 md:text-base" />
          </label>
        )}
        {entry.inputStatus === "missing" && onRelink && (
          <Button type="button" variant="outline" className="h-9 border-red-500 text-red-800" disabled={busy} onClick={() => onRelink(entry.id)}><FilePlus2 /> {entry.missingReason === "permission" ? "Allow file access" : "Relink file"}</Button>
        )}
        {entry.inputStatus !== "missing" && isPdf && needsOcr && onOcr && (
          <Button type="button" variant="outline" className="h-9 border-gray-500/80" disabled={busy} onClick={() => onOcr(entry.id)}>
            {busy ? <Loader2 className="motion-safe:animate-spin" /> : <ScanText />}
            {busy ? "Running OCR" : "OCR text pages"}
          </Button>
        )}
      </div>
      {!busy && !!findings.length && (
        <div className="mt-2 space-y-1" role="status">
          {findings.map((finding) => (
            <p key={finding.id} className={cn("text-xs leading-5", finding.level === "blocker" ? "text-red-700" : "text-amber-800")}>{finding.detail}</p>
          ))}
        </div>
      )}
      {busy && <div className="mt-2 h-1 overflow-hidden rounded-full bg-gray-100"><div className="h-full w-1/2 rounded-full bg-red-600 motion-safe:animate-pulse" /></div>}
    </article>
  );
}
