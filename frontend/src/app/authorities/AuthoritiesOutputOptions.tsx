import { useId, type ReactNode } from "react";
import type { AuthoritiesBuildSettings } from "./types";
import { OptionCard } from "./OptionCards";
import { cn } from "@/app/lib/utils";

/** The outputs a brief can ask for: its Word copy and the final PDF with the book appended. */
export type AuthoritiesOutputOptionsValue = { insertIntoDocument?: boolean } &
  Partial<Pick<AuthoritiesBuildSettings, "tableDelivery" | "citationSuffix" | "finalPdf" | "linkTabs" | "linkPinpoints">>;

type WordMode = "book" | "marks" | "table" | "tab" | "book-tab";
const LEGEND = "mb-2 text-sm font-semibold text-gray-950";

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
  const linked = delivery === "linked-append", table = linked ? "Linked table" : "Table";
  const modes: ReadonlyArray<{ value: WordMode; label: string; detail: string }> = [
    { value: "book", label: "Leave the brief unmarked", detail: "No Word copy of the brief is made." },
    { value: "marks", label: "Mark citations",
      detail: "A Word copy with each citation marked for Word’s Table of Authorities." },
    { value: "table", label: linked ? "Add the linked table" : "Mark and add the table",
      detail: `A ${linked ? "Word copy with a linked" : "marked copy with the"} Table of Authorities on a new last page.` },
    { value: "tab", label: `${table} and [${firstTab}]`, detail: "Also adds each authority’s tab after its citations." },
    { value: "book-tab", label: `${table} and [Book of authorities ${firstTab}]`,
      detail: "The same, naming the book in each tab reference." },
  ];
  const choose = (mode: WordMode) => onChange({ insertIntoDocument: mode !== "book",
    tableDelivery: mode === "marks" ? "native-marks" : delivery,
    citationSuffix: mode === "tab" || mode === "book-tab" ? mode : "none" });
  const final = !!value.finalPdf;
  // Side by side where there is room: the Word copy, then the final PDF it can end in.
  return <div className="@container/output"><div className={cn("grid gap-x-2 gap-y-5", word && "@min-[34rem]/output:grid-cols-2")}>
    {word && <fieldset disabled={disabled} className="min-w-0">
      <legend className={LEGEND}>Word copy</legend>
      <div className="grid auto-rows-fr gap-2">
        {modes.map(mode => <OptionCard key={mode.value} name={name} checked={selected === mode.value}
          disabled={!!lockedDelivery && mode.value === "marks"} onChange={() => choose(mode.value)}
          label={mode.label} detail={mode.detail} />)}
      </div>
    </fieldset>}
    <fieldset disabled={disabled} className="@container/final min-w-0">
      <legend className={LEGEND}>Final PDF</legend>
      <OptionCard type="checkbox" checked={final} onChange={event => onChange({ finalPdf: event.target.checked })}
        label="Append the book to the brief"
        detail="One PDF: the brief, then the whole Book of Authorities, bookmarked." />
      {/* Its links follow under it, unavailable until it is chosen, so choosing it moves nothing. */}
      <div className="mt-2 grid auto-rows-fr gap-2 pl-6 @min-[34rem]/final:grid-cols-2">
        <OptionCard type="checkbox" disabled={!final} checked={!!value.linkTabs}
          onChange={event => onChange({ linkTabs: event.target.checked })} label="Link citations to their tabs"
          detail="Clicking a citation or its tab reference opens its tab in the book." />
        <OptionCard type="checkbox" disabled={!final} checked={!!value.linkPinpoints}
          onChange={event => onChange({ linkPinpoints: event.target.checked })} label="Link pinpoints to the cited passage"
          detail="For PDFs you uploaded, clicking a pinpoint opens its passage; any not found are listed." />
        {brief && <div className="min-w-0 @min-[34rem]/final:col-span-2 [&>*]:h-full">{brief(final)}</div>}
      </div>
    </fieldset>
  </div></div>;
}
