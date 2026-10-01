import { useId, type ReactNode } from "react";
import type { AuthoritiesBuildSettings } from "./types";
import { OptionCard } from "./OptionCards";
import { cn } from "@/app/lib/utils";

/** The outputs a brief can ask for: its Word copy and the final PDF with the book appended. */
export type AuthoritiesOutputOptionsValue = { insertIntoDocument?: boolean } &
  Partial<Pick<AuthoritiesBuildSettings, "tableDelivery" | "citationSuffix" | "finalPdf" | "linkTabs" | "linkPinpoints">>;

type WordMode = "book" | "marks" | "table" | "tab" | "book-tab";
const LEGEND = "mb-2 text-sm font-semibold text-gray-950";
/** A tab reference never breaks inside its number. */
const whole = (text: string) => <span className="whitespace-nowrap">{text}</span>;

/** One option set, drawn as the import options are and read the same at import and at Build:
 *  what the Word copy of a Word brief holds, and whether a final PDF appends the book to the brief.
 *  An option that depends on another stays in place, unavailable, until that one is chosen. */
export function AuthoritiesOutputOptions({ value, onChange, word, disabled = false, lockedDelivery,
  firstTab = "Tab 1", brief }: {
  value: AuthoritiesOutputOptionsValue;
  onChange: (patch: AuthoritiesOutputOptionsValue) => void;
  /** A Word brief also chooses what its Word copy holds. */
  word: boolean;
  disabled?: boolean;
  lockedDelivery?: AuthoritiesBuildSettings["tableDelivery"];
  /** The first tab as this book labels it, for the tab references. */
  firstTab?: string;
  /** The brief as PDF, for a Word brief this app cannot turn into PDF itself. */
  brief?: (available: boolean) => ReactNode;
}) {
  const name = useId();
  const selected: WordMode = !value.insertIntoDocument ? "book" : value.tableDelivery === "native-marks" ? "marks"
    : value.citationSuffix === "tab" || value.citationSuffix === "book-tab" ? value.citationSuffix : "table";
  const delivery = lockedDelivery ?? (value.tableDelivery === "linked-append" ? "linked-append" : "native-append");
  // A linked table is a list of links, without Word's citation fields.
  const linked = delivery === "linked-append", table = linked ? "Linked table" : "Marked copy, table";
  const modes: ReadonlyArray<{ value: WordMode; label: ReactNode; detail: ReactNode }> = [
    { value: "book", label: "No Word copy", detail: "The brief is left as it is, and no copy of it is made." },
    { value: "marks", label: "Marked copy",
      detail: "A copy of the brief with each citation marked for Word’s Table of Authorities." },
    linked ? { value: "table", label: "Copy with a linked table",
      detail: "A copy with a Table of Authorities on a new last page, each authority linked to its source." }
      : { value: "table", label: "Marked copy and table",
        detail: "The marked copy, with Word’s Table of Authorities on a new last page." },
    { value: "tab", label: <>{table} and {whole(`[${firstTab}]`)}</>,
      detail: <>The same, with each citation followed by its authority’s tab, as {whole(`[${firstTab}]`)}.</> },
    { value: "book-tab", label: <>{table} and [Book of authorities {whole(`${firstTab}]`)}</>,
      detail: "The same, with each citation followed by its tab in the Book of Authorities." },
  ];
  const choose = (mode: WordMode) => onChange({ insertIntoDocument: mode !== "book",
    tableDelivery: mode === "marks" ? "native-marks" : delivery,
    citationSuffix: mode === "tab" || mode === "book-tab" ? mode : "none" });
  const final = !!value.finalPdf;
  // Laid out as the passage marks are: two cards a row where there is room.
  const cards = "grid auto-rows-fr gap-2 @min-[34rem]/output:grid-cols-2";
  return <div className="@container/output grid gap-y-5">
    {word && <fieldset disabled={disabled} className="min-w-0">
      <legend className={LEGEND}>Word copy</legend>
      <div className={cards}>
        {modes.map(mode => <OptionCard key={mode.value} name={name} checked={selected === mode.value}
          disabled={!!lockedDelivery && mode.value === "marks"} onChange={() => choose(mode.value)}
          label={mode.label} detail={mode.detail} preview={<WordPreview mode={mode.value} linked={linked} />} />)}
      </div>
    </fieldset>}
    <fieldset disabled={disabled} className="min-w-0">
      <legend className={LEGEND}>Final PDF</legend>
      {/* Its links follow it, unavailable until it is chosen, so choosing it moves nothing. */}
      <div className={cards}>
        <OptionCard type="checkbox" checked={final} onChange={event => onChange({ finalPdf: event.target.checked })}
          label="Append the book to the brief" preview={<PdfPreview kind="append" />}
          detail="One PDF: the brief, then the whole Book of Authorities, bookmarked." />
        {brief ? <div className="min-w-0 [&>*]:h-full">{brief(final)}</div>
          : <span className="hidden @min-[34rem]/output:block" />}
        <OptionCard type="checkbox" disabled={!final} checked={!!value.linkTabs}
          onChange={event => onChange({ linkTabs: event.target.checked })} label="Link citations to their tabs"
          preview={<PdfPreview kind="tabs" />}
          detail="Clicking a citation or its tab reference opens its tab in the book." />
        <OptionCard type="checkbox" disabled={!final} checked={!!value.linkPinpoints}
          onChange={event => onChange({ linkPinpoints: event.target.checked })} label="Link pinpoints to the cited passage"
          preview={<PdfPreview kind="pinpoints" />}
          detail="For PDFs you uploaded, clicking a pinpoint opens its passage; any not found are listed." />
      </div>
    </fieldset>
  </div>;
}

const PAGE = "relative block h-9 w-14 shrink-0 overflow-hidden rounded border border-gray-400 bg-white";
const LINE = "absolute left-2 h-0.5 bg-gray-500";

/** A page of the Word copy as the choice leaves it: drawn as the passage marks are. */
function WordPreview({ mode, linked }: { mode: WordMode; linked: boolean }) {
  const tab = mode === "tab" || mode === "book-tab", table = mode !== "book" && mode !== "marks";
  return <span aria-hidden="true" className={cn(PAGE, mode === "book" && "border-dashed")}>
    {mode === "book" ? [8, 17, 26].map((top, index) => <span key={top}
      className={cn(LINE, "bg-gray-300", index === 1 ? "w-9" : "w-7")} style={{ top }} />)
      : table ? <>
        {/* The brief's last lines, then the table on a new page: a heading over leader rows. */}
        <span className={cn(LINE, "top-[5px] w-6")} />
        {tab && <span className={cn("absolute top-[3px] h-1.5 rounded-sm bg-red-600", mode === "tab" ? "left-[34px] w-2" : "left-[34px] w-4")} />}
        <span className="absolute inset-x-0 top-[11px] border-t border-dashed border-gray-400" />
        <span className="absolute left-2 top-[15px] h-[3px] w-5 bg-gray-900" />
        {[22, 28].map((top) => <span key={top} className="absolute left-2 right-2 flex items-center gap-0.5" style={{ top }}>
          <span className={cn("h-0.5 w-4", linked ? "bg-red-600" : "bg-gray-500")} />
          {!linked && <span className="h-0 flex-1 border-t border-dotted border-gray-500" />}
          {!linked && <span className="h-0.5 w-1 bg-gray-500" />}
        </span>)}
      </> : [8, 17, 26].map((top, index) => <span key={top} className="absolute left-2 flex items-center gap-0.5" style={{ top: top - 2 }}>
        {/* A citation's Word field: the mark the table is built from, after it. */}
        <span className={cn("h-0.5 bg-gray-500", index === 1 ? "w-6" : "w-5")} />
        {index !== 1 && <span className="h-1.5 w-1.5 rounded-[1px] border border-red-600" />}
      </span>)}
  </span>;
}

/** The final PDF: the brief, then the book after it, and where its links lead. */
function PdfPreview({ kind }: { kind: "append" | "tabs" | "pinpoints" }) {
  return <span aria-hidden="true" className="relative block h-9 w-14 shrink-0">
    <span className="absolute left-0 top-0 h-9 w-[26px] rounded border border-gray-400 bg-white">
      {[6, 13, 20, 27].map((top, index) => <span key={top} className={cn("absolute left-1 h-0.5",
        kind !== "append" && index === 1 ? "w-3 bg-red-600" : "w-4 bg-gray-500")} style={{ top }} />)}
    </span>
    {/* The book's first tab, its edge in red. */}
    <span className="absolute right-0 top-0 h-9 w-[26px] rounded border border-gray-400 bg-gray-50">
      <span className="absolute -right-px top-1.5 h-2.5 w-1 rounded-l-sm bg-red-600" />
      {kind === "pinpoints" && <span className="absolute inset-x-1 top-[18px] h-2 bg-red-200" />}
      {[6, 13, 20, 27].map((top) => <span key={top} className="absolute left-1 h-0.5 w-3.5 bg-gray-400" style={{ top }} />)}
    </span>
    {kind !== "append" && <span className={cn("absolute left-4 h-0 w-6 border-t border-red-600",
      kind === "tabs" ? "top-[14px]" : "top-[14px] origin-left rotate-[20deg]")} />}
  </span>;
}
