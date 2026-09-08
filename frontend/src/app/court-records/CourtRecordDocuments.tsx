import {
  Check,
  ChevronDown,
  FilePlus2,
  Loader2,
  Trash2,
} from "lucide-react";
import { CourtRecordStepHeading, RequiredBadge } from "./CourtRecordStepHeading";
import { Button, buttonClassName } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn, formatBytes } from "@/app/lib/utils";
import { acceptedSourceFormats, sourceAccept, sourceFormat } from "./formats";
import { rule70MaximumPages, sourceExhibitSlots } from "./types";
import type { ComplianceFinding, CourtProfile, DocumentKind, RecordEntry } from "./types";

export type OcrRun = { id: string; message?: string; controller: AbortController };

type Props = {
  profile: CourtProfile;
  entries: RecordEntry[];
  busyEntryId?: string;
  entryFindings: Map<string, ComplianceFinding[]>;
  onFiles: (kindId: string, files: File[], exhibitLabel?: string) => void;
  onDescription: (kindId: string, title?: string) => void;
  onPick?: (kindId: string, exhibitLabel?: string) => void;
  onLibrary?: (kindId: string, exhibitLabel?: string) => void;
  sourceLabel?: string;
  onEntry: (id: string, patch: Partial<RecordEntry>) => void;
  onRemove: (id: string) => void;
  onAssign: (id: string, label?: string) => void;
  onAddExhibit?: () => void;
  onAssignKind: (id: string, kindId: string) => void;
  reading?: OcrRun;
  onStopReading?: () => void;
  onRelink?: (id: string) => void;
  kindIds?: string[];
  heading?: string;
  step?: number;
  showUnassigned?: boolean;
};

export function CourtRecordDocuments(props: Props) {
  const hiddenAlternatives = new Set(props.profile.oneOf?.flatMap(({ slots }) => {
    const fulfilled = slots.filter((id) => props.entries.some((entry) => entry.kindId === id));
    return fulfilled.length ? slots.filter((id) => !fulfilled.includes(id)) : [];
  }));
  const permitted = props.profile.documentKinds
    .filter((kind) => kind.requirement !== "forbidden" &&
      !hiddenAlternatives.has(kind.id) && (!props.kindIds || props.kindIds.includes(kind.id)))
    .sort((left, right) => left.order - right.order);
  const headingId = props.kindIds ? `record-documents-${props.kindIds.join("-")}-heading` : "record-documents-heading";
  const exhibitPool = props.profile.family === "affidavit" &&
    props.kindIds?.includes("exhibit") && permitted.find((kind) => kind.id === "exhibit");
  const shown = exhibitPool ? permitted.filter((kind) => kind.id !== "exhibit") : permitted;
  const knownKinds = new Set(props.profile.documentKinds.map(({ id }) => id));
  const unassigned = props.showUnassigned
    ? props.entries.filter((entry) => !knownKinds.has(entry.kindId)) : [];
  const notes = unassigned.filter(({ descriptionOnly }) => descriptionOnly);
  const files = unassigned.filter(({ descriptionOnly }) => !descriptionOnly);
  const single = shown.length === 1 && !exhibitPool ? shown[0] : undefined;
  const singleFilled = single && props.entries.some((entry) => entry.kindId === single.id);
  const singleReplaceable = single && !single.repeatable
    ? props.entries.find((entry) => entry.kindId === single.id) : undefined;
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4" aria-labelledby={headingId}
      data-kind-id={single?.id} data-requirement={single?.requirement}
      onDragOver={(event) => {
        if (single && !single.descriptionOnly && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (single && !single.descriptionOnly && event.dataTransfer.files.length) {
          event.preventDefault(); props.onFiles(single.id, [...event.dataTransfer.files]);
        }
      }}>
      <div className={cn("flex gap-3", single && !singleFilled
        ? "flex-col items-start" : "flex-wrap items-center justify-between")}>
        <CourtRecordStepHeading id={headingId} step={props.step} required={single?.requirement === "required" && !singleFilled && !single.generated}>
          {single ? singleFilled ? single.label : `Add the ${single.label.toLowerCase()}` : props.heading ?? "Documents"}
        </CourtRecordStepHeading>
        {single && !single.descriptionOnly && <DocumentActions {...props} kind={single}
          onDelete={singleReplaceable ? () => props.onRemove(singleReplaceable.id) : undefined} />}
      </div>

      {(!single || singleFilled || notes.length > 0 || files.length > 0) && <div className="mt-3 space-y-4">
        {!!notes.length && <PendingNotes notes={notes} {...props} />}
        {!!files.length && <PendingFiles pending={files} {...props} />}
        {exhibitPool && <ExhibitPool kind={exhibitPool} {...props} />}
        {!!shown.length && <div className="space-y-1.5">
          {shown.map((kind) => <DocumentSlot key={kind.id} kind={kind} {...props} hideLabel={!!single} />)}
        </div>}
      </div>}
    </section>
  );
}

function PendingNotes({ notes, onEntry, onRemove }: Props & { notes: RecordEntry[] }) {
  return <section aria-label="Notes" className="rounded-lg bg-gray-50 p-2.5">
    <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-gray-600">
      Notes
    </h3>
    <div className="space-y-2">{notes.map((entry) => <div key={entry.id}
      className="flex items-center gap-2">
      <Input value={entry.title} aria-label="Note"
        onChange={(event) => onEntry(entry.id, { title: event.target.value })}
        className="h-9 border-gray-400 bg-white md:text-base" />
      <Button type="button" variant="ghost" className="size-9 shrink-0 px-0"
        aria-label="Remove note" onClick={() => onRemove(entry.id)}><Trash2 /></Button>
    </div>)}</div>
  </section>;
}

function PendingFiles(props: Props & { pending: RecordEntry[] }) {
  const available = (entry: RecordEntry) => {
    const format = sourceFormat(entry.file);
    return props.profile.documentKinds.filter((kind) =>
      kind.requirement !== "forbidden" && !kind.generated && !kind.descriptionOnly &&
      (!format || acceptedSourceFormats(kind).includes(format)) &&
      (kind.repeatable || !props.entries.some((item) => item.kindId === kind.id)))
      .sort((left, right) => Number(right.requirement === "required") -
        Number(left.requirement === "required") || left.order - right.order);
  };
  return <section aria-label="Files" className="rounded-lg bg-gray-50 p-2.5">
    <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-gray-600">
      Files
    </h3>
    <div className="space-y-2">{props.pending.map((entry) => <EntryRow key={entry.id}
      {...props} entry={entry} kind={undefined} busy={props.busyEntryId === entry.id}
      findings={(props.entryFindings.get(entry.id) ?? [])
        .filter(({ id }) => !id.startsWith("unknown-"))}
      dateRequired={false} descriptionLabel="Contents description"
      assignmentKinds={available(entry)} />)}</div>
  </section>;
}

function DocumentSlot({ profile, kind, hideLabel, entries, busyEntryId, entryFindings, onFiles, onDescription, onPick, onLibrary, sourceLabel, onEntry, onRemove, onAssign, onAssignKind, reading, onStopReading, onRelink }: Props & { kind: DocumentKind; hideLabel?: boolean }) {
  const matching = entries.filter((entry) => entry.kindId === kind.id);
  if (kind.descriptionOnly) {
    const first = matching[0];
    return <div data-kind-id={hideLabel ? undefined : kind.id} data-requirement={kind.requirement}
      className="py-2.5">
      <label className="block text-sm font-medium text-gray-900">
        <span className={hideLabel ? "sr-only" : undefined}>{kind.label}</span>
        <Input id={first ? `entry-${first.id}-title` : undefined} value={first?.title ?? ""}
          aria-label={`${kind.label} 1`}
          onChange={(event) => {
            const title = event.target.value;
            if (first) {
              if (title) onEntry(first.id, { title });
              else onRemove(first.id);
            }
            else if (title) onDescription(kind.id, title);
          }}
          className="mt-1.5 h-9 border-gray-400 bg-white font-normal md:text-base" />
      </label>
      {matching.slice(1).map((entry, index) => <label key={entry.id}
        className="mt-2 block text-sm font-medium text-gray-900">
        <span className="sr-only">{kind.label} {index + 2}</span>
        <Input id={`entry-${entry.id}-title`} value={entry.title}
          onChange={(event) => {
            if (event.target.value) onEntry(entry.id, { title: event.target.value });
            else onRemove(entry.id);
          }}
          className="h-9 border-gray-400 bg-white font-normal md:text-base" />
      </label>)}
      {first && kind.repeatable && <Button type="button" variant="ghost"
        className="mt-1.5 h-8 px-2 text-gray-700" onClick={() => onDescription(kind.id)}>
        <FilePlus2 /> Add another description
      </Button>}
    </div>;
  }
  const canAdd = kind.repeatable || matching.length === 0;
  const canReplace = !kind.repeatable && matching.length === 1;
  const canDrop = canAdd || canReplace;
  return (
    <div
      data-kind-id={hideLabel ? undefined : kind.id}
      data-requirement={kind.requirement}
      className={hideLabel ? undefined : "py-2"}
      onDragOver={(event) => {
        if (canDrop && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!canDrop || hideLabel) return;
        event.preventDefault();
        onFiles(kind.id, [...event.dataTransfer.files]);
      }}
    >
      {!hideLabel && <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="min-w-0 text-sm font-medium leading-5 text-gray-900">{kind.label}
          {kind.requirement === "required" && !kind.generated && !matching.length &&
            <span className="ms-2 inline-flex"><RequiredBadge /></span>}
        </h3>
        <DocumentActions kind={kind} entries={entries} onFiles={onFiles} onPick={onPick}
          onLibrary={onLibrary} sourceLabel={sourceLabel} onDescription={onDescription}
          onDelete={canReplace ? () => onRemove(matching[0].id) : undefined} />
      </div>}
      {!!matching.length && (
        <div className={cn("divide-y divide-gray-100", !hideLabel && "mt-3")}>
          {matching.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              kind={kind}
              busy={busyEntryId === entry.id}
              findings={entryFindings.get(entry.id) ?? []}
              dateRequired={profile.technical.indexDate === "required" || !!kind.chronological}
              descriptionLabel={profile.outputMode === "separate-files" ? "Document name" : "Contents description"}
              showRemove={!canReplace}
              onEntry={onEntry}
              onRemove={onRemove}
              onAssign={onAssign}
              onAssignKind={onAssignKind}
              reading={reading}
              onStopReading={onStopReading}
              onRelink={onRelink}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentActions({ kind, entries, onDescription, onDelete, ...sources }:
  Pick<Props, "entries" | "onFiles" | "onPick" | "onLibrary" | "sourceLabel" | "onDescription"> &
  { kind: DocumentKind; onDelete?: () => void }) {
  const count = entries.filter((entry) => entry.kindId === kind.id).length;
  const canAdd = kind.repeatable || count === 0;
  const canReplace = !kind.repeatable && count === 1;
  if (!canAdd && !canReplace) return null;
  return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
    <AddFileControls {...sources} kind={kind} label={kind.generated
      ? canReplace ? "Replace signed PDF" : "Add signed PDF"
      : canReplace ? "Replace file" : "Add file"} />
    {canAdd && kind.allowUnavailableNote && <Button type="button" variant="outline"
      className="h-9 border-gray-500/80 px-3" onClick={() => onDescription(kind.id)}>
      <FilePlus2 /> Add note
    </Button>}
    {onDelete && <Button type="button" variant="ghost" size="icon-sm" title="Remove"
      aria-label={`Remove the ${kind.label.toLowerCase()}`} onClick={onDelete}><Trash2 /></Button>}
  </div>;
}

function ExhibitPool(props: Props & { kind: DocumentKind }) {
  const { kind, entries, onFiles, onAssign, onAddExhibit } = props;
  const exhibits = entries.filter((entry) => entry.kindId === kind.id);
  const slots = sourceExhibitSlots(entries);
  const labels = slots?.labels ?? [];
  const mentions = entries.find((entry) => entry.kindId === "affidavit")
    ?.sourceFields?.exhibitMentions ?? {};
  const assigned = new Map<string, RecordEntry>(), pool: RecordEntry[] = [];
  for (const entry of exhibits) {
    const label = entry.exhibitLabel?.trim().toUpperCase();
    if (label && labels.includes(label) && !assigned.has(label)) assigned.set(label, entry);
    else pool.push(entry);
  }
  return <section data-kind-id="exhibit" aria-label="Exhibits">
    <div className="rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 p-3"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const id = event.dataTransfer.getData("text/x-court-record-entry");
        if (id) { event.preventDefault(); onAssign(id); }
        else if (event.dataTransfer.files.length) onFiles(kind.id, [...event.dataTransfer.files]);
      }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-gray-950">Files
          <span className="ms-2 font-normal text-gray-600">
            {pool.length} file{pool.length === 1 ? "" : "s"}
          </span>
        </h4>
        <AddFileControls {...props} label="Add files" />
      </div>
      <p className="mt-1 text-xs leading-5 text-gray-600">
        Drop exhibit files here. Drag an assigned exhibit back to unassign it.
      </p>
      {!!pool.length && <div className="mt-2 divide-y divide-gray-200">{pool.map((entry) =>
        <EntryRow key={entry.id} {...props} entry={entry}
          busy={props.busyEntryId === entry.id} findings={props.entryFindings.get(entry.id) ?? []}
          dateRequired={false} descriptionLabel="Contents description"
          assignmentLabels={labels} dragEnabled />)}</div>}
    </div>
    {!!labels.length && <div className="mt-3 divide-y divide-gray-200">
      {labels.map((label) => {
        const entry = assigned.get(label);
        return <section key={label} aria-label={`Exhibit ${label} slot`}
          className="min-w-0 py-4 first:pt-0"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { const id = event.dataTransfer.getData("text/x-court-record-entry");
            if (id) { event.preventDefault(); event.stopPropagation(); onAssign(id, label); }
            else if (event.dataTransfer.files.length) {
              event.preventDefault(); onFiles(kind.id, [...event.dataTransfer.files], label);
            } }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-gray-950">Exhibit {label}</h4>
            <div className="flex flex-wrap gap-2">
              <AddFileControls {...props} targetLabel={label}
                label={entry ? "Replace file" : "Add file"} />
            </div>
          </div>
          {entry && <EntryRow {...props} entry={entry} busy={props.busyEntryId === entry.id}
            findings={props.entryFindings.get(entry.id) ?? []} dateRequired={false}
            descriptionLabel="Contents description" assignmentLabel={label}
            dragEnabled />}
          <AffidavitWording statements={mentions[label]} />
        </section>;
      })}
    </div>}
    {slots && labels.length < 702 && onAddExhibit && <Button type="button" variant="outline"
      className="mt-3 h-9 border-gray-500/80 px-3" onClick={onAddExhibit}>
      <FilePlus2 /> Add exhibit
    </Button>}
  </section>;
}

function AffidavitWording({ statements = [] }: { statements?: string[] }) {
  const distinct = [...new Set(statements.map((statement) => statement.trim()).filter(Boolean))];
  if (!distinct.length) return null;
  const preview = <span className="min-w-0">
    <span className="block whitespace-nowrap font-semibold text-gray-900 sm:inline">Affidavit said:</span>
    <span className="mt-0.5 line-clamp-2 group-open:line-clamp-none sm:ms-1 sm:mt-0 sm:inline" title={distinct[0]}>
      {distinct[0]}
    </span>
  </span>;
  return <details className="group mt-2 min-w-0">
    <summary className="grid min-h-6 min-w-0 cursor-pointer list-none grid-cols-[minmax(0,1fr)_0.75rem] items-center gap-1.5 rounded-sm text-xs text-gray-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950 [&::-webkit-details-marker]:hidden">
      {preview}<ChevronDown className="size-3.5 group-open:rotate-180" aria-hidden="true" />
    </summary>
    {distinct.length > 1 && <ul className="max-h-32 list-disc space-y-1 overflow-y-auto py-1.5 ps-4 text-xs leading-5 text-gray-600">
      {distinct.slice(1).map((statement) => <li key={statement}>{statement}</li>)}
    </ul>}
  </details>;
}

function AddFileControls({ kind, onFiles, onPick, onLibrary, sourceLabel = "Library",
  targetLabel, label = "Add file" }:
  Pick<Props, "onFiles" | "onPick" | "onLibrary" | "sourceLabel"> & {
    kind: DocumentKind; targetLabel?: string; label?: string;
  }) {
  const multiple = !!kind.repeatable && !targetLabel;
  const id = `court-record-${kind.id}-${targetLabel ?? "file"}`;
  const variant = label.startsWith("Replace") ? "outline" : "default";
  const withTarget = <T,>(callback: (kindId: string, targetLabel?: string) => T) =>
    targetLabel ? callback(kind.id, targetLabel) : callback(kind.id);
  return <>
    {onLibrary && <Button type="button" variant="outline" className="h-9 border-gray-500/80 px-3"
      onClick={() => withTarget(onLibrary)}>{sourceLabel}</Button>}
    {onPick ? <Button id={id} type="button" variant={variant} className="h-9 px-3"
      onClick={() => withTarget(onPick)}>{label}</Button> :
      <label className={buttonClassName({ variant,
        className: "h-9 cursor-pointer px-3 focus-within:ring-3 focus-within:ring-ring/50" })}>
        {label}
        <input id={id} className="sr-only" type="file" accept={sourceAccept(kind)} multiple={multiple}
          aria-required={(kind.requirement === "required" && !kind.generated) || undefined}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            if (targetLabel) onFiles(kind.id, files, targetLabel);
            else onFiles(kind.id, files);
            event.target.value = "";
          }} />
      </label>}
  </>;
}

const pageList = (pages: number[]) => pages.length === 1 ? `page ${pages[0]}`
  : `pages ${pages.slice(0, -1).join(", ")} and ${pages[pages.length - 1]}`;

/**
 * What recognition did to this file, in one line. Scanned pages are read without being
 * asked for, so the entry only ever needs the reader's attention when pages that were
 * read still hold no text.
 */
function TextRecognition({ entry, reading, onStop, onConfirm }: {
  entry: RecordEntry; reading?: OcrRun; onStop?: () => void; onConfirm: () => void;
}) {
  const textless = entry.textlessPages ?? [];
  const line = "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-gray-600";
  if (reading) return <p className={cn("mt-1.5", line)} role="status">
    <Loader2 aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
    {reading.message ?? "Reading the scanned pages"}
    {onStop && <Button type="button" variant="ghost" className="h-6 px-1.5 text-xs underline"
      onClick={onStop}>Stop</Button>}
  </p>;
  if (!entry.ocrAttemptedPages || entry.pageCount === null) return null;
  const read = entry.pageCount - textless.length;
  if (entry.nonTextPagesConfirmed) return <p className={cn("mt-1.5", line)}>
    Text recognised on {read} of {entry.pageCount} pages; the rest are confirmed as
    non-text material.
  </p>;
  if (!textless.length) return <p className={cn("mt-1.5", line)}>
    Text recognised on all {entry.pageCount} pages.
  </p>;
  return <p className={cn("mt-1.5", line)}>
    <span>Text recognised on {read} of {entry.pageCount} pages;{" "}
      {textless.length > 6 ? `${textless.length} pages appear` : `${pageList(textless)} appear`}
      {textless.length === 1 ? "s" : ""} to be photographs.</span>
    <Button type="button" variant="outline" className="h-7 border-gray-500/80 px-2 text-xs"
      onClick={onConfirm}><Check className="size-3.5" /> Confirm</Button>
  </p>;
}

function EntryRow({ entry, kind, busy, findings, dateRequired, descriptionLabel, onEntry, onRemove, onAssign, onAssignKind, assignmentKinds, assignmentLabels, assignmentLabel, dragEnabled = false, showRemove = true, reading, onStopReading, onRelink }: {
  entry: RecordEntry;
  kind?: DocumentKind;
  busy: boolean;
  findings: ComplianceFinding[];
  dateRequired: boolean;
  descriptionLabel: string;
  onEntry: Props["onEntry"];
  onRemove: Props["onRemove"];
  onAssign: Props["onAssign"];
  onAssignKind: Props["onAssignKind"];
  assignmentKinds?: DocumentKind[];
  assignmentLabels?: string[];
  assignmentLabel?: string;
  dragEnabled?: boolean;
  showRemove?: boolean;
  reading?: OcrRun;
  onStopReading?: Props["onStopReading"];
  onRelink?: Props["onRelink"];
}) {
  const isPdf = sourceFormat(entry.file) === "pdf";
  const dateMissing = findings.some((finding) => finding.id === `date-${entry.id}`);
  const titleMissing = findings.some((finding) => finding.id === `description-${entry.id}`);
  const rule70Limit = kind && rule70MaximumPages(kind);
  const rule70Finding = findings.find((finding) => finding.id === `rule70-pages-${entry.id}`);
  return (
    <article
      className="min-w-0 py-3"
      data-entry-id={entry.id}
      aria-busy={busy}
      draggable={dragEnabled}
      onDragStart={(event) => event.dataTransfer.setData("text/x-court-record-entry", entry.id)}
      onDragOver={(event) => { if (dragEnabled) event.preventDefault(); }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData("text/x-court-record-entry");
        if (id && assignmentLabel) { event.preventDefault(); event.stopPropagation();
          onAssign(id, assignmentLabel); }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-3 sm:flex-nowrap sm:gap-y-0">
        <div className="min-w-0 flex-1">
          <label className="block text-xs font-medium text-gray-600">
            {descriptionLabel}
            <Input id={`entry-${entry.id}-title`} value={entry.title}
              required={entry.descriptionOnly || undefined}
              aria-invalid={titleMissing || undefined}
              onChange={(event) => onEntry(entry.id, { title: event.target.value })}
              className={cn("mt-1 h-9 font-normal",
                titleMissing && "border-red-500")} />
          </label>
          {!entry.descriptionOnly && <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
            <span className="max-w-full truncate" title={entry.file.name}>{entry.file.name}</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(entry.lastSeen?.size ?? entry.file.size)}</span>
            {entry.pageCount !== null && <><span aria-hidden="true">·</span><span>{entry.pageCount} page{entry.pageCount === 1 ? "" : "s"}</span></>}
          </div>}
        </div>
        {showRemove && <Button id={`entry-${entry.id}-remove`} type="button" variant="ghost" size="icon-sm"
          onClick={() => onRemove(entry.id)} aria-label={`Remove ${entry.descriptionOnly ? entry.title || kind?.label : entry.file.name}`} title="Remove">
          <Trash2 />
        </Button>}
      </div>
      <div className="mt-3 flex flex-col gap-2 empty:hidden sm:flex-row sm:items-end">
        {assignmentKinds && (assignmentKinds.length === 1
          ? <Button type="button" variant="outline" className="h-9 border-gray-500/80"
              onClick={() => onAssignKind(entry.id, assignmentKinds[0].id)}>
              Use as {assignmentKinds[0].label}
            </Button>
          : assignmentKinds.length ? <label className="block min-w-52 text-xs font-medium text-gray-600">
              Document type
              <select value="" aria-label={`Document type for ${entry.file.name}`}
                onChange={(event) => onAssignKind(entry.id, event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-gray-500/80 bg-white px-2 text-sm text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-red-600">
                <option value="">Choose document type</option>
                {assignmentKinds.map((option) => <option key={option.id} value={option.id}>
                  {option.label}
                </option>)}
              </select>
            </label>
          : <p className="text-xs text-red-700">No compatible document type in this format.</p>)}
        {!!assignmentLabels?.length && (assignmentLabels.length === 1
          ? <Button type="button" variant="outline" className="h-9 border-gray-500/80"
              onClick={() => onAssign(entry.id, assignmentLabels[0])}>
              Assign to Exhibit {assignmentLabels[0]}
            </Button>
          : <label className="block min-w-44 text-xs font-medium text-gray-600">
              Exhibit slot
              <select value="" aria-label={`Assign ${entry.file.name} to an exhibit`}
                onChange={(event) => onAssign(entry.id, event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-gray-500/80 bg-white px-2 text-sm text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-red-600">
                <option value="">Assign to exhibit</option>
                {assignmentLabels.map((label) => <option key={label} value={label}>
                  Exhibit {label}
                </option>)}
              </select>
            </label>)}
        {rule70Limit && entry.pageCount !== null && entry.pageCount > rule70Limit &&
          <label className="block w-full max-w-40 text-xs font-medium text-gray-600">
            Pages in Parts I–IV
            <Input type="number" inputMode="numeric" min={1} max={entry.pageCount} step={1}
              value={entry.rule70CountedPages ?? ""}
              aria-invalid={!!rule70Finding || undefined}
              aria-describedby={rule70Finding ? `finding-${rule70Finding.id}` : undefined}
              onChange={(event) => onEntry(entry.id, { rule70CountedPages:
                event.target.value ? event.target.valueAsNumber : undefined })}
              className={cn("mt-1 h-9 border-gray-500/80 md:text-base",
                rule70Finding && "border-red-500")} />
          </label>}
        {dateRequired && <label className="block w-full max-w-52 text-xs font-medium text-gray-600">
          Document date <span className="text-red-600" aria-hidden="true">*</span>
          <Input id={`entry-${entry.id}-date`} value={entry.date ?? ""}
            required aria-invalid={dateMissing || undefined}
            onChange={(event) => onEntry(entry.id, { date: event.target.value })}
            className={cn("mt-1 h-9 border-gray-500/80 md:text-base", dateMissing && "border-red-500")} />
        </label>}
        {entry.inputStatus === "missing" && onRelink && (
          <Button id={`entry-${entry.id}-relink`} type="button" variant="outline"
            className="h-9 border-red-500 text-red-800" disabled={busy}
            onClick={() => onRelink(entry.id)}><FilePlus2 /> {entry.missingReason === "permission" ? "Allow file access" : "Relink file"}</Button>
        )}
      </div>
      {isPdf && entry.inputStatus !== "missing" && <TextRecognition entry={entry}
        reading={reading?.id === entry.id ? reading : undefined} onStop={onStopReading}
        onConfirm={() => onEntry(entry.id, { nonTextPagesConfirmed: true })} />}
      {!busy && !!findings.length && (
        <div className="mt-2 space-y-1" role="status">
          {findings.filter(({ id }) => !id.startsWith("searchability-")).map((finding) => (
            <p id={`finding-${finding.id}`} key={finding.id} className={cn("text-xs leading-5", finding.level === "blocker" ? "text-red-700" : "text-amber-800")}>{finding.detail}</p>
          ))}
        </div>
      )}
      {busy && <div className="mt-2 h-1 overflow-hidden rounded-full bg-gray-100"><div className="h-full w-1/2 rounded-full bg-red-600 motion-safe:animate-pulse" /></div>}
    </article>
  );
}
