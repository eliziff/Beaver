import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/app/lib/utils";

/** Work started from a step reports itself in that step, beside the control that began it,
 *  and so does the reason it stopped.
 *  `announce` is off where the step already carries its own live region. */
export function StepProgress({ label, error, className, announce = true }: {
  label?: string; error?: string; className?: string; announce?: boolean;
}) {
  if (error) return <span role="alert"
    className={cn("text-sm font-medium text-red-800", className)}>{error}</span>;
  if (!label) return null;
  return <span role={announce ? "status" : undefined}
    className={cn("flex items-center gap-2 text-sm font-medium text-gray-700", className)}>
    <Loader2 className="size-4 shrink-0 text-red-700 motion-safe:animate-spin" aria-hidden="true" />{label}</span>;
}

/** One step of the authorities workflow: a titled card whose actions sit on the right. */
export function StepSection({ title, subtitle, subtitleTitle, actions, className, children }: {
  title: string; subtitle?: ReactNode; subtitleTitle?: string; actions?: ReactNode;
  className?: string; children?: ReactNode;
}) {
  return <section aria-label={title} className={cn("rounded-xl border border-gray-300 bg-white shadow-sm", className)}>
    <div className={cn("flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3",
      children && "border-b border-gray-200")}>
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">{title}</h2>
        {subtitle && <p className="truncate text-sm text-gray-600" title={subtitleTitle}>{subtitle}</p>}</div>
      {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
    {children}
  </section>;
}
