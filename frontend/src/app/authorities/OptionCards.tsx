import { useId, type ChangeEvent, type ReactNode } from "react";
import { cn } from "@/app/lib/utils";

/** The card every Authorities choice is drawn as: a control, a name and one sentence about it.
 *  The whole card is the control's label; a chosen card turns red, an unavailable one fades. */
export function OptionCard({ type = "radio", name, checked, disabled, onChange, label, detail, preview,
  row = false, className }: {
  type?: "radio" | "checkbox"; name?: string; checked: boolean; disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  label: ReactNode; detail?: ReactNode; preview?: ReactNode; className?: string;
  /** One line where its container (an `@container/rows`) is wide: the name, then its sentence. */
  row?: boolean;
}) {
  const id = useId();
  return <label className={cn(CARD, row && "min-h-0 py-2", "cursor-pointer has-[:checked]:border-red-600 has-[:checked]:bg-red-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600 has-[:disabled]:cursor-default has-[:disabled]:opacity-60", className)}>
    <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange}
      aria-labelledby={id} aria-describedby={detail ? `${id}-detail` : undefined} className="h-4 w-4 accent-red-700" />
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

const CARD = "grid min-h-16 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-gray-300 p-3";

function CardText({ id, label, detail, wide = false, row = false }: { id: string; label: ReactNode; detail?: ReactNode;
  wide?: boolean; row?: boolean }) {
  // In a row, every card's name takes the same column, so the sentences line up down the list.
  return <span className={cn("min-w-0", wide && "col-span-2",
    row && "@min-[38rem]/rows:grid @min-[38rem]/rows:grid-cols-[11.5rem_minmax(0,1fr)] @min-[38rem]/rows:items-center @min-[38rem]/rows:gap-3")}>
    <span id={id} className="block text-sm font-semibold text-gray-950">{label}</span>
    {detail && <span id={`${id}-detail`} className={cn("block text-xs leading-4 text-gray-600", row ? "mt-0.5 @min-[38rem]/rows:mt-0" : "mt-0.5")}>{detail}</span>}
  </span>;
}

export type CardOption<T extends string> = { value: T; label: string; detail?: string; preview?: ReactNode };

export function OptionCards<T extends string>({ legend, value, options, onChange, columns, disabled,
  className }: { legend: string; value: T; options: ReadonlyArray<CardOption<T>>;
  onChange: (value: T) => void; columns?: boolean; disabled?: boolean; className?: string }) {
  return <fieldset className={className} disabled={disabled}>
    <legend className="mb-2 text-sm font-semibold text-gray-950">{legend}</legend>
    <div className={cn("grid auto-rows-fr gap-2", columns && "sm:grid-cols-2")}>
      {options.map((option) => <OptionCard key={option.value} name={`authorities-${legend}`}
        checked={value === option.value} onChange={() => onChange(option.value)}
        label={option.label} detail={option.detail} preview={option.preview} />)}
    </div>
  </fieldset>;
}
