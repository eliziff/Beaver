import type { ReactNode } from "react";
import { PageHeader } from "@/app/components/shared/PageHeader";

export function AuthoritiesShell({
  active,
  busy,
  children,
}: {
  active: boolean;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="authorities-host"
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#f3f4f6] ${
        active ? "" : "pointer-events-none opacity-0"
      }`}
    >
      <PageHeader shrink>
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          Authorities
        </h1>
      </PageHeader>
      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        aria-busy={busy}
      >
        {children}
      </div>
    </div>
  );
}

export function AuthoritiesLoadingFrame() {
  return <AuthoritiesShell active busy>{null}</AuthoritiesShell>;
}
