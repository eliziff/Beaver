import type { ReactNode } from "react";

export function CourtRecordStepHeading({ id, step, children, required = false }: {
  id?: string; step?: number; children: ReactNode; required?: boolean;
}) {
  return <h2 id={id} className="flex items-start gap-2 text-sm font-semibold leading-5 text-gray-950">
    {step !== undefined && <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[11px] font-semibold text-gray-700" aria-hidden="true">{step}</span>}
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span>{children}</span>{required && <RequiredBadge />}
    </span>
  </h2>;
}

export function RequiredBadge() {
  return <span className="inline-flex shrink-0 items-center rounded-md bg-gray-100 px-2 py-0.5 text-[11px] font-medium leading-4 text-gray-600">Required</span>;
}
