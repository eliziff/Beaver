import { useId, type ChangeEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/app/lib/utils";

/** The card every Authorities choice is drawn as: a control, a name and one sentence about it.
 *  The whole card is the control's label; a chosen card turns red, an unavailable one fades. Its
 *  focus ring is its own control's: a text box inside it shows its own focus alone. */
export function OptionCard({ type = "radio", name, checked, disabled, onChange, label, detail, preview,
  row = false, className }: {
  type?: "radio" | "checkbox"; name?: string; checked: boolean; disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  label: ReactNode; detail?: ReactNode; preview?: ReactNode; className?: string;
  /** One line where its container (an `@container/rows`) is wide: the name, then its sentence. */
  row?: boolean;
}) {
  const id = useId();
  return <label className={cn(CARD, row && "min-h-0 py-2", "cursor-pointer hover:border-gray-400 has-[:checked]:border-gray-900 has-[:checked]:bg-gray-50 has-[:checked]:shadow-[inset_0_0_0_1px_var(--color-gray-900)] [&:has(>input:focus-visible)]:ring-2 [&:has(>input:focus-visible)]:ring-red-600 has-[:disabled]:cursor-default has-[:disabled]:opacity-60", className)}>
    <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange}
      aria-labelledby={id} aria-describedby={detail ? `${id}-detail` : undefined} className="h-4 w-4 accent-gray-900" />
    {preview}
    <CardText id={id} label={label} detail={detail} wide={!preview} row={row} />
  </label>;
}

/** A card that holds a file instead of a choice, laid out as the choices are. */
export function FileCard({ label, detail, action, disabled, className }: {
  label: ReactNode; detail: ReactNode; action?: ReactNode; disabled?: boolean; className?: string;
}) {
  const id = useId();
  return <div role="group" aria-labelledby={id} aria-describedby={`${id}-detail`} aria-disabled={disabled || undefined}
    className={cn(CARD, "grid-cols-[minmax(0,1fr)_auto]", disabled && "opacity-60", className)}>
    <CardText id={id} label={label} detail={detail} />
    {action}
  </div>;
}

const CARD = "grid min-h-12 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-gray-300 bg-white px-3 py-2";

function CardText({ id, label, detail, wide = false, row = false }: { id: string; label: ReactNode; detail?: ReactNode;
  wide?: boolean; row?: boolean }) {
  // In a row, every card's name takes the same column, so the sentences line up down the list.
  return <span className={cn("min-w-0", wide && "col-span-2",
    row && "@min-[38rem]/rows:grid @min-[38rem]/rows:grid-cols-[11.5rem_minmax(0,1fr)] @min-[38rem]/rows:items-center @min-[38rem]/rows:gap-3")}>
    <span id={id} className="block text-sm font-medium text-gray-950">{label}</span>
    {detail && <span id={`${id}-detail`} className={cn("block text-xs leading-4 text-gray-600", row ? "mt-0.5 @min-[38rem]/rows:mt-0" : "mt-0.5")}>{detail}</span>}
  </span>;
}

/** A setting as one row: its name in the column every row shares, its options as segments, and the
 *  chosen option said in a plain sentence under them. */
export function Segments<T extends string>({ label, value, options, disabled, onChange, stacked = false }: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: string; detail?: string }>;
  disabled?: boolean; onChange: (value: T) => void; stacked?: boolean;
}) {
  const chosen = options.find((option) => option.value === value);
  return <div role="radiogroup" aria-label={label}
    className={stacked ? "grid min-w-0 gap-1.5" : "grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-x-3"}>
    <span className={cn("text-[0.8125rem] font-medium text-gray-700", !stacked && "pt-1.5")}>{label}</span>
    <div className="min-w-0">
      <div className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-md border border-gray-300 bg-white p-0.5">
        {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
          disabled={disabled} onClick={() => { if (option.value !== value) onChange(option.value); }}
          className={cn("h-7 rounded px-2.5 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600",
            option.value === value ? "bg-gray-900 font-medium text-white" : "text-gray-700 hover:bg-gray-100 disabled:text-gray-400")}>
          {option.label}</button>)}
      </div>
      {chosen?.detail && <p className="mt-1 text-xs leading-4 text-gray-600">{chosen.detail}</p>}
    </div>
  </div>;
}

export type CardOption<T extends string> = { value: T; label: string; detail?: string; preview?: ReactNode };

/** The choices as cards under their legend; `collapsed`, closed until opened, its summary naming
 *  the choice made. */
export function OptionCards<T extends string>({ legend, value, options, onChange, columns, disabled,
  className, collapsed = false }: { legend: string; value: T; options: ReadonlyArray<CardOption<T>>;
  onChange: (value: T) => void; columns?: boolean; disabled?: boolean; className?: string; collapsed?: boolean }) {
  const cards = <fieldset className={collapsed ? "mt-3" : className} disabled={disabled}>
    <legend className={collapsed ? "sr-only" : "mb-1.5 text-[0.8125rem] font-medium text-gray-700"}>{legend}</legend>
    <div className={cn("grid auto-rows-fr gap-2", columns && "sm:grid-cols-2")}>
      {options.map((option) => <OptionCard key={option.value} name={`authorities-${legend}`}
        checked={value === option.value} onChange={() => onChange(option.value)}
        label={option.label} detail={option.detail} preview={option.preview} />)}
    </div>
  </fieldset>;
  return collapsed ? <details className={cn("group", className)}>
    <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1 rounded-md pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="h-4 w-4 text-gray-700 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
      <span className="font-semibold text-gray-950">{legend}</span>
      <span className="ml-1 text-gray-600">{options.find((option) => option.value === value)?.label}</span>
    </summary>
    {cards}
  </details> : cards;
}
