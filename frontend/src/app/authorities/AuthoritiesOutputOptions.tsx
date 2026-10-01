import { useId, type ReactNode } from "react";
import type { AuthoritiesBuildSettings } from "./types";
import { cn } from "@/app/lib/utils";

/** The outputs a brief can ask for: its Word copy and the final PDF with the book appended. */
export type AuthoritiesOutputOptionsValue = { insertIntoDocument?: boolean } &
  Partial<Pick<AuthoritiesBuildSettings, "tableDelivery" | "citationSuffix" | "finalPdf" | "linkTabs" | "linkPinpoints">>;

const WORD_OUTPUTS = [
  { value: "book", label: "No marks" },
  { value: "marks", label: "Mark authorities" },
  { value: "table", label: "Mark and add a table" },
  { value: "tabs", label: "Mark, add a table and tab references" },
] as const;
const SUFFIXES = [["book-tab", "[Book of authorities Tab 1]"], ["tab", "[Tab 1]"]] as const;
const row = "flex min-h-8 cursor-pointer items-center gap-2 text-sm text-gray-900 has-[:disabled]:cursor-default has-[:focus-visible]:rounded has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600";
const legend = "mb-1 min-h-8 text-sm font-semibold leading-8 text-gray-900";

/** One option set, read the same at import and at Build: how the Word brief is marked and
 *  whether a final PDF appends the book to the brief. Every row keeps its place whatever is chosen. */
export function AuthoritiesOutputOptions({ value, onChange, word, disabled = false, lockedDelivery, brief }: {
  value: AuthoritiesOutputOptionsValue;
  onChange: (patch: AuthoritiesOutputOptionsValue) => void;
  /** A Word brief also chooses how its copy is marked. */
  word: boolean;
  disabled?: boolean;
  lockedDelivery?: AuthoritiesBuildSettings["tableDelivery"];
  /** The brief PDF row, for a Word brief this app cannot turn into PDF itself. */
  brief?: ReactNode;
}) {
  const name = useId();
  const selected = !value.insertIntoDocument ? "book"
    : value.tableDelivery === "native-marks" ? "marks"
      : value.citationSuffix && value.citationSuffix !== "none" ? "tabs" : "table";
  const delivery = lockedDelivery ?? (value.tableDelivery === "linked-append" ? "linked-append" : "native-append");
  const choose = (mode: typeof WORD_OUTPUTS[number]["value"], suffix = value.citationSuffix) => onChange({
    insertIntoDocument: mode !== "book", tableDelivery: mode === "marks" ? "native-marks" : delivery,
    citationSuffix: mode === "tabs" ? suffix === "tab" ? "tab" : "book-tab" : "none" });
  const final = !!value.finalPdf;
  return <div className="@container/output">
    {/* A fieldset is as wide as its content by default; a long file name must truncate instead. */}
    <div className="grid gap-x-8 gap-y-2 @min-[36rem]/output:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {word && <fieldset disabled={disabled} className="min-w-0">
        <legend className={legend}>Word brief</legend>
        {WORD_OUTPUTS.map(option => <div key={option.value}>
          <label className={row}>
            <input type="radio" name={name} className="accent-red-700" checked={selected === option.value}
              disabled={!!lockedDelivery && option.value === "marks"} onChange={() => choose(option.value)} />
            {option.label}
          </label>
          {/* Choosing a reference chooses tab references, so the pair is never a dead control. */}
          {option.value === "tabs" && <span role="radiogroup" aria-label="Tab reference" className="flex min-h-8 items-center gap-1 pl-6">
            {SUFFIXES.map(([suffix, label]) => {
              const on = selected === "tabs" && (value.citationSuffix ?? "book-tab") === suffix;
              return <label key={suffix} className={cn("flex h-7 cursor-pointer items-center rounded border px-2 text-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600",
                on ? "border-red-600 bg-red-50 text-gray-950" : "border-gray-300 text-gray-600 hover:bg-gray-50")}>
                <input type="radio" name={`${name}-suffix`} className="sr-only" checked={on}
                  onChange={() => choose("tabs", suffix)} />{label}</label>;
            })}
          </span>}
        </div>)}
      </fieldset>}
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="sr-only">Final PDF</legend>
        <label className={cn(row, "mb-1 font-semibold")}>
          <input type="checkbox" className="accent-red-700" checked={final}
            onChange={event => onChange({ finalPdf: event.target.checked })} />
          Final PDF with the book appended
        </label>
        <div className={cn("pl-6", !final && "text-gray-500")}>
          <label className={row}>
            <input type="checkbox" className="accent-red-700" disabled={!final} checked={!!value.linkTabs}
              onChange={event => onChange({ linkTabs: event.target.checked })} />
            {word ? "Link tab references to their tabs" : "Link citations to their tabs"}
          </label>
          <label className={row}>
            <input type="checkbox" className="accent-red-700" disabled={!final} checked={!!value.linkPinpoints}
              onChange={event => onChange({ linkPinpoints: event.target.checked })} />
            Link pinpoints into PDFs you uploaded
          </label>
          {/* Its room is kept while the final PDF is off, so turning it on moves nothing. */}
          {brief && <div className={cn("min-h-8 min-w-0", !final && "invisible")} aria-hidden={!final || undefined}>{brief}</div>}
        </div>
      </fieldset>
    </div>
  </div>;
}
