import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { currentTabReference, tabReference } from "../../../../shared/authorities-order.mjs";
import type { AuthoritiesBuildSettings } from "./types";
import { OptionCard } from "./OptionCards";
import { cn } from "@/app/lib/utils";

/** The outputs a brief can ask for: its Word copy, the tab references in it, and the final PDF
 *  with the book appended. */
export type AuthoritiesOutputOptionsValue = { insertIntoDocument?: boolean } &
  Partial<Pick<AuthoritiesBuildSettings, "tableDelivery" | "citationSuffix" | "citationSuffixLabel" | "tabPrefix" |
    "finalPdf" | "linkTabs" | "linkPinpoints">>;

type WordMode = "none" | "marks" | "table";
type TabMode = NonNullable<AuthoritiesBuildSettings["citationSuffix"]>;
const LEGEND = "mb-2 text-sm font-semibold text-gray-950";
// Laid out as the passage marks are: two cards a row where there is room.
const CARDS = "grid auto-rows-fr gap-2 @min-[34rem]/output:grid-cols-2";
/** Custom wording starts from the usual form; the user types over it. */
const WORDING = "Book of Authorities, Tab";
/** A tab reference never breaks inside it. */
const whole = (text: string) => <span className="whitespace-nowrap">{text}</span>;

/** How a Word brief that this app cannot convert reaches the final PDF: saved as PDF in Word, from
 *  the Word copy Build makes when there is one, so the PDF shows its tab references or table. */
export function briefPdfAdvice(filename: string, value: AuthoritiesOutputOptionsValue) {
  return value.insertIntoDocument || (currentTabReference(value).citationSuffix ?? "none") !== "none"
    ? "Build, open the Word copy in Word, choose File › Save As › PDF, then add it here."
    : `Open ${filename} in Word, choose File › Save As › PDF, then add it here.`;
}

/** A Word brief's two choices, drawn as the import options are and read the same at import and at
 *  Build: what its Word copy holds, and the tab reference after each citation. */
export function AuthoritiesOutputOptions({ value: stored, onChange, disabled = false, lockedDelivery,
  firstTab = "Tab 1" }: {
  value: AuthoritiesOutputOptionsValue;
  onChange: (patch: AuthoritiesOutputOptionsValue) => void;
  disabled?: boolean;
  lockedDelivery?: AuthoritiesBuildSettings["tableDelivery"];
  /** The first tab as this book labels it, for the tab references. */
  firstTab?: string;
}) {
  const name = useId(), tabsName = useId(), input = useRef<HTMLInputElement>(null);
  const value = currentTabReference(stored);
  const selected: WordMode = !value.insertIntoDocument ? "none" : value.tableDelivery === "native-marks" ? "marks" : "table";
  const delivery = lockedDelivery ?? (value.tableDelivery === "linked-append" ? "linked-append" : "native-append");
  // A linked table is a list of links, without Word's citation fields.
  const linked = delivery === "linked-append";
  const modes: ReadonlyArray<{ value: WordMode; label: string; detail: string }> = [
    { value: "none", label: linked ? "No table" : "No marks",
      detail: "Citations are left unmarked; a copy is made only for tab references." },
    { value: "marks", label: "Marked copy",
      detail: "A copy of the brief with each citation marked for Word’s Table of Authorities." },
    linked ? { value: "table", label: "Copy with a linked table",
      detail: "A copy with a Table of Authorities on a new last page, each authority linked to its source." }
      : { value: "table", label: "Marked copy and table",
        detail: "The marked copy, with Word’s Table of Authorities on a new last page." },
  ];
  const tabMode: TabMode = value.citationSuffix ?? "none";
  // The wording is typed here and saved when the box is left, so typing never waits on a save.
  const [words, setWords] = useState(value.citationSuffixLabel ?? WORDING);
  useEffect(() => { if (value.citationSuffixLabel) setWords(value.citationSuffixLabel); }, [value.citationSuffixLabel]);
  const [missing, setMissing] = useState(false);
  const typed = words.trim();
  const sample = tabReference({ citationSuffix: "custom", citationSuffixLabel: typed || "…", tabPrefix: value.tabPrefix }, firstTab)!;
  const chooseCustom = () => {
    if (!typed) { setMissing(true); input.current?.focus(); return; }
    setMissing(false);
    if (tabMode !== "custom" || typed !== value.citationSuffixLabel)
      onChange({ citationSuffix: "custom", citationSuffixLabel: typed });
  };
  return <div className="@container/output grid gap-y-5">
    <fieldset disabled={disabled} className="min-w-0">
      <legend className={LEGEND}>Word copy</legend>
      <div className={CARDS}>
        {modes.map(mode => <OptionCard key={mode.value} name={name} checked={selected === mode.value}
          disabled={!!lockedDelivery && mode.value === "marks"}
          onChange={() => onChange({ insertIntoDocument: mode.value !== "none",
            tableDelivery: mode.value === "marks" ? "native-marks" : delivery })}
          label={mode.label} detail={mode.detail} preview={<WordPreview mode={mode.value} linked={linked} />} />)}
      </div>
    </fieldset>
    <fieldset disabled={disabled} className="min-w-0">
      <legend className={LEGEND}>Tab references</legend>
      <div className="grid gap-2 @min-[34rem]/output:grid-cols-2">
        <OptionCard name={tabsName} checked={tabMode === "none"} onChange={() => onChange({ citationSuffix: "none" })}
          label="None" detail="Citations are left as the brief writes them." preview={<TabPreview mode="none" />} />
        <OptionCard name={tabsName} checked={tabMode === "tab"} onChange={() => onChange({ citationSuffix: "tab" })}
          label={whole(`[${firstTab}]`)} preview={<TabPreview mode="tab" />}
          detail={<>Each citation is followed by its tab, as in “R v Jordan, 2016 SCC 27 {whole(`[${firstTab}]`)}”.</>} />
        <OptionCard name={tabsName} checked={tabMode === "custom"} onChange={chooseCustom}
          className="@min-[34rem]/output:col-span-2" preview={<TabPreview mode="custom" />}
          label="Your wording, then the tab number"
          detail={<>
            <input ref={input} type="text" value={words} maxLength={120} aria-label="Words before the tab number"
              aria-invalid={missing || undefined} placeholder="Appellant’s Book of Authorities, Tab"
              className="mt-1 block h-8 w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-950 outline-none focus-visible:ring-2 focus-visible:ring-red-600 aria-[invalid]:border-red-700"
              onChange={(event) => { setWords(event.target.value); if (event.target.value.trim()) setMissing(false); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
              onBlur={() => { if (typed) chooseCustom(); else { setMissing(false); setWords(value.citationSuffixLabel ?? WORDING); } }} />
            <span className="mt-1 block truncate" aria-live="polite">{missing ? <span className="text-red-800">Type the words before the tab number.</span>
              : <>Inserts <span className="font-medium text-gray-950">{whole(sample)}</span> after each citation.</>}</span>
          </>} />
      </div>
    </fieldset>
  </div>;
}

/** The final PDF, a workflow of its own that the user opts into: the brief as filed, then the book,
 *  its citations linked inside it. Its steps stay in place, unavailable, until it is chosen. */
export function FinalPdfOptions({ value, onChange, disabled = false, brief, result }: {
  value: Pick<AuthoritiesOutputOptionsValue, "finalPdf" | "linkTabs" | "linkPinpoints">;
  onChange: (patch: AuthoritiesOutputOptionsValue) => void;
  disabled?: boolean;
  /** Step 1: the brief as PDF, already there or added here. */
  brief: (available: boolean) => ReactNode;
  /** Step 3: the final PDF's own build and download. */
  result: (available: boolean) => ReactNode;
}) {
  const final = !!value.finalPdf;
  const step = (number: number, title: string, body: ReactNode) => <li className="grid gap-2">
    <span className={cn("flex items-center gap-2 text-sm font-medium", final ? "text-gray-950" : "text-gray-500")}>
      <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full border border-gray-400 text-xs text-gray-700">{number}</span>
      {title}</span>
    {body}
  </li>;
  return <fieldset disabled={disabled} className="@container/output min-w-0">
    <legend className={LEGEND}>Final PDF <span className="font-normal text-gray-500">(optional)</span></legend>
    <OptionCard type="checkbox" checked={final} onChange={event => onChange({ finalPdf: event.target.checked })}
      label="Make a final PDF" preview={<PdfPreview kind="append" />}
      detail="Your brief as filed, then the Book of Authorities, with each citation linked to its tab: “R v Jordan, 2016 SCC 27” opens Tab 4." />
    <p className="mt-2 text-xs leading-4 text-gray-600">
      Its links jump to pages inside the PDF; web links already in the brief are kept as they are.</p>
    <ol className="mt-3 grid gap-4">
      {step(1, "Your brief as PDF", brief(final))}
      {step(2, "Links", <div className={CARDS}>
        <OptionCard type="checkbox" disabled={!final} checked={!!value.linkTabs}
          onChange={event => onChange({ linkTabs: event.target.checked })} label="Link citations to their tabs"
          preview={<PdfPreview kind="tabs" />}
          detail="Clicking “R v Jordan, 2016 SCC 27” or its tab reference opens Tab 4 in the book." />
        <OptionCard type="checkbox" disabled={!final} checked={!!value.linkPinpoints}
          onChange={event => onChange({ linkPinpoints: event.target.checked })} label="Link pinpoints to the cited passage"
          preview={<PdfPreview kind="pinpoints" />}
          detail="For PDFs you uploaded, clicking “at para 105” opens Tab 4 at paragraph 105; any not found are listed." />
      </div>)}
      {step(3, "Build it", result(final))}
    </ol>
  </fieldset>;
}

const PAGE = "relative block h-9 w-14 shrink-0 overflow-hidden rounded border border-gray-400 bg-white";
const LINE = "absolute left-2 h-0.5 bg-gray-500";

/** A page of the Word copy as the choice leaves it: drawn as the passage marks are. */
function WordPreview({ mode, linked }: { mode: WordMode; linked: boolean }) {
  return <span aria-hidden="true" className={cn(PAGE, mode === "none" && "border-dashed")}>
    {mode === "none" ? [8, 17, 26].map((top, index) => <span key={top}
      className={cn(LINE, "bg-gray-300", index === 1 ? "w-9" : "w-7")} style={{ top }} />)
      : mode === "table" ? <>
        {/* The brief's last line, then the table on a new page: a heading over leader rows. */}
        <span className={cn(LINE, "top-[5px] w-6")} />
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

/** A line of the brief with what follows each citation: nothing, its tab, or the user's words and tab. */
function TabPreview({ mode }: { mode: TabMode }) {
  return <span aria-hidden="true" className={PAGE}>
    {[8, 17, 26].map((top, index) => <span key={top} className="absolute left-2 flex items-center gap-0.5" style={{ top: top - 2 }}>
      <span className={cn("h-0.5", index === 1 ? "w-4" : "w-7", mode === "none" ? "bg-gray-300" : "bg-gray-500")} />
      {index === 1 && mode !== "none" && <span className={cn("h-1.5 rounded-sm bg-red-600", mode === "tab" ? "w-2" : "w-5")} />}
    </span>)}
  </span>;
}

/** The final PDF: the brief, then the book after it, and where its links lead inside it. */
function PdfPreview({ kind }: { kind: "append" | "tabs" | "pinpoints" }) {
  return <span aria-hidden="true" className="relative block h-9 w-14 shrink-0">
    <span className="absolute left-0 top-0 h-9 w-[26px] rounded border border-gray-400 bg-white">
      {[6, 13, 20, 27].map((top, index) => <span key={top} className={cn("absolute left-1 h-0.5",
        kind !== "append" && index === 1 ? "w-3 bg-red-600" : "w-4 bg-gray-500")} style={{ top }} />)}
    </span>
    {/* The book's tab, its edge in red; a pinpoint opens at its paragraph, marked. */}
    <span className="absolute right-0 top-0 h-9 w-[26px] rounded border border-gray-400 bg-gray-50">
      <span className="absolute -right-px top-1.5 h-2.5 w-1 rounded-l-sm bg-red-600" />
      {kind === "pinpoints" && <span className="absolute inset-x-1 top-[18px] h-2 bg-red-200" />}
      {[6, 13, 20, 27].map((top) => <span key={top} className="absolute left-1 h-0.5 w-3.5 bg-gray-400" style={{ top }} />)}
    </span>
    {/* The citation's link, an arrow to where it lands. */}
    {kind !== "append" && <span className={cn("absolute left-[15px] flex items-center",
      kind === "tabs" ? "top-[11px]" : "top-[11px] origin-left rotate-[22deg]")}>
      <span className="h-0 w-[22px] border-t border-red-600" />
      <span className="h-0 w-0 border-y-[3px] border-l-4 border-y-transparent border-l-red-600" />
    </span>}
  </span>;
}
